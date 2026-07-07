import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import {
  buildStatsModel,
  buildTraceModel,
  detectOrderingDrift,
  parsePhaseWindows,
} from '../src/surfaces/stats.ts';
import { runDirOf, saveRunState } from '../src/run/store.ts';
import { listStagedSteersForTrace, stageSteer, markSteersDelivered } from '../src/run/steers.ts';
import type { RunState } from '../src/run/store.ts';
import { test } from './helpers/fixtures.ts';

/** ISO stamp `runStartMs + minutes`, matching appendVoiceLog's format the parser anchors on. */
function at(base: number, minutes: number): string {
  return new Date(base + minutes * 60_000).toISOString();
}

/** Write a run's orchestrator + worker logs and mark the workers as having sessions (so the trace reads them). */
function writeLogs(state: RunState, logs: { orchestrator?: string; architect?: string; analyst?: string }): void {
  const dir = runDirOf(state.cwd, state.runId);
  if (logs.orchestrator !== undefined) writeFileSync(join(dir, 'orchestrator.log'), logs.orchestrator);
  if (logs.architect !== undefined) writeFileSync(join(dir, 'architect.log'), logs.architect);
  if (logs.analyst !== undefined) writeFileSync(join(dir, 'analyst.log'), logs.analyst);
  state.sessions = {
    'planning.architect': { provider: 'claude', id: 'a' },
    'planning.analyst': { provider: 'codex', id: 'b' },
  };
  saveRunState(state);
}

describe('parsePhaseWindows — the open current-phase window (P1b)', () => {
  test('a headless current phase (◀-open, no close) gets a REAL window ending at the injected now', () => {
    const log = `[${at(0, 0)}] ◀ harness prompt (phase=spec)\n[${at(0, 10)}] advance_phase (spec)\n[${at(0, 11)}] ◀ harness prompt (phase=plan)\n`;
    const { windows } = parsePhaseWindows(log, 0, { now: Date.parse(at(0, 20)), currentPhase: 'plan' });
    const plan = windows.find((w) => w.phase === 'plan')!;
    expect(plan.startMs).toBe(Date.parse(at(0, 11))); // the real ◀-open, not inferred
    expect(plan.endMs).toBe(Date.parse(at(0, 20))); // the injected now
    expect(plan.inferred).toBeUndefined();
  });

  test('an interactive current phase (no ◀-open) gets an INFERRED window + the inferred count', () => {
    const first = parsePhaseWindows('', Date.parse(at(0, 0)), { now: Date.parse(at(0, 20)), currentPhase: 'research' });
    const w = first.windows.find((x) => x.phase === 'research')!;
    expect(w.inferred).toBe(true); // start inferred from runStart (a first, interactive phase)
    expect(w.endMs).toBe(Date.parse(at(0, 20)));
    expect(first.inferred).toBe(1);
  });

  test('without the open spec, aggregate behavior is unchanged (no trailing open window)', () => {
    const log = `[${at(0, 0)}] ◀ harness prompt (phase=spec)\n[${at(0, 10)}] advance_phase (spec)\n[${at(0, 11)}] ◀ harness prompt (phase=plan)\n`;
    const { windows } = parsePhaseWindows(log, 0);
    expect(windows.map((w) => w.phase)).toEqual(['spec']); // plan's open is NOT emitted
  });
});

describe('detectOrderingDrift — the narrow ordering rule (P2b)', () => {
  const review = (voice: string, startMs: number) => ({ voice, tag: 'review-spec', startMs });
  const maker = (voice: string, startMs: number) => ({ voice, tag: 'write-spec', startMs });

  test('fires on two consecutive checker review turns with no maker turn between', () => {
    const flags = detectOrderingDrift('spec', [review('analyst', 1), review('analyst', 2)]);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ phase: 'spec', first: { tag: 'review-spec' }, second: { tag: 'review-spec' } });
  });

  test('does NOT fire when a maker turn interleaves', () => {
    const flags = detectOrderingDrift('spec', [review('analyst', 1), maker('architect', 2), review('analyst', 3)]);
    expect(flags).toHaveLength(0);
  });

  test('a consultant turn between two reviews is NOT a maker interleave — drift still fires', () => {
    const flags = detectOrderingDrift('spec', [
      review('analyst', 1),
      { voice: 'consultant', tag: 'consultant-spec', startMs: 2 },
      review('analyst', 3),
    ]);
    expect(flags).toHaveLength(1);
  });

  test('an uncataloged tag never counts as a review round', () => {
    const flags = detectOrderingDrift('spec', [
      { voice: 'analyst', tag: 'chatter', startMs: 1 },
      { voice: 'analyst', tag: 'chatter', startMs: 2 },
    ]);
    expect(flags).toHaveLength(0);
  });
});

describe('buildTraceModel — the interleaved timeline over the real cores', () => {
  test('attributes the live/open phase’s turns (P1b) and overlays interventions + a delivered steer', ({ run }) => {
    const base = Date.parse(run.createdAt);
    // frame is the current phase (a framing-only run probes to frame); it is OPEN
    // (◀-open, never advanced), so its turns attribute via the open window.
    writeLogs(run, {
      orchestrator: `[${at(base, 1)}] ◀ harness prompt (phase=frame)\n`,
      architect: `[${at(base, 2)}] ◀ prompt (tag=write-spec)\n[${at(base, 3)}] ▶ response\n`,
      analyst: `[${at(base, 4)}] ◀ prompt (tag=review-spec)\n[${at(base, 5)}] ▶ response\n[${at(base, 6)}] ◀ prompt (tag=review-spec)\n[${at(base, 7)}] ▶ response\n`,
    });
    run.contextEvents = [{ kind: 'compact', voice: 'architect', at: at(base, 3) }];
    run.autoRetries = [{ phase: 'frame', errorClass: 'network', attempt: 1, at: at(base, 4) }];
    saveRunState(run);
    // A steer staged during frame, then DELIVERED — the trace must still show it.
    const steer = stageSteer(run, 'try approach Y', 'frame');
    markSteersDelivered(run, [steer]);

    const model = buildTraceModel(run, base + 20 * 60_000);
    const frame = model.phases.find((p) => p.phase === 'frame')!;
    // The open phase's worker turns are attributed, not dropped.
    expect(frame.turns.map((t) => t.tag)).toEqual(['write-spec', 'review-spec', 'review-spec']);
    // Interventions overlaid: the compaction, the auto-retry, and the delivered steer.
    expect(frame.interventions.map((e) => e.kind).sort()).toEqual(['auto-retry', 'compact', 'steer-staged']);
    // Ordering drift: two reviews, no maker between.
    expect(frame.drift).toHaveLength(1);
  });

  test('an interactive/open phase with no closing header carries an inferred-window note', ({ run }) => {
    const base = Date.parse(run.createdAt);
    // No orchestrator ◀-open at all → frame's window is inferred.
    writeLogs(run, {
      orchestrator: '',
      architect: `[${at(base, 2)}] ◀ prompt (tag=write-spec)\n[${at(base, 3)}] ▶ response\n`,
    });
    const model = buildTraceModel(run, base + 20 * 60_000);
    const frame = model.phases.find((p) => p.phase === 'frame')!;
    expect(frame.inferredWindow).toBe(true);
    expect(frame.turns.map((t) => t.tag)).toEqual(['write-spec']); // still attributed
    expect(model.notes.some((n) => /inferred/.test(n))).toBe(true);
  });

  test('trace --json carries the settled top-level keys, raw', ({ run }) => {
    writeLogs(run, { orchestrator: '' });
    const model = buildTraceModel(run, Date.parse(run.createdAt) + 60_000);
    expect(Object.keys(model).sort()).toEqual(['notes', 'phases', 'runId']);
  });

  test('the aggregate stats model is byte-for-byte unaffected by the open-window addition', ({ run }) => {
    const base = Date.parse(run.createdAt);
    writeLogs(run, {
      orchestrator: `[${at(base, 1)}] ◀ harness prompt (phase=frame)\n`,
      architect: `[${at(base, 2)}] ◀ prompt (tag=write-spec)\n[${at(base, 3)}] ▶ response\n`,
    });
    // buildStatsModel never passes the open param, so the never-closed frame yields
    // no window — its turn stays unattributed (a phase still in progress), exactly
    // as before the trace feature.
    const stats = buildStatsModel(run);
    expect(stats.phases).toHaveLength(0);
    expect(stats.notes.some((n) => /outside any phase window/.test(n))).toBe(true);
  });
});

describe('listStagedSteersForTrace — both dirs, delivered included', () => {
  test('returns a delivered steer (renamed into delivered/) that listPendingSteers omits', ({ run }) => {
    const staged = stageSteer(run, 'note A', 'frame');
    stageSteer(run, 'note B', 'spec'); // stays pending
    markSteersDelivered(run, [staged]);
    const all = listStagedSteersForTrace(run);
    expect(all.map((s) => s.text).sort()).toEqual(['note A', 'note B']);
  });

  test('a file present in both dirs (a mid-scan rename artifact) appears once, never throws', ({ run }) => {
    const s = stageSteer(run, 'racing', 'frame');
    // Simulate the race: copy the same filename into delivered/ while it also
    // still exists in staging (a snapshot mid-rename).
    const dir = runDirOf(run.cwd, run.runId);
    const delivered = join(dir, 'steers', 'delivered');
    mkdirSync(delivered, { recursive: true });
    writeFileSync(join(delivered, s.file), JSON.stringify({ text: 'racing', stagedAt: s.stagedAt, stagedDuring: 'frame' }));
    const all = listStagedSteersForTrace(run);
    expect(all.filter((x) => x.file === s.file)).toHaveLength(1);
  });
});

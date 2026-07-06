import { describe, expect, test as plain } from 'vitest';
import {
  buildStats,
  buildStatsModel,
  gapsBetweenTurns,
  heartbeatCountBetween,
  parseDriverHeartbeats,
  parseVoiceLogTurns,
  renderStats,
  unionDurationMs,
} from '../src/surfaces/stats.ts';
import { phasesOf } from '../src/registry/workflows.ts';
import { formatDuration } from '../src/view/timefmt.ts';
import { appendVoiceLog } from '../src/run/store.ts';
import { test } from './helpers/fixtures.ts';

/**
 * `duet stats` derives effort from the voice logs at view time. The pure core
 * (`buildStats`) is tested on real log-line strings — phase windows from the
 * orchestrator log, worker turns from the worker logs, attributed and aggregated
 * — and on its fail-soft degradations. The fs composer (`buildStatsModel`) gets
 * one round-trip through the real `appendVoiceLog` writer.
 */

const FULL_ORDER = phasesOf('full').map((p) => p.name);
const line = (ts: string, header: string) => `[${ts}] ${header}`;
// A canonical UTC stamp at minute `m` (and optional second) past a fixed hour.
const at = (m: number, s = 0) => `2026-06-26T10:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`;

describe('formatDuration', () => {
  plain.for<[number, string]>([
    [0, '<1m'],
    [59_000, '<1m'],
    [60_000, '1m'],
    [8 * 60_000, '8m'],
    [60 * 60_000, '1h'],
    [83 * 60_000, '1h 23m'],
    [-5, '—'],
    [Number.NaN, '—'],
  ])('%d ms → %s', ([ms, expected]) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe('buildStats — the pure parse core', () => {
  plain('attributes worker turns to the containing phase window; aggregates per phase and per tag', () => {
    const orchestrator = [
      line(at(0), '◀ harness prompt (phase=spec)'),
      'a prompt body',
      '',
      line(at(10), 'advance_phase (spec)'),
      'a summary',
      '',
    ].join('\n');
    const architect = [line(at(1), '◀ prompt (tag=write-spec, from orchestrator)'), 'body', '', line(at(4), '▶ response (session s1)'), 'reply', ''].join('\n');
    const analyst = [line(at(5), '◀ prompt (tag=review-spec, from orchestrator)'), 'body', '', line(at(7), '▶ response (session s2)'), 'reply', ''].join('\n');

    const model = buildStats('run-1', orchestrator, [{ voice: 'architect', log: architect }, { voice: 'analyst', log: analyst }], FULL_ORDER);

    expect.soft(model.phases).toEqual([{ phase: 'spec', windowMs: 10 * 60_000, workerMs: 5 * 60_000, turns: 2 }]);
    expect.soft(model.totalWindowMs).toBe(10 * 60_000);
    // tags sorted longest-first: write-spec (3m) before review-spec (2m).
    expect.soft(model.tags).toEqual([
      { tag: 'write-spec', totalMs: 3 * 60_000, turns: 1 },
      { tag: 'review-spec', totalMs: 2 * 60_000, turns: 1 },
    ]);
    expect.soft(model.notes).toEqual([]);
  });

  plain('a gate-reject re-entry SUMS the phase windows and excludes the gate-wait gap', () => {
    const orchestrator = [
      line(at(0), '◀ harness prompt (phase=finish)'),
      line(at(5), 'advance_phase (finish)'), // window 1: 5m
      // gate wait — the human rejects at :20; this gap must NOT be counted
      line(at(20), '◀ harness prompt (phase=finish)'),
      line(at(23), 'advance_phase (finish)'), // window 2: 3m
    ].join('\n');

    const model = buildStats('run-2', orchestrator, [], FULL_ORDER);
    expect.soft(model.phases).toEqual([{ phase: 'finish', windowMs: 8 * 60_000, workerMs: 0, turns: 0 }]);
    expect.soft(model.totalWindowMs).toBe(8 * 60_000); // not 23m
  });

  plain('a flag-then-resume keeps the first open as one window', () => {
    const orchestrator = [
      line(at(0), '◀ harness prompt (phase=implement)'),
      // ask_human flags at :02; the answer resumes and re-logs the header at :15
      line(at(15), '◀ harness prompt (phase=implement)'),
      line(at(20), 'advance_phase (implement)'),
    ].join('\n');

    const model = buildStats('run-3', orchestrator, [], FULL_ORDER);
    // One window from the first open (:00) to the advance (:20) — 20m.
    expect.soft(model.phases).toEqual([{ phase: 'implement', windowMs: 20 * 60_000, workerMs: 0, turns: 0 }]);
  });

  plain('a budget-stop or turn-failure terminal line ends a worker turn', () => {
    const orchestrator = [line(at(0), '◀ harness prompt (phase=implement)'), line(at(50), 'advance_phase (implement)')].join('\n');
    const builder = [
      line(at(1), '◀ prompt (tag=implement-direct, from orchestrator)'),
      line(at(40), '◼ budget-control stop: per-turn cap reached'), // a capped turn still counts (39m)
    ].join('\n');

    const model = buildStats('run-4', orchestrator, [{ voice: 'builder', log: builder }], FULL_ORDER);
    expect.soft(model.tags).toEqual([{ tag: 'implement-direct', totalMs: 39 * 60_000, turns: 1 }]);
    expect.soft(model.phases[0]).toMatchObject({ phase: 'implement', workerMs: 39 * 60_000, turns: 1 });
  });

  plain('a missing orchestrator log degrades to a note, no phases', () => {
    const model = buildStats('run-5', undefined, [], FULL_ORDER);
    expect.soft(model.phases).toEqual([]);
    expect.soft(model.notes[0]).toContain('no orchestrator log');
  });

  plain('an interactive run (worker turns, no harness prompts) notes the gap and counts turns under tags only', () => {
    const orchestrator = [line(at(0), '▶ orchestrator'), 'some narration', ''].join('\n'); // no harness-prompt lines
    const architect = [line(at(1), '◀ prompt (tag=implement-direct, from orchestrator)'), line(at(6), '▶ response (session s1)')].join('\n');

    const model = buildStats('run-6', orchestrator, [{ voice: 'architect', log: architect }], FULL_ORDER);
    expect.soft(model.phases).toEqual([]); // no windows → no phase rows
    expect.soft(model.tags).toEqual([{ tag: 'implement-direct', totalMs: 5 * 60_000, turns: 1 }]); // still tallied by tag
    expect.soft(model.notes.join('\n')).toContain('interactively');
    expect.soft(model.notes.join('\n')).toContain('outside any phase window');
  });

  plain('an EXPECTED-but-missing worker log degrades to a note (not a silent undercount)', () => {
    const orchestrator = [line(at(0), '◀ harness prompt (phase=spec)'), line(at(10), 'advance_phase (spec)')].join('\n');
    // The composer passes a session-bearing worker with no log as { role } (no log).
    const model = buildStats('run-7', orchestrator, [{ voice: 'analyst' }], FULL_ORDER);
    expect.soft(model.notes.join('\n')).toContain('analyst log missing');
  });

  plain('a worker prompt with no terminal line is noted as still-open, not dropped', () => {
    const orchestrator = [line(at(0), '◀ harness prompt (phase=implement)'), line(at(50), 'advance_phase (implement)')].join('\n');
    // A prompt with no ▶ response / stop / failure after it — an in-flight turn.
    const architect = [line(at(1), '◀ prompt (tag=implement-direct, from orchestrator)'), 'body, then the log ends mid-turn'].join('\n');

    const model = buildStats('run-8', orchestrator, [{ voice: 'architect', log: architect }], FULL_ORDER);
    expect.soft(model.tags).toEqual([]); // the open turn contributes no duration
    expect.soft(model.notes.join('\n')).toContain('architect: 1 turn(s) still open');
  });

  plain('a gate crossing with no logged entry infers its window from the previous crossing (interactive phases attribute)', () => {
    // An interactively-orchestrated stretch voice-logs the advance_phase closes
    // but no harness-prompt opens (the interactive host serves briefs via
    // get_task). The phases are sequential, so each close bounds the next
    // phase's inferred window — worker turns attribute instead of orphaning
    // (the 70b2/ec57 forensics: 15–16 turns fell outside every window).
    const runStart = Date.parse(at(0));
    const orchestrator = [
      line(at(10), 'advance_phase (frame)'), // no open — inferred window: runStart → :10
      line(at(30), 'advance_phase (spec)'), // no open — inferred window: :10 → :30
      line(at(31), '◀ harness prompt (phase=plan)'), // headless from here — a real window
      line(at(40), 'advance_phase (plan)'),
    ].join('\n');
    const architect = [
      line(at(2), '◀ prompt (tag=think-holistic, from orchestrator)'),
      line(at(6), '▶ response (session s1)'),
      line(at(12), '◀ prompt (tag=write-spec, from orchestrator)'),
      line(at(20), '▶ response (session s1)'),
    ].join('\n');

    const model = buildStats('run-9', orchestrator, [{ voice: 'architect', log: architect }], FULL_ORDER, undefined, runStart);
    expect.soft(model.phases.map((p) => ({ phase: p.phase, turns: p.turns }))).toEqual([
      { phase: 'frame', turns: 1 },
      { phase: 'spec', turns: 1 },
      { phase: 'plan', turns: 0 },
    ]);
    // The first inferred window floors at the run's creation, not the epoch.
    expect.soft(model.phases[0]?.windowMs).toBe(10 * 60_000);
    expect.soft(model.notes.join('\n')).toContain('inferred from gate crossings');
    expect.soft(model.notes.join('\n')).not.toContain('outside any phase window');
  });
});

describe('buildStats — the architect-model label', () => {
  plain('attaches the resolved builder model per phase when a labeler is supplied', () => {
    const orchestrator = [line(at(0), '◀ harness prompt (phase=implement)'), line(at(5), 'advance_phase (implement)')].join('\n');
    const model = buildStats('run-lbl', orchestrator, [], FULL_ORDER, (phase) => (phase === 'implement' ? 'claude-sonnet-5' : undefined));
    expect.soft(model.phases[0]).toMatchObject({ phase: 'implement', makerModel: 'claude-sonnet-5' });
  });

  plain('no labeler ⇒ no makerModel field (byte-for-byte the aggregate rows)', () => {
    const orchestrator = [line(at(0), '◀ harness prompt (phase=implement)'), line(at(5), 'advance_phase (implement)')].join('\n');
    const model = buildStats('run-nolbl', orchestrator, [], FULL_ORDER);
    expect.soft(model.phases[0]).not.toHaveProperty('makerModel');
  });
});

describe('corpus telemetry primitives', () => {
  plain('unionDurationMs merges overlapping worker intervals so parallel turns do not double-count busy time', () => {
    expect(
      unionDurationMs([
        { startMs: 0, endMs: 10 },
        { startMs: 5, endMs: 20 },
        { startMs: 30, endMs: 35 },
      ]),
    ).toBe(25);
  });

  plain('parseVoiceLogTurns classifies ok, budget, failed, and timeout terminal lines', () => {
    const log = [
      line(at(0), '◀ prompt (tag=ok-turn, from orchestrator)'),
      line(at(1), '▶ response (session s1)'),
      line(at(2), '◀ prompt (tag=budget-turn, from orchestrator)'),
      line(at(3), '◼ budget-control stop: per-turn cap reached'),
      line(at(4), '◀ prompt (tag=timeout-turn, from orchestrator)'),
      line(at(5), '✗ turn failed: operation timed out'),
      line(at(6), '◀ prompt (tag=failed-turn, from orchestrator)'),
      line(at(7), '✗ turn failed: auth rejected'),
    ].join('\n');

    expect(parseVoiceLogTurns('builder', log).turns.map((t) => [t.tag, t.status])).toEqual([
      ['ok-turn', 'ok'],
      ['budget-turn', 'budget'],
      ['timeout-turn', 'timeout'],
      ['failed-turn', 'failed'],
    ]);
  });

  plain('gapsBetweenTurns reports only gaps over the threshold, ordered by turn time', () => {
    const turns = parseVoiceLogTurns(
      'builder',
      [
        line(at(0), '◀ prompt (tag=a, from orchestrator)'),
        line(at(1), '▶ response (session s1)'),
        line(at(2), '◀ prompt (tag=b, from orchestrator)'),
        line(at(3), '▶ response (session s1)'),
        line(at(40), '◀ prompt (tag=c, from orchestrator)'),
        line(at(41), '▶ response (session s1)'),
      ].join('\n'),
    ).turns;

    const gaps = gapsBetweenTurns(turns, 25 * 60_000);
    expect.soft(gaps).toHaveLength(1);
    expect.soft(gaps[0]?.before.tag).toBe('b');
    expect.soft(gaps[0]?.after.tag).toBe('c');
  });

  plain('driver heartbeats parse from stored UTC lines and can be counted across a turn', () => {
    const heartbeats = parseDriverHeartbeats(
      [
        line(at(0), '⏳ implement phase still running — 5m elapsed'),
        line(at(5), '⏳ implement phase still running — 10m elapsed'),
        line(at(12), 'not a heartbeat'),
      ].join('\n'),
    );
    expect.soft(heartbeats).toEqual([
      { atMs: Date.parse(at(0)), elapsedMinutes: 5 },
      { atMs: Date.parse(at(5)), elapsedMinutes: 10 },
    ]);
    expect.soft(heartbeatCountBetween(heartbeats, Date.parse(at(1)), Date.parse(at(6)))).toBe(1);
  });
});

describe('buildStatsModel — the fs composer over real appendVoiceLog output', () => {
  test('reads the planted voice logs and produces a phase row and a tag', ({ run }) => {
    appendVoiceLog(run, 'orchestrator', '◀ harness prompt (phase=spec)', 'brief');
    appendVoiceLog(run, 'architect', '◀ prompt (tag=write-spec, from orchestrator)', 'go');
    appendVoiceLog(run, 'architect', '▶ response (session s1)', 'done');
    appendVoiceLog(run, 'orchestrator', 'advance_phase (spec)', 'converged');

    const model = buildStatsModel(run);
    // Real timestamps are sub-second apart, so durations round to <1m — the
    // structure (a spec phase, a write-spec tag) is what this round-trip pins.
    expect.soft(model.phases.map((p) => p.phase)).toEqual(['spec']);
    expect.soft(model.phases[0]?.turns).toBe(1);
    expect.soft(model.tags.map((t) => t.tag)).toEqual(['write-spec']);
    expect.soft(renderStats(model)).toContain('━━━ duet stats');
  });

  test('labels each phase with the model that ran it — the architect through planning, the builder in delivery', ({ run }) => {
    run.bindings.duties = {
      ...run.bindings.duties,
      builder: { provider: 'claude', model: 'claude-sonnet-5', transport: 'headless' },
    };
    appendVoiceLog(run, 'orchestrator', '◀ harness prompt (phase=plan)', 'brief');
    appendVoiceLog(run, 'orchestrator', 'advance_phase (plan)', 'ok');
    appendVoiceLog(run, 'orchestrator', '◀ harness prompt (phase=implement)', 'brief');
    appendVoiceLog(run, 'orchestrator', 'advance_phase (implement)', 'ok');

    const byPhase = Object.fromEntries(buildStatsModel(run).phases.map((p) => [p.phase, p.makerModel]));
    expect.soft(byPhase['plan']).toBe('claude-opus-4-8'); // planning ran on the base model
    expect.soft(byPhase['implement']).toBe('claude-sonnet-5'); // the build ran on the impl model
  });

  test('a codex maker labels deferred model as "codex", and shows explicit model/effort when set', ({ run }) => {
    run.bindings.duties = {
      ...run.bindings.duties,
      architect: { provider: 'codex' },
      builder: { provider: 'codex', model: 'gpt-5.5', effort: 'high' },
    };
    appendVoiceLog(run, 'orchestrator', '◀ harness prompt (phase=plan)', 'brief');
    appendVoiceLog(run, 'orchestrator', 'advance_phase (plan)', 'ok');
    appendVoiceLog(run, 'orchestrator', '◀ harness prompt (phase=implement)', 'brief');
    appendVoiceLog(run, 'orchestrator', 'advance_phase (implement)', 'ok');

    const byPhase = Object.fromEntries(buildStatsModel(run).phases.map((p) => [p.phase, p.makerModel]));
    expect.soft(byPhase['plan']).toBe('codex');
    expect.soft(byPhase['implement']).toBe('gpt-5.5@high');
  });
});

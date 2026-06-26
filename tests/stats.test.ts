import { describe, expect, test as plain } from 'vitest';
import { buildStats, buildStatsModel, renderStats } from '../src/stats.ts';
import { phasesOf } from '../src/phases.ts';
import { formatDuration } from '../src/timefmt.ts';
import { appendVoiceLog } from '../src/run-store.ts';
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
    const implementer = [line(at(1), '◀ prompt (tag=write-spec, from orchestrator)'), 'body', '', line(at(4), '▶ response (session s1)'), 'reply', ''].join('\n');
    const reviewer = [line(at(5), '◀ prompt (tag=review-spec, from orchestrator)'), 'body', '', line(at(7), '▶ response (session s2)'), 'reply', ''].join('\n');

    const model = buildStats('run-1', orchestrator, [{ role: 'implementer', log: implementer }, { role: 'reviewer', log: reviewer }], FULL_ORDER);

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
      line(at(0), '◀ harness prompt (phase=impl)'),
      // ask_human flags at :02; the answer resumes and re-logs the header at :15
      line(at(15), '◀ harness prompt (phase=impl)'),
      line(at(20), 'advance_phase (impl)'),
    ].join('\n');

    const model = buildStats('run-3', orchestrator, [], FULL_ORDER);
    // One window from the first open (:00) to the advance (:20) — 20m.
    expect.soft(model.phases).toEqual([{ phase: 'impl', windowMs: 20 * 60_000, workerMs: 0, turns: 0 }]);
  });

  plain('a budget-stop or turn-failure terminal line ends a worker turn', () => {
    const orchestrator = [line(at(0), '◀ harness prompt (phase=impl)'), line(at(50), 'advance_phase (impl)')].join('\n');
    const implementer = [
      line(at(1), '◀ prompt (tag=implement-direct, from orchestrator)'),
      line(at(40), '◼ budget-control stop: per-turn cap reached'), // a capped turn still counts (39m)
    ].join('\n');

    const model = buildStats('run-4', orchestrator, [{ role: 'implementer', log: implementer }], FULL_ORDER);
    expect.soft(model.tags).toEqual([{ tag: 'implement-direct', totalMs: 39 * 60_000, turns: 1 }]);
    expect.soft(model.phases[0]).toMatchObject({ phase: 'impl', workerMs: 39 * 60_000, turns: 1 });
  });

  plain('a missing orchestrator log degrades to a note, no phases', () => {
    const model = buildStats('run-5', undefined, [], FULL_ORDER);
    expect.soft(model.phases).toEqual([]);
    expect.soft(model.notes[0]).toContain('no orchestrator log');
  });

  plain('an interactive run (worker turns, no harness prompts) notes the gap and counts turns under tags only', () => {
    const orchestrator = [line(at(0), '▶ orchestrator'), 'some narration', ''].join('\n'); // no harness-prompt lines
    const implementer = [line(at(1), '◀ prompt (tag=implement-direct, from orchestrator)'), line(at(6), '▶ response (session s1)')].join('\n');

    const model = buildStats('run-6', orchestrator, [{ role: 'implementer', log: implementer }], FULL_ORDER);
    expect.soft(model.phases).toEqual([]); // no windows → no phase rows
    expect.soft(model.tags).toEqual([{ tag: 'implement-direct', totalMs: 5 * 60_000, turns: 1 }]); // still tallied by tag
    expect.soft(model.notes.join('\n')).toContain('interactively');
    expect.soft(model.notes.join('\n')).toContain('outside any phase window');
  });

  plain('an EXPECTED-but-missing worker log degrades to a note (not a silent undercount)', () => {
    const orchestrator = [line(at(0), '◀ harness prompt (phase=spec)'), line(at(10), 'advance_phase (spec)')].join('\n');
    // The composer passes a session-bearing worker with no log as { role } (no log).
    const model = buildStats('run-7', orchestrator, [{ role: 'reviewer' }], FULL_ORDER);
    expect.soft(model.notes.join('\n')).toContain('reviewer log missing');
  });

  plain('a worker prompt with no terminal line is noted as still-open, not dropped', () => {
    const orchestrator = [line(at(0), '◀ harness prompt (phase=impl)'), line(at(50), 'advance_phase (impl)')].join('\n');
    // A prompt with no ▶ response / stop / failure after it — an in-flight turn.
    const implementer = [line(at(1), '◀ prompt (tag=implement-direct, from orchestrator)'), 'body, then the log ends mid-turn'].join('\n');

    const model = buildStats('run-8', orchestrator, [{ role: 'implementer', log: implementer }], FULL_ORDER);
    expect.soft(model.tags).toEqual([]); // the open turn contributes no duration
    expect.soft(model.notes.join('\n')).toContain('implementer: 1 turn(s) still open');
  });
});

describe('buildStatsModel — the fs composer over real appendVoiceLog output', () => {
  test('reads the planted voice logs and produces a phase row and a tag', ({ run }) => {
    appendVoiceLog(run, 'orchestrator', '◀ harness prompt (phase=spec)', 'brief');
    appendVoiceLog(run, 'implementer', '◀ prompt (tag=write-spec, from orchestrator)', 'go');
    appendVoiceLog(run, 'implementer', '▶ response (session s1)', 'done');
    appendVoiceLog(run, 'orchestrator', 'advance_phase (spec)', 'converged');

    const model = buildStatsModel(run);
    // Real timestamps are sub-second apart, so durations round to <1m — the
    // structure (a spec phase, a write-spec tag) is what this round-trip pins.
    expect.soft(model.phases.map((p) => p.phase)).toEqual(['spec']);
    expect.soft(model.phases[0]?.turns).toBe(1);
    expect.soft(model.tags.map((t) => t.tag)).toEqual(['write-spec']);
    expect.soft(renderStats(model)).toContain('━━━ duet stats');
  });
});

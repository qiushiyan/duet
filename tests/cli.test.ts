import { describe, expect } from 'vitest';
import { newRunInputOpts, resolveAfkArgs, takeoverPlan } from '../src/cli.ts';
import { test } from './helpers/fixtures.ts';

/**
 * The `duet new` / `duet afk` argument plumbing, tested at its pure seam — the
 * action bodies are thin wiring (they spawn drivers), so the disambiguation and
 * forwarding logic is extracted into helpers that carry the decisions.
 */

describe('resolveAfkArgs — duet afk positional disambiguation (#2)', () => {
  test('a lone arg that names an existing run is the runId (bare posture for that run)', ({ projectDir, run }) => {
    // `duet afk <runId>` — previously impossible: the run id parsed as a preset.
    expect(resolveAfkArgs(projectDir, run.runId, undefined)).toEqual({ runId: run.runId });
  });

  test('a preset + an explicit runId pass through unchanged', ({ projectDir, run }) => {
    // `duet afk overnight <runId>`
    expect(resolveAfkArgs(projectDir, 'overnight', run.runId)).toEqual({ preset: 'overnight', runId: run.runId });
  });

  test('a lone arg that is NOT a run dir stays the preset (posture for the latest run)', ({ projectDir }) => {
    // `duet afk overnight` — "overnight" is a preset, not a run id.
    expect(resolveAfkArgs(projectDir, 'overnight', undefined)).toEqual({ preset: 'overnight' });
  });

  test('no args is the bare attend-none posture for the latest run', ({ projectDir }) => {
    // `duet afk`
    expect(resolveAfkArgs(projectDir, undefined, undefined)).toEqual({});
  });
});

describe('newRunInputOpts — duet new flag forwarding (#3)', () => {
  test('an explicit empty --gates-at is forwarded KEY-PRESENT, not dropped', () => {
    // The CLI must hand "" to resolveRunInputs so the parser rejects it as empty
    // (framing.ts), rather than truthy-dropping it to attend-all.
    expect(newRunInputOpts({ gatesAt: '' })).toEqual({ gatesAt: '' });
  });

  test('an absent --gates-at is omitted', () => {
    expect(newRunInputOpts({})).toEqual({});
  });

  test('truthy-gated siblings treat an empty string as an omitted flag', () => {
    // spec/framing/template/workflow carry no empty-value semantics.
    expect(newRunInputOpts({ spec: '', framing: '', template: '', workflow: '' })).toEqual({});
  });

  test('real values pass through', () => {
    expect(newRunInputOpts({ gatesAt: 'frame, spec', workflow: 'full', retryInfra: '2' })).toEqual({
      gatesAt: 'frame, spec',
      workflow: 'full',
      retryInfra: '2',
    });
  });
});

describe('takeoverPlan — the takeover decision (resume vs inspect vs clear-orphan)', () => {
  test('a persistent role with a captured session opens to RESUME (not ephemeral)', ({ run }) => {
    run.workerSessions = { reviewer: 'rev-1' };
    expect(takeoverPlan(run, 'reviewer')).toEqual({ kind: 'open', sessionId: 'rev-1', ephemeral: false });
  });

  test('the consultant with a captured session opens to INSPECT — ephemeral, duet will not resume it', ({ consultantRun }) => {
    consultantRun.workerSessions = { consultant: 'c-1' };
    expect(takeoverPlan(consultantRun, 'consultant')).toEqual({ kind: 'open', sessionId: 'c-1', ephemeral: true });
  });

  test('a pending record with no session is a clear-orphan — read-only-safe for the consultant, an abandon for a worker', ({
    run,
    consultantRun,
  }) => {
    run.pendingTurns = { reviewer: { tag: 'review-spec', startedAt: 't', status: 'running' } };
    expect.soft(takeoverPlan(run, 'reviewer')).toEqual({ kind: 'clear-orphan', ephemeral: false });

    consultantRun.pendingTurns = { consultant: { tag: 'consultant-spec', startedAt: 't', status: 'running' } };
    expect.soft(takeoverPlan(consultantRun, 'consultant')).toEqual({ kind: 'clear-orphan', ephemeral: true });
  });

  test('no session and no orphan is no-session', ({ run }) => {
    expect(takeoverPlan(run, 'reviewer')).toEqual({ kind: 'no-session' });
  });
});

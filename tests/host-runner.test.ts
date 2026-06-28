import { describe, expect, onTestFinished, vi } from 'vitest';
import { runHostedPhase } from '../src/harness/host-runner.ts';
import type { HostedSession, PhaseHost, TurnOutcome } from '../src/harness/host-runner.ts';
import type { DriverInput } from '../src/harness/driver.ts';
import { loadRunState, saveRunState } from '../src/run-store.ts';
import type { ErrorClass } from '../src/worker-health.ts';
import { test } from './helpers/fixtures.ts';

/**
 * The shared phase run loop's four rails (entry replay, nudge-once, twice-ended
 * flag, crash → flag + opt-in retry), driven through the `PhaseHost` seam with a
 * scripted host — a third adapter next to the in-process driver and the stdio
 * host. This is the payoff of the extraction: the rails are exercised with a
 * 5-line fake session instead of a full Agent SDK fake (driver.test.ts) or a real
 * `_mcp` subprocess (stdio-host.test.ts). The two production hosts remain pinned
 * end-to-end by those suites; this one owns the host-agnostic logic directly.
 */

type Step = TurnOutcome | ((input: DriverInput) => Promise<TurnOutcome> | TurnOutcome);

/**
 * A scripted PhaseHost. Each `driveTurn` shifts the next step: a TurnOutcome
 * literal is returned; a thunk runs (it may persist a marker / pendingQuestion
 * and return an outcome, or throw to model a crash). `calls` records the rails'
 * use of the seam — how many sessions opened/closed, and whether the failure was
 * classified.
 */
function scriptedHost(
  steps: Step[],
  opts: { retryable?: boolean; errorClass?: ErrorClass } = {},
): { host: PhaseHost; calls: { opened: number; closed: number; classified: number } } {
  const queue = [...steps];
  const calls = { opened: 0, closed: 0, classified: 0 };
  const host: PhaseHost = {
    retryable: opts.retryable ?? false,
    classifyFailure: () => {
      calls.classified += 1;
      return opts.errorClass ?? 'unknown';
    },
    async openSession(input): Promise<HostedSession> {
      calls.opened += 1;
      return {
        async driveTurn(): Promise<TurnOutcome> {
          const step = queue.shift();
          if (step === undefined) throw new Error('scriptedHost: ran out of scripted steps');
          return typeof step === 'function' ? step(input) : step;
        },
        async close(): Promise<void> {
          calls.closed += 1;
        },
      };
    },
  };
  return { host, calls };
}

const frameInput = (runId: string, cwd: string): DriverInput => ({ runId, cwd, phase: 'frame' });

const network = () => {
  throw new Error('fetch failed: ECONNRESET');
};

describe('A — entry marker replay', () => {
  test('a terminal marker for this phase is re-emitted without opening a session', async ({ projectDir, run }) => {
    run.terminalMarker = { phase: 'frame', kind: 'advance' };
    saveRunState(run);
    const { host, calls } = scriptedHost([]); // no steps — driveTurn must never be reached

    const event = await runHostedPhase(frameInput(run.runId, projectDir), host);

    expect.soft(event).toEqual({ type: 'phase.advance' });
    expect.soft(calls.opened).toBe(0); // the session was never opened — pure replay
  });

  test('a stale marker from a PRIOR phase is ignored — the loop runs normally', async ({ projectDir, run }) => {
    run.terminalMarker = { phase: 'spec', kind: 'flag' }; // not this phase
    saveRunState(run);
    const { host, calls } = scriptedHost(['advanced']);

    const event = await runHostedPhase(frameInput(run.runId, projectDir), host);

    expect.soft(event).toEqual({ type: 'phase.advance' });
    expect.soft(calls.opened).toBe(1); // not replayed — the session ran
  });
});

describe('B — the phase turn and the single nudge', () => {
  test('a phase turn that advances crosses as phase.advance, no nudge', async ({ projectDir, run }) => {
    const { host, calls } = scriptedHost(['advanced']);
    const event = await runHostedPhase(frameInput(run.runId, projectDir), host);
    expect.soft(event).toEqual({ type: 'phase.advance' });
    expect.soft(calls.closed).toBe(1); // the session is always closed
  });

  test('a phase turn that flags crosses as phase.flag', async ({ projectDir, run }) => {
    const { host } = scriptedHost(['flagged']);
    const event = await runHostedPhase(frameInput(run.runId, projectDir), host);
    expect(event).toEqual({ type: 'phase.flag' });
  });

  test('a silent phase turn gets exactly one nudge; advancing on the nudge crosses', async ({ projectDir, run }) => {
    const { host, calls } = scriptedHost(['continue', 'advanced']);
    const event = await runHostedPhase(frameInput(run.runId, projectDir), host);
    expect.soft(event).toEqual({ type: 'phase.advance' });
    expect.soft(calls.opened).toBe(1); // one session spans the phase turn AND the nudge
  });

  test('a self-flag (a pre-set pendingQuestion + a flagged outcome) is preserved, never clobbered', async ({ projectDir, run }) => {
    // Models the in-process abnormal-subtype / budget stop: the turn sets its own
    // question and reports flagged; the run loop must not overwrite it.
    const { host } = scriptedHost([
      (input) => {
        const s = loadRunState(input.cwd, input.runId);
        s.pendingQuestion = { question: 'budget cap', cause: 'budget' };
        saveRunState(s);
        return 'flagged';
      },
    ]);

    const event = await runHostedPhase(frameInput(run.runId, projectDir), host);

    expect.soft(event).toEqual({ type: 'phase.flag' });
    expect.soft(loadRunState(projectDir, run.runId).pendingQuestion?.cause).toBe('budget');
  });
});

describe('C — twice-ended flag', () => {
  test('two silent turns (phase + nudge) flag with the stuck-run question', async ({ projectDir, run }) => {
    const { host } = scriptedHost(['continue', 'continue']);
    const event = await runHostedPhase(frameInput(run.runId, projectDir), host);
    expect.soft(event).toEqual({ type: 'phase.flag' });
    const q = loadRunState(projectDir, run.runId).pendingQuestion;
    expect.soft(q?.question).toContain('the run is stuck');
    expect.soft(q?.cause).toBe('infra');
  });
});

describe('D — crash → flag, with the host-supplied classification', () => {
  test('a non-retryable host flags immediately, carrying classifyFailure’s errorClass', async ({ projectDir, run }) => {
    const { host, calls } = scriptedHost([network], { retryable: false, errorClass: 'network' });

    const event = await runHostedPhase(frameInput(run.runId, projectDir), host);

    expect.soft(event).toEqual({ type: 'phase.flag' });
    expect.soft(calls.opened).toBe(1); // never retried — one attempt
    expect.soft(calls.classified).toBe(1); // the host classified the failure
    const q = loadRunState(projectDir, run.runId).pendingQuestion;
    expect.soft(q?.question).toContain('failed at the infrastructure layer');
    expect.soft(q?.cause).toBe('infra');
    expect.soft(q?.errorClass).toBe('network');
  });

  test('first-terminal-wins: a marker persisted just before a throw is honored, never classified', async ({ projectDir, run }) => {
    run.retryInfra = 5; // retry ON — to prove the marker wins over both flag AND retry
    saveRunState(run);
    const { host, calls } = scriptedHost(
      [
        (input) => {
          const s = loadRunState(input.cwd, input.runId);
          s.terminalMarker = { phase: 'frame', kind: 'advance' };
          saveRunState(s);
          throw new Error('fetch failed: ECONNRESET'); // a late infra error after the decision
        },
      ],
      { retryable: true, errorClass: 'network' },
    );

    const event = await runHostedPhase(frameInput(run.runId, projectDir), host);

    expect.soft(event).toEqual({ type: 'phase.advance' }); // the decision, not a flag
    expect.soft(calls.classified).toBe(0); // the catch returned before classifying
    expect.soft(calls.opened).toBe(1); // not retried
    expect.soft(loadRunState(projectDir, run.runId).pendingQuestion).toBeUndefined();
  });
});

describe('D — opt-in retry (retryable host only)', () => {
  test('a recoverable failure then success completes with no flag, retryState reset', async ({ projectDir, run }) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    run.retryInfra = 2;
    saveRunState(run);
    const { host, calls } = scriptedHost([network, 'advanced'], { retryable: true, errorClass: 'network' });

    const p = runHostedPhase(frameInput(run.runId, projectDir), host);
    await vi.advanceTimersByTimeAsync(5_000); // let the backoff elapse → retry

    expect.soft(await p).toEqual({ type: 'phase.advance' });
    expect.soft(calls.opened).toBe(2); // one retry = a second session
    expect.soft(calls.closed).toBe(2); // both sessions closed (the first before continuing)
    expect.soft(loadRunState(projectDir, run.runId).retryState).toBeUndefined(); // concludeEpisode reset it
  });

  test('exhaustion flags after the cap', async ({ projectDir, run }) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    run.retryInfra = 1;
    saveRunState(run);
    const { host, calls } = scriptedHost([network, network], { retryable: true, errorClass: 'network' });

    const p = runHostedPhase(frameInput(run.runId, projectDir), host);
    await vi.advanceTimersByTimeAsync(60_000); // cascade through the retry

    expect.soft(await p).toEqual({ type: 'phase.flag' });
    expect.soft(calls.opened).toBe(2); // attempt + one retry, then exhausted
    expect.soft(loadRunState(projectDir, run.runId).pendingQuestion?.cause).toBe('infra');
  });
});

describe('the openSession contract', () => {
  test('an openSession that throws becomes crash = flag; no session is closed', async ({ projectDir, run }) => {
    let closed = 0;
    const host: PhaseHost = {
      retryable: false,
      classifyFailure: () => 'network',
      async openSession(): Promise<HostedSession> {
        // A host that fails to open (e.g. a transport connect failure) is
        // responsible for releasing its own resources before throwing — the run
        // loop only closes a session it received back.
        throw new Error('fetch failed: ECONNRESET');
      },
    };

    const event = await runHostedPhase(frameInput(run.runId, projectDir), host);

    expect.soft(event).toEqual({ type: 'phase.flag' });
    expect.soft(closed).toBe(0); // nothing to close — the runner never received a session
    expect.soft(loadRunState(projectDir, run.runId).pendingQuestion?.errorClass).toBe('network');
  });
});

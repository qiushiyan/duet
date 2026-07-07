import { describe, expect, test, vi } from 'vitest';
import { ContextDeadlineExceededError, WALL_CLOCK_DRAIN_GRACE_MS, WALL_CLOCK_TICK_MS, WallClockExceededError, runWithContextDeadline, runWithWallClockDeadline } from '../src/voices/providers/wall-clock.ts';
import { ClaudeWorker } from '../src/voices/providers/claude.ts';
import { CodexWorker } from '../src/voices/providers/codex.ts';

// execa is the provider's true external boundary (mock allowed there) — mocked
// so the S3 claude wiring test can hand runTurn a hanging subprocess and drive
// its wall-clock wrap with fake timers.
const mockExeca = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: mockExeca }));

// The codex SDK is the codex provider's true external boundary — mocked so the
// S3 integration test can hand runTurn a hanging stream and drive its wall-clock
// wrap with fake timers (there is no other CodexWorker test, so the whole-file
// mock is inert elsewhere; the pure codex helpers don't touch the client).
const codexRunStreamed = vi.hoisted(() => vi.fn());
const codexConstructedOptions = vi.hoisted((): unknown[] => []);
const codexStartThreadOptions = vi.hoisted(() => vi.fn());
const codexResumeThreadOptions = vi.hoisted(() => vi.fn());
vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    constructor(options?: unknown) {
      codexConstructedOptions.push(options);
    }
    startThread(options?: unknown) {
      codexStartThreadOptions(options);
      return { id: 'codex-thread', runStreamed: codexRunStreamed };
    }
    resumeThread(id: string, options?: unknown) {
      codexResumeThreadOptions(id, options);
      return { id: 'codex-thread', runStreamed: codexRunStreamed };
    }
  },
}));

/**
 * A deterministic clock + scheduler: `now` is a mutable value the test advances
 * (a machine-sleep makes it JUMP), and `schedule` captures each callback so the
 * test fires it by hand — no real timers, so the suspend-on-wake model is
 * exercised exactly. Two timers exist across a deadline hit: the recurring
 * deadline re-check (scheduled first — `fireTick`) and the drain grace timer
 * scheduled after the abort (`fireGrace` = the most recent). `cancelled` reports
 * whether the deadline re-check was cleared (the happy-path assertion).
 */
function fakeClock(start = 1_000_000) {
  let nowValue = start;
  const scheduled: Array<() => void> = [];
  let cancelled = false;
  return {
    now: (): number => nowValue,
    advance: (ms: number): void => {
      nowValue += ms;
    },
    fireTick: (): void => scheduled[0]?.(),
    fireGrace: (): void => scheduled[scheduled.length - 1]?.(),
    get cancelled(): boolean {
      return cancelled;
    },
    schedule: (cb: () => void): (() => void) => {
      scheduled.push(cb);
      return () => {
        cancelled = true;
      };
    },
  };
}

/**
 * Both deadlines are veneers over ONE race/drain core (`raceCut` in
 * wall-clock.ts), so the shared behaviors — settle-before-the-deadline
 * passthrough, abort-exactly-once on the cut, the drain-before-reject
 * discipline, the bounded grace — are pinned once, parameterized over how each
 * guard is armed and tripped. Each guard's unique edges (the wall-clock
 * post-wake catch, the context sampler's silence rule, the typed error shapes)
 * keep their own tests below.
 */
interface ArmedGuard {
  /** The guarded turn promise. */
  promise: Promise<string>;
  /** Fire a re-check tick while still healthy — must not cut. */
  nearMiss: () => void;
  /** Cross the deadline, then fire the re-check tick — must cut. */
  trip: () => void;
}

const guards = [
  {
    name: 'runWithWallClockDeadline (S3 — the wall-clock backstop)',
    errorClass: WallClockExceededError,
    arm: (clock: ReturnType<typeof fakeClock>, run: Promise<string>, abort: () => void): ArmedGuard => ({
      promise: runWithWallClockDeadline({ run, abort, capMs: 90 * 60_000, now: clock.now, schedule: clock.schedule }),
      nearMiss: () => {
        clock.advance(60 * 60_000); // most of the cap elapsed, still under it
        clock.fireTick();
      },
      trip: () => {
        clock.advance(91 * 60_000); // now past the 90-min cap in wall-clock terms
        clock.fireTick();
      },
    }),
  },
  {
    name: 'runWithContextDeadline (the window-fill sibling)',
    errorClass: ContextDeadlineExceededError,
    arm: (clock: ReturnType<typeof fakeClock>, run: Promise<string>, abort: () => void): ArmedGuard => {
      let fill = 400_000; // healthy — well under the limit
      return {
        promise: runWithContextDeadline({ run, abort, sample: () => fill, limitTokens: 850_000, schedule: clock.schedule }),
        nearMiss: () => clock.fireTick(), // a tick below the limit
        trip: () => {
          fill = 870_000; // the fill crossed the emergency line
          clock.fireTick();
        },
      };
    },
  },
];

describe.for(guards)('$name — the shared race/drain skeleton', ({ errorClass, arm }) => {
  test('a run that settles before the deadline yields its value; abort never called, timer cleared', async () => {
    const clock = fakeClock();
    const abort = vi.fn();
    const { promise } = arm(clock, Promise.resolve('done'), abort);
    await expect(promise).resolves.toBe('done');
    expect.soft(abort).not.toHaveBeenCalled();
    expect.soft(clock.cancelled).toBe(true); // the deadline timer was cleared
  });

  test('a run that rejects before the deadline propagates its error; abort never called', async () => {
    const clock = fakeClock();
    const abort = vi.fn();
    const boom = new Error('boom');
    const { promise } = arm(clock, Promise.reject(boom), abort);
    await expect(promise).rejects.toBe(boom);
    expect.soft(abort).not.toHaveBeenCalled();
    expect.soft(clock.cancelled).toBe(true);
  });

  test('a tripped deadline aborts exactly once and rejects typed; a healthy tick never cuts', async () => {
    const clock = fakeClock();
    const abort = vi.fn();
    // never resolves on its own — the deadline is the only way out
    const { promise, nearMiss, trip } = arm(clock, new Promise<string>(() => {}), abort);
    const assertion = expect(promise).rejects.toBeInstanceOf(errorClass);
    // A tick while still healthy does nothing.
    nearMiss();
    expect.soft(abort).not.toHaveBeenCalled();
    // The trip aborts and begins the drain; a further tick must not re-abort.
    trip();
    clock.fireTick();
    clock.fireGrace(); // the run never settles — the grace cap completes the drain
    await assertion;
    expect.soft(abort).toHaveBeenCalledTimes(1);
  });

  test('the deadline DRAINS before rejecting: no resumable checkpoint is exposed until the killed run settles', async () => {
    // The race Codex flagged: the deadline rejection becomes a "resume this
    // session" checkpoint (S5), so exposing it while the aborted process/stream
    // is still tearing down could let a fast resume race a dying writer. The
    // deadline must abort, WAIT for `run` to settle, and only THEN reject.
    const clock = fakeClock();
    const abort = vi.fn();
    let killRun: () => void = () => {};
    const run = new Promise<string>((resolve) => {
      killRun = () => resolve('the child finally exited');
    });
    const { promise, trip } = arm(clock, run, abort);
    let rejected = false;
    void promise.catch(() => {
      rejected = true;
    });
    // Deadline wins: abort fires at once, but the checkpoint is WITHHELD.
    trip();
    expect.soft(abort).toHaveBeenCalledTimes(1);
    await Promise.resolve(); // flush microtasks — still draining, still pending
    expect.soft(rejected).toBe(false);
    // The killed run settles (the child exited) → NOW it rejects, and with the
    // typed error, never the run's own (untrustworthy) late value.
    killRun();
    await expect(promise).rejects.toBeInstanceOf(errorClass);
  });

  test('the drain is BOUNDED: an unkillable run rejects at the grace cap, never hangs the driver', async () => {
    // If abort can't actually stop the turn, the deadline must still reject — the
    // grace cap is what keeps a wedged, unkillable turn from hanging the driver.
    const clock = fakeClock();
    const abort = vi.fn();
    const { promise, trip } = arm(clock, new Promise<string>(() => {}), abort); // never settles, even after abort
    const assertion = expect(promise).rejects.toBeInstanceOf(errorClass);
    trip(); // deadline wins → abort + drain begins
    clock.fireGrace(); // run never settled → the grace cap rejects anyway
    await assertion;
    expect.soft(abort).toHaveBeenCalledTimes(1);
  });
});

describe('runWithWallClockDeadline — the wall-clock-only edges', () => {
  test('a suspend-sized jump past the deadline aborts on the first post-wake tick', async () => {
    const clock = fakeClock();
    const abort = vi.fn();
    const promise = runWithWallClockDeadline({
      run: new Promise<string>(() => {}),
      abort,
      capMs: 90 * 60_000,
      now: clock.now,
      schedule: clock.schedule,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(WallClockExceededError);
    // The machine sleeps for hours while a monotonic timer would be frozen; on
    // wake `now()` has jumped far past the deadline. ONE post-wake tick catches it.
    clock.advance(8 * 60 * 60_000); // an 8-hour overnight sleep
    clock.fireTick();
    clock.fireGrace(); // the never-resolving run drains to its grace cap
    await assertion;
    expect.soft(abort).toHaveBeenCalledTimes(1);
  });

  test('an abort that itself throws still rejects once with the typed error', async () => {
    const clock = fakeClock();
    const abort = vi.fn(() => {
      throw new Error('the kill itself failed');
    });
    const promise = runWithWallClockDeadline({
      run: new Promise<string>(() => {}),
      abort,
      capMs: 90 * 60_000,
      now: clock.now,
      schedule: clock.schedule,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(WallClockExceededError);
    clock.advance(91 * 60_000);
    clock.fireTick();
    clock.fireTick(); // a second tick must not re-abort or double-settle
    clock.fireGrace(); // the run never settles — the grace cap completes the drain
    await assertion;
    expect.soft(abort).toHaveBeenCalledTimes(1);
  });

  test('WallClockExceededError is identifiable by kind and names the cap value', () => {
    const err = new WallClockExceededError(90 * 60_000);
    expect.soft(err).toBeInstanceOf(Error);
    expect.soft(err.kind).toBe('wall-clock');
    expect.soft(err.message).toMatch(/90/); // the cap VALUE — the phrasing is not pinned
  });
});

describe('runWithContextDeadline — the sampler-only edges', () => {
  test('an undefined sample (telemetry silence) never cuts a healthy turn', async () => {
    const clock = fakeClock();
    const abort = vi.fn();
    let finish!: (v: string) => void;
    const promise = runWithContextDeadline({
      run: new Promise<string>((r) => (finish = r)),
      abort,
      sample: () => undefined,
      limitTokens: 850_000,
      schedule: clock.schedule,
    });
    clock.fireTick();
    clock.fireTick();
    expect.soft(abort).not.toHaveBeenCalled();
    finish('done');
    await expect(promise).resolves.toBe('done');
  });

  test('the error is identifiable by kind and names the fill value', () => {
    // The message's classification as context-overflow (the compaction
    // prescription) is pinned behaviorally through classifyError in
    // claude-provider.test.ts's never-accepted context-cut test — not by
    // phrasing here.
    const err = new ContextDeadlineExceededError(870_000, 850_000);
    expect.soft(err.kind).toBe('context-deadline');
    expect.soft(err.message).toContain('870000'); // the fill VALUE — the phrasing is not pinned
  });
});

describe('the wall-clock backstop is wired into runTurn (S3 — the load-bearing regression guard)', () => {
  // Two reviewers flagged that runWithWallClockDeadline is thoroughly unit-tested
  // but NOTHING proved runTurn actually routes through it at the effective cap —
  // so deleting the wrap or passing a wrong capMs would leave the suite green
  // while silently reintroducing the 7447 machine-sleep regression this branch
  // exists to prevent. These pin the wiring per provider: the turn is aborted at
  // the cap, and NOT one tick before it (which also pins that capMs is the
  // effective per-turn cap, not a shorter default). Real execa/stream are the
  // mocked boundary; fake timers drive Date.now + the deadline's re-check ticks.
  const cap = 90 * 60_000;

  test('claude: runTurn kills the execa child at the effective cap, not before', async () => {
    vi.useFakeTimers();
    try {
      const kill = vi.fn();
      const hanging = Object.assign(new Promise<never>(() => {}), { kill }); // a subprocess that never settles
      mockExeca.mockReturnValueOnce(hanging);
      const promise = new ClaudeWorker({ model: 'claude-opus-4-8' }).runTurn({ prompt: 'build it', cwd: '/x', timeoutMs: cap });
      const rejects = expect(promise).rejects.toThrow(); // no accepted transcript ⇒ recovers to an infra error
      await vi.advanceTimersByTimeAsync(cap - WALL_CLOCK_TICK_MS);
      expect.soft(kill).not.toHaveBeenCalled(); // the cap is honored — not a shorter default
      await vi.advanceTimersByTimeAsync(2 * WALL_CLOCK_TICK_MS);
      expect.soft(kill).toHaveBeenCalledTimes(1); // the wrap fired at the cap, exactly once
      await vi.advanceTimersByTimeAsync(WALL_CLOCK_DRAIN_GRACE_MS); // let the bounded drain settle the turn
      await rejects;
    } finally {
      vi.useRealTimers();
    }
  });

  test('codex: runTurn aborts the runStreamed signal at the effective cap, not before', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      codexRunStreamed.mockImplementation((_prompt: string, opts: { signal: AbortSignal }) => {
        signal = opts.signal;
        return new Promise(() => {}); // hang — never emits thread.started, never resolves
      });
      const promise = new CodexWorker({ timeoutMs: cap }).runTurn({ prompt: 'build it', cwd: '/x' });
      const rejects = expect(promise).rejects.toBeInstanceOf(WallClockExceededError); // never accepted ⇒ re-thrown
      await vi.advanceTimersByTimeAsync(cap - WALL_CLOCK_TICK_MS);
      expect.soft(signal?.aborted).toBe(false); // the deadline has not fired before the cap
      await vi.advanceTimersByTimeAsync(2 * WALL_CLOCK_TICK_MS);
      expect.soft(signal?.aborted).toBe(true); // the wall-clock deadline aborted the stream at the cap
      await vi.advanceTimersByTimeAsync(WALL_CLOCK_DRAIN_GRACE_MS); // let the bounded drain settle the turn
      await rejects;
    } finally {
      vi.useRealTimers();
    }
  });
});

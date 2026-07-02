import { describe, expect, test, vi } from 'vitest';
import { ContextDeadlineExceededError, WALL_CLOCK_TICK_MS, WallClockExceededError, runWithContextDeadline, runWithWallClockDeadline } from '../src/providers/wall-clock.ts';
import { FakeWorker } from './helpers/fixtures.ts';

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

describe('runWithWallClockDeadline (S3 — the wall-clock backstop)', () => {
  test('a run that resolves before the deadline yields its value; abort never called, timer cleared', async () => {
    const clock = fakeClock();
    const abort = vi.fn();
    const result = await runWithWallClockDeadline({
      run: Promise.resolve('done'),
      abort,
      capMs: 90 * 60_000,
      now: clock.now,
      schedule: clock.schedule,
    });
    expect.soft(result).toBe('done');
    expect.soft(abort).not.toHaveBeenCalled();
    expect.soft(clock.cancelled).toBe(true); // the deadline timer was cleared
  });

  test('a run that rejects before the deadline propagates its error; abort never called', async () => {
    const clock = fakeClock();
    const abort = vi.fn();
    const boom = new Error('boom');
    await expect(
      runWithWallClockDeadline({
        run: Promise.reject(boom),
        abort,
        capMs: 90 * 60_000,
        now: clock.now,
        schedule: clock.schedule,
      }),
    ).rejects.toBe(boom);
    expect.soft(abort).not.toHaveBeenCalled();
    expect.soft(clock.cancelled).toBe(true);
  });

  test('a never-resolving run past the deadline aborts exactly once and throws WallClockExceededError', async () => {
    const clock = fakeClock();
    const abort = vi.fn();
    const promise = runWithWallClockDeadline({
      run: new Promise<string>(() => {}), // never resolves on its own
      abort,
      capMs: 90 * 60_000,
      now: clock.now,
      schedule: clock.schedule,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(WallClockExceededError);
    // A tick BEFORE the deadline does nothing.
    clock.advance(60 * 60_000);
    clock.fireTick();
    expect.soft(abort).not.toHaveBeenCalled();
    // A tick PAST the deadline aborts and begins the drain; a further tick must
    // not re-abort. The run never settles, so the grace timer completes the drain.
    clock.advance(31 * 60_000); // 91 min elapsed > 90-min cap
    clock.fireTick();
    clock.fireTick();
    clock.fireGrace();
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
    const promise = runWithWallClockDeadline({ run, abort, capMs: 90 * 60_000, now: clock.now, schedule: clock.schedule });
    let rejected = false;
    void promise.catch(() => {
      rejected = true;
    });
    // Deadline wins: abort fires at once, but the checkpoint is WITHHELD.
    clock.advance(91 * 60_000);
    clock.fireTick();
    expect.soft(abort).toHaveBeenCalledTimes(1);
    await Promise.resolve(); // flush microtasks — still draining, still pending
    expect.soft(rejected).toBe(false);
    // The killed run settles (the child exited) → NOW it rejects, and with the
    // typed error, never the run's own (untrustworthy) late value.
    killRun();
    await expect(promise).rejects.toBeInstanceOf(WallClockExceededError);
  });

  test('the drain is BOUNDED: an unkillable run rejects at the grace cap, never hangs the driver', async () => {
    // If abort can't actually stop the turn, the deadline must still reject — the
    // grace cap is what keeps a wedged, unkillable turn from hanging the driver.
    const clock = fakeClock();
    const abort = vi.fn();
    const promise = runWithWallClockDeadline({
      run: new Promise<string>(() => {}), // never settles, even after abort
      abort,
      capMs: 90 * 60_000,
      now: clock.now,
      schedule: clock.schedule,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(WallClockExceededError);
    clock.advance(91 * 60_000);
    clock.fireTick(); // deadline wins → abort + drain begins
    clock.fireGrace(); // run never settled → the grace cap rejects anyway
    await assertion;
    expect.soft(abort).toHaveBeenCalledTimes(1);
  });

  test('WallClockExceededError names the cap in minutes and is identifiable by kind', () => {
    const err = new WallClockExceededError(90 * 60_000);
    expect.soft(err).toBeInstanceOf(Error);
    expect.soft(err.kind).toBe('wall-clock');
    expect.soft(err.message).toContain('90-minute');
  });

  test('the default re-check cadence is exported', () => {
    expect(WALL_CLOCK_TICK_MS).toBe(30_000);
  });

  // The S5 seam: a FakeWorker scripts a WallClockExceededError to model a turn
  // aborted at its wall-clock cap, so S5's higher-level recovery tests can drive
  // the abort outcome through the WorkerProvider interface. No fixture change —
  // FakeWorker already relays a scripted Error as a rejection.
  test('a FakeWorker can model an overrun by scripting a WallClockExceededError', async () => {
    const worker = new FakeWorker('claude', [new WallClockExceededError(90 * 60_000)]);
    await expect(worker.runTurn({ prompt: 'build it' })).rejects.toBeInstanceOf(WallClockExceededError);
  });
});
describe('runWithContextDeadline (the window-fill sibling of the wall-clock backstop)', () => {
  test('a run that resolves before the fill reaches the limit yields its value; abort never called', async () => {
    const clock = fakeClock();
    const abort = vi.fn();
    const result = await runWithContextDeadline({
      run: Promise.resolve('done'),
      abort,
      sample: () => 500_000,
      limitTokens: 850_000,
      schedule: clock.schedule,
    });
    expect.soft(result).toBe('done');
    expect.soft(abort).not.toHaveBeenCalled();
    expect.soft(clock.cancelled).toBe(true);
  });

  test('a sample at/over the limit cuts the turn: abort once, DRAIN, then the typed rejection', async () => {
    const clock = fakeClock();
    let killed: (() => void) | undefined;
    const run = new Promise<string>((_, reject) => {
      killed = () => reject(new Error('killed'));
    });
    const abort = vi.fn(() => killed?.());
    let fill = 400_000;
    const promise = runWithContextDeadline({
      run,
      abort,
      sample: () => fill,
      limitTokens: 850_000,
      schedule: clock.schedule,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(ContextDeadlineExceededError);
    clock.fireTick(); // below the limit — no cut
    expect.soft(abort).not.toHaveBeenCalled();
    fill = 870_000;
    clock.fireTick(); // the fill crossed the emergency line
    await assertion; // rejects only after the killed run settled (the drain)
    expect.soft(abort).toHaveBeenCalledTimes(1);
  });

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

  test('an unkillable run still rejects at the drain grace, exactly once', async () => {
    const clock = fakeClock();
    const abort = vi.fn();
    const promise = runWithContextDeadline({
      run: new Promise<string>(() => {}),
      abort,
      sample: () => 900_000,
      limitTokens: 850_000,
      schedule: clock.schedule,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(ContextDeadlineExceededError);
    clock.fireTick(); // cut → abort + drain begins
    clock.fireGrace(); // the run never settles → the grace cap rejects anyway
    await assertion;
    expect.soft(abort).toHaveBeenCalledTimes(1);
  });

  test('the error names the fill and classifies as context-overflow territory ("context-window cap")', () => {
    const err = new ContextDeadlineExceededError(870_000, 850_000);
    expect.soft(err.kind).toBe('context-deadline');
    expect.soft(err.message).toContain('context-window cap');
    expect.soft(err.message).toContain('870000');
  });
});

import { describe, expect, test, vi } from 'vitest';
import { WALL_CLOCK_TICK_MS, WallClockExceededError, runWithWallClockDeadline } from '../src/providers/wall-clock.ts';
import { FakeWorker } from './helpers/fixtures.ts';

/**
 * A deterministic clock + scheduler: `now` is a mutable value the test advances
 * (a machine-sleep makes it JUMP), and `schedule` captures the tick callback so
 * the test fires it by hand — no real timers, so the suspend-on-wake model is
 * exercised exactly.
 */
function fakeClock(start = 1_000_000) {
  let nowValue = start;
  let tick: (() => void) | undefined;
  let cancelled = false;
  return {
    now: (): number => nowValue,
    advance: (ms: number): void => {
      nowValue += ms;
    },
    fireTick: (): void => tick?.(),
    get cancelled(): boolean {
      return cancelled;
    },
    schedule: (cb: () => void): (() => void) => {
      tick = cb;
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
    // A tick PAST the deadline aborts and rejects; a further tick must not re-abort.
    clock.advance(31 * 60_000); // 91 min elapsed > 90-min cap
    clock.fireTick();
    clock.fireTick();
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

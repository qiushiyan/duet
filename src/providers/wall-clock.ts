/**
 * The wall-clock backstop for a worker turn — the load-bearing half of the
 * resilience work no CLI flag can cover.
 *
 * execa's `timeout` and `AbortSignal.timeout` are MONOTONIC: an overnight
 * machine-sleep freezes their countdown with the process, so on wake a
 * "90-minute" cap can map to many real hours (the audited 7447 dead-run, where a
 * 60-min cap rode 117 min of wall-clock). This helper bounds a turn in REAL
 * (Date) time instead: it re-checks an injected `now()` against a fixed deadline
 * on a timer tick, so when a suspend ends the very next tick sees the elapsed
 * wall-clock and aborts promptly — where a monotonic timer would have counted
 * only awake time.
 *
 * It races the in-flight turn promise against that deadline. The turn settling
 * first wins (its value or its error), with the timer cleared and `abort` never
 * called; the deadline winning calls `abort` exactly once (the execa child-kill,
 * or the owned AbortController), then DRAINS — waits for the killed `run` to
 * actually settle, bounded by a short grace — before rejecting with a typed
 * WallClockExceededError. The drain matters because that rejection becomes a
 * *resumable* checkpoint (S5): exposing it while the killed process/stream is
 * still tearing down would let a fast resume race a dying writer on the same
 * session. The grace cap keeps an unkillable turn from hanging the driver.
 *
 * `now`/`schedule` are injected (defaults: Date.now + setInterval) so a test
 * drives `now` past the deadline and fires the captured tick deterministically,
 * with no real timers.
 */

/**
 * A worker turn was aborted by its wall-clock deadline — a SETTLED, resumable
 * checkpoint, not a generic infra failure. Honest recovery (resume vs. resend)
 * keys on this type, parallel to BudgetCutoffError; the message names the cap.
 */
export class WallClockExceededError extends Error {
  readonly kind = 'wall-clock' as const;
  constructor(capMs: number) {
    super(`the worker turn exceeded its ${Math.round(capMs / 60_000)}-minute wall-clock cap and was aborted`);
    this.name = 'WallClockExceededError';
  }
}

/** How often the deadline is re-checked against wall-clock `now()` (overridable for tests). */
export const WALL_CLOCK_TICK_MS = 30_000;

/**
 * How long the deadline waits for the aborted `run` to actually settle before it
 * rejects anyway. Comfortably above execa's SIGTERM→SIGKILL escalation (~5 s
 * default), so the killed child's own exit normally wins the race; the cap only
 * bites if a turn is genuinely unkillable, where returning late still beats
 * hanging the driver forever (the bounded-waste-then-recover philosophy).
 */
export const WALL_CLOCK_DRAIN_GRACE_MS = 10_000;

export interface WallClockDeadlineArgs<T> {
  /** The in-flight turn promise raced against the deadline. */
  run: Promise<T>;
  /**
   * Kill the turn's underlying process / stream — the execa child-kill, or the
   * owned AbortController's abort. Called at most once, only when the deadline wins.
   */
  abort: () => void;
  /** The effective per-turn cap, in ms (the same value the monotonic timer uses). */
  capMs: number;
  /** Wall-clock source; default Date.now. A suspend makes this JUMP on wake — the whole point. */
  now?: () => number;
  /** Schedules a recurring deadline re-check, returning a canceller. Default: setInterval. */
  schedule?: (cb: () => void, ms: number) => () => void;
  /** Re-check cadence; default WALL_CLOCK_TICK_MS. */
  tickMs?: number;
  /**
   * Max wait for the aborted `run` to settle before the deadline rejects anyway.
   * Default WALL_CLOCK_DRAIN_GRACE_MS. The drain never exposes the checkpoint
   * while the killed process/stream may still be writing the session.
   */
  graceMs?: number;
}

export function runWithWallClockDeadline<T>(args: WallClockDeadlineArgs<T>): Promise<T> {
  const now = args.now ?? Date.now;
  const schedule =
    args.schedule ??
    ((cb, ms) => {
      const id = setInterval(cb, ms);
      return () => clearInterval(id);
    });
  const tickMs = args.tickMs ?? WALL_CLOCK_TICK_MS;
  const graceMs = args.graceMs ?? WALL_CLOCK_DRAIN_GRACE_MS;
  const deadline = now() + args.capMs;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let cancel: () => void = () => {};
    // First to settle wins: clears the timer once, then runs its conclusion. A
    // later settlement (e.g. the run rejecting after the deadline killed it) is a
    // guarded no-op — and is still HANDLED, so it never surfaces as unhandled.
    const finish = (conclude: () => void): void => {
      if (settled) return;
      settled = true;
      cancel();
      conclude();
    };
    cancel = schedule(() => {
      // Re-check the deadline against REAL time each tick. After a suspend the
      // timer fires late but `now()` has jumped, so this catches the overrun on
      // the first post-wake tick.
      if (!settled && now() >= deadline) {
        finish(() => {
          // An abort that itself throws must neither prevent the typed rejection
          // (S5 classifies on it) nor escape this timer callback as an uncaught
          // exception (try/finally would re-throw it after the reject). Swallow
          // it — the kill is best-effort; the WallClockExceededError is what the
          // caller is owed, exactly once.
          try {
            args.abort();
          } catch {
            // best-effort kill — the deadline still rejects with the typed error.
          }
          // DRAIN, then reject. The rejection is a *resumable* checkpoint (S5),
          // so don't expose it until the killed `run` has actually settled — else
          // a fast resume could race the dying process/stream writing the same
          // session. Whichever comes first — `run` settling (the child exited) or
          // the grace cap (an unkillable turn) — reaps exactly once with the typed
          // error. `run`'s outcome is discarded: the deadline already won.
          let drained = false;
          let cancelGrace: () => void = () => {};
          const reap = (): void => {
            if (drained) return;
            drained = true;
            cancelGrace();
            reject(new WallClockExceededError(args.capMs));
          };
          cancelGrace = schedule(reap, graceMs);
          args.run.then(reap, reap);
        });
      }
    }, tickMs);
    args.run.then(
      (value) => finish(() => resolve(value)),
      (err) => finish(() => reject(err)),
    );
  });
}

import { formatAge } from './worker-health.ts';

/**
 * View-time timestamp helpers. Stored logs and `status --json` keep raw UTC ISO
 * — they are the inspectable-without-duet / machine-consumed artifacts — so a
 * raw `…Z` is never a bug to a reader. Only HUMAN-TEXT renders localize: the
 * status lists, the doctor rows, and the tmux/`duet logs` voice lines. These are
 * pure string transforms that read the local clock at call time (fine at view
 * time, never persisted). Each passes a malformed timestamp through unchanged so
 * a half-written log line never throws into a viewer.
 */

const pad = (n: number): string => String(n).padStart(2, '0');

/** A stored UTC ISO timestamp → a local wall-clock `YYYY-MM-DD HH:MM` — the
 *  same shape the status lists used, now in the human's own zone. Date matters
 *  in those lists (a steer staged yesterday), so the date stays. */
export function localStamp(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A stored UTC ISO timestamp → a local time-of-day `HH:MM:SS` — for the dense,
 *  fast-streaming voice log, where the date is "today" noise and time-of-day is
 *  the signal a watcher wants (the full stamp stays in the file). */
export function localClock(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** A stored UTC ISO timestamp → a compact relative age (`3m ago`), reusing
 *  formatAge so the activity line and the heartbeat's `last activity Nm ago`
 *  read alike. `now` is injectable for tests; in the colorizer it defaults to
 *  the clock at stream time — accurate when the line lands, frozen after. */
export function relativeAge(iso: string, now: number = Date.now()): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return `${formatAge(now - ms)} ago`;
}

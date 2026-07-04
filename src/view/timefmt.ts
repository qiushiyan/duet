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

/** A duration in ms → a coarse `Hh Mm` / `Mm` / `<1m` label, for `duet stats`.
 *  h/m granularity is the right altitude for phase-level effort (seconds are
 *  noise across a multi-hour run). A negative or non-finite input renders `—`
 *  rather than throwing, so a half-parsed log can't crash the view. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return '<1m';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

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

/** A stored UTC ISO timestamp → a short local `HH:MM` — the trailing stamp on
 *  the promoted `⋯` activity line, naming when the action was logged in the
 *  human's zone. A relative age can't serve there: the colorizer renders a line
 *  once as it streams, so an age would read ~0 at that instant and freeze, while
 *  a wall-clock time stays meaningful frozen. */
export function localTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Worker health — the pure substrate behind `duet doctor` (#1), the enriched
 * heartbeat (#2), and infra crash classification (#4a). Given a transcript's
 * JSONL text and an injected `now`, it answers two questions honestly:
 *
 *   1. classifyError / scanTerminalErrors — what TERMINAL API errors does this
 *      transcript carry, and what class is each? (Ported from
 *      `.duet/proto/errscan.py`.)
 *   2. probeRole — is this role idle / working / long-inference / retrying /
 *      silent-stuck / crashed right now? (Ported from `.duet/proto/doctor.py`.)
 *
 * It is PURE BY DESIGN — string in, value out, no fs, no clock, no imports of
 * `lifecycle`/`status`. That purity is load-bearing: `lifecycle.ts`
 * value-imports `status.ts`, so a value-import chain status → worker-health →
 * lifecycle would close a runtime cycle. The fs locating/tail-reading lives in
 * `sessions.ts`; the composition (driver liveness + phase) lives in
 * `doctor.ts`. This module only parses.
 *
 * Two honesty guarantees survive the port (they are WHY the projection is
 * trustworthy, not incidental):
 *   - Error-bearing records only — never a free-text grep — so discussion
 *     *about* a 403 in a transcript is never counted as a 403.
 *   - Classify on the TERMINAL event, not `api_retry` (which carries no usable
 *     status); raw 429/529 the SDK recovered from are not failures.
 */

export type Schema = 'claude' | 'codex';

/**
 * Error classes in FIRST-MATCH-WINS order (context-overflow and login/quota
 * before bare-auth before transient) — the order is the classifier, so it must
 * not be reordered. `context-overflow` is the one DETERMINISTIC class: the
 * session's conversation no longer fits its context window, so an identical
 * retry can never succeed — recovery is compaction (or a session reset), never
 * a resend, and it is never auto-retried.
 */
export type ErrorClass =
  | 'context-overflow'
  | 'login-required'
  | 'quota-billing'
  | 'auth'
  | 'rate-limit'
  | 'network'
  | 'dns'
  | 'server'
  | 'unknown';

/** A role's live verdict, highest-precedence first (see `computeVerdict`). */
export type Verdict = 'crashed' | 'retrying' | 'working' | 'long-inference' | 'silent/stuck' | 'idle';

// Verdict thresholds (ms), compared against an injected `now` — never Date.now()
// inside these pure functions. Tunable constants, not a product call.
export const WORKING_MAX_QUIET_MS = 60_000; // < 1m quiet ⇒ working
export const LONG_INFERENCE_MAX_QUIET_MS = 1_800_000; // < 30m quiet ⇒ long-inference; beyond ⇒ silent/stuck
export const RECENT_ERROR_MS = 180_000; // a terminal error newer than this ⇒ crashed
export const RETRY_WINDOW_MS = 120_000; // the orchestrator's approximate in-flight/recency window (doctor.ts)

const TAXONOMY: ReadonlyArray<{ cls: ErrorClass; patterns: RegExp[] }> = [
  {
    // The Anthropic API's over-window rejection, as the CLI relays it ("Prompt is
    // too long", sometimes with a `N tokens > M maximum` tail), plus duet's own
    // context-deadline cut (ContextDeadlineExceededError's "context-window cap"
    // phrasing). Matched first: unambiguous, and misreading it as transient infra
    // sent an orchestrator into two futile retries and a 10-hour park (the
    // 20260701 wedge).
    cls: 'context-overflow',
    patterns: [/prompt is too long/i, /context-window cap/i],
  },
  {
    cls: 'login-required',
    patterns: [/Please run \/login/, /Invalid API key/, /OAuth token (?:has )?expired/, /\btoken expired\b/],
  },
  { cls: 'quota-billing', patterns: [/credit balance is too low/, /insufficient_quota/, /usage limit[s]?\b[^\n]*reach/] },
  { cls: 'auth', patterns: [/403 Request not allowed/, /Failed to authenticate/, /authentication_error/, /\bUnauthorized\b/] },
  { cls: 'rate-limit', patterns: [/\b429\b/, /\b529\b/, /Overloaded/, /overloaded_error/, /temporarily limiting requests/] },
  {
    cls: 'network',
    patterns: [
      /ConnectionRefused/,
      /ECONNRESET/,
      /ECONNREFUSED/,
      /socket connection was closed/,
      /Connection closed mid-response/,
      /fetch failed/,
      /FailedToOpenSocket/,
      /ETIMEDOUT/,
      /Connection error/,
    ],
  },
  { cls: 'dns', patterns: [/ENOTFOUND/] },
  { cls: 'server', patterns: [/Internal server error/, /\b500 Internal\b/] },
];

/** codex flags a function_call_output / event only on an UNAMBIGUOUS failure signature. */
const CODEX_HARD =
  /(ENOTFOUND|ECONNREFUSED|ECONNRESET|API Error|Failed to authenticate|403 Request not allowed|Please run \/login|fetch failed|Internal server error)/;

/** A compact human age for a millisecond duration (mirrors `doctor.py:age`):
 *  `<90s` → `Ns`, `<90m` → `Nm`, else `NhMm`. Pure — for the heartbeat + doctor. */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

/** Classify an error string by the taxonomy; unmatched text is `unknown`. */
export function classifyError(text: string): ErrorClass {
  for (const { cls, patterns } of TAXONOMY) {
    for (const p of patterns) if (p.test(text)) return cls;
  }
  return 'unknown';
}

/** The persisted, per-episode retry budget state (#4b) — survives a driver re-spawn. */
export interface RetryState {
  attempts: number;
  lastClass?: ErrorClass;
}

export type RetryDecision =
  | { action: 'retry'; delayMs: number; nextRetryState: RetryState }
  | { action: 'flag'; errorClass: ErrorClass };

/** Exponential backoff with a 30s cap. */
function backoffMs(attempt: number): number {
  return Math.min(30_000, 2_000 * 2 ** attempt);
}

/**
 * The ONE retry policy (#4b) — the single mechanism the driver consults, so the
 * default-off / auth-once / never-retry / exhaustion-to-flag rules live in one
 * place, not scattered conditionals. `retryInfra` is the attempt budget (0 or
 * absent ⇒ off). Returns either a retry (with backoff and the next RetryState to
 * persist) or a flag (with the class to surface).
 *
 *  - default-off / exhausted ⇒ flag.
 *  - network / server / rate-limit ⇒ retry (always-recoverable transient set).
 *  - auth ⇒ retry exactly ONCE: a first auth retries; a second CONSECUTIVE auth
 *    is persistent ⇒ flag as `login-required`, never retried even with budget.
 *  - context-overflow / login-required / quota-billing / dns / unknown ⇒ flag
 *    (never auto-retried — overflow is deterministic: a retry can never fit).
 */
export function retryDecision(errorClass: ErrorClass, retryState: RetryState | undefined, retryInfra: number): RetryDecision {
  const attempts = retryState?.attempts ?? 0;
  // Persistent auth escalates BEFORE the budget check — a second consecutive
  // auth is login-required regardless of remaining budget. Ordered after
  // exhaustion, `--retry-infra 1` would exhaust on the first retry and lose the
  // escalation signal. Unreachable at default-off: no retry ever runs, so
  // `lastClass` is never 'auth'.
  if (errorClass === 'auth' && retryState?.lastClass === 'auth') return { action: 'flag', errorClass: 'login-required' };
  if (retryInfra < 1 || attempts >= retryInfra) return { action: 'flag', errorClass };

  if (errorClass === 'auth') {
    return { action: 'retry', delayMs: backoffMs(attempts), nextRetryState: { attempts: attempts + 1, lastClass: 'auth' } };
  }
  if (errorClass === 'network' || errorClass === 'server' || errorClass === 'rate-limit') {
    return { action: 'retry', delayMs: backoffMs(attempts), nextRetryState: { attempts: attempts + 1, lastClass: errorClass } };
  }
  return { action: 'flag', errorClass };
}

export interface TerminalError {
  /** ISO timestamp of the error record, or '' when the record carried none. */
  ts: string;
  errorClass: ErrorClass;
  /** A normalized one-line snippet of the error text (for display). */
  text: string;
}

export interface RoleHealth {
  verdict: Verdict;
  /** ms since the newest content record, when the transcript had one. */
  lastActivityAgeMs?: number;
  /** `api_retry` events counted at/after `retriesSince` (the current turn). */
  retries: number;
  recentErrors: TerminalError[];
}

export type JsonRecord = Record<string, unknown>;

/** Parse JSONL leniently — one record per line, skipping blank/partial/foreign lines (errscan's `records`). */
export function parseRecords(jsonl: string): JsonRecord[] {
  const out: JsonRecord[] = [];
  for (const raw of jsonl.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === 'object') out.push(o as JsonRecord);
    } catch {
      // half-written or foreign line — skip rather than break the scan
    }
  }
  return out;
}

/**
 * Whether THIS turn's prompt was accepted into the session — true iff the
 * transcript carries a real activity record (a `user`/`assistant`/`result`
 * record; tool steps ride inside those) timestamped at/after `sinceMs`, the
 * turn's start. The lower bound is LOAD-BEARING: a persistent (implementer /
 * reviewer) session already holds PRIOR turns' records, so a whole-transcript
 * scan would false-positive on a resumed turn that failed before its new prompt
 * was ever accepted — and that cascades into wrongly resuming (or, in S7,
 * wrongly resetting) a session the worker never acted in this turn. `system`
 * records (init/startup) are excluded: they prove the process launched, not that
 * the prompt was accepted. Pure — string + number in, boolean out.
 */
export function transcriptShowsPromptAccepted(jsonl: string, sinceMs: number): boolean {
  for (const o of parseRecords(jsonl)) {
    const t = o['type'];
    if (t !== 'user' && t !== 'assistant' && t !== 'result') continue;
    const ts = o['timestamp'];
    const ms = typeof ts === 'string' ? Date.parse(ts) : NaN;
    if (Number.isFinite(ms) && ms >= sinceMs) return true;
  }
  return false;
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, 200);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
}

function claudeErrors(records: JsonRecord[]): TerminalError[] {
  const hits: TerminalError[] = [];
  for (const o of records) {
    const ts = typeof o['timestamp'] === 'string' ? (o['timestamp'] as string) : '';
    let text: string | undefined;
    if (o['type'] === 'assistant' && o['isApiErrorMessage'] === true) {
      const content = (o['message'] as JsonRecord | undefined)?.['content'];
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c && typeof c === 'object' && (c as JsonRecord)['type'] === 'text') text = str((c as JsonRecord)['text']);
        }
      }
    } else if (o['type'] === 'result' && o['is_error'] === true) {
      text = str(o['result']);
    }
    if (text) hits.push({ ts, errorClass: classifyError(text), text: normalize(text) });
  }
  return hits;
}

function codexErrors(records: JsonRecord[]): TerminalError[] {
  const hits: TerminalError[] = [];
  for (const o of records) {
    const ts = typeof o['timestamp'] === 'string' ? (o['timestamp'] as string) : '';
    const p = o['payload'];
    if (!p || typeof p !== 'object') continue;
    const payload = p as JsonRecord;
    const ptype = payload['type'];
    let text: string | undefined;
    if (ptype === 'error' || ptype === 'stream_error' || ptype === 'turn_aborted') {
      // Classify over the WHOLE serialized payload — a real envelope can carry a
      // long prefix with the failure signature past any fixed offset, so slicing
      // before classifyError would misreport it as `unknown`. `normalize` does
      // the display-only truncation below.
      text = JSON.stringify(payload);
    } else if (ptype === 'function_call_output') {
      const out = str(payload['output']);
      if (out.includes('exited with code 0')) continue; // explicit tool SUCCESS — never an error
      const m = CODEX_HARD.exec(out);
      if (m) text = out.slice(Math.max(0, m.index - 20), m.index + 90); // keep the signature in-window
    }
    if (text) hits.push({ ts, errorClass: classifyError(text), text: normalize(text) });
  }
  return hits;
}

/**
 * The TERMINAL classified errors in a transcript tail — error-bearing records
 * only (claude: `isApiErrorMessage` assistants or `is_error` results; codex:
 * explicit error events or a hard-failure `function_call_output`, skipping
 * `exited with code 0`). Discussion *about* an error is structurally never
 * counted, and `api_retry` events are not errors.
 */
export function scanTerminalErrors(jsonl: string, schema: Schema): TerminalError[] {
  const records = parseRecords(jsonl);
  return schema === 'claude' ? claudeErrors(records) : codexErrors(records);
}

/** Whether a record represents real activity (skip pure metadata like claude's
 *  `last-prompt`/`pr-link` and codex's `session_meta` — the `494961h` bug). */
function isActivityRecord(o: JsonRecord, schema: Schema): boolean {
  const t = o['type'];
  if (schema === 'claude') return t === 'assistant' || t === 'user' || t === 'result' || t === 'system';
  return t !== 'session_meta';
}

/** Epoch-ms of the newest activity record carrying a timestamp, or undefined. */
function lastActivityMs(records: JsonRecord[], schema: Schema): number | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const o = records[i];
    if (!o) continue;
    const ts = o['timestamp'];
    if (typeof ts !== 'string' || !ts) continue;
    if (!isActivityRecord(o, schema)) continue;
    const ms = Date.parse(ts);
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

/** Count `api_retry` system records, scoped to at/after `retriesSince` when given. */
function countRetries(records: JsonRecord[], retriesSince?: number): number {
  let n = 0;
  for (const o of records) {
    if (o['type'] !== 'system' || o['subtype'] !== 'api_retry') continue;
    if (retriesSince !== undefined) {
      const ts = o['timestamp'];
      const ms = typeof ts === 'string' ? Date.parse(ts) : NaN;
      if (!Number.isFinite(ms) || ms < retriesSince) continue;
    }
    n++;
  }
  return n;
}

function newestErrorMs(errors: TerminalError[]): number | undefined {
  let newest: number | undefined;
  for (const e of errors) {
    if (!e.ts) continue;
    const ms = Date.parse(e.ts);
    if (Number.isFinite(ms) && (newest === undefined || ms > newest)) newest = ms;
  }
  return newest;
}

/**
 * The LIVE terminal error right now, or undefined: the newest terminal error,
 * but ONLY when it is recent (within RECENT_ERROR_MS of `now`) AND not superseded
 * by later activity (`lastMs <= newestErr`). This is the single rule behind both
 * the `crashed` verdict (`computeVerdict`) and infra-crash classification
 * (`driver.ts`) — they MUST share it, or a recovered error reads as live in one
 * path but not the other (the exact drift this extraction removes). Operates on
 * already-parsed inputs; `currentTerminalError` is the jsonl-level wrapper.
 */
function liveTerminalError(errors: TerminalError[], lastMs: number | undefined, now: number): TerminalError | undefined {
  const newestErr = newestErrorMs(errors);
  if (newestErr === undefined || now - newestErr >= RECENT_ERROR_MS) return undefined;
  if (lastMs !== undefined && lastMs > newestErr) return undefined; // superseded by later activity
  return errors.at(-1); // newest by append order (transcripts are append-only)
}

/**
 * The live terminal error in a transcript tail — recent AND not superseded by
 * later activity (NOT recency alone). `driver.ts`'s `classifyInfraError` consults
 * this for its opaque-throw fallback, so a stale error a later turn already
 * recovered from is never read as the current crash cause.
 */
export function currentTerminalError(jsonl: string, schema: Schema, now: number): TerminalError | undefined {
  const records = parseRecords(jsonl);
  const errors = schema === 'claude' ? claudeErrors(records) : codexErrors(records);
  const lastMs = lastActivityMs(records, schema);
  return liveTerminalError(errors, lastMs, now);
}

/**
 * The role's verdict by fixed precedence (highest first):
 *   crashed (terminal error newer than RECENT_ERROR_MS)
 *   → idle (not in flight — `inFlightSince` absent ⇒ no turn, or no session)
 *   → retrying (in flight, `retriesSince` given, ≥1 api_retry this turn)
 *   → working (in flight, quiet < 60s) → long-inference (< 30m) → silent/stuck (≥ 30m).
 *
 * `retrying` is eligible ONLY when `retriesSince` is a true turn-start anchor —
 * the orchestrator (which has only a recency window, no per-turn marker) omits
 * it, so a prior-turn `api_retry` inside the window can never read as retrying.
 */
function computeVerdict(args: {
  now: number;
  inFlightSince?: number;
  retriesSince?: number;
  lastActivityAgeMs?: number;
  retries: number;
  recentErrors: TerminalError[];
}): Verdict {
  const lastMs = args.lastActivityAgeMs !== undefined ? args.now - args.lastActivityAgeMs : undefined;
  // `crashed` only when there is a LIVE terminal error — recent AND not superseded
  // by later activity (a write the worker made after recovering). The error stays
  // in `recentErrors` either way; only the verdict reflects the recovery. Same
  // rule `classifyInfraError` reads via `currentTerminalError`, shared here.
  if (liveTerminalError(args.recentErrors, lastMs, args.now)) return 'crashed';
  if (args.inFlightSince === undefined) return 'idle';
  if (args.retriesSince !== undefined && args.retries >= 1) return 'retrying';
  // Quiet = time since the most recent of {last write, turn start}: a brand-new
  // turn whose transcript hasn't been written yet is measured from its start,
  // not from a stale prior-turn write.
  const sinceStart = Math.max(0, args.now - args.inFlightSince);
  const quiet = Math.min(args.lastActivityAgeMs ?? sinceStart, sinceStart);
  if (quiet < WORKING_MAX_QUIET_MS) return 'working';
  if (quiet < LONG_INFERENCE_MAX_QUIET_MS) return 'long-inference';
  return 'silent/stuck';
}

/**
 * Probe one role's transcript tail for its live health. `inFlightSince`'s
 * PRESENCE is the in-flight signal (no separate boolean); `retriesSince` anchors
 * "this turn's" retries and gates the `retrying` verdict. Both undefined ⇒ idle
 * (or crashed on a recent terminal error). All ages are vs the injected `now`.
 */
export function probeRole(
  jsonl: string,
  opts: { schema: Schema; now: number; inFlightSince?: number; retriesSince?: number },
): RoleHealth {
  const records = parseRecords(jsonl);
  const lastMs = lastActivityMs(records, opts.schema);
  const lastActivityAgeMs = lastMs !== undefined ? Math.max(0, opts.now - lastMs) : undefined;
  const recentErrors = opts.schema === 'claude' ? claudeErrors(records) : codexErrors(records);
  const retries = countRetries(records, opts.retriesSince);
  const verdict = computeVerdict({
    now: opts.now,
    ...(opts.inFlightSince !== undefined ? { inFlightSince: opts.inFlightSince } : {}),
    ...(opts.retriesSince !== undefined ? { retriesSince: opts.retriesSince } : {}),
    ...(lastActivityAgeMs !== undefined ? { lastActivityAgeMs } : {}),
    retries,
    recentErrors,
  });
  return { verdict, ...(lastActivityAgeMs !== undefined ? { lastActivityAgeMs } : {}), retries, recentErrors };
}

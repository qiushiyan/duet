import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * JSONL transcript builders — composable record fragments (NOT whole captured
 * files), each a single provider record shaped exactly as the real CLIs write
 * it, so worker-health's parsers are tested on the structure they ship against.
 * `jsonl(...)` joins records into a tail string; the plant helpers write a
 * built transcript at the provider's real path shape under a fake `home`.
 */

const BASE_TS = '2026-06-20T00:00:00.000Z';

type Rec = Record<string, unknown>;

export function jsonl(...records: Rec[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n');
}

// ── claude (~/.claude/projects/<slug>/<id>.jsonl) ──────────────────────────

/** A synthetic API-error assistant record — `isApiErrorMessage:true`. */
export function claudeApiError(text: string, { ts = BASE_TS } = {}): Rec {
  return { type: 'assistant', isApiErrorMessage: true, timestamp: ts, message: { content: [{ type: 'text', text }] } };
}

/** A terminal `is_error` result record. */
export function claudeResultError(result: string, { ts = BASE_TS } = {}): Rec {
  return { type: 'result', is_error: true, result, timestamp: ts };
}

/** A NORMAL assistant text record — the discussion-not-error case (must classify to zero). */
export function claudeAssistantText(text: string, { ts = BASE_TS } = {}): Rec {
  return { type: 'assistant', timestamp: ts, message: { content: [{ type: 'text', text }] } };
}

/** An SDK retry event — carries no usable status, must never be counted as a terminal error. */
export function claudeApiRetry({ ts = BASE_TS } = {}): Rec {
  return { type: 'system', subtype: 'api_retry', error: 'unknown', error_status: null, timestamp: ts };
}

/** A tool-result user record — an activity/recency marker. */
export function claudeUserToolResult({ ts = BASE_TS } = {}): Rec {
  return { type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', content: 'ok' }] } };
}

/** A trailing metadata record WITHOUT a timestamp — must be skipped for last-activity. */
export function claudeMetadata(type = 'last-prompt'): Rec {
  return { type, sessionId: 's' };
}

// ── codex (~/.codex/sessions/<y>/<m>/<d>/rollout-<ts>-<id>.jsonl) ───────────

/** A function_call_output record (use `… exited with code 0` for the success case). */
export function codexFunctionOutput(output: string, { ts = BASE_TS } = {}): Rec {
  return { type: 'response_item', timestamp: ts, payload: { type: 'function_call_output', output } };
}

/** An explicit codex error event. */
export function codexErrorEvent(message: string, { ts = BASE_TS } = {}): Rec {
  return { type: 'event_msg', timestamp: ts, payload: { type: 'error', message } };
}

/** A codex token-count event — an activity/recency marker, not an error. */
export function codexTokenCount(total: number, { ts = BASE_TS } = {}): Rec {
  return { type: 'event_msg', timestamp: ts, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total } } } };
}

// ── planting under a fake home (the environment seam) ──────────────────────

function setMtime(path: string, mtime?: number): void {
  if (mtime !== undefined) utimesSync(path, mtime / 1000, mtime / 1000);
}

/** Write a claude transcript at `<home>/.claude/projects/<slug>/<sessionId>.jsonl`; returns the path. */
export function plantClaudeTranscript(
  home: string,
  sessionId: string,
  content: string,
  { slug = 'proj', mtime }: { slug?: string; mtime?: number } = {},
): string {
  const dir = join(home, '.claude', 'projects', slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, content);
  setMtime(path, mtime);
  return path;
}

/** Write a codex rollout at `<home>/.codex/sessions/2026/06/20/rollout-<stamp>-<sessionId>.jsonl`; returns the path. */
export function plantCodexRollout(
  home: string,
  sessionId: string,
  content: string,
  { stamp = '2026-06-20T00-00-00', mtime }: { stamp?: string; mtime?: number } = {},
): string {
  const dir = join(home, '.codex', 'sessions', '2026', '06', '20');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-${stamp}-${sessionId}.jsonl`);
  writeFileSync(path, content);
  setMtime(path, mtime);
  return path;
}

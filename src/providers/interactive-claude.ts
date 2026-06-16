import { COMPACT_CONFIRMATION, claudeContextUsage } from './claude.ts';
import type { WorkerTurn } from './types.ts';

/**
 * Interactive claude transport — the pure transcript parser.
 *
 * `parseInteractiveTurn` turns a transcript tail into one WorkerTurn: it finds
 * the user record carrying this turn's nonce (turn-open), walks forward, and
 * closes on the final assistant message (or a compact boundary). No I/O — the
 * watcher feeds it bytes. This is the piece the owned-pty production transport
 * reuses UNCHANGED, which is why the tmux/pty choice is contained to injection.
 *
 * The uncertain part — which transcript record opens/closes a turn, the
 * compact-boundary shape — is confirmable only against a real interactive
 * session (the plan's Slice 5). It is isolated into the five predicates below
 * so a correction against a real captured transcript stays localized to them;
 * the walk-the-tail control flow above is meant to stay stable.
 */

/** One parsed transcript record — a permissive view; the predicates name the shapes that matter. */
interface ParsedRecord {
  type?: unknown;
  subtype?: unknown;
  sessionId?: unknown;
  modelUsage?: unknown;
  message?: { role?: unknown; content?: unknown; usage?: unknown; stop_reason?: unknown };
}

/** Parse one JSONL line, tolerating a cut or foreign line (the parseRolloutContext robustness bar). */
function parseLine(line: string): ParsedRecord | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return typeof value === 'object' && value !== null ? (value as ParsedRecord) : undefined;
  } catch {
    return undefined;
  }
}

/** A record's message content flattened to text, for substring matching and final-text extraction. */
function contentText(rec: ParsedRecord): string {
  const content = rec.message?.content;
  if (typeof content === 'string') return content;
  if (content === undefined) return '';
  return JSON.stringify(content);
}

function sessionIdOf(rec: ParsedRecord | undefined): string | undefined {
  return typeof rec?.sessionId === 'string' ? rec.sessionId : undefined;
}

// === isolated predicates — the live-auth-uncertain event vocabulary (Slice 5 corrects HERE) ===

/** Our injected prompt opens the turn: a user record whose content carries the per-turn nonce. */
export function isTurnOpen(rec: ParsedRecord, nonce: string): boolean {
  return rec.type === 'user' && contentText(rec).includes(nonce);
}

/** The turn's final assistant message — `stop_reason: end_turn`, not a mid-turn tool_use step. */
export function isFinalAssistant(rec: ParsedRecord): boolean {
  return rec.type === 'assistant' && rec.message?.stop_reason === 'end_turn';
}

/** A successful `/compact` closes the turn with this boundary instead of an assistant message. */
export function isCompactBoundary(rec: ParsedRecord): boolean {
  return rec.type === 'system' && rec.subtype === 'compact_boundary';
}

/** The final assistant text — the analogue of the headless `result`, not the joined tool narration. */
export function extractText(rec: ParsedRecord): string {
  const content = rec.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: string; text: string } => {
      return typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string';
    })
    .map((b) => b.text)
    .join('');
}

/** Per-turn token usage from the final assistant's `message.usage` (mirrors the headless tokens shape). */
export function extractUsage(rec: ParsedRecord): { input: number; output: number } | undefined {
  const usage = rec.message?.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  if (!usage || usage.input_tokens === undefined) return undefined;
  return { input: usage.input_tokens, output: usage.output_tokens ?? 0 };
}

/**
 * The context-window source. Headless reads it from the result envelope's
 * modelUsage; the interactive transcript has no such envelope, so we scan for a
 * record carrying modelUsage and let `claudeContextUsage` return undefined when
 * none is found — context is best-effort, never load-bearing (types.ts). WHERE
 * the window lives in a real interactive transcript is a Slice 5 question.
 */
function extractModelUsage(records: ParsedRecord[]): Record<string, { contextWindow?: number }> | undefined {
  for (const rec of records) {
    if (rec.modelUsage && typeof rec.modelUsage === 'object') {
      return rec.modelUsage as Record<string, { contextWindow?: number }>;
    }
  }
  return undefined;
}

/**
 * Parse the turn whose user record carries `nonce` out of a transcript tail.
 * Returns `undefined` when that turn has not closed yet (the watcher keeps
 * reading): no nonce-bearing user record visible, or no turn-close after it.
 */
export function parseInteractiveTurn(tail: string, opts: { nonce: string }): WorkerTurn | undefined {
  const records: ParsedRecord[] = [];
  for (const line of tail.split('\n')) {
    const rec = parseLine(line);
    if (rec) records.push(rec);
  }

  const openIdx = records.findIndex((r) => isTurnOpen(r, opts.nonce));
  if (openIdx < 0) return undefined;
  const turn = records.slice(openIdx);

  for (const rec of turn.slice(1)) {
    if (isCompactBoundary(rec)) {
      const sessionId = sessionIdOf(rec) ?? sessionIdOf(records[openIdx]);
      if (sessionId === undefined) return undefined;
      return { text: COMPACT_CONFIRMATION, sessionId };
    }
    if (isFinalAssistant(rec)) {
      const sessionId = sessionIdOf(rec) ?? sessionIdOf(records[openIdx]);
      if (sessionId === undefined) return undefined;
      const tokens = extractUsage(rec);
      const context = claudeContextUsage(turn, extractModelUsage(turn));
      return {
        text: extractText(rec),
        sessionId,
        ...(tokens ? { tokens } : {}),
        ...(context ? { context } : {}),
      };
    }
  }
  return undefined;
}

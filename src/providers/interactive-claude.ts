import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { COMPACT_CONFIRMATION, claudeContextUsage } from './claude.ts';
import { TmuxPane } from './pane.ts';
import type { PaneController, PaneFactory } from './pane.ts';
import type { RunTurnOptions, WorkerProvider, WorkerTurn } from './types.ts';

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

/**
 * This turn's session id as soon as the transcript reveals it — the nonce-bearing
 * user record (turn-open), or the first record after it, carrying a `sessionId`.
 * Unlike the headless transports, the interactive worker does not predeclare an id
 * (it cannot pass `--session-id` through the TUI), so a FRESH turn learns its id
 * only from the transcript — but well before turn-close, which is what lets the
 * live-activity poll locate the transcript mid-turn instead of waiting for settle.
 * Reads the SAME `sessionId` field `parseInteractiveTurn` already trusts; undefined
 * until one is visible (the watcher keeps polling).
 */
export function sessionIdForNonce(tail: string, nonce: string): string | undefined {
  const records: ParsedRecord[] = [];
  for (const line of tail.split('\n')) {
    const rec = parseLine(line);
    if (rec) records.push(rec);
  }
  const openIdx = records.findIndex((r) => isTurnOpen(r, nonce));
  if (openIdx < 0) return undefined;
  for (const rec of records.slice(openIdx)) {
    const id = sessionIdOf(rec);
    if (id !== undefined) return id;
  }
  return undefined;
}

// === injection ===

/** The per-turn correlation marker the injection appends to the prompt body. */
export function turnMarker(nonce: string): string {
  return `[duet-turn:${nonce}]`;
}

/** The prompt body actually submitted: the prompt plus the per-turn nonce the locator matches on. */
function injectionBody(prompt: string, nonce: string): string {
  return `${prompt}\n\n${turnMarker(nonce)}`;
}

// === transcript location (correlation by unique nonce) ===

/**
 * Claude Code's project-directory name for a cwd: the absolute path with its
 * separators (and dots) folded to '-', e.g. `/Users/me/dev/duet` →
 * `-Users-me-dev-duet`. Isolated and best-effort — the exact transform for
 * unusual characters is a Slice 5 confirmable. Correctness does not depend on
 * getting it right, only performance: `searchDirs` puts the scoped dir FIRST but
 * falls back to the whole projects tree on a miss, so a wrong slug costs a wider
 * scan, never a missed transcript; nonce-correlation protects the result either way.
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

/**
 * Where to look for this turn's transcript, in order: the cwd-derived project dir
 * first (the fast, spec-aligned path), then the whole projects tree as a fallback.
 * The fallback is what keeps correctness independent of the slug rule — if the
 * guess is wrong (or the dir doesn't exist), the root scan still finds the file.
 */
function searchDirs(root: string, cwd: string | undefined): string[] {
  if (!cwd) return [root];
  const scoped = join(root, claudeProjectSlug(cwd));
  return scoped === root ? [root] : [scoped, root];
}

/**
 * Finds and reads this turn's transcript among the project's session files.
 * The slug is SHARED — the orchestrator SDK session writes there concurrently —
 * so "newest file" is ambiguous (unlike codex, which knows its id and keys the
 * scan on the `-<id>.jsonl` suffix). Instead we correlate on the per-turn nonce:
 * the session file carrying it IS this turn's, whether the file is new (turn 1)
 * or an append to a resumed session (turn 2+) — no mtime/recency reasoning, so
 * a coarse-granularity filesystem can't hide an append. The nonce is unique per
 * turn, so a match in more than one file is a should-not-happen the locator
 * refuses to guess through. Reading the whole file (not a fixed tail) keeps the
 * turn-open user record in scope even for a long single turn.
 *
 * `dirs` are searched in order (scoped first, root fallback): the common case
 * finds it in the scoped dir and never scans wider; the root scan fires only on
 * a miss, which for a correct slug is just the brief window before the prompt's
 * user record lands, and for a wrong slug is what preserves correctness.
 */
class TranscriptStore {
  private readonly dirs: string[];

  constructor(dirs: string[]) {
    this.dirs = dirs;
  }

  /**
   * The path of the session file carrying `nonce`, or undefined if none yet (the
   * watcher keeps polling). Throws — never guesses — when more than one carries it.
   */
  locate(nonce: string): string | undefined {
    for (const dir of this.dirs) {
      const matches = this.sessionsIn(dir).filter((p) => this.read(p).includes(nonce));
      if (matches.length > 1) {
        throw new Error(
          `interactive claude: the turn nonce matched ${matches.length} session transcripts — refusing to guess which is this turn's`,
        );
      }
      if (matches.length === 1) return matches[0];
    }
    return undefined;
  }

  read(path: string): string {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return '';
    }
  }

  /** Every session transcript under `dir` (absent/unreadable dir → none; a dir named *.jsonl reads as empty). */
  private sessionsIn(dir: string): string[] {
    let entries: string[];
    try {
      entries = readdirSync(dir, { recursive: true }).map(String);
    } catch {
      return [];
    }
    return entries.filter((rel) => rel.endsWith('.jsonl')).map((rel) => join(dir, rel));
  }
}

// === the worker ===

const POLL_INTERVAL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll the pane until it is ready for input, or throw at the per-turn deadline. */
async function waitUntilReady(pane: PaneController, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    if (await pane.pollReady()) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('interactive claude: the session was not ready for input before the per-turn timeout');
}

/**
 * Watch the transcript until this turn closes, or throw at the per-turn deadline.
 * `onSessionId` (a FRESH turn's only id source — see runTurn) fires once, the first
 * time the located transcript reveals this turn's session id, so the live-activity
 * poll can start mid-turn rather than at settle.
 */
async function watchForTurn(store: TranscriptStore, nonce: string, deadline: number, onSessionId?: (id: string) => void): Promise<WorkerTurn> {
  let located: string | undefined;
  let announced = false;
  let lastSessionId: string | undefined;
  while (Date.now() < deadline) {
    if (!located) located = store.locate(nonce); // throws on an ambiguous match
    if (located) {
      const tail = store.read(located);
      const sessionId = sessionIdForNonce(tail, nonce);
      if (sessionId !== undefined) {
        lastSessionId = sessionId;
        if (!announced) {
          onSessionId?.(sessionId);
          announced = true;
        }
      }
      const turn = parseInteractiveTurn(tail, { nonce });
      if (turn) return turn;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  // Deadline. A located transcript carrying our nonce IS proof the prompt was
  // injected and accepted, so with a session id this is a resumable aborted
  // CHECKPOINT (resume, don't re-send) — the interactive analogue of the headless
  // accepted-abort split. No located transcript ⇒ no acceptance evidence ⇒ an
  // infra error (retry). ("Not ready before timeout" is the distinct pre-injection
  // throw in waitUntilReady, which never reaches here.)
  if (located && lastSessionId !== undefined) {
    return { text: '', sessionId: lastSessionId, aborted: true };
  }
  throw new Error(
    located
      ? 'interactive claude: the turn did not complete in the transcript before the per-turn timeout'
      : 'interactive claude: could not correlate the turn transcript — no session file carried the turn nonce before the timeout',
  );
}

/**
 * The interactive claude worker: drives one turn through the interactive `claude`
 * TUI so it bills the flat subscription quota — launch → readiness-poll →
 * submit(prompt + nonce) → watch the transcript + parse → teardown, the whole
 * turn bounded by one per-turn deadline (`PHASE[phase].workerTurnTimeoutMs`,
 * threaded as `timeoutMs`). Implements WorkerProvider with `name = 'claude'`:
 * the orchestrator sees the same contract as the headless transport.
 *
 * Teardown is a CONTRACT, not a side effect (the no-daemon claim depends on it):
 * `pane.kill()` runs in a `finally`, so it fires on success, throw, and timeout
 * alike — a timed-out turn never leaves a lingering interactive pane. A stall or
 * a tmux error becomes a thrown `runTurn` error, which the `send_prompt` rail
 * converts to retry-once-then-ask_human (src/harness/tools.ts) — the one failure
 * that rail can't catch is a silent hang, which the deadline forecloses.
 *
 * `transcriptRoot` and `newPane` are injectable so tests drive it over a FakePane
 * and a tmpdir; they default to `~/.claude/projects` and a real TmuxPane.
 */
export class InteractiveClaudeWorker implements WorkerProvider {
  readonly name = 'claude' as const;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly transcriptRoot: string;
  private readonly newPane: PaneFactory;

  constructor(config: { model: string; timeoutMs: number; transcriptRoot?: string; newPane?: PaneFactory }) {
    this.model = config.model;
    this.timeoutMs = config.timeoutMs;
    this.transcriptRoot = config.transcriptRoot ?? join(homedir(), '.claude', 'projects');
    this.newPane = config.newPane ?? ((c) => new TmuxPane(c));
  }

  async runTurn(opts: RunTurnOptions): Promise<WorkerTurn> {
    // Structural backstop for the implementer-only scope: this transport always
    // launches with bypass permissions (TmuxPane), so it physically cannot honor
    // read-only. Refuse rather than silently ignore opts.readOnly — the config
    // layer already keeps interactive off non-implementer roles, so this never
    // fires in production; it makes the WorkerProvider contract honest regardless
    // of how runTurn is reached.
    if (opts.readOnly) {
      throw new Error(
        'interactive claude cannot run a read-only turn: the interactive transport always launches with bypass permissions, so it serves the read-write implementer only. A read-only interactive worker (a claude reviewer) is a production item — bind that role to headless claude or codex instead.',
      );
    }
    // A resume already knows its id — announce it now (as early as the headless
    // transports do). A fresh turn has no predeclared id (the TUI takes no
    // --session-id), so it learns its id from the transcript: watchForTurn fires
    // onSessionId the first time the nonce-bearing record reveals it.
    if (opts.sessionId) opts.onSessionId?.(opts.sessionId);
    const nonce = randomBytes(8).toString('hex');
    const store = new TranscriptStore(searchDirs(this.transcriptRoot, opts.cwd));
    const pane = this.newPane({
      model: this.model,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    // Effective cap: a per-turn override wins over the construction value (which
    // is required here, so no provider floor to fall back to). Already Date-based,
    // so this transport needs no wall-clock conversion — the deadline is real time.
    const deadline = Date.now() + (opts.timeoutMs ?? this.timeoutMs);
    try {
      await pane.open();
      await waitUntilReady(pane, deadline);
      await pane.submitPrompt(injectionBody(opts.prompt, nonce));
      return await watchForTurn(store, nonce, deadline, opts.sessionId ? undefined : opts.onSessionId);
    } finally {
      await pane.kill().catch(() => {});
    }
  }
}

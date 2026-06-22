/**
 * Worker activity — the pure substrate behind the live-activity voice-log line
 * (docs/automation-design.md §"Visualization"). A worker turn is non-streaming:
 * the providers parse one envelope at turn end (claude `-p --output-format
 * json`) / the final `Turn` (codex `run()`), so between `◀ prompt` and `▶
 * response` the only thing that lands in the voice log is the 5-minute
 * heartbeat. A healthy worker grinding for 30 minutes looks identical to a
 * stalled one.
 *
 * Both providers write standard JSONL transcripts *live* as the turn runs, and
 * `sessions.ts` already locates+tail-reads them for the heartbeat's last-activity
 * age. This module extracts the worker's *current action* from that same tail —
 * which file it is reading, or that an edit happened — so the heartbeat poll can
 * surface it. It is the read/write sibling of `worker-health.ts`'s health probe,
 * and like it, PURE BY DESIGN: string in, value out, no fs, no clock. The fs
 * tail-read stays in `sessions.ts`; the emit (the 30s heartbeat poll) lives in
 * `harness/tools.ts`.
 *
 * Two roles, two formats:
 *   - claude implementer — `assistant` records carry `message.content[].tool_use`
 *     with a structured `input.file_path`: a clean read/write signal.
 *   - codex (reviewer by default, read-only; implementer when bound there) —
 *     reads are shell commands (`exec_command` with `arguments.cmd` =
 *     `sed -n '1,260p' CLAUDE.md`), so the file is embedded in the command
 *     string: we surface a path only when the command is confidently a single
 *     known read file (`sed`/`cat`/`head`/`tail`) and otherwise emit no line —
 *     a search, a pipeline, or a multi-file read is skipped, never a guessed,
 *     partial, or raw-command line (tool inputs beyond the file path are out of
 *     scope). Writes come from an `apply_patch` custom_tool_call, from whose
 *     patch text we read the first file HEADER path, never a hunk.
 *
 * Scope is bounded to the file path: no message text, no tool inputs/outputs
 * beyond the path, no diffs. A changed-line count is deliberately dropped too —
 * neither provider hands one over for free (claude only a `structuredPatch`
 * needing correlation+summing, codex nothing).
 */

import { parseRecords } from './worker-health.ts';
import type { JsonRecord, Schema } from './worker-health.ts';

/**
 * One worker action, normalized across providers. `id` is the provider-native
 * tool-call id (claude `tool_use.id` / codex `call_id`) — the stable key the
 * heartbeat poll dedups on, so the same action is never re-emitted across ticks.
 *  - `read`  — a file read; the path is the whole signal.
 *  - `write` — an edit/write happened; the path, never its contents.
 * Anything that can't be pinned to a single file path surfaces no activity —
 * the scope is the path, never a command or its arguments.
 */
export type WorkerActivity =
  | { id: string; kind: 'read'; path: string }
  | { id: string; kind: 'write'; path: string };

/** The marker that prefixes an activity voice-log line. The colorizer keys on
 *  it (src/colorize.ts dims `⋯` lines, like the `⏳` heartbeat) — a
 *  producer/colorizer contract, kept as a matching literal in both places the
 *  way `⏳`/`✗` already are. */
const ACTIVITY_MARKER = '⋯';

/** The one human-facing line shape for an activity — exported so it is testable
 *  alongside the parser and shared by the heartbeat poll. Plain text; the
 *  colorizer is the only place color is applied (the view-time-color invariant). */
export function activityLine(activity: WorkerActivity): string {
  switch (activity.kind) {
    case 'read':
      return `${ACTIVITY_MARKER} reading ${activity.path}`;
    case 'write':
      return `${ACTIVITY_MARKER} editing ${activity.path}`;
  }
}

/**
 * The worker's most recent action in a transcript tail, or undefined when the
 * tail carries no qualifying read/write/run. Scans newest-first and returns the
 * newest *qualifying* activity — a non-qualifying tool call (a claude `Grep`, a
 * `Bash`) is skipped so the last real file touch still shows, and searches never
 * masquerade as reads. Like `probeRole`, it parses already-tail-trimmed JSONL.
 */
export function latestActivity(jsonl: string, schema: Schema): WorkerActivity | undefined {
  const records = parseRecords(jsonl);
  return schema === 'claude' ? claudeActivity(records) : codexActivity(records);
}

// ── claude: structured tool_use on assistant records ───────────────────────

const CLAUDE_READ_TOOLS = new Set(['Read']);
const CLAUDE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function claudeActivity(records: JsonRecord[]): WorkerActivity | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const o = records[i];
    if (!o || o['type'] !== 'assistant') continue;
    const content = (o['message'] as JsonRecord | undefined)?.['content'];
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j];
      if (!block || typeof block !== 'object') continue;
      const b = block as JsonRecord;
      if (b['type'] !== 'tool_use') continue;
      const name = b['name'];
      const id = b['id'];
      const filePath = (b['input'] as JsonRecord | undefined)?.['file_path'];
      if (typeof name !== 'string' || typeof id !== 'string' || typeof filePath !== 'string' || !filePath) continue;
      if (CLAUDE_READ_TOOLS.has(name)) return { id, kind: 'read', path: filePath };
      if (CLAUDE_WRITE_TOOLS.has(name)) return { id, kind: 'write', path: filePath };
      // a non-qualifying tool_use (Grep/Glob/Bash/Task): keep scanning older for
      // the last real read/write — searches never surface as reads.
    }
  }
  return undefined;
}

// ── codex: function_call (shell reads) + apply_patch custom_tool_call (writes) ──

/** Read commands that take their target file(s) as plain argument(s). */
const READ_COMMANDS = new Set(['cat', 'sed', 'head', 'tail']);
/** Shell metacharacters that make a command a pipeline/redirect/compound — too
 *  ambiguous to pin to one read file, so it surfaces no path. */
const SHELL_META = /[|<>;`&]|\$\(/;
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** The first file header in an apply_patch body (`*** Update/Add/Delete File: <p>`). */
const PATCH_FILE_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m;

function codexActivity(records: JsonRecord[]): WorkerActivity | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const payload = records[i]?.['payload'];
    if (!payload || typeof payload !== 'object') continue;
    const p = payload as JsonRecord;
    const type = p['type'];
    const id = p['call_id'];
    if (typeof id !== 'string') continue;
    // A write: codex applies edits via an apply_patch custom_tool_call whose
    // `input` is the patch text. Surface only the first file HEADER path, never
    // a hunk — the path, not the contents.
    if (type === 'custom_tool_call' && p['name'] === 'apply_patch') {
      const path = patchHeaderPath(typeof p['input'] === 'string' ? p['input'] : '');
      if (path !== undefined) return { id, kind: 'write', path };
      continue; // a malformed patch → keep scanning older
    }
    // A read: a shell-exec call (`exec_command`/`shell`) confidently targeting
    // one known read file. A search, a pipeline, or a multi-file read surfaces
    // no path — we keep scanning older for the last confident single-file read,
    // never a guessed/partial path and never the raw command (out of scope).
    if (type === 'function_call' && (p['name'] === 'exec_command' || p['name'] === 'shell')) {
      const cmd = commandString(p['arguments']);
      const path = cmd !== undefined ? readPathFromCommand(cmd) : undefined;
      if (path !== undefined) return { id, kind: 'read', path };
      continue;
    }
  }
  return undefined;
}

/** The first file path in an apply_patch body, or undefined when none parses. */
function patchHeaderPath(patch: string): string | undefined {
  const m = PATCH_FILE_HEADER.exec(patch);
  return m ? (m[1] ?? '').trim() || undefined : undefined;
}

/** A function_call's `arguments` is a JSON string; pull the command out of it.
 *  `exec_command` carries `{cmd}`, the older `shell` carries `{command: [...]}`. */
function commandString(args: unknown): string | undefined {
  if (typeof args !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const o = parsed as JsonRecord;
  if (typeof o['cmd'] === 'string') return o['cmd'];
  if (Array.isArray(o['command'])) return o['command'].filter((t) => typeof t === 'string').join(' ');
  return undefined;
}

/** The single file a known read command targets, or undefined unless the command
 *  is confidently a one-file read — a pipeline, a search, an unsupported command,
 *  or a multi-file read all return undefined (never a partial or guessed path). */
function readPathFromCommand(cmd: string): string | undefined {
  if (SHELL_META.test(cmd)) return undefined; // pipeline/redirect/compound
  const tokens = tokenize(cmd);
  let i = 0;
  while (i < tokens.length && ENV_ASSIGN.test(tokens[i] ?? '')) i++; // skip leading env assignments
  const name = (tokens[i] ?? '').split('/').pop() ?? ''; // /usr/bin/sed → sed
  if (!READ_COMMANDS.has(name)) return undefined;
  const operands = fileOperands(name, tokens.slice(i + 1));
  return operands.length === 1 ? operands[0] : undefined; // exactly one file, else ambiguous → no line
}

/** The file operands of a known read command — option flags removed (and the
 *  separate numeric value of head/tail `-n`/`-c`), and sed's leading script
 *  argument dropped. Returns every remaining operand so the caller can require
 *  exactly one: a multi-file read is ambiguous and must not look single-file. */
function fileOperands(cmd: string, args: string[]): string[] {
  const operands: string[] = [];
  let endOfOptions = false;
  for (let k = 0; k < args.length; k++) {
    const t = args[k] ?? '';
    if (endOfOptions) {
      operands.push(t);
      continue;
    }
    if (t === '--') {
      endOfOptions = true;
      continue;
    }
    if (t.startsWith('-')) {
      // head/tail take a separate numeric value for -n/-c when not attached.
      if ((cmd === 'head' || cmd === 'tail') && /^-[nc]$/.test(t) && /^\d+$/.test(args[k + 1] ?? '')) k++;
      continue;
    }
    operands.push(t);
  }
  // sed's first non-option operand is the script (e.g. '1,260p'), not a file.
  return cmd === 'sed' ? operands.slice(1) : operands;
}

/** A best-effort shell tokenizer: splits on whitespace, honoring single/double
 *  quotes (no escape handling — telemetry, not a shell). */
function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

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
 *   - codex reviewer (read-only) — reads are shell commands (`exec_command` with
 *     `arguments.cmd` = `sed -n '1,260p' CLAUDE.md`), so the file is embedded in
 *     the command string. We pull a path only from a known single-file read
 *     command and fall back to showing the (truncated) command otherwise —
 *     conservative skip-on-uncertainty, never a guessed path.
 *
 * A changed-line count is deliberately dropped: neither provider hands one over
 * for free (claude only a `structuredPatch` needing correlation+summing, codex
 * nothing), and computing it by hand is out of scope.
 */

import { parseRecords } from './worker-health.ts';
import type { JsonRecord, Schema } from './worker-health.ts';

/**
 * One worker action, normalized across providers. `id` is the provider-native
 * tool-call id (claude `tool_use.id` / codex `call_id`) — the stable key the
 * heartbeat poll dedups on, so the same action is never re-emitted across ticks.
 *  - `read`  — a file read; the path is the whole signal.
 *  - `write` — an edit/write happened; the path, never its contents.
 *  - `run`   — a codex shell command we could not pin to a single read file
 *              (a search, a pipeline); the label is the command, truncated.
 */
export type WorkerActivity =
  | { id: string; kind: 'read'; path: string }
  | { id: string; kind: 'write'; path: string }
  | { id: string; kind: 'run'; label: string };

/** The marker that prefixes an activity voice-log line. The colorizer keys on
 *  it (src/colorize.ts dims `⋯` lines, like the `⏳` heartbeat) — a
 *  producer/colorizer contract, kept as a matching literal in both places the
 *  way `⏳`/`✗` already are. */
const ACTIVITY_MARKER = '⋯';

const RUN_LABEL_MAX = 80;

/** The one human-facing line shape for an activity — exported so it is testable
 *  alongside the parser and shared by the heartbeat poll. Plain text; the
 *  colorizer is the only place color is applied (the view-time-color invariant). */
export function activityLine(activity: WorkerActivity): string {
  switch (activity.kind) {
    case 'read':
      return `${ACTIVITY_MARKER} reading ${activity.path}`;
    case 'write':
      return `${ACTIVITY_MARKER} editing ${activity.path}`;
    case 'run':
      return `${ACTIVITY_MARKER} running ${activity.label}`;
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

// ── codex: function_call records; reads are shell commands ─────────────────

/** Read commands that take their target file as a plain argument. */
const READ_COMMANDS = new Set(['cat', 'sed', 'head', 'tail', 'nl', 'bat', 'less', 'more']);
/** Shell metacharacters that make a command a pipeline/redirect/compound — too
 *  ambiguous to pin to one read file, so we fall back to the raw command. */
const SHELL_META = /[|<>;`&]|\$\(/;

function codexActivity(records: JsonRecord[]): WorkerActivity | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const payload = records[i]?.['payload'];
    if (!payload || typeof payload !== 'object') continue;
    const p = payload as JsonRecord;
    if (p['type'] !== 'function_call') continue;
    const name = p['name'];
    const id = p['call_id'];
    if (typeof id !== 'string') continue;
    // Only shell-exec calls carry read activity; other function names (MCP
    // tools, apply_patch) are not the read signal this surfaces — skip them and
    // keep scanning older.
    if (name !== 'exec_command' && name !== 'shell') continue;
    const cmd = commandString(p['arguments']);
    if (cmd === undefined) continue;
    const path = readPathFromCommand(cmd);
    if (path !== undefined) return { id, kind: 'read', path };
    return { id, kind: 'run', label: truncate(cmd, RUN_LABEL_MAX) };
  }
  return undefined;
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

/** The single file a known read command targets, or undefined when the command
 *  is a pipeline, a search, or otherwise not a confident single-file read. */
function readPathFromCommand(cmd: string): string | undefined {
  if (SHELL_META.test(cmd)) return undefined; // pipeline/redirect/compound
  const tokens = tokenize(cmd);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? '')) i++; // skip env assignments
  const name = tokens[i];
  if (name === undefined) return undefined;
  const base = name.split('/').pop() ?? name; // /usr/bin/sed → sed
  if (!READ_COMMANDS.has(base)) return undefined;
  // The file is the last non-flag argument; a read command's other args (sed's
  // script, a -n flag) precede it.
  for (let j = tokens.length - 1; j > i; j--) {
    const t = tokens[j] ?? '';
    if (t && !t.startsWith('-')) return t;
  }
  return undefined;
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

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

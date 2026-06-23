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
 *     with a structured `input.file_path`: a clean read/write signal. Searches
 *     (Grep/Glob) and Bash are skipped so the last real file touch still shows —
 *     claude's structured tools already give it high coverage.
 *   - codex (reviewer by default, read-only; implementer when bound there) — its
 *     work is shell commands (`exec_command` with `arguments.cmd` =
 *     `sed -n '1,260p' CLAUDE.md`), so for a long time only a confident single
 *     known read file surfaced and codex panes read near-blank: most of a codex
 *     reviewer's turn is `rg` searches, chained/piped reads, and `git`/`pnpm`
 *     runs (observed: of ~172 commands in one run, ~23 were the simple-read
 *     shape). Because the goal here is LIVENESS, not a precise audit trail, codex
 *     commands now classify into a bounded vocabulary — `read` (a known read
 *     command's first file operand), `search` (`rg`/`grep`/`find`/`ls`), and
 *     `run` (`git`/`pnpm`/`node`/…) — taking the FIRST pipeline/chain segment as
 *     the sourcing action (`nl f | sed` → reads `f`; `sed a && sed b` → reads
 *     `a`). It is honest-but-low-fidelity: never the raw command, never a guessed
 *     path, and a redirect/command-substitution or an unknown tool still surfaces
 *     no line. Writes come from an `apply_patch` custom_tool_call, from whose
 *     patch text we read the first file HEADER path, never a hunk.
 *
 * Scope stays bounded — a path, a short search target, or a `<tool> <subcommand>`
 * phrase: no message text, no full command, no diffs. A changed-line count is
 * deliberately dropped too — neither provider hands one over for free (claude
 * only a `structuredPatch` needing correlation+summing, codex nothing).
 */

import { isAbsolute, relative } from 'node:path';
import { parseRecords } from './worker-health.ts';
import type { JsonRecord, Schema } from './worker-health.ts';

/**
 * One worker action, normalized across providers. `id` is the provider-native
 * tool-call id (claude `tool_use.id` / codex `call_id`) — the stable key the
 * heartbeat poll dedups on, so the same action is never re-emitted across ticks.
 *  - `read`   — a file read; the path is the whole signal.
 *  - `write`  — an edit/write happened; the path, never its contents.
 *  - `search` — a codex search/listing (`rg`/`grep`/`find`/`ls`); `subject` is
 *               the target path(s) or pattern, never the raw command.
 *  - `run`    — a codex command run (`git`/`pnpm`/`node`/…); `subject` is a short
 *               `<tool> <subcommand>` phrase, never the raw command.
 * `read`/`write` carry a `path` (the poll relativizes it to repo-root before it
 * logs); `search`/`run` carry an already-concise `subject`. Anything that can't
 * be pinned to one of these surfaces no activity.
 */
export type WorkerActivity = { id: string } & WorkerAction;

/** A worker action without its tool-call id — what the per-provider classifiers
 *  return; the scan attaches the id. A discriminated union (not `Omit<…, 'id'>`,
 *  which would collapse the variants to their common keys). */
type WorkerAction =
  | { kind: 'read'; path: string }
  | { kind: 'write'; path: string }
  | { kind: 'search'; subject: string }
  | { kind: 'run'; subject: string };

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
    case 'search':
      return `${ACTIVITY_MARKER} searching ${activity.subject}`;
    case 'run':
      return `${ACTIVITY_MARKER} running ${activity.subject}`;
  }
}

/**
 * A worker-reported path made repo-relative — the canonical voice-log form (like
 * git's repo-relative paths; an absolute path leaks the machine's worktree
 * location, and claude/codex disagree on which they emit). Applied at
 * produce-time by the heartbeat poll, which holds the run's cwd. Pure: node:path
 * is string-only (no fs). An already-relative path (codex) passes through
 * unchanged; an absolute path OUTSIDE the repo keeps its absolute form — a
 * `../../…` rewrite would read worse than the honest absolute.
 */
export function repoRelative(p: string, cwd: string): string {
  if (!isAbsolute(p)) return p;
  const rel = relative(cwd, p);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : p;
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

// ── codex: function_call (shell work) + apply_patch custom_tool_call (writes) ──

/** Read commands that take their target file(s) as plain argument(s). */
const READ_COMMANDS = new Set(['cat', 'sed', 'head', 'tail', 'nl']);
/** Search/listing commands — exploration, surfaced as `search` with a target. */
const SEARCH_COMMANDS = new Set(['rg', 'grep', 'egrep', 'fgrep', 'ag', 'fd', 'find', 'ls']);
/** Search commands whose FIRST operand is the pattern, not a path (so the path
 *  targets, if any, are the better subject; the pattern is the fallback). */
const PATTERN_FIRST = new Set(['rg', 'grep', 'egrep', 'fgrep', 'ag']);
/** Tool-runners — surfaced as `run` with a short `<tool> <subcommand>` phrase. */
const RUN_COMMANDS = new Set([
  'git', 'pnpm', 'npm', 'yarn', 'npx', 'pnpx', 'node', 'tsc', 'vitest', 'jest', 'eslint', 'prettier', 'make', 'cargo', 'go', 'python', 'python3',
]);
/** Shell control operators that separate pipeline/chain segments (own tokens). */
const CONTROL_OPS = new Set(['|', '||', '&&', ';', '&']);
/** Redirect operators — a redirected first segment is too ambiguous, no line. */
const REDIRECT = new Set(['>', '>>', '<', '<<', '2>', '&>']);
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Cap on a search/run subject — telemetry, never a full command transcript. */
const SUBJECT_MAX = 60;
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
    // Shell work (`exec_command`/`shell`): classified into the bounded read /
    // search / run vocabulary. An unknown tool, a redirect, or a command
    // substitution surfaces nothing — we keep scanning older for the last
    // recognizable action, never a guessed path and never the raw command.
    if (type === 'function_call' && (p['name'] === 'exec_command' || p['name'] === 'shell')) {
      const cmd = commandString(p['arguments']);
      const act = cmd !== undefined ? classifyCommand(cmd) : undefined;
      if (act !== undefined) return { id, ...act };
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

/** The action (sans id) a codex shell command sources, or undefined when nothing
 *  recognizable can be pinned. Reduces a pipeline/chain to its FIRST segment (the
 *  sourcing command), bails on a redirect or command substitution, then classifies
 *  the segment's tool into read / search / run. Never the raw command. */
function classifyCommand(cmd: string): WorkerAction | undefined {
  const tokens = tokenize(cmd);
  // First pipeline/chain segment: `nl f | sed …` reads `f`; `sed a && sed b`
  // reads `a` — the action currently sourcing the work.
  const opIdx = tokens.findIndex((t) => CONTROL_OPS.has(t));
  const seg = opIdx === -1 ? tokens : tokens.slice(0, opIdx);
  // A redirect or command substitution makes the target ambiguous — no line.
  if (seg.some((t) => REDIRECT.has(t) || t.includes('`') || t.includes('$('))) return undefined;
  let i = 0;
  while (i < seg.length && ENV_ASSIGN.test(seg[i] ?? '')) i++; // skip leading env assignments
  const tool = (seg[i] ?? '').split('/').pop() ?? ''; // /usr/bin/sed → sed
  const args = seg.slice(i + 1);
  if (!tool) return undefined;
  if (READ_COMMANDS.has(tool)) {
    const operands = fileOperands(tool, args);
    const path = operands[0];
    return path !== undefined ? { kind: 'read', path } : undefined; // first of a multi-file read; none → no line
  }
  if (SEARCH_COMMANDS.has(tool)) return { kind: 'search', subject: searchSubject(tool, args) };
  if (RUN_COMMANDS.has(tool)) return { kind: 'run', subject: runSubject(tool, args) };
  return undefined; // unknown tool → stay conservative, no line
}

/** A search/listing command's subject: its first path target when present, else
 *  its pattern (for the pattern-first searchers) — the first meaningful operand,
 *  not all of them, which sidesteps flag-value noise (`find x -maxdepth 2` → `x`)
 *  and reads cleanly; never the raw command, capped. */
function searchSubject(tool: string, args: string[]): string {
  const operands = bareOperands(args);
  if (PATTERN_FIRST.has(tool)) {
    const subject = operands[1] ?? operands[0] ?? tool; // first path target, else the pattern, else the tool
    return truncate(subject, SUBJECT_MAX);
  }
  return truncate(operands[0] ?? tool, SUBJECT_MAX); // find/ls: the first path/root
}

/** A tool-run's subject: the tool plus its subcommand when the next token is one
 *  (not a flag) — `git diff --stat` → "git diff", `pnpm --filter x test` → "pnpm". */
function runSubject(tool: string, args: string[]): string {
  const next = args[0];
  return next !== undefined && next.length > 0 && !next.startsWith('-') ? `${tool} ${next}` : tool;
}

/** Non-flag operands, honoring a `--` end-of-options marker. Best-effort: a flag's
 *  separate value may leak in (telemetry, not a parser) — bounded by the cap. */
function bareOperands(args: string[]): string[] {
  const out: string[] = [];
  let endOfOptions = false;
  for (const t of args) {
    if (endOfOptions) {
      out.push(t);
      continue;
    }
    if (t === '--') {
      endOfOptions = true;
      continue;
    }
    if (t.startsWith('-')) continue;
    out.push(t);
  }
  return out;
}

/** Truncate a subject to a cap with an ellipsis — never a full command transcript. */
function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** The file operands of a known read command — option flags removed (and the
 *  separate numeric value of head/tail `-n`/`-c`), and sed's leading script
 *  argument dropped. Returns every remaining operand in order; the caller takes
 *  the first as the read's current file (a multi-file read shows its first). */
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

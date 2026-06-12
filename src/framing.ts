import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';
import { GATE_PHASES } from './phases.ts';
import type { GatePhase } from './phases.ts';
import { ensureDuetDir } from './run-store.ts';

/**
 * The framing — the one file the human writes per run, and the only place
 * project knowledge enters the system. This module owns its whole journey:
 * the template, the bare-`duet new` editor flow, the machine/prose
 * frontmatter boundary, and the resolution of CLI flags against frontmatter
 * into a run's inputs.
 *
 * The frontmatter boundary rule (settled 2026-06-12, see
 * docs/automation-design.md §"Gate pre-authorization"): a key belongs in
 * frontmatter only when its practical expression is a FIXED VALUE and a
 * DETERMINISTIC CONSUMER (the harness) acts on it without judgment. If the
 * value is natural language with riders, or the consumer is the orchestrator
 * applying judgment, it stays in the prose body. Spec/plan locations,
 * verification posture, skills, planning style: prose, always — the planlab
 * run is the evidence (the framing's literal spec dir was wrong relative to
 * the worktree root and judgment resolved it).
 *
 * Current keys: `gates_at`, `spec`. Pre-approved for later: `budget_usd`,
 * if open-questions Q19 resolves in favor of a run-level budget model.
 *
 * Frontmatter is parsed at `duet new` and STRIPPED before the framing body
 * is embedded in the orchestrator's prompt — the orchestrator sees only the
 * rendered posture instructions, never the raw config, so there is exactly
 * one source of truth in its context.
 */

export const DEFAULT_FRAMING_FILE = join('.duet', 'framing-draft.md');

export const FRAMING_TEMPLATE = `---
# Machine-parsed options (fixed values the harness acts on; judgment-weighed
# detail belongs in the prose below). Uncomment to use.
# gates_at: frame, spec   — phases whose gates you attend; the rest are
#                           pre-authorized and auto-cross with packets
#                           recorded. Preset: overnight = frame,spec.
#                           pr is always attended. Default: every gate.
# spec: path/to/draft.md  — enter at the spec review loop (skips FRAME).
---

# Problem
<what to build or change, why, and the scope boundaries — what's explicitly out>

# Onboarding
<skill to invoke (e.g. /onboarding <topic>) or files each worker should read first>
<park any assets the framing references (screenshots, mocks) under .duet/ —
 paths like ~/Desktop rot out from under old runs>

# Conventions
- Specs live at: <e.g. docs/specs/YYYY-MM-DD-<slug>.md>
- Plans live at: <path or directory convention — required>
- Branch: <"this worktree's branch is the run's branch", or a naming convention>
- Commit style: <conventional commits / your norm>

# Verification
- Typecheck: <command>
- Tests: <command>
- Environment-only actions (migrations, deploys): flag me — never attempt.

# Docs
<docs-update skill name if one exists, else where docs live and what usually needs updating>

# Planning style
<tdd-plan vs start-plan preference, or let the orchestrator judge>
`;

/** GUI editors that detach by default and need a wait flag to block. */
const NEEDS_WAIT_FLAG = new Set(['code', 'code-insiders', 'cursor', 'windsurf', 'subl', 'zed']);

function resolveEditor(): { command: string; args: string[] } {
  const raw = process.env['VISUAL'] || process.env['EDITOR'] || 'vi';
  const parts = raw.split(/\s+/).filter(Boolean);
  const command = parts[0] ?? 'vi';
  const args = parts.slice(1);
  if (NEEDS_WAIT_FLAG.has(basename(command)) && !args.includes('--wait') && !args.includes('-w')) {
    args.push('--wait');
  }
  return { command, args };
}

/**
 * The bare `duet new` entry: open the user's editor on a draft framing file
 * under .duet/ (seeding the template when the file doesn't exist), block
 * until it closes, and return the file name to run with. Throws when the
 * user wrote nothing — an empty or untouched template means "don't start
 * the run"; an aborted edit leaves the draft in place for next time.
 */
export async function editFramingForRun(cwd: string): Promise<string> {
  ensureDuetDir(cwd);
  const path = join(cwd, DEFAULT_FRAMING_FILE);
  if (!existsSync(path)) writeFileSync(path, FRAMING_TEMPLATE);

  const { command, args } = resolveEditor();
  console.log(`no --spec/--framing given — opening ${DEFAULT_FRAMING_FILE} in ${basename(command)}; write the framing, save, and close to start the run`);
  try {
    await execa(command, [...args, path], { stdio: 'inherit' });
  } catch (err) {
    const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
    throw new Error(`editor exited with an error (${detail}) — run not started; anything you saved is in ${DEFAULT_FRAMING_FILE}`);
  }

  const content = readFileSync(path, 'utf8');
  if (!content.trim()) {
    throw new Error(`run not started: ${DEFAULT_FRAMING_FILE} is empty`);
  }
  if (content.trim() === FRAMING_TEMPLATE.trim()) {
    throw new Error(`run not started: ${DEFAULT_FRAMING_FILE} is still the untouched template — fill it in (it's saved for next time)`);
  }
  return DEFAULT_FRAMING_FILE;
}

/** Named presets — pure aliases for gate lists, never a separate vocabulary. */
const GATES_AT_PRESETS: Record<string, GatePhase[]> = {
  overnight: ['frame', 'spec'],
};

export interface FramingFrontmatter {
  gatesAt?: GatePhase[];
  spec?: string;
}

const frontmatterSchema = z.object({
  gates_at: z.string().optional(),
  spec: z.string().optional(),
});

/**
 * Parse a `--gates-at` value: a preset name or a comma/space-separated list
 * of gate-bearing phase names. `pr` is force-appended — the Open-PR gate is
 * never pre-authorizable. Throws with the full vocabulary on bad input.
 */
export function parseGatesAt(value: string): GatePhase[] {
  const preset = GATES_AT_PRESETS[value.trim()];
  const names = preset ?? value.split(/[,\s]+/).filter(Boolean);
  const gates: GatePhase[] = [];
  for (const name of names) {
    if (!(GATE_PHASES as readonly string[]).includes(name)) {
      throw new Error(
        `gates_at: "${name}" is not a gate-bearing phase — use a list from {${GATE_PHASES.join(', ')}} or the preset "overnight" (= frame,spec). The open phase has no gate; pr is always attended.`,
      );
    }
    if (!gates.includes(name as GatePhase)) gates.push(name as GatePhase);
  }
  if (gates.length === 0) {
    throw new Error(`gates_at is empty — list the phases whose gates you will attend (from {${GATE_PHASES.join(', ')}}), or omit it to attend every gate.`);
  }
  if (!gates.includes('pr')) gates.push('pr');
  return gates;
}

/**
 * Split a framing file into its frontmatter (parsed, validated) and its
 * prose body (what the orchestrator gets). Files without a leading `---`
 * block pass through untouched. Unknown keys and bad values fail loudly —
 * a config typo that silently became prose would change run behavior.
 */
export function parseFramingFile(content: string): { meta: FramingFrontmatter; body: string } {
  if (!content.startsWith('---\n')) return { meta: {}, body: content };
  const end = content.indexOf('\n---', 4);
  if (end === -1) {
    throw new Error('framing frontmatter opened with "---" but never closed — add the closing "---" line or remove the block');
  }
  const block = content.slice(4, end);
  // EOF right after the closing --- means an empty body (indexOf would
  // return -1 and slice(0) would hand back the whole file, frontmatter included).
  const afterClose = content.indexOf('\n', end + 1);
  const body = afterClose === -1 ? '' : content.slice(afterClose + 1).replace(/^\n/, '');

  const raw: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) {
      throw new Error(`framing frontmatter line "${trimmed}" is not "key: value" — only key/value pairs and # comments are allowed in the block`);
    }
    const key = trimmed.slice(0, colon).trim();
    raw[key] = trimmed.slice(colon + 1).trim();
  }

  const parsed = frontmatterSchema.strict().safeParse(raw);
  if (!parsed.success) {
    const unknown = Object.keys(raw).filter((k) => !(k in frontmatterSchema.shape));
    throw new Error(
      unknown.length > 0
        ? `framing frontmatter has unknown key(s): ${unknown.join(', ')} — valid keys are gates_at and spec. Everything the orchestrator should weigh with judgment belongs in the prose body, not here.`
        : `framing frontmatter is invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }

  const meta: FramingFrontmatter = {};
  if (parsed.data.gates_at) meta.gatesAt = parseGatesAt(parsed.data.gates_at);
  if (parsed.data.spec) meta.spec = parsed.data.spec;
  return { meta, body };
}

/** A run's resolved inputs — what `duet new` hands to createRun. */
export interface RunInputs {
  /** The framing prose body (frontmatter stripped) — what the orchestrator sees. */
  framing?: string;
  /** The verbatim framing file, for the run-dir archive. */
  framingRaw?: string;
  gatesAt?: GatePhase[];
  /** Validated spec path, relative to cwd. */
  specPath?: string;
  /** The framing file used, when one was (the CLI consumes the editor draft after archiving). */
  framingFile?: string;
}

/**
 * Resolve `duet new`'s inputs: with neither --spec nor --framing, run the
 * editor flow; parse the framing's frontmatter; apply flag-over-frontmatter
 * precedence for gates_at and spec; validate the spec file exists. Throws
 * with actionable messages — the CLI surfaces them verbatim.
 */
export async function resolveRunInputs(
  cwd: string,
  opts: { spec?: string; framing?: string; gatesAt?: string },
): Promise<RunInputs> {
  let framingFile = opts.framing;
  if (!opts.spec && !framingFile) {
    framingFile = await editFramingForRun(cwd);
  }

  let framingRaw: string | undefined;
  let framing: string | undefined;
  let meta: FramingFrontmatter = {};
  if (framingFile) {
    framingRaw = readFileSync(resolve(cwd, framingFile), 'utf8');
    try {
      const parsed = parseFramingFile(framingRaw);
      meta = parsed.meta;
      framing = parsed.body;
    } catch (err) {
      throw new Error(`${framingFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const gatesAt = opts.gatesAt ? parseGatesAt(opts.gatesAt) : meta.gatesAt; // flag wins over frontmatter

  let specPath: string | undefined;
  const specInput = opts.spec ?? meta.spec; // flag wins over frontmatter
  if (specInput) {
    specPath = relative(cwd, resolve(cwd, specInput));
    if (!existsSync(resolve(cwd, specPath))) {
      throw new Error(`spec file not found: ${specInput}`);
    }
  }

  return {
    ...(framing !== undefined ? { framing } : {}),
    ...(framingRaw !== undefined ? { framingRaw } : {}),
    ...(gatesAt ? { gatesAt } : {}),
    ...(specPath ? { specPath } : {}),
    ...(framingFile ? { framingFile } : {}),
  };
}

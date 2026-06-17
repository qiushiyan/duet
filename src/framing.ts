import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';
import { GATE_PHASES } from './phases.ts';
import type { GatePhase } from './phases.ts';
import { ensureDuetDir } from './run-store.ts';

/**
 * The framing — the one file the human writes per run, and the only place
 * project knowledge enters the system. This module owns its whole journey:
 * the seed template (the built-in default, or a project's own
 * `.duet/templates/<name>.md` selected with `--template`), the bare-`duet new`
 * editor flow, the machine/prose frontmatter boundary, and the resolution of
 * CLI flags against frontmatter into a run's inputs. A template is just
 * pre-baked framing — it seeds the editor draft and is then parsed and
 * archived like any framing, so the framing turn stays the single entry seam.
 *
 * The frontmatter boundary rule (settled 2026-06-12, see
 * docs/automation-design.md §"Gate pre-authorization"): a key belongs in
 * frontmatter only when its practical expression is a FIXED VALUE and a
 * DETERMINISTIC CONSUMER (the harness) acts on it without judgment. If the
 * value is natural language with riders, or the consumer is the orchestrator
 * applying judgment, it stays in the prose body. Spec/plan locations,
 * verification posture, skills: prose, always — the planlab
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

/**
 * Where a project keeps its own framing seed templates, mirroring
 * `.github/ISSUE_TEMPLATE/`. Self-ignored like the rest of `.duet/` — a
 * template is the human's own convenience for composing the framing turn,
 * not a tracked artifact of the host repo (augment, never lock in). Commit
 * them by carving `!/templates/` into `.duet/.gitignore` if you want them
 * shared across worktrees.
 */
export const TEMPLATES_DIR = join('.duet', 'templates');

export const FRAMING_TEMPLATE = `---
# Machine-parsed options (fixed values the harness acts on; judgment-weighed
# detail belongs in the prose below). Uncomment to use.
# gates_at: skip-plan     — phases whose gates you attend; the rest are
#                           pre-authorized and auto-cross with packets
#                           recorded. Presets: skip-plan (walk away at spec
#                           approval, return at the Ship gate) and overnight
#                           (= frame,spec). Or a list, e.g. "frame, spec".
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
 * A template name selects a file in TEMPLATES_DIR — it is a plain slug, never
 * a path. Reject separators, traversal, and leading dots so `--template` can
 * never read outside the templates dir; append the `.md` extension when the
 * name omits it.
 */
function templateFileName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.startsWith('.') || !/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error(
      `template name "${name}" is not a plain name — it selects a file in ${TEMPLATES_DIR}, so use letters, digits, "-" or "_" (no slashes or "..")`,
    );
  }
  return trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
}

/** A "did you mean…" tail for a missing-template error: the .md names present
 *  in the templates dir, or a nudge to create the dir. */
function availableTemplatesHint(dir: string): string {
  if (!existsSync(dir)) return `; no ${TEMPLATES_DIR}/ directory yet — create it and add <name>.md files`;
  const names = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -'.md'.length));
  return names.length > 0 ? `; available: ${names.join(', ')}` : `; ${TEMPLATES_DIR}/ has no .md templates yet`;
}

/**
 * Resolve the text that seeds a fresh framing draft. Templates are pre-baked
 * framings — a full framing file (frontmatter + prose), parsed normally at run
 * time, so a template can pre-set `gates_at` as well as the prose skeleton.
 *
 * A named template (`--template <name>`) reads `.duet/templates/<name>.md` and
 * fails loudly, listing what's available, when it's missing — a typo'd name
 * must never silently fall back to the built-in and start the wrong run. With
 * no name, a project's own `.duet/templates/default.md` overrides the built-in
 * when present; otherwise the built-in FRAMING_TEMPLATE.
 */
export function resolveTemplateSeed(cwd: string, templateName?: string): string {
  const dir = resolve(cwd, TEMPLATES_DIR);
  if (templateName !== undefined) {
    const file = templateFileName(templateName);
    const path = join(dir, file);
    if (!existsSync(path)) {
      throw new Error(`template "${templateName}" not found at ${join(TEMPLATES_DIR, file)}${availableTemplatesHint(dir)}`);
    }
    return readFileSync(path, 'utf8');
  }
  const fallback = join(dir, 'default.md');
  return existsSync(fallback) ? readFileSync(fallback, 'utf8') : FRAMING_TEMPLATE;
}

/**
 * The bare `duet new` entry: open the user's editor on a draft framing file
 * under .duet/ (seeding it from `resolveTemplateSeed` when the file doesn't
 * exist), block until it closes, and return the file name to run with. Throws
 * when the user wrote nothing — an empty or untouched template means "don't
 * start the run"; an aborted edit leaves the draft in place for next time.
 */
export async function editFramingForRun(cwd: string, templateName?: string): Promise<string> {
  ensureDuetDir(cwd);
  const path = join(cwd, DEFAULT_FRAMING_FILE);
  const seed = resolveTemplateSeed(cwd, templateName);
  // An explicit --template is a deliberate "start from this template": it
  // (re)seeds the draft even over a stale one (with a note, since that
  // discards it). The bare path leaves an existing draft alone, so aborted
  // work survives to the next `duet new`.
  if (templateName !== undefined) {
    if (existsSync(path)) console.log(`--template ${templateName}: re-seeding ${DEFAULT_FRAMING_FILE} (previous draft discarded)`);
    writeFileSync(path, seed);
  } else if (!existsSync(path)) {
    writeFileSync(path, seed);
  }

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
  // Untouched = identical to a seed this draft could have been created from:
  // the seed we'd write now (built-in, default.md, or the named template) OR
  // the built-in template. The bare path reuses an existing draft without
  // reseeding, so across runs an on-disk draft can predate the current seed
  // (e.g. a default.md added since it was last written); folding in the
  // built-in keeps an unfilled draft from silently launching a run.
  const trimmed = content.trim();
  if (trimmed === seed.trim() || trimmed === FRAMING_TEMPLATE.trim()) {
    throw new Error(`run not started: ${DEFAULT_FRAMING_FILE} is still the untouched template — fill it in (it's saved for next time)`);
  }
  return DEFAULT_FRAMING_FILE;
}

/**
 * Open the user's editor on a throwaway file and return what they saved —
 * the no-inline-text path for gate riders and rejection feedback (a shell
 * flag is a hostile place to compose substantial prose). The instruction
 * seed is a leading HTML comment, stripped on read, so what the user writes
 * is used verbatim. The temp file is deleted afterwards: the text's only
 * life is the staging handshake it feeds.
 */
export async function composeInEditor(instructions: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'duet-compose-'));
  const path = join(dir, 'message.md');
  writeFileSync(path, `<!-- ${instructions}\n     Write below this line; save and close to send. This file is discarded after reading. -->\n\n`);
  const { command, args } = resolveEditor();
  console.log(`opening ${basename(command)} — write the text, save, and close`);
  try {
    await execa(command, [...args, path], { stdio: 'inherit' });
    const content = readFileSync(path, 'utf8');
    return content.replace(/^<!--[\s\S]*?-->\s*/, '').trim();
  } catch (err) {
    const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
    throw new Error(`editor exited with an error (${detail}) — nothing was sent`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Resolve a piece of human input that may arrive inline or via the editor —
 * the one path shared by every command that takes the human's words
 * (`continue --approve/--reject/--answer`, `steer`). An inline string (a
 * `--flag "text"` value or a positional argument) is returned verbatim; a
 * bare flag (commander hands back `true`) or an omitted optional argument
 * (`undefined`) opens the editor on a throwaway file seeded with
 * `instructions` (see `composeInEditor`). Callers decide what an empty
 * result means — approve treats it as "no rider", the rest abort.
 */
export async function resolveHumanText(
  inline: string | boolean | undefined,
  instructions: string,
): Promise<string> {
  return typeof inline === 'string' ? inline : composeInEditor(instructions);
}

/** Named presets — pure aliases for gate lists, never a separate vocabulary. */
const GATES_AT_PRESETS: Record<string, GatePhase[]> = {
  /** Attend nothing after the spec — the full sleep posture. */
  overnight: ['frame', 'spec'],
  /**
   * Walk away at spec approval, return at the Ship gate — the plan loop runs
   * unattended. Born from run evidence (the human reports rubber-stamping
   * plan gates); whether this earns default status is Q20's evidence stream.
   */
  'skip-plan': ['frame', 'spec', 'impl', 'docs'],
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
        `gates_at: "${name}" is not a gate-bearing phase — use a list from {${GATE_PHASES.join(', ')}} or a preset: "overnight" (= frame,spec) or "skip-plan" (= frame,spec,impl,docs — walk away at spec approval, return at the Ship gate). The open phase has no gate; pr is always attended.`,
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
 * editor flow (seeded from --template or the project default); parse the
 * framing's frontmatter; apply flag-over-frontmatter precedence for gates_at
 * and spec; validate the spec file exists. Throws with actionable messages —
 * the CLI surfaces them verbatim.
 */
export async function resolveRunInputs(
  cwd: string,
  opts: { spec?: string; framing?: string; gatesAt?: string; template?: string },
): Promise<RunInputs> {
  if (opts.template !== undefined && (opts.spec || opts.framing)) {
    throw new Error(
      '--template seeds the editor draft for the bare `duet new` flow — it conflicts with --spec/--framing, which supply the framing directly',
    );
  }
  let framingFile = opts.framing;
  if (!opts.spec && !framingFile) {
    framingFile = await editFramingForRun(cwd, opts.template);
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

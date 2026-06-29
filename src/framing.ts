import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { execa } from "execa";
import { z } from "zod";
import { WORKFLOWS, gatePhasesOf } from "./phases.ts";
import type { GatePhase, WorkflowName } from "./phases.ts";
import { ensureDuetDir } from "./run-store.ts";

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

export const DEFAULT_FRAMING_FILE = join(".duet", "framing-draft.md");

/**
 * Where a project keeps its own framing seed templates, mirroring
 * `.github/ISSUE_TEMPLATE/`. Self-ignored like the rest of `.duet/` — a
 * template is the human's own convenience for composing the framing turn,
 * not a tracked artifact of the host repo (augment, never lock in). Commit
 * them by carving `!/templates/` into `.duet/.gitignore` if you want them
 * shared across worktrees.
 */
export const TEMPLATES_DIR = join(".duet", "templates");

export const FRAMING_TEMPLATE = `---
# Machine-parsed options (fixed values the harness acts on; judgment-weighed
# detail belongs in the prose below). Uncomment to use.
# workflow: full          — full (default): frame → spec → plan → impl →
#                           finish (reconcile docs, open a PR). rir:
#                           research → implement → review → publish (open a PR;
#                           no spec/plan), for small, well-understood work.
# gates_at: overnight     — phases whose gates you attend; the rest are
#                           pre-authorized and auto-cross with packets
#                           recorded. Presets are workflow-specific: full →
#                           skip-plan (walk away at spec approval, return at the
#                           Ship gate) / overnight (= frame,spec); rir → afk
#                           (attend none). Or a list, e.g. "frame, spec".
#                           Default: overnight — attend frame and spec; plan,
#                           Ship, and the Open-PR gate all auto-cross. List
#                           "finish" to stop and review the opened PR. rir
#                           attends all three of its gates by default.
# spec: path/to/draft.md  — enter at the spec review loop (skips FRAME). full-only.
---

# Problem

# Onboarding

# Conventions
- Specs live at: docs/specs
- Plans live at: docs/plans
- Branch: current branch

# Verification


Never lint or typecheck on the global project.

# Docs

`;

/** GUI editors that detach by default and need a wait flag to block. */
const NEEDS_WAIT_FLAG = new Set(["code", "code-insiders", "cursor", "windsurf", "subl", "zed"]);

function resolveEditor(): { command: string; args: string[] } {
  const raw = process.env["VISUAL"] || process.env["EDITOR"] || "vi";
  const parts = raw.split(/\s+/).filter(Boolean);
  const command = parts[0] ?? "vi";
  const args = parts.slice(1);
  if (NEEDS_WAIT_FLAG.has(basename(command)) && !args.includes("--wait") && !args.includes("-w")) {
    args.push("--wait");
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
  if (trimmed.startsWith(".") || !/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error(
      `template name "${name}" is not a plain name — it selects a file in ${TEMPLATES_DIR}, so use letters, digits, "-" or "_" (no slashes or "..")`,
    );
  }
  return trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
}

/** A "did you mean…" tail for a missing-template error: the .md names present
 *  in the templates dir, or a nudge to create the dir. */
function availableTemplatesHint(dir: string): string {
  if (!existsSync(dir))
    return `; no ${TEMPLATES_DIR}/ directory yet — create it and add <name>.md files`;
  const names = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -".md".length));
  return names.length > 0
    ? `; available: ${names.join(", ")}`
    : `; ${TEMPLATES_DIR}/ has no .md templates yet`;
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
      throw new Error(
        `template "${templateName}" not found at ${join(TEMPLATES_DIR, file)}${availableTemplatesHint(dir)}`,
      );
    }
    return readFileSync(path, "utf8");
  }
  const fallback = join(dir, "default.md");
  return existsSync(fallback) ? readFileSync(fallback, "utf8") : FRAMING_TEMPLATE;
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
    if (existsSync(path))
      console.log(
        `--template ${templateName}: re-seeding ${DEFAULT_FRAMING_FILE} (previous draft discarded)`,
      );
    writeFileSync(path, seed);
  } else if (!existsSync(path)) {
    writeFileSync(path, seed);
  }

  const { command, args } = resolveEditor();
  console.log(
    `no --spec/--framing given — opening ${DEFAULT_FRAMING_FILE} in ${basename(command)}; write the framing, save, and close to start the run`,
  );
  try {
    await execa(command, [...args, path], { stdio: "inherit" });
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new Error(
      `editor exited with an error (${detail}) — run not started; anything you saved is in ${DEFAULT_FRAMING_FILE}`,
    );
  }

  const content = readFileSync(path, "utf8");
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
    throw new Error(
      `run not started: ${DEFAULT_FRAMING_FILE} is still the untouched template — fill it in (it's saved for next time)`,
    );
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
  const dir = mkdtempSync(join(tmpdir(), "duet-compose-"));
  const path = join(dir, "message.md");
  writeFileSync(
    path,
    `<!-- ${instructions}\n     Write below this line; save and close to send. This file is discarded after reading. -->\n\n`,
  );
  const { command, args } = resolveEditor();
  console.log(`opening ${basename(command)} — write the text, save, and close`);
  try {
    await execa(command, [...args, path], { stdio: "inherit" });
    const content = readFileSync(path, "utf8");
    return content.replace(/^<!--[\s\S]*?-->\s*/, "").trim();
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
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
 * `instructions` (see `composeInEditor`) — but ONLY on an interactive
 * terminal.
 *
 * Off a TTY (a headless concierge, a piped invocation) a bare flag returns
 * the `undefined` SENTINEL instead of opening an editor the caller can't
 * drive — the non-interactive editor hang this fixes (#6). `undefined` is
 * deliberately distinct from `""` (an editor saved empty): the caller maps
 * the sentinel per intent — approve treats it as "no rider", reject/answer/
 * steer fail fast naming the inline/file/stdin forms. Both subprocess seams are
 * injected so tests pin behavior without a real terminal: `isTTY` for
 * interactivity, `compose` for the editor launch (defaults to the real
 * `composeInEditor` — a faked `compose` avoids spawning an editor child).
 */
export async function resolveHumanText(
  inline: string | boolean | undefined,
  instructions: string,
  { isTTY = Boolean(process.stdin.isTTY), compose = composeInEditor }: { isTTY?: boolean; compose?: (instructions: string) => Promise<string> } = {},
): Promise<string | undefined> {
  if (typeof inline === "string") return inline;
  if (!isTTY) return undefined;
  return compose(instructions);
}

export interface FramingFrontmatter {
  gatesAt?: GatePhase[];
  spec?: string;
  retryInfra?: number;
  workflow?: WorkflowName;
  /** The gateless posture (a fixed boolean the harness acts on — boundary-rule shape). */
  gateless?: boolean;
  /** Orchestrate this run from the human's interactive session (the --interactive flag by another door). */
  interactive?: boolean;
  /**
   * A per-run consultant TOGGLE — flip a config-bound consultant on or off for this
   * run, the posture-shaped half of the consultant knob. The BINDING (which
   * provider/model) stays config/--consultant: a fixed value the harness acts on
   * earns frontmatter; a role binding does not.
   */
  consultant?: 'on' | 'off';
}

const frontmatterSchema = z.object({
  gates_at: z.string().optional(),
  spec: z.string().optional(),
  retry_infra: z.string().optional(),
  workflow: z.string().optional(),
  gateless: z.string().optional(),
  interactive: z.string().optional(),
  consultant: z.string().optional(),
});

/**
 * Parse a boolean frontmatter value (`true`/`false`). Like `gates_at`, a fixed
 * value with a deterministic harness consumer — it earns frontmatter under the
 * boundary rule. Throws (never coerces a typo to false) so a misspelled posture
 * fails loudly rather than silently flipping the run.
 */
export function parseBoolKey(key: string, value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  throw new Error(`${key}: "${value}" is not a boolean — use true or false.`);
}

/**
 * Parse the `consultant` toggle (`on`/`off`). It flips a config-bound consultant
 * for one run — it never BINDS one, so a provider/model value is rejected with a
 * pointer to where bindings live. This is the toggle-vs-binding line that keeps
 * "which model" in config and the on/off posture in frontmatter.
 */
export function parseConsultantToggle(value: string): "on" | "off" {
  const v = value.trim().toLowerCase();
  if (v === "on") return "on";
  if (v === "off") return "off";
  throw new Error(
    `consultant: "${value}" is not on or off — the framing toggles a consultant on or off; it does not bind one. Choose the provider/model with --consultant or [roles.consultant] in your config.`,
  );
}

/** Validate a workflow name against the registry; throws with the valid set. */
export function parseWorkflow(value: string): WorkflowName {
  const names = Object.keys(WORKFLOWS) as WorkflowName[];
  if (!(names as string[]).includes(value.trim())) {
    throw new Error(`workflow: "${value}" is not a duet workflow — choose one of {${names.join(", ")}}.`);
  }
  return value.trim() as WorkflowName;
}

/**
 * Parse a `retry_infra` value: a non-negative integer attempt budget (0 ⇒ off).
 * A fixed value with a deterministic harness consumer, so it qualifies under the
 * frontmatter boundary rule, paralleling `gates_at`.
 */
export function parseRetryInfra(value: string): number {
  const n = Number(value.trim());
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`retry_infra: "${value}" is not a non-negative integer — it is the auto-retry attempt budget (0 or omit to disable).`);
  }
  return n;
}

/**
 * Parse a `--gates-at` value: a preset name or a comma/space-separated list
 * of gate-bearing phase names. Any workflow forceAttend gates are appended (the
 * generic non-pre-authorizable mechanism; currently empty for both workflows —
 * the Open-PR gate is pre-authorized-by-default now, attended only when `finish`
 * is listed). Throws with the full vocabulary on bad input.
 */
export function parseGatesAt(value: string, workflow: WorkflowName = "full"): GatePhase[] {
  const gatePhases = gatePhasesOf(workflow);
  const presets: Record<string, readonly string[]> = WORKFLOWS[workflow].presets;
  const presetNames = Object.keys(presets);
  const preset = presets[value.trim()];
  const matchedPreset = preset !== undefined;
  const names = preset ?? value.split(/[,\s]+/).filter(Boolean);
  const gates: GatePhase[] = [];
  for (const name of names) {
    if (!(gatePhases as readonly string[]).includes(name)) {
      const presetHint = presetNames.length > 0 ? ` or a preset: ${presetNames.join(", ")}` : "";
      throw new Error(
        `gates_at: "${name}" is not a gate-bearing phase of the "${workflow}" workflow — use a list from {${gatePhases.join(", ")}}${presetHint}.`,
      );
    }
    if (!gates.includes(name as GatePhase)) gates.push(name as GatePhase);
  }
  // A matched preset may legally resolve to an empty attended-gates list
  // (RIR's afk = [] ⇒ attend nothing); only a user-typed empty list is invalid.
  if (!matchedPreset && gates.length === 0) {
    throw new Error(
      `gates_at is empty — list the phases whose gates you will attend (from {${gatePhases.join(", ")}}), or omit it to attend every gate.`,
    );
  }
  for (const forced of WORKFLOWS[workflow].forceAttend) {
    if (!gates.includes(forced as GatePhase)) gates.push(forced as GatePhase);
  }
  return gates;
}

/**
 * Split a framing file into its frontmatter (parsed, validated) and its
 * prose body (what the orchestrator gets). Files without a leading `---`
 * block pass through untouched. Unknown keys and bad values fail loudly —
 * a config typo that silently became prose would change run behavior.
 */
export function parseFramingFile(content: string): { meta: FramingFrontmatter; body: string } {
  if (!content.startsWith("---\n")) return { meta: {}, body: content };
  const end = content.indexOf("\n---", 4);
  if (end === -1) {
    throw new Error(
      'framing frontmatter opened with "---" but never closed — add the closing "---" line or remove the block',
    );
  }
  const block = content.slice(4, end);
  // EOF right after the closing --- means an empty body (indexOf would
  // return -1 and slice(0) would hand back the whole file, frontmatter included).
  const afterClose = content.indexOf("\n", end + 1);
  const body = afterClose === -1 ? "" : content.slice(afterClose + 1).replace(/^\n/, "");

  const raw: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) {
      throw new Error(
        `framing frontmatter line "${trimmed}" is not "key: value" — only key/value pairs and # comments are allowed in the block`,
      );
    }
    const key = trimmed.slice(0, colon).trim();
    raw[key] = trimmed.slice(colon + 1).trim();
  }

  const parsed = frontmatterSchema.strict().safeParse(raw);
  if (!parsed.success) {
    const unknown = Object.keys(raw).filter((k) => !(k in frontmatterSchema.shape));
    throw new Error(
      unknown.length > 0
        ? `framing frontmatter has unknown key(s): ${unknown.join(", ")} — valid keys are gates_at, spec, retry_infra, workflow, gateless, interactive, and consultant. Everything the orchestrator should weigh with judgment belongs in the prose body, not here.`
        : `framing frontmatter is invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }

  const meta: FramingFrontmatter = {};
  if (parsed.data.workflow !== undefined) meta.workflow = parseWorkflow(parsed.data.workflow);
  // gates_at validates against the frontmatter's own workflow (default full);
  // resolveRunInputs re-validates if the --workflow flag overrides it. Guard is
  // key-present, not truthy, so a literal empty `gates_at:` reaches parseGatesAt
  // and is rejected rather than silently ignored.
  if (parsed.data.gates_at !== undefined) meta.gatesAt = parseGatesAt(parsed.data.gates_at, meta.workflow ?? "full");
  if (parsed.data.spec) meta.spec = parsed.data.spec;
  if (parsed.data.retry_infra !== undefined) meta.retryInfra = parseRetryInfra(parsed.data.retry_infra);
  if (parsed.data.gateless !== undefined) meta.gateless = parseBoolKey("gateless", parsed.data.gateless);
  if (parsed.data.interactive !== undefined) meta.interactive = parseBoolKey("interactive", parsed.data.interactive);
  if (parsed.data.consultant !== undefined) meta.consultant = parseConsultantToggle(parsed.data.consultant);
  return { meta, body };
}

/** A run's resolved inputs — what `duet new` hands to createRun. */
export interface RunInputs {
  /** The framing prose body (frontmatter stripped) — what the orchestrator sees. */
  framing?: string;
  /** The verbatim framing file, for the run-dir archive. */
  framingRaw?: string;
  gatesAt?: GatePhase[];
  /** The resolved workflow arc (flag > frontmatter > 'full'). */
  workflow: WorkflowName;
  /** Validated spec path, relative to cwd. */
  specPath?: string;
  /** Opt-in infra auto-retry budget (0/absent ⇒ off). */
  retryInfra?: number;
  /** The gateless posture (sugar: gatesAt already materialized to [] here). */
  gateless?: boolean;
  /**
   * Frontmatter launch/binding hints the CLI resolves against its own flags (the
   * flags win) — not createRun inputs, so the CLI pulls them out before createRun:
   * `interactive` picks the orchestrator host, `consultantToggle` flips the
   * consultant binding via loadRunConfig.
   */
  interactive?: boolean;
  consultantToggle?: "on" | "off";
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
  opts: { spec?: string; framing?: string; gatesAt?: string; template?: string; retryInfra?: string; workflow?: string; gateless?: boolean },
): Promise<RunInputs> {
  if (opts.template !== undefined && (opts.spec || opts.framing)) {
    throw new Error(
      "--template seeds the editor draft for the bare `duet new` flow — it conflicts with --spec/--framing, which supply the framing directly",
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
    framingRaw = readFileSync(resolve(cwd, framingFile), "utf8");
    try {
      const parsed = parseFramingFile(framingRaw);
      meta = parsed.meta;
      framing = parsed.body;
    } catch (err) {
      throw new Error(`${framingFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const workflow = opts.workflow !== undefined ? parseWorkflow(opts.workflow) : (meta.workflow ?? "full"); // flag wins
  const retryInfra = opts.retryInfra !== undefined ? parseRetryInfra(opts.retryInfra) : meta.retryInfra; // flag wins

  // gates_at resolves against the final workflow: the --gates-at flag parses
  // directly against it; a frontmatter list parsed against a different
  // frontmatter workflow is re-validated against the final one (the flag may
  // have overridden it), so a Full-shaped gates_at can't ride into a RIR run.
  let gatesAt: GatePhase[] | undefined;
  // Key-present, not truthy — matching parseFramingFile: a literal `--gates-at ""`
  // reaches parseGatesAt and is rejected as empty, rather than silently ignored
  // (defaulting to attend-all) the way a truthiness check would drop it.
  if (opts.gatesAt !== undefined) gatesAt = parseGatesAt(opts.gatesAt, workflow);
  else if (meta.gatesAt) gatesAt = workflow === (meta.workflow ?? "full") ? meta.gatesAt : parseGatesAt(meta.gatesAt.join(","), workflow);

  // Gateless is sugar over two axes: the posture axis (attend nothing) is
  // materialized here as gatesAt = []; the consultant axis (backstop-only) rides
  // the returned `gateless` flag onto RunState. Because gateless already
  // pre-authorizes every gate, naming gates to attend is a contradiction — reject
  // an explicit attend-something gates_at rather than silently dropping it. An
  // explicit attend-NONE preset (rir's afk → []) is compatible (same posture).
  const gateless = opts.gateless ?? meta.gateless ?? false; // flag wins over frontmatter
  if (gateless) {
    if (gatesAt && gatesAt.length > 0) {
      throw new Error(
        "a gateless run attends no gates — drop the gates_at key / --gates-at (gateless already pre-authorizes every gate so you can walk away from the start).",
      );
    }
    gatesAt = [];
  }

  let specPath: string | undefined;
  const specInput = opts.spec ?? meta.spec; // flag wins over frontmatter
  if (specInput) {
    if (workflow === "rir") {
      throw new Error(
        "--workflow rir takes no --spec: the RIR arc has no spec phase — its research decisions are the design. Use the default (full) workflow for a spec-entry run.",
      );
    }
    specPath = relative(cwd, resolve(cwd, specInput));
    if (!existsSync(resolve(cwd, specPath))) {
      throw new Error(`spec file not found: ${specInput}`);
    }
  }

  return {
    ...(framing !== undefined ? { framing } : {}),
    ...(framingRaw !== undefined ? { framingRaw } : {}),
    ...(gatesAt ? { gatesAt } : {}),
    workflow,
    ...(specPath ? { specPath } : {}),
    ...(retryInfra !== undefined ? { retryInfra } : {}),
    ...(gateless ? { gateless } : {}),
    // Frontmatter passthrough — the CLI resolves these against its flags (flags win).
    ...(meta.interactive !== undefined ? { interactive: meta.interactive } : {}),
    ...(meta.consultant !== undefined ? { consultantToggle: meta.consultant } : {}),
    ...(framingFile ? { framingFile } : {}),
  };
}

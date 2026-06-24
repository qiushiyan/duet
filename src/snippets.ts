import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { ANYTIME_SNIPPETS, CONSULTANT_SNIPPETS, consultantSnippetsForWorkflow, phaseSnippetsFor, phasesOf, workflowOfPhase } from './phases.ts';
import type { PhaseName, WorkflowName } from './phases.ts';

/**
 * Duet's snippet library — `snippets.toml` at the repo root, seeded from the
 * user's tabtype config plus the documented `ceo-summary`. The
 * orchestrator reads it via `list_snippets`; approved `propose_snippet_edit`
 * diffs apply here, and porting back to tabtype stays a manual human step.
 */

export interface Snippet {
  key: string;
  expand: string;
}

/**
 * Where an effective snippet resolved from: the shipped base library, or one of
 * the two override layers. Provenance is a `duet snippets` display concern only
 * — the library SERVED to workers carries no source marker (that is exactly what
 * the byte-for-byte-identity guarantee requires).
 */
export type SnippetLayer = 'shipped' | 'user' | 'project';

/** A snippet plus the layer it resolved from — the merged-library element. */
export interface EffectiveSnippet extends Snippet {
  source: SnippetLayer;
}

/**
 * Where to discover override layers when resolving the effective library. Both
 * fields optional: `configDir` (default `~/.config/duet`) holds the USER
 * override `snippets.toml`; `cwd` (the project root) holds the PROJECT override
 * at `<cwd>/.duet/snippets.toml`. An absent field skips that layer's discovery —
 * with neither, resolution is the shipped base verbatim.
 */
export interface SnippetLibraryContext {
  /** Project root — its `.duet/snippets.toml` is the project override layer. */
  cwd?: string;
  /** User config dir — its `snippets.toml` is the user override layer. Default `~/.config/duet`. */
  configDir?: string;
}

/** A parsed override layer fed to `mergeSnippetLayers`: its source tag, the path it came from (for errors), and its snippets. */
export interface SnippetOverrideLayer {
  source: Exclude<SnippetLayer, 'shipped'>;
  path: string;
  snippets: Snippet[];
}

/**
 * Merge override layers onto the base library — PURE, the feature's test seam.
 * Each override replaces a snippet's ENTIRE body (whole-body, keyed by snippet
 * key); there is no partial/field merge. Layers apply in array order, last-wins
 * per key, so a later layer (project) overrides an earlier one (user). Base
 * order is preserved and every result element carries the layer it resolved
 * from.
 *
 * Fail-closed: an override naming a key absent from the BASE library throws —
 * overrides may only replace existing snippets, never introduce new keys (a new
 * key would have no phase classification and go silently invisible in
 * list_snippets). Validation is against the base key set only; an earlier layer
 * cannot add a key a later layer could then target.
 *
 * With no override layers the result is the base library tagged `shipped`,
 * element-for-element — the foundation of the byte-for-byte-identity guarantee.
 */
export function mergeSnippetLayers(base: Snippet[], overrides: SnippetOverrideLayer[] = []): EffectiveSnippet[] {
  const merged: EffectiveSnippet[] = base.map((s) => ({ ...s, source: 'shipped' }));
  const byKey = new Map(merged.map((s) => [s.key, s]));
  for (const layer of overrides) {
    for (const override of layer.snippets) {
      const target = byKey.get(override.key);
      if (!target) {
        throw new Error(
          `snippet override at ${layer.path} names unknown key "${override.key}". Overrides can only replace existing duet snippets — run "duet snippets" to list valid keys, fix the key, or remove that [[snippets]] entry.`,
        );
      }
      target.expand = override.expand;
      target.source = layer.source;
    }
  }
  return merged;
}

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SNIPPETS_PATH = join(PACKAGE_ROOT, 'snippets.toml');

/**
 * The vendored methodology skills (`skills/internal/`) — duet's PLAN-phase
 * quality opinion, shipped in the package (`files` includes `skills`). Snippet
 * bodies cite these with a `{{skills_dir}}/…` token that `snippetBlock` resolves
 * to this absolute dir at serve time, so a worker on any install reads the real
 * files. Same package-relative resolution as `SNIPPETS_PATH` — `src/` and
 * `dist/` both sit one level below the root, so it survives the published build.
 * Exported for the snippet guard (`tests/snippets.test.ts`).
 */
export const SKILLS_DIR = join(PACKAGE_ROOT, 'skills', 'internal');

/**
 * Resolve the `{{skills_dir}}` placeholder in a snippet body to the vendored
 * absolute path. Applied only on the serve path (the rendered XML), never
 * stored: `loadSnippets`/`getSnippet` keep the portable token, so the library on
 * disk and in memory never carries a machine-specific path — the invariant this
 * substitution exists to hold.
 */
function withSkillsDir(body: string): string {
  return body.replaceAll('{{skills_dir}}', SKILLS_DIR);
}

// The file is hand-edited (snippet proposals apply here) — validate so a
// typo fails with the path and the problem, not a crash downstream.
const librarySchema = z.object({
  snippets: z.array(z.object({ key: z.string(), expand: z.string() }).loose()),
});

let cache: Snippet[] | undefined;

export function loadSnippets(): Snippet[] {
  if (!cache) {
    const parsed = librarySchema.safeParse(parse(readFileSync(SNIPPETS_PATH, 'utf8')));
    if (!parsed.success) {
      throw new Error(
        `${SNIPPETS_PATH} is not a valid snippet library (${parsed.error.issues[0]?.message ?? 'unknown issue'}) — each [[snippets]] entry needs a string "key" and a string "expand".`,
      );
    }
    cache = parsed.data.snippets;
  }
  return cache;
}

let byKey: Map<string, Snippet> | undefined;
function index(): Map<string, Snippet> {
  if (!byKey) byKey = new Map(loadSnippets().map((s) => [s.key, s]));
  return byKey;
}

/**
 * Look up a snippet by key. Returns the STORED form — a `{{skills_dir}}`
 * placeholder is left unresolved; only the render path (`snippetBlock`, via
 * `renderSnippetLibrary`) resolves it. Worker-facing delivery must go through
 * the render path, never a raw `getSnippet(...).expand`.
 */
export function getSnippet(key: string): Snippet | undefined {
  return index().get(key);
}

/**
 * Read and validate one override file, or return undefined when it is absent.
 * Same schema as the shipped library; a malformed file throws naming the path
 * and the problem (the contextual analogue of `loadSnippets`' own guard), so a
 * typo fails loud at the serve surface rather than silently dropping overrides.
 * Deliberately NOT cached: the project layer is cwd-relative and the user layer
 * home-relative, so the effective library is run-scoped — only the shipped base
 * keeps a process-global cache (it is the immutable package file).
 */
function loadOverrideLayer(path: string, source: Exclude<SnippetLayer, 'shipped'>): SnippetOverrideLayer | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = librarySchema.safeParse(parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    throw new Error(
      `snippet override at ${path} is not a valid snippet library (${parsed.error.issues[0]?.message ?? 'unknown issue'}) — each [[snippets]] entry needs a string "key" and a string "expand". Fix or remove the file.`,
    );
  }
  return { source, path, snippets: parsed.data.snippets };
}

/**
 * Resolve the effective library in a run/project context: the shipped base with
 * the user (`<configDir>/snippets.toml`) and project (`<cwd>/.duet/snippets.toml`)
 * override layers stacked on top, project winning. THE contextual entry point —
 * `loadSnippets`/`getSnippet` stay shipped-only and context-free (their only
 * non-render caller does an existence check, and the key set is override-invariant
 * since an unknown key is an error). With no override files present the result is
 * the base library tagged `shipped`, element-for-element — the byte-for-byte
 * guarantee the no-override author relies on.
 */
export function loadEffectiveSnippets(ctx: SnippetLibraryContext = {}): EffectiveSnippet[] {
  const configDir = ctx.configDir ?? join(homedir(), '.config', 'duet');
  const layers: SnippetOverrideLayer[] = [];
  const userLayer = loadOverrideLayer(join(configDir, 'snippets.toml'), 'user');
  if (userLayer) layers.push(userLayer);
  if (ctx.cwd !== undefined) {
    const projectLayer = loadOverrideLayer(join(ctx.cwd, '.duet', 'snippets.toml'), 'project');
    if (projectLayer) layers.push(projectLayer);
  }
  return mergeSnippetLayers(loadSnippets(), layers);
}

/**
 * One snippet's effective (merged) form plus its provenance — for
 * `duet snippets show <key>`. STORED form: the `{{skills_dir}}` token is left
 * unresolved, matching `getSnippet`.
 */
export function getEffectiveSnippet(key: string, ctx: SnippetLibraryContext = {}): EffectiveSnippet | undefined {
  return loadEffectiveSnippets(ctx).find((s) => s.key === key);
}

export interface SnippetRenderOpts {
  /**
   * The current phase — renders the phase-grouped view: this phase's templates
   * and the anytime helpers in full, other phases indexed by key. Omitted (or
   * `all`) renders the flat full library.
   */
  phase?: PhaseName;
  /**
   * The run's workflow — scopes the coming-next / already-done arc slicing.
   * Omitted, it is inferred from `phase` (phase names are globally unique).
   */
  workflow?: WorkflowName;
  /** snippet key → roles already sent that template this phase; annotated in the view. */
  sentTo?: Record<string, string[]>;
  /** Render every snippet's full body, ungrouped — the escape hatch for a cross-phase template. */
  all?: boolean;
  /**
   * Whether a consultant is bound for this run. Gates the checkpoint snippets
   * (CONSULTANT_SNIPPETS) on every render path: an unbound run's library is
   * byte-for-byte today's (the consultant snippets never appear, body or key),
   * a bound run sees each checkpoint snippet in its owning phase. Default false,
   * so a context-less render (the no-arg menu) treats the run as unbound.
   */
  consultantBound?: boolean;
  /**
   * Run/project context for override discovery. When PRESENT, the served library
   * is the merged effective library (shipped + user + project overrides); when
   * ABSENT, the shipped library is served verbatim — the no-context path stays
   * byte-for-byte today's and reads no override file, so a context-less render is
   * independent of machine state (the existing guard tests rely on this). The
   * merge is provenance-tracked internally but the rendered XML carries no source
   * marker (`snippetBlock` ignores it), preserving byte identity when unused.
   */
  libraryContext?: SnippetLibraryContext;
}

/**
 * Render the library for the orchestrator, XML-tagged per the prompting
 * conventions. The default (a phase given, `all` off) is progressive
 * disclosure: the current phase's templates and the always-available helpers
 * in full, the other phases listed by key only — the snippets actually reached
 * for now, without the rest as noise (docs/prompting-and-tool-design.md
 * §"Just-in-time / progressive disclosure"). `all` (or no phase) renders every
 * body. `sentTo` annotates templates already sent this phase so later turns
 * want the delta, not the template.
 */
export function renderSnippetLibrary(opts: SnippetRenderOpts = {}): string {
  const consultantBound = opts.consultantBound ?? false;
  // No libraryContext ⇒ shipped-only (byte-for-byte today's, no override file read).
  // A context ⇒ the merged effective library. The renderers take the resolved
  // array, so the override layering is invisible past this line.
  const library: Snippet[] = opts.libraryContext ? loadEffectiveSnippets(opts.libraryContext) : loadSnippets();
  if (opts.all || !opts.phase) return renderFlat(library, opts.sentTo, opts.all, consultantBound, opts.workflow);
  return renderForPhase(library, opts.phase, opts.workflow ?? workflowOfPhase(opts.phase), opts.sentTo, consultantBound);
}

function snippetBlock(s: Snippet, sentTo?: Record<string, string[]>): string {
  const sent = sentTo?.[s.key];
  const attr = sent && sent.length > 0 ? ` already_sent_this_phase_to="${sent.join(', ')}"` : '';
  return `<snippet key="${s.key}"${attr}>\n${withSkillsDir(s.expand)}\n</snippet>`;
}

function renderFlat(library: Snippet[], sentTo?: Record<string, string[]>, all?: boolean, consultantBound = false, workflow?: WorkflowName): string {
  // The flat library is the whole file, so the checkpoint snippets must be filtered
  // here: unbound shows NONE; bound shows only the consultant snippets THIS arc's
  // checkpoints reach (per-arc honesty — a bound rir run never sees full's contract
  // snippets, the leak the workflow filter closes). With no workflow (defensive,
  // outside the tool path), a bound run falls back to every consultant snippet.
  const allowedConsultant = !consultantBound
    ? new Set<string>()
    : workflow
      ? consultantSnippetsForWorkflow(workflow)
      : CONSULTANT_SNIPPETS;
  const snippets = library.filter((s) => !CONSULTANT_SNIPPETS.has(s.key) || allowedConsultant.has(s.key));
  return [
    all ? '<snippet_library all="true">' : '<snippet_library>',
    ...snippets.map((s) => snippetBlock(s, sentTo)),
    '</snippet_library>',
  ].join('\n');
}

function fullBodies(byKey: Map<string, Snippet>, keys: readonly string[], sentTo?: Record<string, string[]>): string[] {
  return keys.map((k) => byKey.get(k)).filter((s): s is Snippet => s !== undefined).map((s) => snippetBlock(s, sentTo));
}

function renderForPhase(
  library: Snippet[],
  phase: PhaseName,
  workflow: WorkflowName,
  sentTo: Record<string, string[]> | undefined,
  consultantBound: boolean,
): string {
  // Look the phase/anytime keys up in the RESOLVED library (so overridden bodies
  // serve), not the shipped-only `getSnippet` global. Insertion order = base
  // order; key lookups are order-independent, so the no-context path is identical.
  const byKey = new Map<string, Snippet>(library.map((s) => [s.key, s]));
  const phases = phasesOf(workflow);
  const i = phases.findIndex((p) => p.name === phase);
  // Each phase's ENABLED snippets — the always-on base plus its consultant
  // checkpoint snippet only when bound, so the consultant snippet shows in its
  // owning phase and nowhere else, and an unbound run never sees it.
  const snippetsOf = (name: PhaseName): readonly string[] => phaseSnippetsFor(name, { consultant: consultantBound });
  const current = snippetsOf(phase);
  const lines: string[] = [
    `<snippet_library phase="${phase}">`,
    'Showing this phase’s templates and the always-available helpers in full; the other phases are listed by key only, in arc order. Call list_snippets with all=true for any snippet’s full body (use when you genuinely need a template from another phase).',
    `<phase_templates phase="${phase}">`,
    ...(current.length > 0
      ? fullBodies(byKey, current, sentTo)
      : ['(No library templates — this phase is skill- and mechanics-driven; compose from scratch or reach for a helper.)']),
    '</phase_templates>',
    '<anytime_helpers>',
    ...fullBodies(byKey, ANYTIME_SNIPPETS, sentTo),
    '</anytime_helpers>',
  ];

  const indexLine = (p: { name: PhaseName }): string => `<phase name="${p.name}">${snippetsOf(p.name).join(', ')}</phase>`;

  const next = phases.slice(i + 1).filter((p) => snippetsOf(p.name).length > 0);
  if (next.length > 0) {
    lines.push(
      '<coming_next note="the nominal arc — gate rejects loop back and pre-authorized gates skip the stop; orientation for forward-looking work, not a cue to reach ahead">',
      ...next.map(indexLine),
      '</coming_next>',
    );
  }

  const done = phases.slice(0, i).filter((p) => snippetsOf(p.name).length > 0);
  if (done.length > 0) {
    lines.push('<already_done>', ...done.map(indexLine), '</already_done>');
  }

  lines.push('</snippet_library>');
  return lines.join('\n');
}

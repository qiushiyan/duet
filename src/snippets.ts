import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { ANYTIME_SNIPPETS, phasesOf, workflowOfPhase } from './phases.ts';
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

const SNIPPETS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'snippets.toml');

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

export function getSnippet(key: string): Snippet | undefined {
  return index().get(key);
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
  if (opts.all || !opts.phase) return renderFlat(opts.sentTo, opts.all);
  return renderForPhase(opts.phase, opts.workflow ?? workflowOfPhase(opts.phase), opts.sentTo);
}

function snippetBlock(s: Snippet, sentTo?: Record<string, string[]>): string {
  const sent = sentTo?.[s.key];
  const attr = sent && sent.length > 0 ? ` already_sent_this_phase_to="${sent.join(', ')}"` : '';
  return `<snippet key="${s.key}"${attr}>\n${s.expand}\n</snippet>`;
}

function renderFlat(sentTo?: Record<string, string[]>, all?: boolean): string {
  return [
    all ? '<snippet_library all="true">' : '<snippet_library>',
    ...loadSnippets().map((s) => snippetBlock(s, sentTo)),
    '</snippet_library>',
  ].join('\n');
}

function fullBodies(keys: readonly string[], sentTo?: Record<string, string[]>): string[] {
  return keys.map((k) => getSnippet(k)).filter((s): s is Snippet => s !== undefined).map((s) => snippetBlock(s, sentTo));
}

function renderForPhase(phase: PhaseName, workflow: WorkflowName, sentTo?: Record<string, string[]>): string {
  const phases = phasesOf(workflow);
  const i = phases.findIndex((p) => p.name === phase);
  const current = phases[i]!;
  const lines: string[] = [
    `<snippet_library phase="${phase}">`,
    'Showing this phase’s templates and the always-available helpers in full; the other phases are listed by key only, in arc order. Call list_snippets with all=true for any snippet’s full body (use when you genuinely need a template from another phase).',
    `<phase_templates phase="${phase}">`,
    ...(current.snippets.length > 0
      ? fullBodies(current.snippets, sentTo)
      : ['(No library templates — this phase is skill- and mechanics-driven; compose from scratch or reach for a helper.)']),
    '</phase_templates>',
    '<anytime_helpers>',
    ...fullBodies(ANYTIME_SNIPPETS, sentTo),
    '</anytime_helpers>',
  ];

  const next = phases.slice(i + 1).filter((p) => p.snippets.length > 0);
  if (next.length > 0) {
    lines.push(
      '<coming_next note="the nominal arc — gate rejects loop back and pre-authorized gates skip the stop; orientation for forward-looking work, not a cue to reach ahead">',
      ...next.map((p) => `<phase name="${p.name}">${p.snippets.join(', ')}</phase>`),
      '</coming_next>',
    );
  }

  const done = phases.slice(0, i).filter((p) => p.snippets.length > 0);
  if (done.length > 0) {
    lines.push(
      '<already_done>',
      ...done.map((p) => `<phase name="${p.name}">${p.snippets.join(', ')}</phase>`),
      '</already_done>',
    );
  }

  lines.push('</snippet_library>');
  return lines.join('\n');
}

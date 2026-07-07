/**
 * `duet graph` — the render-on-demand visualization surface. This module owns the
 * RENDERERS (ANSI pipeline, `--json`, `--mermaid`) and the thin CLI-facing
 * composers that resolve inputs and build a `GraphModel`; the model itself (the
 * shared spine + overlays) lives in `graph-model.ts`. Read-only throughout: the
 * blueprint path resolves through `resolveWorkflowSourceReadOnly` (no provision),
 * and nothing here writes.
 *
 * View-time color only (the standing `colorize.ts` rule): the ANSI pipeline
 * paints duty lanes (maker blue, checker yellow) via `VOICE_PAINT`, and
 * picocolors auto-disables off-TTY / under NO_COLOR. `--json` and `--mermaid`
 * are always plain text.
 */

import { CONFIG_PATH, resolveRunConfig } from '../voices/bindings.ts';
import type { WorkflowName } from '../registry/workflows.ts';
import { VOICE_PAINT } from '../view/colorize.ts';
import { blockSummary, blueprintModel } from './graph-model.ts';
import type { BindingRow, GraphModel, PhaseCheckpoint, PhaseNode, WorkflowSpine } from './graph-model.ts';
import { formatWorkflowSource, resolveWorkflowSourceReadOnly } from './workflow-source.ts';

/**
 * Build the blueprint model for a workflow, read-only. Resolves the compiled
 * workflow WITHOUT provisioning, then the config-resolved default bindings (no
 * flags/framing — what a run WOULD freeze on this machine), then the overlay.
 * `configPath` is injectable for tests; production uses `CONFIG_PATH`.
 */
export async function buildBlueprintModel(
  cwd: string,
  name: WorkflowName,
  opts: { home?: string; configPath?: string } = {},
): Promise<GraphModel> {
  const { workflow, source } = await resolveWorkflowSourceReadOnly(cwd, name, opts.home ? { home: opts.home } : {});
  const resolved = resolveRunConfig({ workflow }, opts.configPath ?? CONFIG_PATH);
  return blueprintModel(workflow, source, { bindings: resolved.bindings, degradedEdges: resolved.degradedEdges });
}

/** The `--json` render — the model verbatim, raw UTC, additive-only schema (pinned by tests, like status/stats). */
export function renderGraphJson(model: GraphModel): string {
  return JSON.stringify(model, null, 2);
}

/** The ANSI render — dispatches on mode. Blueprint today; the run overlay adds its arm. */
export function renderGraph(model: GraphModel): string {
  switch (model.mode) {
    case 'blueprint':
      return renderBlueprint(model);
  }
}

/** Whether a phase's gate is attended by default (in the posture set, or attend-all when the posture is undefined). */
function attendedByDefault(spine: WorkflowSpine, phase: string): boolean {
  return spine.defaultPosture === undefined || spine.defaultPosture.includes(phase);
}

/** The per-phase annotations after the gate: posture, rounds, and the live checkpoint (when any). */
function phaseAnnotations(spine: WorkflowSpine, node: PhaseNode, checkpoint: PhaseCheckpoint | undefined): string {
  const parts: string[] = [attendedByDefault(spine, node.name) ? 'attend' : 'auto'];
  if (node.roundCap !== undefined) parts.push(`${node.roundCap} rounds`);
  if (checkpoint?.live) parts.push(`consultant: ${checkpoint.kind}`);
  return parts.join(' · ');
}

function paintDuty(duty: string): string {
  const paint = VOICE_PAINT[duty as keyof typeof VOICE_PAINT];
  return paint ? paint(duty) : duty;
}

/** The stage's duty pair with its declared continuity edges (delivery), painted by lane. */
function stageLine(stage: WorkflowSpine['stages'][number]): string {
  const duties = `${paintDuty(stage.duties.maker)} + ${paintDuty(stage.duties.checker)}`;
  const edges = Object.entries(stage.continuity).map(([into, from]) => `${into}←${from}`);
  const continuity = edges.length > 0 ? `  · continues ${edges.join(', ')}` : '';
  return `  ${stage.name.padEnd(10)} ${duties}${continuity}`;
}

function renderBlueprint(model: GraphModel & { mode: 'blueprint' }): string {
  const { spine } = model;
  const checkpointByPhase = new Map(model.checkpoints.map((c) => [c.phase, c]));
  const lines: string[] = [];
  lines.push(`blueprint · ${spine.name} — ${spine.displayName}`);
  lines.push(`source · ${spine.source ? formatWorkflowSource(spine.source) : 'shipped'}`);
  lines.push('');
  lines.push('pipeline');
  spine.phases.forEach((node, i) => {
    const annotations = phaseAnnotations(spine, node, checkpointByPhase.get(node.name));
    lines.push(`  ${node.name.padEnd(10)} ${blockSummary(node).padEnd(18)} ▸ ${node.gate.label.padEnd(14)}  ${annotations}`);
    if (i < spine.phases.length - 1) lines.push('  │');
  });

  lines.push('', 'stages');
  for (const stage of spine.stages) lines.push(stageLine(stage));

  lines.push('', 'bindings — defaults, resolved against ~/.config/duet/config.toml (a run re-resolves and freezes at creation)');
  for (const row of bindingRowsInOrder(model.bindings)) lines.push(`  ${row.address.padEnd(13)} ${row.label}`);
  if (model.degradedEdges.length > 0) {
    const edges = model.degradedEdges.map((e) => `${e.into}←${e.from} (${e.reason})`).join(', ');
    lines.push(`  degraded edges: ${edges}`);
  }

  lines.push('', `default attended gates · ${spine.defaultPosture === undefined ? 'all' : spine.defaultPosture.length === 0 ? 'none — walk away from the start' : spine.defaultPosture.join(', ')}`);
  return lines.join('\n');
}

/** Bindings in a stable display order — orchestrator first, then duties/consultant as bound. */
function bindingRowsInOrder(rows: BindingRow[]): BindingRow[] {
  const order = ['orchestrator', 'architect', 'analyst', 'builder', 'critic', 'judge', 'consultant'];
  return [...rows].sort((a, b) => order.indexOf(a.address) - order.indexOf(b.address));
}

/**
 * The `--mermaid` render — a static flowchart of the spine (phases → gates, with
 * the block/posture annotations), plain text, no ANSI: the docs/PR artifact.
 * Blueprint only (a live cursor or turn timeline adds little to a static diagram).
 */
export function renderGraphMermaid(model: GraphModel): string {
  if (model.mode !== 'blueprint') throw new Error('mermaid is a blueprint-only render');
  const { spine } = model;
  const checkpointByPhase = new Map(model.checkpoints.map((c) => [c.phase, c]));
  const lines: string[] = ['flowchart TD'];
  spine.phases.forEach((node, i) => {
    // IDs are index-derived (p0, p0_gate), never the phase name: a project-authored
    // name may carry spaces/hyphens/punctuation, which are invalid in a Mermaid id.
    // The name only ever appears inside a quoted, escaped LABEL.
    const id = `p${i}`;
    const posture = attendedByDefault(spine, node.name) ? 'attend' : 'auto';
    const checkpoint = checkpointByPhase.get(node.name);
    const ck = checkpoint?.live ? ` · ${checkpoint.kind}` : '';
    lines.push(`  ${id}["${mermaidLabel(`${node.name}: ${blockSummary(node)}`)}"]`);
    lines.push(`  ${id}_gate{{"${mermaidLabel(`${node.gate.label} (${posture}${ck})`)}"}}`);
    lines.push(`  ${id} --> ${id}_gate`);
    if (i < spine.phases.length - 1) lines.push(`  ${id}_gate --> p${i + 1}`);
  });
  return lines.join('\n');
}

/** Escape a Mermaid node label — quotes become the HTML entity Mermaid renders, so a name with a `"` can't break out of the quoted label. */
function mermaidLabel(text: string): string {
  return text.replace(/"/g, '#quot;');
}

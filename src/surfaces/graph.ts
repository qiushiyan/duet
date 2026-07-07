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

import pc from 'picocolors';
import { CONFIG_PATH, resolveRunConfig } from '../voices/bindings.ts';
import type { WorkflowName } from '../registry/workflows.ts';
import { workflowFor } from '../run/workflow.ts';
import { probeRunPosition } from '../run/position.ts';
import { listPendingSteers } from '../run/steers.ts';
import type { RunState } from '../run/store.ts';
import { VOICE_PAINT } from '../view/colorize.ts';
import { localStamp } from '../view/timefmt.ts';
import { blockSummary, blueprintModel, runGraphModel } from './graph-model.ts';
import type {
  BlueprintGraphModel,
  BindingRow,
  DriftFlag,
  GraphModel,
  PhaseCheckpoint,
  PhaseNode,
  RunGraphModel,
  RunNodeState,
  WorkflowSpine,
} from './graph-model.ts';
import { buildStatusModel } from './status.ts';
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
): Promise<BlueprintGraphModel> {
  const { workflow, source } = await resolveWorkflowSourceReadOnly(cwd, name, opts.home ? { home: opts.home } : {});
  const resolved = resolveRunConfig({ workflow }, opts.configPath ?? CONFIG_PATH);
  return blueprintModel(workflow, source, { bindings: resolved.bindings, degradedEdges: resolved.degradedEdges });
}

/**
 * Build the run model for a run, read-only. Reads the frozen workflow, probes the
 * position, and builds the pinned StatusModel (with the run's pending steers so
 * the steer-drift signal is populated) — then overlays live position. Reads only
 * `state.json`, `workflow.json`, and the steer dir; mutates nothing (safe while a
 * driver holds the run).
 */
export function buildRunGraphModel(state: RunState): RunGraphModel {
  const workflow = workflowFor(state);
  const position = probeRunPosition(state);
  const status = buildStatusModel(state, position, listPendingSteers(state));
  return runGraphModel(workflow, status, state, position);
}

/** The `--json` render — the model verbatim, raw UTC, additive-only schema (pinned by tests, like status/stats). */
export function renderGraphJson(model: GraphModel): string {
  return JSON.stringify(model, null, 2);
}

/** The ANSI render — dispatches on mode. */
export function renderGraph(model: GraphModel): string {
  switch (model.mode) {
    case 'blueprint':
      return renderBlueprint(model);
    case 'run':
      return renderRun(model);
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

/** The status glyph for a run node — done ✓, current ▸, future ○. */
const RUN_STATUS_GLYPH: Record<RunNodeState['status'], string> = { done: '✓', current: '▸', future: '○' };

/** One human line for a phase-attributed drift flag. */
function driftSummary(flag: DriftFlag): string {
  switch (flag.kind) {
    case 'unexpected-tag':
      return `unexpected snippet '${flag.tag}' (${flag.voice})`;
    case 'rounds-past-cap':
      return `rounds ${flag.used} past cap ${flag.cap}`;
    case 'auto-retry':
      return `auto-retry ${flag.errorClass} (attempt ${flag.attempt})`;
    case 'steer-staged':
      return 'steer currently staged during this phase';
  }
}

/** The per-node trailing annotation: gate outcome/posture, rounds, held-high, and a drift marker. */
function runNodeAnnotation(node: RunNodeState): string {
  const parts: string[] = [];
  if (node.status === 'done') parts.push(node.gate.outcome ?? 'crossed');
  else if (node.status === 'current') parts.push(`← current · gate ${node.gate.posture}`);
  else parts.push(`gate ${node.gate.posture}`);
  if (node.gate.heldHigh) parts.push('holds for a high decision');
  if (node.rounds) parts.push(`rounds ${node.rounds.used}/${node.rounds.cap}`);
  return parts.join(' · ');
}

/** A one-line description of the current stop + the command that acts there. */
function stopLine(stop: StopModelLike): string {
  switch (stop.kind) {
    case 'running':
      return `running in the background (pid ${stop.pid})`;
    case 'interactive':
      return `orchestrated interactively — steer in your session (phase ${stop.phase})`;
    case 'gate':
      return `waiting at the ${stop.gate} — ${stop.commands.approve}`;
    case 'flag':
      return `queued question — ${stop.command}`;
    case 'crashed':
      return `crashed mid-phase (${stop.phase}) — ${stop.command}`;
    case 'abandoned':
      return `abandoned — revive with ${stop.revive}`;
    case 'done':
      return 'run complete';
  }
}

/** Structural view of StopModel this module renders (avoids re-importing every arm's shape). */
type StopModelLike = RunGraphModel['stop'];

function renderRun(model: RunGraphModel): string {
  const lines: string[] = [];
  lines.push(`run · ${model.runId} — ${model.spine.displayName}`);
  lines.push(`workflow · ${model.spine.name}`);
  if (model.stop.kind === 'abandoned') lines.push('(abandoned — no live cursor; started phases shown as reached)');
  lines.push('', 'arc');
  model.nodes.forEach((node, i) => {
    const label = `${node.phase.padEnd(10)} ${gateLabelOf(model.spine, node.phase).padEnd(14)}`;
    const painted = node.status === 'current' ? pc.bold(label) : node.status === 'future' ? pc.dim(label) : label;
    lines.push(`  ${RUN_STATUS_GLYPH[node.status]} ${painted}  ${runNodeAnnotation(node)}`);
    for (const flag of node.drift) lines.push(`      ⚠ ${driftSummary(flag)}`);
    if (i < model.nodes.length - 1) lines.push('  │');
  });

  lines.push('', `stop · ${stopLine(model.stop)}`);

  if (model.degradedEdges.length > 0) {
    lines.push(`degraded edges: ${model.degradedEdges.map((e) => `${e.into}←${e.from} (${e.reason})`).join(', ')} — the frozen manifest ran these fresh`);
  }
  if (model.interventions.length > 0) {
    lines.push(`context interventions: ${summarizeInterventions(model.interventions)}`);
  }
  if (model.ledgers.autoApprovals.length > 0) {
    lines.push(`auto-approved gates: ${model.ledgers.autoApprovals.map((a) => `${a.gate} (${localStamp(a.at)})`).join(', ')}`);
  }
  return lines.join('\n');
}

/** The gate label for a phase from the spine (the run node carries only the phase name). */
function gateLabelOf(spine: WorkflowSpine, phase: string): string {
  return spine.phases.find((p) => p.name === phase)?.gate.label ?? phase;
}

/** A per-kind tally of context interventions ("compact ×1, cutoff ×2"), voices noted. */
function summarizeInterventions(events: RunGraphModel['interventions']): string {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  return [...counts].map(([kind, n]) => `${kind} ×${n}`).join(', ');
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

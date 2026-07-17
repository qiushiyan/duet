import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { WORKFLOWS, isShippedWorkflowName } from '../registry/workflows.ts';
import type { GatePhase } from '../registry/workflows.ts';
import type { WorkflowSource } from '../run/store.ts';
import { blockSummary } from './graph-model.ts';
import type { BindingRow, GraphModel, StageNode } from './graph-model.ts';
import {
  definedWorkflowSources,
  discoverWorkflowSources,
  formatWorkflowSource,
  projectWorkflowDir,
  provisionWorkflowDir,
} from './workflow-source.ts';

export interface WorkflowListModel {
  rows: WorkflowListRow[];
}

export interface WorkflowListRow {
  name: string;
  status: 'available' | 'collision';
  sources: WorkflowListSource[];
  title?: string;
}

export interface WorkflowListSource {
  layer: WorkflowSource['layer'];
  path?: string;
}

export interface InitializedWorkflow {
  name: string;
  path: string;
  text: string;
}

function displayPath(path: string, cwd: string): string {
  return relative(cwd, path) || path;
}

function sourcePath(source: WorkflowSource, cwd: string): string | undefined {
  return source.path ? displayPath(source.path, cwd) : undefined;
}

function layerHeader(layer: WorkflowSource['layer'], rows: WorkflowListRow[]): string {
  if (layer === 'shipped') return 'shipped';
  const firstPath = rows.find((row) => row.sources[0]?.layer === layer)?.sources[0]?.path;
  const dir = firstPath ? dirname(firstPath) : layer;
  return `${layer} · ${dir}`;
}

export function buildWorkflowListModel(cwd: string, opts: { home?: string } = {}): WorkflowListModel {
  return {
    rows: discoverWorkflowSources(cwd, opts).map((entry) => {
      const sources = entry.layers.map((source) => ({
        layer: source.layer,
        ...(sourcePath(source, cwd) ? { path: sourcePath(source, cwd) } : {}),
      }));
      const status = sources.length === 1 ? 'available' : 'collision';
      const shippedTitle =
        status === 'available' && isShippedWorkflowName(entry.name) && sources[0]?.layer === 'shipped'
          ? WORKFLOWS[entry.name].displayName
          : undefined;
      return { name: entry.name, status, sources, ...(shippedTitle ? { title: shippedTitle } : {}) };
    }),
  };
}

export function renderWorkflowList(model: WorkflowListModel): string {
  const available = model.rows.filter((row) => row.status === 'available');
  const collisions = model.rows.filter((row) => row.status === 'collision');
  const width = model.rows.reduce((max, row) => Math.max(max, row.name.length), 0);
  const sections: string[] = [];

  for (const layer of ['shipped', 'project', 'user'] as const) {
    const rows = available.filter((row) => row.sources[0]?.layer === layer);
    if (rows.length === 0) continue;
    sections.push(layerHeader(layer, rows));
    for (const row of rows) {
      const source = row.sources[0]!;
      const detail = row.title ?? source.path ?? '';
      sections.push(`  ${row.name.padEnd(width)}  ${detail}`.trimEnd());
    }
  }

  if (collisions.length > 0) {
    if (sections.length > 0) sections.push('');
    sections.push('collisions');
    for (const row of collisions) {
      const sources = row.sources
        .map((source) => (source.path ? `${source.layer} (${source.path})` : source.layer))
        .join(' + ');
      sections.push(`  ${row.name.padEnd(width)}  ${sources} — remove the duplicate; greenflag rejects shadowing`);
    }
  }

  return sections.length > 0 ? sections.join('\n') : 'no workflows found';
}

function formatGatePosture(gates: GatePhase[] | undefined): string {
  if (gates === undefined) return 'all';
  if (gates.length === 0) return 'none — walk away from the start';
  return gates.join(', ');
}

/** A stage's declared continuity edges, in maker-then-checker order — `builder<-architect / critic<-analyst`, or fresh. */
function continuitySummary(stage: StageNode): string {
  const edges = Object.entries(stage.continuity).map(([into, from]) => `${into}<-${from}`);
  if (edges.length === 0) return 'structurally fresh';
  return `declares ${edges.join(' / ')} continuity (a cross-provider binding may degrade an edge to fresh at run creation)`;
}

/** Bindings ordered orchestrator → duties → consultant for a stable listing (shared shape with the graph blueprint). */
function bindingRowsInOrder(rows: BindingRow[]): BindingRow[] {
  const order = ['orchestrator', 'architect', 'analyst', 'builder', 'critic', 'judge', 'consultant'];
  return [...rows].sort((a, b) => order.indexOf(a.address) - order.indexOf(b.address));
}

/**
 * The `greenflag workflows check` summary, rendered over the SAME blueprint spine
 * `greenflag graph --workflow` uses — the structural join (phases, gates, stages,
 * continuity, posture) is read off the spine, not re-derived, and the summary
 * ADDS the two things the graph blueprint surfaces that this command omitted:
 * the config-resolved default bindings and the per-phase consultant checkpoints.
 */
export function renderWorkflowCheck(model: GraphModel & { mode: 'blueprint' }, cwd: string): string {
  const { spine } = model;
  const contractAuthor = spine.phases.find((p) => p.consultantCheckpoint === 'contract')?.name;
  const contractVerify = spine.phases.find((p) => p.consultantCheckpoint === 'verify')?.name;
  const lines = [
    `workflow  ${spine.name} — ${spine.displayName}`,
    `source    ${spine.source ? formatWorkflowSource(spine.source, cwd).replace(': ', ' · ') : 'shipped'}`,
    '',
    `phases (${spine.phases.length})`,
  ];

  for (const node of spine.phases) {
    const extras = [
      // Only doc-loop rounds surface; the build phase's own review-loop cap is an
      // internal rail the design excludes as noise ("no round-caps beyond doc-loop rounds").
      node.block === 'doc-loop' ? `${node.roundCap} rounds` : undefined,
      node.consultantCheckpoint === 'contract' ? 'authors the acceptance contract' : undefined,
    ].filter((extra) => extra !== undefined);
    lines.push(`  ${node.name.padEnd(10)} ${blockSummary(node).padEnd(18)} -> ${node.gate.label}${extras.length > 0 ? ` · ${extras.join(' · ')}` : ''}`);
  }

  lines.push('', 'stages');
  for (const stage of spine.stages) {
    const duties = `${stage.duties.maker} + ${stage.duties.checker}`;
    const continuity = stage.name === 'delivery' ? ` · ${continuitySummary(stage)}` : '';
    lines.push(`  ${stage.name.padEnd(10)} ${duties}${continuity}`);
  }

  // The config-resolved default bindings (labeled as defaults, like the graph blueprint).
  lines.push('', 'bindings (defaults · resolved from ~/.config/greenflag/config.toml)');
  for (const row of bindingRowsInOrder(model.bindings)) lines.push(`  ${row.address.padEnd(13)} ${row.label}`);
  if (model.degradedEdges.length > 0) {
    lines.push(`  degraded edges: ${model.degradedEdges.map((e) => `${e.into}<-${e.from} (${e.reason})`).join(', ')}`);
  }

  // The per-phase consultant checkpoints — the second field the plain summary omitted.
  const checkpoints = model.checkpoints;
  if (checkpoints.length > 0) {
    const consultantBound = model.bindings.some((b) => b.address === 'consultant');
    lines.push('', `consultant checkpoints   ${consultantBound ? '(a consultant is bound — these fire)' : '(fire when a consultant is bound)'}`);
    for (const c of checkpoints) lines.push(`  ${c.phase.padEnd(10)} ${c.kind}`);
  }

  lines.push('', `default attended gates   ${formatGatePosture(spine.defaultPosture)}`);
  lines.push(
    `acceptance contract      ${
      contractAuthor ? `authored at ${contractAuthor}, verified at ${contractVerify ?? 'none'} (when a consultant is bound)` : 'none'
    }`,
  );
  return lines.join('\n');
}

function validateNewWorkflowName(name: string): void {
  if (!name.trim()) throw new Error('workflow name is required — use a kebab-case filename stem such as "deep-relay".');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(
      `workflow name "${name}" is invalid — use kebab-case letters and numbers only, with no path separators (example: deep-relay).`,
    );
  }
}

function workflowStarter(name: string): string {
  return `import { build, defineWorkflow, finish, frame } from 'greenflag/workflows';

export default defineWorkflow({
  name: '${name}',
  title: '${name} workflow',
  phases: [
    // frame() gathers direction, build({ review: 'writable' }) runs one writable delivery pass, and finish() opens the PR.
    // For other complete shapes, use the worked examples in skills/greenflag-frame/references/workflow-definitions.md.
    frame(),
    build({ review: 'writable' }),
    finish(),
  ],
  // attend lists the gates you want to stop at by default. Omit it to attend every gate; use [] only when the workflow should default to walk-away.
});
`;
}

export function initWorkflowDefinition(cwd: string, name: string, opts: { home?: string } = {}): InitializedWorkflow {
  validateNewWorkflowName(name);
  const existing = definedWorkflowSources(cwd, name, opts);
  if (existing.length > 0) {
    throw new Error(
      `workflow "${name}" already resolves from ${existing.map((source) => formatWorkflowSource(source, cwd)).join(', ')} — choose a new name; greenflag rejects workflow shadowing.`,
    );
  }

  const dir = projectWorkflowDir(cwd);
  const path = join(dir, `${name}.ts`);
  if (existsSync(path)) throw new Error(`${path} already exists — choose a new workflow name or edit that file directly.`);
  provisionWorkflowDir(dir);
  const text = workflowStarter(name);
  writeFileSync(path, text);
  return { name, path, text };
}

export function renderWorkflowInit(result: InitializedWorkflow, cwd: string): string {
  const path = displayPath(result.path, cwd);
  return [
    `created ${path}`,
    `check it: greenflag workflows check ${result.name}`,
    `run it:   greenflag new --workflow ${result.name}`,
    'share it by carving !/workflows/ into .greenflag/.gitignore when this project definition should be committed',
  ].join('\n');
}

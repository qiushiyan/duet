import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  WORKFLOWS,
  contractAuthorPhaseOf,
  continuityEdgeFor,
  defaultPosture,
  defaultPreAuthorizedOf,
  gatePhasesOf,
  isShippedWorkflowName,
  phasesOf,
  stagesOf,
} from '../registry/workflows.ts';
import type { CompiledWorkflow, Duty, GatePhase, PhaseSpec } from '../registry/workflows.ts';
import type { WorkflowSource } from '../run/store.ts';
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
      sections.push(`  ${row.name.padEnd(width)}  ${sources} — remove the duplicate; duet rejects shadowing`);
    }
  }

  return sections.length > 0 ? sections.join('\n') : 'no workflows found';
}

function blockSummary(phase: PhaseSpec): string {
  switch (phase.semantics.block) {
    case 'frame':
      return 'frame';
    case 'doc-loop':
      return `doc-loop (${phase.semantics.artifactKind})`;
    case 'build':
      return `build (${phase.semantics.reviewPosture})`;
    case 'finish':
      return 'finish';
  }
}

// The compact gate label — the heading's leading "<X> gate" token, not the full
// packet heading (`heading` is the status line printed above the gate packet at
// run time; its "— the orchestrator's summary" tail is noise in a structural
// summary). Every gate heading is "<LABEL> — <description>" (define.ts gate
// constructors), so the split is total; a heading without the separator falls
// back to itself.
function gateLabel(phase: PhaseSpec): string {
  return phase.gate.heading.split(' — ')[0]!;
}

function contractVerifyPhase(workflow: CompiledWorkflow): string | undefined {
  return phasesOf(workflow).find((phase) => phase.consultantCheckpoint === 'verify')?.name;
}

function formatGatePosture(gates: GatePhase[] | undefined): string {
  if (gates === undefined) return 'all';
  if (gates.length === 0) return 'none — walk away from the start';
  return gates.join(', ');
}

function continuitySummary(workflow: CompiledWorkflow, deliveryDuties: readonly Duty[]): string {
  const edges = deliveryDuties
    .map((duty) => {
      const from = continuityEdgeFor(workflow, duty);
      return from ? `${duty}<-${from}` : undefined;
    })
    .filter((edge) => edge !== undefined);
  if (edges.length === 0) return 'structurally fresh';
  return `declares ${edges.join(' / ')} continuity (a cross-provider binding may degrade an edge to fresh at run creation)`;
}

export function renderWorkflowCheck(workflow: CompiledWorkflow, source: WorkflowSource, cwd: string): string {
  const phases = phasesOf(workflow);
  const stages = stagesOf(workflow);
  const defaultAttended = defaultPosture(gatePhasesOf(workflow), defaultPreAuthorizedOf(workflow));
  const contractAuthor = contractAuthorPhaseOf(workflow);
  const contractVerify = contractVerifyPhase(workflow);
  const lines = [
    `workflow  ${workflow.name} — ${workflow.displayName}`,
    `source    ${formatWorkflowSource(source, cwd).replace(': ', ' · ')}`,
    '',
    `phases (${phases.length})`,
  ];

  for (const phase of phases) {
    const extras = [
      // Only doc-loop rounds surface; the build phase's own review-loop cap is an
      // internal rail the design excludes as noise ("no round-caps beyond doc-loop rounds").
      phase.semantics.block === 'doc-loop' ? `${phase.roundCap} rounds` : undefined,
      phase.name === contractAuthor ? 'authors the acceptance contract' : undefined,
    ].filter((extra) => extra !== undefined);
    lines.push(`  ${phase.name.padEnd(10)} ${blockSummary(phase).padEnd(18)} -> ${gateLabel(phase)}${extras.length > 0 ? ` · ${extras.join(' · ')}` : ''}`);
  }

  lines.push('', 'stages');
  for (const stage of stages) {
    const duties = `${stage.duties.maker} + ${stage.duties.checker}`;
    const continuity = stage.name === 'delivery' ? ` · ${continuitySummary(workflow, [stage.duties.maker, stage.duties.checker])}` : '';
    lines.push(`  ${stage.name.padEnd(10)} ${duties}${continuity}`);
  }

  lines.push('', `default attended gates   ${formatGatePosture(defaultAttended)}`);
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
  return `import { build, defineWorkflow, finish, frame } from 'duet/workflows';

export default defineWorkflow({
  name: '${name}',
  title: '${name} workflow',
  phases: [
    // frame() gathers direction, build({ review: 'writable' }) runs one writable delivery pass, and finish() opens the PR.
    // For other complete shapes, use the worked examples in skills/duet-frame/references/workflow-definitions.md.
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
      `workflow "${name}" already resolves from ${existing.map((source) => formatWorkflowSource(source, cwd)).join(', ')} — choose a new name; duet rejects workflow shadowing.`,
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
    `check it: duet workflows check ${result.name}`,
    `run it:   duet new --workflow ${result.name}`,
    'share it by carving !/workflows/ into .duet/.gitignore when this project definition should be committed',
  ].join('\n');
}

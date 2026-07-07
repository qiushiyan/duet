import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { PhaseEvent } from '../run/phase-events.ts';
import type { RunState } from '../run/store.ts';
import type { CompiledWorkflow, PhaseName } from '../registry/workflows.ts';
import { phasesOf } from '../registry/workflows.ts';
import { runHostedPhase } from '../orchestrator/hosts/host-runner.ts';
import type { RunOrchestratorTurn } from '../orchestrator/hosts/driver.ts';
import { diffReplay } from './diff.ts';
import { makeReplayHost } from './host.ts';
import type { ReplayHostCapture } from './host.ts';
import { rewindPhaseState } from './phase-state.ts';
import { parseProtocolTrace } from './record.ts';
import type { ProtocolTrace } from './record.ts';
import type { SteerEvent } from './record.ts';
import { buildReplayReport, renderReplayReportJson, renderReplayReportText } from './report.ts';
import type { ReplayReport } from './report.ts';
import { scriptedWorkersForTrace } from './scripted-worker.ts';

export interface ReplayRecord {
  readonly runDir: string;
  readonly state: RunState;
  readonly workflow: CompiledWorkflow;
}

export interface PreparedReplayPhase {
  readonly recordId: string;
  readonly phase: PhaseName;
  readonly outputDir: string;
  readonly trace: ProtocolTrace;
  readonly recordedBrief: string;
  readonly state: RunState;
  readonly runDir: string;
  readonly reconstructionNotes: readonly string[];
}

export interface PrepareReplayPhaseInput {
  readonly record: ReplayRecord;
  readonly phase: PhaseName;
  readonly outputDir: string;
  readonly replayRunId?: string;
}

export interface RunReplayPhaseInput extends PrepareReplayPhaseInput {
  readonly runTurn?: RunOrchestratorTurn;
  readonly log?: (line: string) => void;
}

export interface ReplayPhaseResult {
  readonly prepared: PreparedReplayPhase;
  readonly outcome: PhaseEvent;
  readonly capture: ReplayHostCapture;
  readonly report: ReplayReport;
  readonly textReportPath: string;
  readonly jsonReportPath: string;
}

export function prepareReplayPhase(input: PrepareReplayPhaseInput): PreparedReplayPhase {
  const outputDir = resolve(input.outputDir);
  mkdirSync(outputDir, { recursive: true });
  ensurePhase(input.record.workflow, input.phase);
  const recordId = input.record.state.runId || basename(input.record.runDir);
  const trace = parseRecordTrace(input.record.runDir);
  const recordedBrief = recordedBriefFor(trace, input.phase);
  const reconstructionNotes = [
    'phase-entry state synthesized from terminal state.json',
    'raw historical list_snippets tool output is not recorded; replay serves the current snippet library if list_snippets is called',
    ...trace.notes,
    ...midPhaseSteerNotes(trace, input.phase),
    ...(recordedBrief ? [] : [`recorded phase brief for ${input.phase} was missing; replay prompt is empty`]),
  ];
  const rewound = rewindPhaseState({
    recordState: input.record.state,
    workflow: input.record.workflow,
    phase: input.phase,
    outputDir,
    trace,
    ...(input.replayRunId ? { replayRunId: input.replayRunId } : {}),
  });
  return {
    recordId,
    phase: input.phase,
    outputDir,
    trace,
    recordedBrief,
    state: rewound.state,
    runDir: rewound.runDir,
    reconstructionNotes: [...reconstructionNotes, ...rewound.notes],
  };
}

export async function runReplayPhase(input: RunReplayPhaseInput): Promise<ReplayPhaseResult> {
  const prepared = prepareReplayPhase(input);
  const scripted = scriptedWorkersForTrace(prepared.state, prepared.trace, prepared.phase);
  const { host, capture } = makeReplayHost({
    providers: scripted.providers,
    recordedBrief: prepared.recordedBrief,
    outputDir: prepared.outputDir,
    ...(input.runTurn ? { runTurn: input.runTurn } : {}),
    ...(input.log ? { log: input.log } : {}),
  });
  const outcome = await runHostedPhase({ cwd: prepared.state.cwd, runId: prepared.state.runId, phase: prepared.phase }, host);
  const diff = diffReplay({
    original: prepared.trace,
    phase: prepared.phase,
    freshEvents: capture.events,
    scriptedCalls: scripted.calls,
  });
  const report = buildReplayReport({
    recordId: prepared.recordId,
    phase: prepared.phase,
    outputDir: prepared.outputDir,
    reconstructionNotes: [...prepared.reconstructionNotes, ...capture.notes],
    freshRun: { id: prepared.state.runId, outcome: outcome.type, diff },
  });
  const textReportPath = join(prepared.outputDir, 'replay-report.txt');
  const jsonReportPath = join(prepared.outputDir, 'replay-report.json');
  writeFileSync(textReportPath, renderReplayReportText(report));
  writeFileSync(jsonReportPath, renderReplayReportJson(report));
  return { prepared, outcome, capture, report, textReportPath, jsonReportPath };
}

function parseRecordTrace(runDir: string): ProtocolTrace {
  const orchestratorLog = readOptional(join(runDir, 'orchestrator.log'));
  const workerLogs = workerLogNames(runDir).map((voice) => ({ voice, log: readOptional(join(runDir, `${voice}.log`)) }));
  return parseProtocolTrace({ ...(orchestratorLog !== undefined ? { orchestratorLog } : {}), workerLogs });
}

function workerLogNames(runDir: string): string[] {
  if (!existsSync(runDir)) return [];
  return readdirSync(runDir)
    .filter((name) => name.endsWith('.log'))
    .filter((name) => name !== 'orchestrator.log' && name !== 'driver.log')
    .map((name) => name.slice(0, -'.log'.length))
    .sort();
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function recordedBriefFor(trace: ProtocolTrace, phase: PhaseName): string {
  const brief = trace.events.find((event) => event.kind === 'phase_brief' && event.phase === phase);
  return brief?.kind === 'phase_brief' ? brief.body : '';
}

function midPhaseSteerNotes(trace: ProtocolTrace, phase: PhaseName): string[] {
  return trace.events
    .filter((event): event is SteerEvent => event.kind === 'steer' && event.delivery === 'live' && event.phase === phase)
    .map((event) => `mid-phase steer staged ${event.stagedAt} was recorded but not re-injected at its original tool-result boundary`);
}

function ensurePhase(workflow: CompiledWorkflow, phase: PhaseName): void {
  if (phasesOf(workflow).some((p) => p.name === phase)) return;
  throw new Error(`phase "${phase}" is not part of workflow "${workflow.name}"`);
}

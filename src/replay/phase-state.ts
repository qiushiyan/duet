import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { phasesOf, phaseSpec, stageOf, stagesOf } from '../registry/workflows.ts';
import type { CompiledWorkflow, Duty, PhaseName, StageName } from '../registry/workflows.ts';
import { runDirOf, saveRunState } from '../run/store.ts';
import type { RunState, SessionKey } from '../run/store.ts';
import { WORKFLOW_FILE } from '../run/workflow.ts';
import type { ProtocolTrace } from './record.ts';

export interface RewindPhaseStateInput {
  readonly recordState: RunState;
  readonly workflow: CompiledWorkflow;
  readonly phase: PhaseName;
  readonly outputDir: string;
  readonly trace?: ProtocolTrace;
  readonly replayRunId?: string;
}

export interface RewoundPhaseState {
  readonly state: RunState;
  readonly runDir: string;
  readonly notes: readonly string[];
}

export function rewindPhaseState(input: RewindPhaseStateInput): RewoundPhaseState {
  const notes: string[] = [];
  const replayRunId = input.replayRunId ?? `${input.recordState.runId}-replay-${input.phase}`;
  const cwd = join(input.outputDir, 'workspace');
  const state = cloneState(input.recordState);
  state.runId = replayRunId;
  state.cwd = cwd;
  delete state.corpusDir;

  clearReplayIdentity(state);
  clearPhaseProducedState(state, input.workflow, input.phase, input.trace, notes);
  state.sessions = classifySessions(state, input.workflow, input.phase, input.trace, notes);

  const branchFixedBeforePhase = workerPromptBeforePhase(input.trace, input.phase) || Object.keys(state.sessions).length > 0;
  if (branchFixedBeforePhase) state.workerDispatched = true;
  else delete state.workerDispatched;

  const runDir = runDirOf(cwd, replayRunId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, WORKFLOW_FILE), JSON.stringify(input.workflow, null, 2) + '\n');
  saveRunState(state);
  return { state, runDir, notes };
}

function cloneState(state: RunState): RunState {
  return JSON.parse(JSON.stringify(state)) as RunState;
}

function clearReplayIdentity(state: RunState): void {
  delete state.orchestratorSessionId;
  delete state.activeTurns;
  delete state.pendingTurns;
  delete state.contextUsage;
  delete state.pendingMessage;
  delete state.pendingQuestion;
  delete state.retryState;
  delete state.machineState;
  delete state.lastActivity;
  state.costs = {
    orchestratorUsd: 0,
    orchestratorCostPartial: false,
    claudeWorkersUsd: 0,
    claudeWorkersCostPartial: false,
    codexTokens: { input: 0, output: 0 },
  };
}

function clearPhaseProducedState(
  state: RunState,
  workflow: CompiledWorkflow,
  phase: PhaseName,
  trace: ProtocolTrace | undefined,
  notes: string[],
): void {
  delete state.phaseStarted[phase];
  delete state.rounds[phase];
  delete state.sentSnippets?.[phase];
  delete state.phaseSummaries[phase];
  if (state.terminalMarker?.phase === phase) delete state.terminalMarker;

  if (state.specPath && phaseProducesSpecPath(state, phase, trace)) {
    notes.push(`cleared specPath produced by ${phase}; phase-entry value was synthesized from terminal state`);
    delete state.specPath;
  }

  if (phaseSpec(workflow, phase).consultantCheckpoint === 'contract') {
    if (state.acceptanceContractDraft) {
      notes.push(`cleared acceptanceContractDraft produced by ${phase}`);
      delete state.acceptanceContractDraft;
    }
    if (state.acceptanceContract) {
      notes.push(`cleared acceptanceContract derived from ${phase}'s contract checkpoint`);
      delete state.acceptanceContract;
    }
  }
}

function phaseProducesSpecPath(state: RunState, phase: PhaseName, trace: ProtocolTrace | undefined): boolean {
  if (phase !== 'spec' && phase !== 'design') return false;
  if (!state.specPath) return false;
  const brief = trace?.events.find((event) => event.kind === 'phase_brief' && event.phase === phase);
  if (!brief) return true;
  return !brief.body.includes(`path="${state.specPath}"`);
}

function classifySessions(
  state: RunState,
  workflow: CompiledWorkflow,
  phase: PhaseName,
  trace: ProtocolTrace | undefined,
  notes: string[],
): RunState['sessions'] {
  const classified: RunState['sessions'] = {};
  const targetStage = stageOf(workflow, phase);
  const targetStageIndex = stageIndex(workflow, targetStage);
  const replayedVoices = new Set(
    trace?.events.flatMap((event) => (event.kind === 'worker_prompt' && event.phase === phase ? [event.voice] : [])) ?? [],
  );
  const laterCompleted = hasCompletedLaterPhase(state, workflow, phase);

  for (const [key, record] of Object.entries(state.sessions) as Array<[SessionKey, NonNullable<RunState['sessions'][SessionKey]>]>) {
    if (key === 'consultant') {
      if (laterCompleted) {
        notes.push('cleared downstream-produced consultant session');
        continue;
      }
      if (replayedVoices.has('consultant')) {
        notes.push('cleared consultant session produced by replayed phase');
        continue;
      }
      classified[key] = record;
      continue;
    }

    const parsed = parseDutySessionKey(key);
    if (!parsed) {
      notes.push(`kept unclassified session ${key}`);
      classified[key] = record;
      continue;
    }
    const index = stageIndex(workflow, parsed.stage);
    if (index < targetStageIndex) {
      classified[key] = record;
      continue;
    }
    if (index > targetStageIndex) {
      notes.push(`cleared downstream-produced session ${key}`);
      continue;
    }
    if (replayedVoices.has(parsed.duty)) {
      notes.push(`cleared same-stage session ${key} produced or overwritten by ${phase}`);
      continue;
    }
    classified[key] = record;
  }
  return classified;
}

function parseDutySessionKey(key: SessionKey): { stage: StageName; duty: Duty } | undefined {
  if (key === 'consultant') return undefined;
  const [stage, duty] = key.split('.');
  if (!stage || !duty) return undefined;
  return { stage: stage as StageName, duty: duty as Duty };
}

function stageIndex(workflow: CompiledWorkflow, stage: StageName): number {
  return stagesOf(workflow).findIndex((s) => s.name === stage);
}

function hasCompletedLaterPhase(state: RunState, workflow: CompiledWorkflow, phase: PhaseName): boolean {
  const order = phasesOf(workflow).map((p) => p.name);
  const phaseIndex = order.indexOf(phase);
  return Object.keys(state.phaseSummaries).some((name) => order.indexOf(name as PhaseName) > phaseIndex);
}

function workerPromptBeforePhase(trace: ProtocolTrace | undefined, phase: PhaseName): boolean {
  if (!trace) return false;
  const phaseStart = trace.events.find((event) => event.kind === 'phase_brief' && event.phase === phase)?.order;
  if (phaseStart === undefined) return false;
  return trace.events.some((event) => event.kind === 'worker_prompt' && event.order < phaseStart);
}

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  WORKFLOWS,
  isShippedWorkflowName,
  validatedWorkflowSpec,
  workflowDefinition,
} from '../registry/workflows.ts';
import type { CompiledWorkflow, WorkflowSpecInput } from '../registry/workflows.ts';
import { UnloadableRunError } from './store.ts';
import type { RunState } from './store.ts';
import { mirrorFile } from './corpus.ts';

export const WORKFLOW_FILE = 'workflow.json';

export function workflowPath(cwd: string, runId: string): string {
  return join(cwd, '.duet', 'runs', runId, WORKFLOW_FILE);
}

export function writeFrozenWorkflow(state: Pick<RunState, 'cwd' | 'runId' | 'workflow' | 'corpusDir'>, workflow: CompiledWorkflow): void {
  if (workflow.name !== state.workflow) {
    throw new Error(
      `run ${state.runId} names workflow "${state.workflow}" but tried to freeze "${workflow.name}" — the run state and frozen workflow must agree`,
    );
  }
  const path = workflowPath(state.cwd, state.runId);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(workflow, null, 2) + '\n');
  renameSync(tmp, path);
  mirrorFile(state, WORKFLOW_FILE);
}

/**
 * duet keeps no backward compatibility for retired workflow vocabulary, so a
 * frozen workflow that no longer validates IS a run duet can no longer speak —
 * there is no second category to sort it into, and nothing to translate. The
 * refusal is an `UnloadableRunError` so the listing surfaces REPORT it: a corpus
 * record that silently vanished from `duet stats` / `grade` / `graph` would read
 * as "you have no runs" when the truth is "your run no longer loads, and here is
 * the way out".
 *
 * The validator's own message rides along as the evidence, naming whichever knob
 * duet stopped speaking — a `design` artifact kind, a workflow-named build
 * `examplesKey`, both retired 2026-07-08. The era is offered as the known cause
 * and never asserted as the diagnosis, so a hand-corrupted file is not dated to
 * a cohort it was never part of.
 */
function readWorkflowFile(state: Pick<RunState, 'runId' | 'workflow'>, path: string): CompiledWorkflow {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as WorkflowSpecInput;
  let workflow: CompiledWorkflow;
  try {
    workflow = validatedWorkflowSpec(parsed);
  } catch (error) {
    throw new UnloadableRunError(
      state.runId,
      `run ${state.runId} froze a workflow duet no longer speaks — ${error instanceof Error ? error.message : String(error)}. duet keeps no backward compatibility for retired workflow vocabulary; runs frozen before 2026-07-08 (when the spec and design documents unified into one spec doc-loop) are the known cohort. Its transcripts and logs are intact: read them directly, or remove .duet/runs/${state.runId}. Replay and grading of these runs is not supported.`,
    );
  }
  if (workflow.name !== state.workflow) {
    throw new Error(
      `run ${state.runId} state names workflow "${state.workflow}" but ${WORKFLOW_FILE} names "${workflow.name}" — restore the matching frozen workflow file or fix state.json`,
    );
  }
  return workflow;
}

export function workflowForRunDir(state: Pick<RunState, 'runId' | 'workflow'>, runDir: string): CompiledWorkflow {
  const path = join(runDir, WORKFLOW_FILE);
  if (existsSync(path)) {
    return readWorkflowFile(state, path);
  }
  if (isShippedWorkflowName(state.workflow)) return validatedWorkflowSpec(workflowDefinition(state.workflow));
  throw new Error(
    `run ${state.runId} names workflow "${state.workflow}" but has no frozen ${WORKFLOW_FILE}, and it is not shipped (${Object.keys(WORKFLOWS).join(' · ')})`,
  );
}

export function workflowFor(state: Pick<RunState, 'cwd' | 'runId' | 'workflow'>): CompiledWorkflow {
  return workflowForRunDir(state, join(state.cwd, '.duet', 'runs', state.runId));
}

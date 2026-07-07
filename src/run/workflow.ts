import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  WORKFLOWS,
  isShippedWorkflowName,
  validatedWorkflowSpec,
  workflowDefinition,
} from '../registry/workflows.ts';
import type { CompiledWorkflow, WorkflowSpecInput } from '../registry/workflows.ts';
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

function readWorkflowFile(state: Pick<RunState, 'runId' | 'workflow'>, path: string): CompiledWorkflow {
  const workflow = validatedWorkflowSpec(JSON.parse(readFileSync(path, 'utf8')) as WorkflowSpecInput);
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

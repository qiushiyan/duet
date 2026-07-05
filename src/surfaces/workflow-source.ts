import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileWorkflow } from '../workflows.ts';
import {
  WORKFLOWS,
  isShippedWorkflowName,
  validatedWorkflowSpec,
  workflowDefinition,
} from '../registry/workflows.ts';
import type { CompiledWorkflow, WorkflowName, WorkflowSpecInput } from '../registry/workflows.ts';
import type { WorkflowDefinition } from '../registry/define.ts';
import type { WorkflowSource } from '../run/store.ts';

export interface ResolvedWorkflowSource {
  workflow: CompiledWorkflow;
  source: WorkflowSource;
}

export function projectWorkflowDir(cwd: string): string {
  return join(cwd, '.duet', 'workflows');
}

export function userWorkflowDir(home: string = homedir()): string {
  return join(home, '.config', 'duet', 'workflows');
}

export function formatWorkflowSource(source: WorkflowSource, cwd?: string): string {
  if (source.layer === 'shipped') return 'shipped';
  const path = source.path && cwd ? relative(cwd, source.path) || basename(source.path) : source.path;
  return path ? `${source.layer}: ${path}` : source.layer;
}

function tsNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => entry.name.slice(0, -'.ts'.length))
    .sort();
}

function candidateFile(dir: string, name: string): string | undefined {
  const path = join(dir, `${name}.ts`);
  return existsSync(path) ? path : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCompiledLike(value: unknown): value is WorkflowSpecInput {
  return isRecord(value) && typeof value.name === 'string' && typeof value.displayName === 'string' && Array.isArray(value.phases);
}

function moduleWorkflowExport(mod: Record<string, unknown>, path: string): unknown {
  if ('default' in mod) return mod.default;
  if ('workflow' in mod) return mod.workflow;
  throw new Error(
    `${path} does not export a workflow definition — default-export defineWorkflow({ ... }) from this file.`,
  );
}

async function loadWorkflowFile(path: string, requestedName: string): Promise<CompiledWorkflow> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`${path} could not be imported (${err instanceof Error ? err.message : String(err)}) — fix or remove the workflow file.`);
  }
  const exported = moduleWorkflowExport(mod, path);
  const workflow = isCompiledLike(exported)
    ? validatedWorkflowSpec(exported)
    : compileWorkflow(exported as WorkflowDefinition);
  if (workflow.name !== requestedName) {
    throw new Error(
      `${path} exports workflow "${workflow.name}" but was loaded as "${requestedName}" — rename the file or the defineWorkflow({ name }) value so they match.`,
    );
  }
  return workflow;
}

export async function resolveWorkflowSource(
  cwd: string,
  name: WorkflowName,
  opts: { home?: string } = {},
): Promise<ResolvedWorkflowSource> {
  const projectDir = projectWorkflowDir(cwd);
  const userDir = userWorkflowDir(opts.home);
  const candidates: Array<{ source: WorkflowSource; load: () => Promise<CompiledWorkflow> }> = [];
  if (isShippedWorkflowName(name)) {
    candidates.push({
      source: { layer: 'shipped' },
      load: async () => validatedWorkflowSpec(workflowDefinition(name)),
    });
  }
  const projectPath = candidateFile(projectDir, name);
  if (projectPath) {
    candidates.push({
      source: { layer: 'project', path: projectPath },
      load: () => loadWorkflowFile(projectPath, name),
    });
  }
  const userPath = candidateFile(userDir, name);
  if (userPath) {
    candidates.push({
      source: { layer: 'user', path: userPath },
      load: () => loadWorkflowFile(userPath, name),
    });
  }

  if (candidates.length > 1) {
    throw new Error(
      `workflow "${name}" is defined in multiple layers (${candidates.map((c) => formatWorkflowSource(c.source, cwd)).join(', ')}) — remove the duplicate; duet rejects workflow shadowing rather than choosing a winner.`,
    );
  }
  if (candidates.length === 0) {
    const project = tsNames(projectDir);
    const user = tsNames(userDir);
    const available = [
      `shipped: ${Object.keys(WORKFLOWS).join(', ')}`,
      ...(project.length > 0 ? [`project: ${project.join(', ')}`] : []),
      ...(user.length > 0 ? [`user: ${user.join(', ')}`] : []),
    ].join(' · ');
    throw new Error(
      `workflow "${name}" was not found — choose one of ${available}, or add ${name}.ts under ${projectDir} or ${userDir}.`,
    );
  }

  const [candidate] = candidates;
  return { workflow: await candidate!.load(), source: candidate!.source };
}

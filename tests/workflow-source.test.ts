import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect } from 'vitest';
import { defaultBindingsFor } from '../src/voices/bindings.ts';
import { createRun, loadRunState } from '../src/run/store.ts';
import { workflowFor } from '../src/run/workflow.ts';
import { resolveRunInputs } from '../src/surfaces/framing.ts';
import { projectWorkflowDir, resolveWorkflowSource, userWorkflowDir } from '../src/surfaces/workflow-source.ts';
import { test } from './helpers/fixtures.ts';

const sdk = pathToFileURL(join(process.cwd(), 'src', 'workflows.ts')).href;

function workflowFile(name: string, body: string): string {
  return `import { build, defineWorkflow, finish, frame } from ${JSON.stringify(sdk)};

export default defineWorkflow({
  name: ${JSON.stringify(name)},
  title: ${JSON.stringify(`${name} title`)},
  presets: { afk: [] },
  ${body}
});
`;
}

function writeProjectWorkflow(cwd: string, name: string, body = "phases: [frame({ name: 'think' }), build({ review: 'writable', audit: true }), finish()],"): string {
  const dir = projectWorkflowDir(cwd);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.ts`);
  writeFileSync(path, workflowFile(name, body));
  return path;
}

describe('workflow source loader', () => {
  test('resolves a project workflow file and compiles it once into the run inputs', async ({ projectDir }) => {
    writeProjectWorkflow(projectDir, 'instant');
    writeFileSync(join(projectDir, 'brief.md'), 'ship it');

    const inputs = await resolveRunInputs(projectDir, { framing: 'brief.md', workflow: 'instant' });
    expect.soft(inputs.workflow).toBe('instant');
    expect.soft(inputs.workflowSpec.displayName).toBe('instant title');
    expect.soft(inputs.workflowSource).toMatchObject({ layer: 'project', path: join(projectDir, '.duet', 'workflows', 'instant.ts') });

    const run = createRun({
      cwd: projectDir,
      ...inputs,
      bindings: defaultBindingsFor(inputs.workflowSpec),
    });
    rmSync(join(projectDir, '.duet', 'workflows', 'instant.ts'));

    const loaded = loadRunState(projectDir, run.runId);
    expect.soft(workflowFor(loaded).name).toBe('instant');
    expect.soft(workflowFor(loaded).displayName).toBe('instant title');
  });

  test('loads a user workflow when the project layer does not define that name', async ({ projectDir }) => {
    const home = join(projectDir, 'home');
    const dir = userWorkflowDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'personal.ts'), workflowFile('personal', "phases: [frame({ name: 'think' }), build({ review: 'writable', audit: true }), finish()],"));

    const resolved = await resolveWorkflowSource(projectDir, 'personal', { home });
    expect.soft(resolved.workflow.name).toBe('personal');
    expect.soft(resolved.source.layer).toBe('user');
    expect.soft(resolved.source.path).toBe(join(home, '.config', 'duet', 'workflows', 'personal.ts'));
  });

  test('rejects shipped-name and cross-layer collisions before importing a workflow', async ({ projectDir }) => {
    const fullPath = writeProjectWorkflow(projectDir, 'full');
    await expect(resolveWorkflowSource(projectDir, 'full')).rejects.toThrow(/defined in multiple layers.*shipped.*project/);
    rmSync(fullPath);

    const home = join(projectDir, 'home');
    writeProjectWorkflow(projectDir, 'dup');
    mkdirSync(userWorkflowDir(home), { recursive: true });
    writeFileSync(join(userWorkflowDir(home), 'dup.ts'), workflowFile('dup', "phases: [frame({ name: 'think' }), build({ review: 'writable', audit: true }), finish()],"));
    await expect(resolveWorkflowSource(projectDir, 'dup', { home })).rejects.toThrow(/defined in multiple layers.*project.*user/);
  });

  test('wraps illegal compositions with the workflow file path and compiler fix', async ({ projectDir }) => {
    const dir = projectWorkflowDir(projectDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'plan-fixer.ts'),
      `import { build, defineWorkflow, doc, finish, frame } from ${JSON.stringify(sdk)};
export default defineWorkflow({
  name: 'plan-fixer',
  title: 'Plan fixer',
  phases: [frame(), doc('spec'), doc('plan'), build({ review: 'fixer' }), finish()],
});
`,
    );
    await expect(resolveWorkflowSource(projectDir, 'plan-fixer')).rejects.toThrow(/plan-fixer\.ts[\s\S]*plan \+ fresh delivery|no prose world exists/);
  });
});

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect } from 'vitest';
import { execa } from 'execa';
import { defaultBindingsFor } from '../src/voices/bindings.ts';
import { createRun, loadRunState } from '../src/run/store.ts';
import { workflowFor } from '../src/run/workflow.ts';
import { resolveRunInputs } from '../src/surfaces/framing.ts';
import {
  definedWorkflowSources,
  discoverWorkflowSources,
  projectWorkflowDir,
  provisionWorkflowDir,
  resolveWorkflowSource,
  resolveWorkflowSourceReadOnly,
  userWorkflowDir,
  workflowSdkRuntimeUrl,
} from '../src/surfaces/workflow-source.ts';
import { test } from './helpers/fixtures.ts';

const workflowSourceUrl = pathToFileURL(join(process.cwd(), 'src', 'surfaces', 'workflow-source.ts')).href;
const sdkUrl = pathToFileURL(join(process.cwd(), 'src', 'workflows.ts')).href;

function workflowFile(name: string, body: string, sdk = sdkUrl): string {
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

const SDK_SURFACE_FIXTURE = `import {
  build,
  compileWorkflow,
  defineWorkflow,
  doc,
  finish,
  frame,
  type CompiledWorkflow,
  type GateName,
  type PhaseExpr,
  type WorkflowDefinition,
  type WorkflowDefinitionInput,
} from 'duet/workflows';

const gate: GateName = 'triage';
const allBlocks: readonly PhaseExpr[] = [
  frame(),
  frame({ name: 'triage' }),
  doc('spec'),
  doc('plan', { rounds: 2, contract: true, name: 'plan' }),
  doc('design', { audit: false, name: 'design' }),
  build({ review: 'critique', audit: false, name: 'build' }),
  build({ review: 'writable', audit: true }),
  build({ review: 'fixer', name: 'judge' }),
  finish(),
  finish({ name: 'open-pr' }),
];

const input: WorkflowDefinitionInput = {
  name: 'surface',
  title: 'Surface drift guard',
  attend: [gate],
  presets: { afk: [] },
  phases: [frame(), build({ review: 'writable', audit: true }), finish()],
};

const definition: WorkflowDefinition = defineWorkflow(input);
const compiled: CompiledWorkflow = compileWorkflow(definition);
export default definition;
void allBlocks;
void compiled;
`;

function writeRealSdkTsconfig(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ESNext',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          allowImportingTsExtensions: true,
          erasableSyntaxOnly: true,
          verbatimModuleSyntax: true,
          noEmit: true,
          paths: { 'duet/workflows': [join(process.cwd(), 'src', 'workflows.ts')] },
          skipLibCheck: true,
        },
        include: ['surface.ts'],
      },
      null,
      2,
    )}\n`,
  );
}

describe('workflow source loader', () => {
  test('resolves the SDK module beside the active CLI entry', () => {
    expect(pathToFileURL(join('/pkg', 'dist', 'workflows.mjs')).href).toBe(
      workflowSdkRuntimeUrl({ exec: process.execPath, entry: join('/pkg', 'dist', 'cli.mjs') }, pathToFileURL(join('/pkg', 'dist', 'cli.mjs')).href),
    );
    expect(pathToFileURL(join('/pkg', 'src', 'workflows.ts')).href).toBe(
      workflowSdkRuntimeUrl(
        { exec: process.execPath, entry: join('/pkg', 'src', 'surfaces', 'cli.ts') },
        pathToFileURL(join('/pkg', 'src', 'surfaces', 'workflow-source.ts')).href,
      ),
    );
  });

  test('the Node loader hook resolves duet/workflows for workflow files', async ({ projectDir }) => {
    const dir = projectWorkflowDir(projectDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'hooked.ts'),
      `import { build, defineWorkflow, finish, frame } from 'duet/workflows';
export default defineWorkflow({
  name: 'hooked',
  title: 'hooked title',
  presets: { afk: [] },
  phases: [frame({ name: 'think' }), build({ review: 'writable', audit: true }), finish()],
});
`,
    );
    const script = join(projectDir, 'load-hook.mjs');
    writeFileSync(
      script,
      `import { resolveWorkflowSource } from ${JSON.stringify(workflowSourceUrl)};
const resolved = await resolveWorkflowSource(${JSON.stringify(projectDir)}, 'hooked');
console.log(resolved.workflow.name + ':' + resolved.source.layer);
`,
    );
    const { stdout } = await execa(process.execPath, [script], { cwd: process.cwd() });
    expect(stdout).toBe('hooked:project');
    await execa('pnpm', ['exec', 'tsc', '-p', dir, '--noEmit'], { cwd: process.cwd() });
  });

  test('resolves a project workflow file and compiles it once into the run inputs', async ({ projectDir }) => {
    writeProjectWorkflow(projectDir, 'instant');
    writeFileSync(join(projectDir, 'brief.md'), 'ship it');

    const inputs = await resolveRunInputs(projectDir, { framing: 'brief.md', workflow: 'instant' });
    expect.soft(inputs.workflow).toBe('instant');
    expect.soft(inputs.workflowSpec.displayName).toBe('instant title');
    expect.soft(inputs.workflowSource).toMatchObject({ layer: 'project', path: join(projectDir, '.duet', 'workflows', 'instant.ts') });
    expect.soft(readFileSync(join(projectDir, '.duet', 'workflows', 'tsconfig.json'), 'utf8')).toContain('"duet/workflows"');
    expect.soft(readFileSync(join(projectDir, '.duet', 'workflows', 'duet-workflows.d.ts'), 'utf8')).toContain("declare module 'duet/workflows'");

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

  test('missing external workflow lookup reports authoring paths without creating absent dirs', async ({ projectDir }) => {
    const home = join(projectDir, 'home');
    const projectDirPath = projectWorkflowDir(projectDir);
    const userDirPath = userWorkflowDir(home);
    await expect(resolveWorkflowSource(projectDir, 'missing-workflow', { home })).rejects.toThrow(
      new RegExp(`workflow "missing-workflow" was not found[\\s\\S]*${projectDirPath}[\\s\\S]*${userDirPath}`),
    );

    expect.soft(existsSync(projectDirPath)).toBe(false);
    expect.soft(existsSync(userDirPath)).toBe(false);

    mkdirSync(projectDirPath, { recursive: true });
    await expect(resolveWorkflowSource(projectDir, 'still-missing', { home })).rejects.toThrow(/workflow "still-missing" was not found/);
    const projectTsconfig = readFileSync(join(projectDirPath, 'tsconfig.json'), 'utf8');
    expect.soft(projectTsconfig).toContain('"erasableSyntaxOnly": true');
    expect.soft(projectTsconfig).toContain('"duet/workflows"');
    expect.soft(existsSync(userDirPath)).toBe(false);
  });

  test('provisioned duet-workflows.d.ts stays in sync with the real SDK surface', async ({ projectDir }) => {
    const provisionedDir = projectWorkflowDir(projectDir);
    provisionWorkflowDir(provisionedDir);
    writeFileSync(join(provisionedDir, 'surface.ts'), SDK_SURFACE_FIXTURE);
    await execa('pnpm', ['exec', 'tsc', '-p', provisionedDir, '--noEmit'], { cwd: process.cwd() });

    const realSdkDir = join(projectDir, 'real-sdk');
    writeRealSdkTsconfig(realSdkDir);
    writeFileSync(join(realSdkDir, 'surface.ts'), SDK_SURFACE_FIXTURE);
    await execa('pnpm', ['exec', 'tsc', '-p', realSdkDir, '--noEmit'], { cwd: process.cwd() });
  });

  test('generated .d.ts stubs are never workflow definitions', async ({ projectDir }) => {
    const home = join(projectDir, 'home');
    const projectDirPath = projectWorkflowDir(projectDir);
    const userDirPath = userWorkflowDir(home);
    provisionWorkflowDir(projectDirPath);
    provisionWorkflowDir(userDirPath);

    expect.soft(discoverWorkflowSources(projectDir, { home }).map((entry) => entry.name)).not.toContain('duet-workflows.d');
    expect.soft(definedWorkflowSources(projectDir, 'duet-workflows.d', { home })).toEqual([]);
    await expect(resolveWorkflowSource(projectDir, 'duet-workflows.d', { home })).rejects.toThrow(
      /workflow "duet-workflows\.d" was not found[\s\S]*shipped: full, blueprint, relay, short/,
    );
    await expect(resolveWorkflowSource(projectDir, 'duet-workflows.d', { home })).rejects.not.toThrow(/duet-workflows\.d\.ts could not be imported/);
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
      `import { build, defineWorkflow, doc, finish, frame } from ${JSON.stringify(sdkUrl)};
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

describe('resolveWorkflowSourceReadOnly — the no-provision entry point (the blueprint safety guard)', () => {
  test('resolves a project workflow WITHOUT writing tsconfig/.d.ts, while resolveWorkflowSource DOES provision', async ({ projectDir }) => {
    writeProjectWorkflow(projectDir, 'instant');
    const dir = projectWorkflowDir(projectDir);
    const before = readdirSync(dir).sort();
    expect(before).toEqual(['instant.ts']); // only the definition file exists

    const resolved = await resolveWorkflowSourceReadOnly(projectDir, 'instant');
    expect.soft(resolved.workflow.name).toBe('instant');
    expect.soft(resolved.source).toMatchObject({ layer: 'project' });
    // The load-bearing assertion: the dir is byte-for-byte as before — no
    // tsconfig.json, no duet-workflows.d.ts was written.
    expect(readdirSync(dir).sort()).toEqual(before);

    // Control: the provisioning entry point on the SAME dir DOES scaffold.
    await resolveWorkflowSource(projectDir, 'instant');
    expect(readdirSync(dir).sort()).toEqual(['duet-workflows.d.ts', 'instant.ts', 'tsconfig.json']);
  });

  test('a shipped-workflow blueprint neither imports nor writes (fully read-only)', async ({ projectDir }) => {
    // No .duet/workflows dir exists at all — a shipped read-only resolve must not create it.
    const dir = projectWorkflowDir(projectDir);
    expect(existsSync(dir)).toBe(false);

    const resolved = await resolveWorkflowSourceReadOnly(projectDir, 'full');
    expect.soft(resolved.workflow.name).toBe('full');
    expect.soft(resolved.source.layer).toBe('shipped');
    // Nothing was scaffolded — the workflow dir still does not exist.
    expect(existsSync(dir)).toBe(false);
  });
});

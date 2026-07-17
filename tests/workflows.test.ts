import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execa } from 'execa';
import { describe, expect } from 'vitest';
import { resolveWorkflowSource, userWorkflowDir, projectWorkflowDir } from '../src/surfaces/workflow-source.ts';
import {
  buildWorkflowListModel,
  initWorkflowDefinition,
  renderWorkflowCheck,
  renderWorkflowInit,
  renderWorkflowList,
} from '../src/surfaces/workflows.ts';
import { blueprintModel } from '../src/surfaces/graph-model.ts';
import { build, compileWorkflow, defineWorkflow, doc, finish, frame } from '../src/workflows.ts';
import { WORKFLOWS } from '../src/registry/workflows.ts';
import { test } from './helpers/fixtures.ts';
import { defaultBindingsFor } from '../src/voices/bindings.ts';
import type { ResolvedWorkflowSource } from '../src/surfaces/workflow-source.ts';

/** Build the blueprint model `renderWorkflowCheck` now renders over — default bindings unless a consultant is asked for. */
function checkModel(resolved: ResolvedWorkflowSource, opts: { consultant?: boolean } = {}) {
  const base = defaultBindingsFor(resolved.workflow);
  const bindings = opts.consultant
    ? { ...base, consultant: { provider: 'claude' as const, model: 'claude-opus-4-8', transport: 'headless' as const } }
    : base;
  return blueprintModel(resolved.workflow, resolved.source, { bindings, degradedEdges: [] });
}

const cliPath = join(process.cwd(), 'src', 'surfaces', 'cli.ts');
const sdkUrl = pathToFileURL(join(process.cwd(), 'src', 'workflows.ts')).href;

function workflowFile(
  name: string,
  body = "phases: [frame(), build({ review: 'writable', audit: true }), finish()],",
): string {
  return `import { build, defineWorkflow, doc, finish, frame } from ${JSON.stringify(sdkUrl)};

export default defineWorkflow({
  name: ${JSON.stringify(name)},
  title: ${JSON.stringify(`${name} title`)},
  presets: { afk: [] },
  ${body}
});
`;
}

function writeProjectWorkflow(cwd: string, name: string, contents = workflowFile(name)): string {
  const dir = projectWorkflowDir(cwd);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.ts`);
  writeFileSync(path, contents);
  return path;
}

async function checkCli(cwd: string, name: string) {
  return execa(process.execPath, [cliPath, 'workflows', 'check', name], { cwd, reject: false });
}

describe('greenflag workflows list', () => {
  test('lists shipped, project, and user definitions without importing external files', ({ projectDir }) => {
    const home = join(projectDir, 'home');
    writeProjectWorkflow(projectDir, 'project-arc');
    const marker = join(projectDir, 'imported.txt');
    writeProjectWorkflow(
      projectDir,
      'broken-but-listed',
      `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'imported');
throw new Error('listing imported me');
`,
    );
    const userDir = userWorkflowDir(home);
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'personal.ts'), workflowFile('personal'));

    const model = buildWorkflowListModel(projectDir, { home });
    const out = renderWorkflowList(model);

    expect.soft(out).toContain('shipped');
    expect.soft(out).toMatch(/full\s+Full \(spec/);
    expect.soft(out).toContain('project · .greenflag/workflows');
    expect.soft(out).toContain('project-arc');
    expect.soft(out).toContain('broken-but-listed');
    expect.soft(out).toContain('user · home/.config/greenflag/workflows');
    expect.soft(out).toContain('personal');
    expect.soft(out).not.toContain('personal title');
    expect.soft(existsSync(marker), 'list must not import workflow files').toBe(false);
    expect.soft(existsSync(join(projectDir, '.greenflag', 'workflows', 'greenflag-workflows.d.ts')), 'list must not provision typings').toBe(false);
  });

  test('renders collisions in their own section', ({ projectDir }) => {
    const home = join(projectDir, 'home');
    writeProjectWorkflow(projectDir, 'full');
    writeProjectWorkflow(projectDir, 'dup');
    mkdirSync(userWorkflowDir(home), { recursive: true });
    writeFileSync(join(userWorkflowDir(home), 'dup.ts'), workflowFile('dup'));

    const out = renderWorkflowList(buildWorkflowListModel(projectDir, { home }));

    expect.soft(out).toMatch(/collisions[\s\S]*full\s+shipped \+ project \(\.greenflag\/workflows\/full\.ts\)/);
    expect.soft(out).toMatch(/collisions[\s\S]*dup\s+project \(\.greenflag\/workflows\/dup\.ts\) \+ user \(home\/\.config\/greenflag\/workflows\/dup\.ts\)/);
    expect.soft(out).not.toMatch(/project · \.greenflag\/workflows[\s\S]*\n\s+dup\s/);
  });

  test('json rows keep the uniform status and sources shape', ({ projectDir }) => {
    writeProjectWorkflow(projectDir, 'full');

    const full = buildWorkflowListModel(projectDir).rows.find((row) => row.name === 'full');

    expect(full).toEqual({
      name: 'full',
      status: 'collision',
      sources: [
        { layer: 'shipped' },
        { layer: 'project', path: '.greenflag/workflows/full.ts' },
      ],
    });
  });
});

describe('greenflag workflows check', () => {
  test('summarizes a resolved workflow from registry facts', async ({ projectDir }) => {
    writeProjectWorkflow(
      projectDir,
      'deep-relay',
      workflowFile(
        'deep-relay',
        "phases: [frame(), doc('spec', { contract: true, rounds: 2 }), build({ review: 'fixer' }), finish()], attend: ['spec'],",
      ),
    );
    const resolved = await resolveWorkflowSource(projectDir, 'deep-relay');

    const out = renderWorkflowCheck(checkModel(resolved), projectDir);

    expect.soft(out).toContain('workflow  deep-relay — deep-relay title');
    expect.soft(out).toContain('source    project · .greenflag/workflows/deep-relay.ts');
    expect.soft(out).toContain('phases (4)');
    expect.soft(out).toContain('spec       doc-loop (spec)');
    // The gate line shows the compact "<X> gate" label, not the full packet heading.
    expect.soft(out).toContain('-> SPEC gate · 2 rounds');
    expect.soft(out).not.toContain("the orchestrator's summary");
    // Rounds surface for the doc-loop only; the build phase's own review cap stays hidden.
    expect.soft(out).toMatch(/build \(fixer\)\s+-> SHIP gate$/m);
    expect.soft(out).toContain('authors the acceptance contract');
    expect.soft(out).toContain('delivery   builder + judge · structurally fresh');
    expect.soft(out).toContain('default attended gates   spec');
    expect.soft(out).toContain('acceptance contract      authored at spec, verified at implement (when a consultant is bound)');
  });

  test('enriches the summary with config-resolved bindings and per-phase consultant checkpoints (the same spine as greenflag graph)', async ({ projectDir }) => {
    const resolved = await resolveWorkflowSource(projectDir, 'full');

    // Without a consultant bound: bindings show the defaults, checkpoints are latent.
    const plain = renderWorkflowCheck(checkModel(resolved), projectDir);
    expect.soft(plain).toContain('bindings (defaults · resolved from ~/.config/greenflag/config.toml)');
    expect.soft(plain).toMatch(/architect\s+claude:claude-opus-4-8/);
    expect.soft(plain).toMatch(/analyst\s+codex/);
    expect.soft(plain).toContain('consultant checkpoints   (fire when a consultant is bound)');
    // The per-phase checkpoint kinds, render-facing (never the internal `challenge`).
    expect.soft(plain).toMatch(/frame\s+generative/);
    expect.soft(plain).toMatch(/spec\s+bet-audit/);
    expect.soft(plain).toMatch(/plan\s+backstop/);
    expect.soft(plain).not.toContain('challenge');

    // With a consultant bound: the consultant binding row appears and the note flips.
    const withConsultant = renderWorkflowCheck(checkModel(resolved, { consultant: true }), projectDir);
    expect.soft(withConsultant).toMatch(/consultant\s+claude:claude-opus-4-8/);
    expect.soft(withConsultant).toContain('consultant checkpoints   (a consultant is bound — these fire)');
  });

  test('surfaces resolver and compiler failures without a command-specific wrapper', async ({ projectDir }) => {
    // The error prose itself is owned by workflow-source.test.ts (resolver) and
    // the compiler; the CLI delta pinned here is only that `workflows check`
    // exits 1 and surfaces the error UNWRAPPED (no added prefix) — one
    // identifying token per failure case.
    writeProjectWorkflow(projectDir, 'full');
    writeProjectWorkflow(projectDir, 'mismatch', workflowFile('other-name'));
    writeProjectWorkflow(projectDir, 'bad-world', workflowFile('bad-world', "phases: [frame(), doc('spec'), build({ review: 'writable' }), finish()],"));
    writeProjectWorkflow(projectDir, 'import-throws', "throw new Error('top-level boom');");
    const cases: Array<[name: string, token: string]> = [
      ['full', 'multiple layers'],
      ['missing', 'was not found'],
      ['mismatch', 'loaded as "mismatch"'],
      ['bad-world', 'writable build prose world'],
      ['import-throws', 'top-level boom'],
    ];
    for (const [name, token] of cases) {
      const result = await checkCli(projectDir, name);
      expect.soft(result.exitCode, name).toBe(1);
      expect.soft(result.stderr, name).toContain(token);
      expect.soft(result.stderr, name).not.toContain('workflows check failed');
    }
  });
});

describe('greenflag workflows init', () => {
  test('refuses names that already resolve from any layer', ({ projectDir }) => {
    const home = join(projectDir, 'home');
    mkdirSync(userWorkflowDir(home), { recursive: true });
    writeFileSync(join(userWorkflowDir(home), 'personal.ts'), workflowFile('personal'));
    writeProjectWorkflow(projectDir, 'local');

    expect(() => initWorkflowDefinition(projectDir, 'full', { home })).toThrow(/already resolves from shipped/);
    expect(() => initWorkflowDefinition(projectDir, 'local', { home })).toThrow(/already resolves from project: \.greenflag\/workflows\/local\.ts/);
    expect(() => initWorkflowDefinition(projectDir, 'personal', { home })).toThrow(/already resolves from user: home\/\.config\/greenflag\/workflows\/personal\.ts/);
  });

  test('refuses invalid or path-escaping names before writing', ({ projectDir }) => {
    expect(() => initWorkflowDefinition(projectDir, '')).toThrow(/workflow name is required/);
    expect(() => initWorkflowDefinition(projectDir, '../escape')).toThrow(/invalid/);
    expect(() => initWorkflowDefinition(projectDir, 'not_ok')).toThrow(/invalid/);
    expect.soft(existsSync(join(projectDir, 'escape.ts'))).toBe(false);
    expect.soft(existsSync(projectWorkflowDir(projectDir))).toBe(false);
  });

  test('provisions a typed starter that compiles through check', async ({ projectDir }) => {
    const result = initWorkflowDefinition(projectDir, 'starter-flow');
    const rendered = renderWorkflowInit(result, projectDir);

    expect.soft(rendered).toContain('created .greenflag/workflows/starter-flow.ts');
    expect.soft(rendered).toContain('greenflag workflows check starter-flow');
    expect.soft(rendered).toContain('greenflag new --workflow starter-flow');
    expect.soft(rendered).toContain('!/workflows/');
    expect.soft(readFileSync(join(projectWorkflowDir(projectDir), 'greenflag-workflows.d.ts'), 'utf8')).toContain("declare module 'greenflag/workflows'");

    const source = readFileSync(result.path, 'utf8');
    expect.soft(source).toContain("import { build, defineWorkflow, finish, frame } from 'greenflag/workflows';");
    expect.soft(source).toContain("name: 'starter-flow'");
    expect.soft(source).toContain("build({ review: 'writable' })");
    expect.soft(source).toContain('skills/greenflag-frame/references/workflow-definitions.md');

    const checked = await checkCli(projectDir, 'starter-flow');
    expect.soft(checked.exitCode).toBe(0);
    expect.soft(checked.stdout).toContain('workflow  starter-flow — starter-flow workflow');
  });
});

describe('workflow SDK rebuild pins — blueprint and short', () => {
  // skill.test.ts pins the full and relay rebuilds byte-identical to the
  // registry rows (the greenflag-frame reference's executable workflow-ts examples);
  // blueprint and short have no reference example, so their
  // SDK-rebuild-equals-registry pins live here.
  const rebuilds = {
    blueprint: defineWorkflow({
      name: 'blueprint',
      title: 'Blueprint (frame → spec → implement → ship → PR)',
      attend: ['spec'],
      presets: { afk: [] },
      phases: [frame(), doc('spec', { rounds: 2, contract: true }), build({ review: 'critique' }), finish()],
    }),
    short: defineWorkflow({
      name: 'short',
      title: 'Short (research → implement → ship → PR)',
      attend: ['research'],
      presets: { afk: [] },
      phases: [frame({ name: 'research' }), build({ review: 'writable', audit: true }), finish()],
    }),
  };

  for (const name of ['blueprint', 'short'] as const) {
    test(`${name} compiles byte-identical to the shipped registry row`, () => {
      expect(JSON.stringify(compileWorkflow(rebuilds[name]), null, 2)).toBe(JSON.stringify(WORKFLOWS[name], null, 2));
    });
  }
});

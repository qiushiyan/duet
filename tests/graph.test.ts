import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { WORKFLOWS } from '../src/registry/workflows.ts';
import { defaultBindingsFor } from '../src/voices/bindings.ts';
import { blueprintModel } from '../src/surfaces/graph-model.ts';
import { buildBlueprintModel, renderGraph, renderGraphJson, renderGraphMermaid } from '../src/surfaces/graph.ts';
import { consultantBindingsFor, test } from './helpers/fixtures.ts';

/**
 * Render tests assert on the rendered strings (a render concern), and pin the
 * additive `--json` schema by key snapshot. picocolors self-disables off-TTY, so
 * the ANSI render is plain text under test — assert substrings freely.
 */

const shipped = { layer: 'shipped' as const };

function blueprint(workflow: keyof typeof WORKFLOWS, consultant = false) {
  const bindings = consultant ? consultantBindingsFor(workflow) : defaultBindingsFor(workflow);
  return blueprintModel(WORKFLOWS[workflow], shipped, { bindings, degradedEdges: [] });
}

describe('renderGraph — the blueprint ANSI pipeline', () => {
  // The structural facts (phase order, block/knob labels, default posture,
  // binding rows, checkpoint kinds, continuity/degraded edges) are pinned on
  // the MODEL in graph-model.test.ts; the render owns only that it draws the
  // sections over that model.
  test('renders the pipeline and bindings sections from the model', () => {
    const out = renderGraph(blueprint('full'));
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain('pipeline');
    expect(out).toContain('spec'); // a phase row made it into the pipeline
    expect(out).toContain('bindings');
    expect(out).toContain('architect'); // a duty binding row
  });
});

describe('renderGraphMermaid — the static blueprint flowchart', () => {
  test('emits a plain-text flowchart of the spine, gates chained by index-derived ids', () => {
    const out = renderGraphMermaid(blueprint('short'));
    expect(out.startsWith('flowchart TD')).toBe(true);
    // Ids are index-derived (p0, p0_gate), the phase name lives only in the label.
    expect(out).toContain('p0["research: frame"]');
    expect(out).toContain('p0 --> p0_gate');
    expect(out).toContain('p0_gate --> p1');
    // No control/ESC characters in the docs artifact (a static, plain-text diagram).
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u001f]/.test(out.replace(/\n/g, ""))).toBe(false);
  });

  test('a project phase name with a space is safe — it never becomes a bare Mermaid id', async ({ projectDir }) => {
    const dir = join(projectDir, '.greenflag', 'workflows');
    mkdirSync(dir, { recursive: true });
    const sdk = join(process.cwd(), 'src', 'workflows.ts');
    writeFileSync(
      join(dir, 'spacey.ts'),
      `import { build, defineWorkflow, finish, frame } from ${JSON.stringify(sdk)};\n` +
        `export default defineWorkflow({ name: 'spacey', title: 'Spacey', presets: { afk: [] }, phases: [frame({ name: 'open pr' }), build({ review: 'writable', audit: true }), finish()] });\n`,
    );
    const model = await buildBlueprintModel(projectDir, 'spacey', { configPath: join(projectDir, 'none.toml') });
    const out = renderGraphMermaid(model);
    // The spaced name appears only inside a quoted label on an index-derived id.
    expect(out).toContain('p0["open pr: frame"]');
    expect(out).toContain('p0 --> p0_gate');
    // It must NOT appear as a bare node/id token (which would be invalid Mermaid).
    expect(out).not.toMatch(/(^|\s)open pr[\[{]/);
  });
});

describe('renderGraphJson — the additive pinned schema', () => {
  test('blueprint --json carries the settled top-level keys, raw', () => {
    const model = blueprint('full', true);
    const json = JSON.parse(renderGraphJson(model));
    expect(Object.keys(json).sort()).toEqual(['bindings', 'checkpoints', 'degradedEdges', 'mode', 'spine']);
    expect(json.mode).toBe('blueprint');
    expect(Object.keys(json.spine).sort()).toEqual(['defaultPosture', 'displayName', 'name', 'phases', 'source', 'stages']);
    // A phase node's keys (roundCap present on a review-loop phase).
    const spec = json.spine.phases.find((p: { name: string }) => p.name === 'spec');
    expect(Object.keys(spec).sort()).toEqual(['artifactKind', 'block', 'consultantCheckpoint', 'duties', 'gate', 'name', 'reviewLoop', 'roundCap', 'stage']);
    // A checkpoint row carries the render-facing kind.
    const checkpoint = json.checkpoints.find((c: { phase: string }) => c.phase === 'spec');
    expect(checkpoint).toMatchObject({ phase: 'spec', mode: 'specGate', kind: 'bet-audit', live: true });
  });
});

describe('buildBlueprintModel — read-only resolve + config-resolved bindings', () => {
  test('resolves a shipped workflow with default bindings and no consultant', async ({ projectDir }) => {
    const model = await buildBlueprintModel(projectDir, 'full', { configPath: join(projectDir, 'no-such-config.toml') });
    expect(model.mode).toBe('blueprint');
    expect(model.spine.name).toBe('full');
    expect(model.bindings.some((b) => b.address === 'consultant')).toBe(false);
  });

  test('a config [duties.builder] override shows in the resolved bindings', async ({ projectDir }) => {
    const configPath = join(projectDir, 'config.toml');
    writeFileSync(configPath, '[duties.builder]\nprovider = "codex"\n');
    const model = await buildBlueprintModel(projectDir, 'full', { configPath });
    const builder = model.bindings.find((b) => b.address === 'builder');
    expect(builder?.label).toBe('codex');
    // Crossing the builder to codex degrades the builder←architect continuity edge.
    expect(model.degradedEdges.some((e) => e.into === 'builder')).toBe(true);
  });

  test('a config [consultant] binding lights up the live checkpoints', async ({ projectDir }) => {
    const configPath = join(projectDir, 'config.toml');
    writeFileSync(configPath, '[consultant]\nprovider = "claude"\n');
    const model = await buildBlueprintModel(projectDir, 'full', { configPath });
    expect(model.bindings.some((b) => b.address === 'consultant')).toBe(true);
    expect(model.checkpoints.some((c) => c.live)).toBe(true);
  });

  test('resolves a project-composed workflow read-only (no provisioning side effects)', async ({ projectDir }) => {
    const dir = join(projectDir, '.greenflag', 'workflows');
    mkdirSync(dir, { recursive: true });
    const sdk = join(process.cwd(), 'src', 'workflows.ts');
    writeFileSync(
      join(dir, 'tiny.ts'),
      `import { build, defineWorkflow, finish, frame } from ${JSON.stringify(sdk)};\n` +
        `export default defineWorkflow({ name: 'tiny', title: 'Tiny', presets: { afk: [] }, phases: [frame(), build({ review: 'writable', audit: true }), finish()] });\n`,
    );
    const model = await buildBlueprintModel(projectDir, 'tiny', { configPath: join(projectDir, 'none.toml') });
    expect(model.spine.name).toBe('tiny');
    expect(model.spine.source).toMatchObject({ layer: 'project' });
  });
});

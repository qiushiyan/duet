import { describe, expect, test } from 'vitest';
import { WORKFLOWS } from '../src/registry/workflows.ts';
import { consultantBindingsFor } from './helpers/fixtures.ts';
import { defaultBindingsFor, degradedEdgesFor } from '../src/voices/bindings.ts';
import { blueprintModel, structuralSpine } from '../src/surfaces/graph-model.ts';
import type { WorkflowSpine } from '../src/surfaces/graph-model.ts';

/**
 * The spine is asserted on the MODEL, not a rendered string, so these survive
 * render tweaks (the doc's test standard). One test per shipped arc proves the
 * structural projection; the blueprint overlay tests prove the config-resolved
 * defaults and the live checkpoints.
 */

function phase(spine: WorkflowSpine, name: string) {
  const node = spine.phases.find((p) => p.name === name);
  if (!node) throw new Error(`no phase ${name} in ${spine.name}`);
  return node;
}

describe('structuralSpine — the shared structural projection', () => {
  test('full: phase order, blocks, gate labels, stage duties, caps', () => {
    const spine = structuralSpine(WORKFLOWS.full);
    expect(spine.name).toBe('full');
    expect(spine.phases.map((p) => p.name)).toEqual(['frame', 'spec', 'plan', 'implement', 'finish']);
    expect(spine.phases.map((p) => p.block)).toEqual(['frame', 'doc-loop', 'doc-loop', 'build', 'finish']);
    // The block's distinguishing knob rides the node — what the render
    // summarizes as "doc-loop (spec)" / "build (critique)".
    expect(phase(spine, 'spec').artifactKind).toBe('spec');
    expect(phase(spine, 'implement').reviewPosture).toBe('critique');
    // Every phase carries a gate with a compact label (the "<LABEL>" token) and a machine state name.
    for (const p of spine.phases) {
      expect(p.gate.label.length).toBeGreaterThan(0);
      expect(p.gate.label).not.toContain(' — ');
      expect(p.gate.state.length).toBeGreaterThan(0);
    }
    // reviewLoop phases (doc-loop + build) carry a roundCap; frame/finish do not.
    expect(phase(spine, 'spec').reviewLoop).toBe(true);
    expect(phase(spine, 'spec').roundCap).toBeGreaterThan(0);
    expect(phase(spine, 'frame').reviewLoop).toBe(false);
    expect(phase(spine, 'frame').roundCap).toBeUndefined();
    // Stage duties resolve per phase's stage.
    expect(phase(spine, 'plan').duties).toEqual({ maker: 'architect', checker: 'analyst' });
    expect(phase(spine, 'implement').duties).toEqual({ maker: 'builder', checker: 'critic' });
  });

  test('full: stages carry the duty pairs and the delivery continuity edges', () => {
    const spine = structuralSpine(WORKFLOWS.full);
    expect(spine.stages.map((s) => s.name)).toEqual(['planning', 'delivery']);
    const planning = spine.stages.find((s) => s.name === 'planning')!;
    const delivery = spine.stages.find((s) => s.name === 'delivery')!;
    // Planning duties start fresh (no continuity into them).
    expect(planning.continuity).toEqual({});
    // Delivery continues both duties from their planning counterparts.
    expect(delivery.continuity).toEqual({ builder: 'architect', critic: 'analyst' });
  });

  test('relay: delivery is structurally fresh (no continuity edges)', () => {
    const spine = structuralSpine(WORKFLOWS.relay);
    const delivery = spine.stages.find((s) => s.name === 'delivery')!;
    expect(delivery.continuity).toEqual({});
  });

  test('short: no spec/plan, a single build stage, a one-interruption default posture', () => {
    const spine = structuralSpine(WORKFLOWS.short);
    expect(spine.phases.map((p) => p.name)).toEqual(['research', 'implement', 'finish']);
    // short's default attends Direction only (the handoff gate) — blueprint/relay's
    // one-interruption shape (flipped 2026-07-11 from attend-all).
    expect(spine.defaultPosture).toEqual(['research']);
  });

  test('full: defaultPosture is the attended set (frame, spec) — the Open-PR gate is pre-authorized', () => {
    const spine = structuralSpine(WORKFLOWS.full);
    expect(spine.defaultPosture).toEqual(['frame', 'spec']);
  });

  test('the static consultant-checkpoint mode rides each phase (no liveness in the pure spine)', () => {
    const spine = structuralSpine(WORKFLOWS.full);
    expect(phase(spine, 'frame').consultantCheckpoint).toBe('frame');
    expect(phase(spine, 'spec').consultantCheckpoint).toBe('specGate');
    expect(phase(spine, 'plan').consultantCheckpoint).toBe('contract');
    expect(phase(spine, 'implement').consultantCheckpoint).toBe('verify');
    expect(phase(spine, 'finish').consultantCheckpoint).toBeUndefined();
  });
});

describe('blueprintModel — the config-resolved default overlay', () => {
  test('carries the structural spine plus a binding row per bound address', () => {
    const bindings = defaultBindingsFor('full');
    const model = blueprintModel(WORKFLOWS.full, { layer: 'shipped' }, { bindings, degradedEdges: [] });
    expect(model.mode).toBe('blueprint');
    expect(model.spine.phases.map((p) => p.name)).toEqual(['frame', 'spec', 'plan', 'implement', 'finish']);
    expect(model.spine.source).toEqual({ layer: 'shipped' });
    // Every default-bound address (orchestrator + the four duties) has a labeled row.
    const addresses = model.bindings.map((b) => b.address).sort();
    expect(addresses).toEqual(['analyst', 'architect', 'builder', 'critic', 'orchestrator']);
    // The label is the human binding form: the shipped default runs makers on
    // claude (with the defaulted model) and checkers on codex.
    const byAddress = Object.fromEntries(model.bindings.map((b) => [b.address, b.label]));
    expect(byAddress.architect).toBe('claude:claude-opus-4-8');
    expect(byAddress.builder).toBe('claude:claude-opus-4-8');
    expect(byAddress.analyst).toBe('codex');
    expect(byAddress.critic).toBe('codex');
  });

  test('a consultant-bound blueprint surfaces live checkpoints with render-facing kinds', () => {
    const bindings = consultantBindingsFor('full');
    const model = blueprintModel(WORKFLOWS.full, { layer: 'shipped' }, { bindings, degradedEdges: [] });
    // The consultant address gets a row too.
    expect(model.bindings.some((b) => b.address === 'consultant')).toBe(true);
    // Checkpoints are present for every checkpoint-bearing phase, live, kind render-facing.
    const byPhase = Object.fromEntries(model.checkpoints.map((c) => [c.phase, c]));
    expect(byPhase.frame).toMatchObject({ mode: 'frame', kind: 'generative', live: true });
    expect(byPhase.spec).toMatchObject({ mode: 'specGate', kind: 'bet-audit', live: true });
    expect(byPhase.plan).toMatchObject({ mode: 'contract', kind: 'backstop', live: true });
    expect(byPhase.implement).toMatchObject({ mode: 'verify', kind: 'backstop', live: true });
    // finish carries no checkpoint.
    expect(byPhase.finish).toBeUndefined();
    // The internal taxonomy never leaks: `kind` is render-facing by type — a
    // `challenge` comparison is a compile error, so the surface can't see it.
  });

  test('without a consultant bound, checkpoints resolve but are not live (default-off preserved)', () => {
    const bindings = defaultBindingsFor('full');
    const model = blueprintModel(WORKFLOWS.full, { layer: 'shipped' }, { bindings, degradedEdges: [] });
    expect(model.bindings.some((b) => b.address === 'consultant')).toBe(false);
    // The checkpoint modes still project (they are registry data), but none is live.
    expect(model.checkpoints.length).toBeGreaterThan(0);
    expect(model.checkpoints.every((c) => c.live === false)).toBe(true);
  });

  test('degraded edges pass through to the model (a cross-provider continuity binding)', () => {
    // build the builder on codex while the architect stays claude → the
    // builder←architect edge degrades to fresh.
    const bindings = {
      ...defaultBindingsFor('full'),
      duties: { ...defaultBindingsFor('full').duties, builder: { provider: 'codex' as const } },
    };
    const degradedEdges = degradedEdgesFor(bindings, WORKFLOWS.full);
    const model = blueprintModel(WORKFLOWS.full, { layer: 'shipped' }, { bindings, degradedEdges });
    expect(model.degradedEdges).toEqual(degradedEdges);
    expect(model.degradedEdges.some((e) => e.into === 'builder')).toBe(true);
  });
});

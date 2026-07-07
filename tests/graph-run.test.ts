import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { buildStatusModel } from '../src/surfaces/status.ts';
import { runGraphModel } from '../src/surfaces/graph-model.ts';
import type { RunNodeState } from '../src/surfaces/graph-model.ts';
import { buildRunGraphModel, renderGraph, renderGraphJson } from '../src/surfaces/graph.ts';
import { workflowFor } from '../src/run/workflow.ts';
import { runDirOf, saveRunState } from '../src/run/store.ts';
import type { RunState } from '../src/run/store.ts';
import type { RunPosition } from '../src/run/position.ts';
import type { Steer } from '../src/run/steers.ts';
import { defaultBindingsFor } from '../src/voices/bindings.ts';
import { test } from './helpers/fixtures.ts';

/**
 * The run overlay is asserted on the MODEL (the position probe is pure and
 * injectable), fed a RunState + a scripted RunPosition. Status is built with the
 * same position and the run's pending steers so the steer-drift signal populates.
 */
function runModel(state: RunState, position: RunPosition, pending: Steer[] = []) {
  const status = buildStatusModel(state, position, pending);
  return runGraphModel(workflowFor(state), status, state, position);
}

function node(nodes: RunNodeState[], phase: string): RunNodeState {
  const n = nodes.find((p) => p.phase === phase);
  if (!n) throw new Error(`no node ${phase}`);
  return n;
}

describe('runGraphModel — done/current/future + gate outcomes', () => {
  test('a gate position marks its phase current; earlier phases done with their crossing authority', ({ run }) => {
    run.autoApprovals = [{ gate: 'directionGate', at: '2026-07-07T10:00:00.000Z' }];
    const model = runModel(run, { kind: 'gate', phase: 'spec' });
    expect(node(model.nodes, 'frame').status).toBe('done');
    expect(node(model.nodes, 'spec').status).toBe('current');
    expect(node(model.nodes, 'plan').status).toBe('future');
    // frame's gate was ledgered auto-crossed; a done gate with no ledger renders `crossed`.
    expect(node(model.nodes, 'frame').gate.outcome).toBe('auto-crossed');
  });

  test('a completed gate with no autoApprovals entry renders `crossed`, NEVER "attended"', ({ run }) => {
    run.autoApprovals = []; // nothing ledgered
    const model = runModel(run, { kind: 'gate', phase: 'plan' });
    const frame = node(model.nodes, 'frame');
    expect(frame.status).toBe('done');
    expect(frame.gate.outcome).toBe('crossed');
    // State does not attest an explicit human approval — "attended" is never an outcome.
    for (const n of model.nodes) expect((n.gate.outcome as string) ?? '').not.toBe('attended');
  });

  test('done position ⇒ every node done, no cursor', ({ run }) => {
    const model = runModel(run, { kind: 'done' });
    expect(model.nodes.every((n) => n.status === 'done')).toBe(true);
    expect(model.nodes.some((n) => n.status === 'current')).toBe(false);
  });

  test('abandoned ⇒ no cursor; a phase is done/crossed only when a LATER phase started (crossing proof)', ({ run }) => {
    run.phaseStarted = { frame: true, spec: true }; // reached spec; spec never advanced
    const model = runModel(run, { kind: 'abandoned' });
    expect(model.nodes.some((n) => n.status === 'current')).toBe(false);
    // frame's gate is PROVEN crossed — a later phase (spec) started.
    expect(node(model.nodes, 'frame').status).toBe('done');
    expect(node(model.nodes, 'frame').gate.outcome).toBe('crossed');
    // spec is the furthest reached: started but NOT proven crossed → future, no outcome.
    expect(node(model.nodes, 'spec').status).toBe('future');
    expect(node(model.nodes, 'spec').gate.outcome).toBeUndefined();
    expect(node(model.nodes, 'plan').status).toBe('future');
  });

  test('abandoned NEVER claims an uncrossed gate crossed (phaseStarted is entry-sent, not crossed)', ({ run }) => {
    run.phaseStarted = { frame: true }; // frame reached, never advanced; nothing after it
    run.autoApprovals = [];
    const model = runModel(run, { kind: 'abandoned' });
    // The furthest-reached phase was merely started — no later phase, no ledgered
    // auto-approval — so it must not be claimed crossed (the honesty invariant, the
    // temporal analogue of never-"attended").
    const frame = node(model.nodes, 'frame');
    expect(frame.status).toBe('future');
    for (const n of model.nodes) expect(n.gate.outcome).toBeUndefined();
  });

  test('abandoned: a ledgered auto-approval is crossing proof even without a recorded later phaseStarted', ({ run }) => {
    run.phaseStarted = { frame: true };
    run.autoApprovals = [{ gate: 'directionGate', at: '2026-07-07T10:00:00.000Z' }]; // frame's gate auto-crossed
    const model = runModel(run, { kind: 'abandoned' });
    expect(node(model.nodes, 'frame').status).toBe('done');
    expect(node(model.nodes, 'frame').gate.outcome).toBe('auto-crossed');
  });

  test('a high human decision holding a (pre-authorized) gate sets heldHigh', ({ run }) => {
    run.phaseSummaries = { plan: { summary: 's', artifacts: [], humanDecisions: [{ title: 'bet the DB', severity: 'high' }] } };
    const model = runModel(run, { kind: 'gate', phase: 'plan' });
    expect(node(model.nodes, 'plan').gate.heldHigh).toBe(true);
    expect(node(model.nodes, 'frame').gate.heldHigh).toBeUndefined();
  });

  test('gate posture reflects gatesAt: listed = attended, unlisted = pre-authorized', ({ run }) => {
    run.gatesAt = ['frame', 'spec']; // the full default
    const model = runModel(run, { kind: 'gate', phase: 'spec' });
    expect(node(model.nodes, 'frame').gate.posture).toBe('attended');
    expect(node(model.nodes, 'plan').gate.posture).toBe('pre-authorized');
  });
});

describe('runGraphModel — phase-attributed drift, and the run-level intervention split', () => {
  test('an unexpected snippet tag flags; a phase snippet and an anytime helper do not', ({ run }) => {
    run.sentSnippets = { spec: { architect: ['write-spec', 'reread-context'], analyst: ['review-spec', 'bogus-tag'] } };
    const drift = node(runModel(run, { kind: 'gate', phase: 'spec' }).nodes, 'spec').drift;
    const unexpected = drift.filter((d) => d.kind === 'unexpected-tag');
    expect(unexpected).toHaveLength(1);
    expect(unexpected[0]).toMatchObject({ kind: 'unexpected-tag', tag: 'bogus-tag', voice: 'analyst' });
  });

  test('rounds past cap raises the cap flag', ({ run }) => {
    run.rounds = { spec: 5 }; // full's spec cap is 3
    const drift = node(runModel(run, { kind: 'gate', phase: 'spec' }).nodes, 'spec').drift;
    expect(drift.some((d) => d.kind === 'rounds-past-cap')).toBe(true);
  });

  test('an auto-retry in a phase raises that phase’s auto-retry flag', ({ run }) => {
    run.autoRetries = [{ phase: 'implement', errorClass: 'network', attempt: 2, at: '2026-07-07T10:00:00.000Z' }];
    const model = runModel(run, { kind: 'running', pid: 999, phase: 'implement' });
    expect(node(model.nodes, 'implement').drift.some((d) => d.kind === 'auto-retry')).toBe(true);
    expect(node(model.nodes, 'spec').drift.some((d) => d.kind === 'auto-retry')).toBe(false);
  });

  test('a steer currently staged during a phase raises the steer-staged flag (pending-only)', ({ run }) => {
    const pending: Steer[] = [{ file: 'x.json', text: 'try Y', stagedAt: '2026-07-07T10:00:00.000Z', stagedDuring: 'implement' }];
    const model = runModel(run, { kind: 'running', pid: 999, phase: 'implement' }, pending);
    expect(node(model.nodes, 'implement').drift.some((d) => d.kind === 'steer-staged')).toBe(true);
  });

  test('a context intervention is run-level (interventions), NOT a per-phase drift flag', ({ run }) => {
    run.contextEvents = [{ kind: 'compact', voice: 'architect', at: '2026-07-07T10:00:00.000Z' }];
    const model = runModel(run, { kind: 'gate', phase: 'spec' });
    expect(model.interventions).toHaveLength(1);
    // It has no phase to attach to — no node carries it (nor anything else) as drift.
    expect(model.nodes.flatMap((n) => n.drift)).toHaveLength(0);
  });

  test('the run arc applies FROZEN-binding degradation, so it never implies an edge the manifest ran fresh', ({ run }) => {
    // Freeze the builder on codex while the architect stays claude → builder←architect degrades.
    run.bindings = { ...defaultBindingsFor('full'), duties: { ...defaultBindingsFor('full').duties, builder: { provider: 'codex' } } };
    const model = runModel(run, { kind: 'gate', phase: 'spec' });
    expect(model.degradedEdges.some((e) => e.into === 'builder')).toBe(true);
  });
});

describe('the run view is read-only and its JSON is additive', () => {
  test('building the model against a run dir with a live driver.pid mutates nothing', ({ run }) => {
    // A live driver holds the run — the read must not race its saves.
    writeFileSync(join(runDirOf(run.cwd, run.runId), 'driver.pid'), String(process.pid));
    const statePath = join(runDirOf(run.cwd, run.runId), 'state.json');
    const before = readFileSync(statePath, 'utf8');
    const model = buildRunGraphModel(run);
    expect(model.mode).toBe('run');
    // byte-for-byte unchanged — nothing was written.
    expect(readFileSync(statePath, 'utf8')).toBe(before);
  });

  test('run --json carries the settled top-level keys, raw', ({ run }) => {
    saveRunState(run);
    const json = JSON.parse(renderGraphJson(buildRunGraphModel(run)));
    expect(Object.keys(json).sort()).toEqual(['degradedEdges', 'interventions', 'ledgers', 'mode', 'nodes', 'runId', 'spine', 'stop']);
    expect(json.mode).toBe('run');
  });

  test('the ANSI run render shows the arc, cursor glyphs, and the stop line', ({ run }) => {
    run.autoApprovals = [{ gate: 'directionGate', at: '2026-07-07T10:00:00.000Z' }];
    const status = buildStatusModel(run, { kind: 'gate', phase: 'spec' }, []);
    const out = renderGraph(runGraphModel(workflowFor(run), status, run, { kind: 'gate', phase: 'spec' }));
    expect(out).toContain(`run · ${run.runId}`);
    expect(out).toContain('✓ frame'); // done
    expect(out).toContain('▸ spec'); // current
    expect(out).toContain('auto-crossed');
    expect(out).toContain('stop ·');
  });
});

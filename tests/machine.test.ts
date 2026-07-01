import { describe, expect, test } from 'vitest';
import { createActor, fromCallback, waitFor } from 'xstate';
import type { AnyMachineSnapshot } from 'xstate';
import { duetMachine, interactiveMachine, machineFor } from '../src/harness/machine.ts';
import { phasesOf } from '../src/phases.ts';
import type { WorkflowName } from '../src/phases.ts';
import { scriptedMachine } from './helpers/scripted-machine.ts';

/**
 * Offline statechart behavior — no LLM, no subprocesses. Verifies the one
 * hard guarantee the skeleton exists for: gates and flag-waits transition
 * only on the right human events (everything else is a structural no-op),
 * snapshots persist/restore across "process exits", and the entry route
 * sends spec-entry runs straight to the spec loop.
 */

const quiescent = (s: AnyMachineSnapshot) => s.hasTag('quiescent') || s.status === 'done';

function startActor(machine: ReturnType<typeof scriptedMachine>['machine'], hasSpec = false) {
  const actor = createActor(machine, { input: { runId: 'test', cwd: '/tmp', hasSpec } });
  actor.start();
  return actor;
}

// The arcs under test. The coherence + spine-walk assertions derive from
// `phasesOf(workflow)`, so every workflow's machine is checked against its own
// registry entry, not a single hardcoded arc.
const ARCS: WorkflowName[] = ['full', 'rir'];

describe('phase table ⇄ machine coherence (per workflow)', () => {
  test.each(ARCS)('%s: every phase contributes its loop, flag-wait, and gate, with the right tags', (wf) => {
    const machine = machineFor(wf);
    for (const spec of phasesOf(wf)) {
      expect.soft(machine.states[`${spec.name}Loop`]?.tags, `${spec.name}Loop`).toEqual(['phase']);
      expect
        .soft(machine.states[`${spec.name}FlagWait`]?.tags, `${spec.name}FlagWait`)
        .toEqual(['quiescent', 'flag-wait']);
      if (spec.gate) {
        expect.soft(machine.states[spec.gate.state]?.tags, spec.gate.state).toEqual(['quiescent', 'gate']);
      }
    }
  });

  test.each(ARCS)('%s: quiescent states are exactly the gates, flag-waits, and done', (wf) => {
    // The lifecycle loop persists snapshots wherever this tag appears; a
    // state tagged quiescent by mistake would persist a snapshot with a live
    // actor, which restore cannot resume (the persistence guardrail).
    const quiescent = Object.entries(machineFor(wf).states)
      .filter(([, node]) => node.tags.includes('quiescent'))
      .map(([name]) => name)
      .sort();
    const expected = [
      ...phasesOf(wf).flatMap((p) => [`${p.name}FlagWait`, ...(p.gate ? [p.gate.state] : [])]),
      'done',
    ].sort();
    expect(quiescent).toEqual(expected);
  });

  test.each(ARCS)('%s: the clean advance→approve spine visits each gate in order, ending done', async (wf) => {
    const phases = phasesOf(wf);
    const { machine, calls } = scriptedMachine(
      phases.map(() => ({ type: 'phase.advance' as const })),
      wf,
    );
    const actor = startActor(machine);
    const gates: string[] = [];
    for (;;) {
      const snap = await waitFor(actor, quiescent);
      if (snap.status === 'done') break;
      gates.push(String(snap.value));
      actor.send({ type: 'human.approve' });
    }
    expect.soft(gates).toEqual(phases.filter((p) => p.gate).map((p) => p.gate!.state));
    expect.soft(calls).toEqual(phases.map((p) => p.name));
  });
});

describe('entry routing', () => {
  test('framing-only runs start at the frame phase', async () => {
    const { machine, calls } = scriptedMachine([{ type: 'phase.advance' }]);
    const actor = startActor(machine);
    const snap = await waitFor(actor, quiescent);
    expect(snap.value).toBe('directionGate');
    expect(calls).toEqual(['frame']);
  });

  test('spec-entry runs skip the frame phase and start at the spec loop', async () => {
    const { machine, calls } = scriptedMachine([{ type: 'phase.advance' }]);
    const actor = startActor(machine, true);
    const snap = await waitFor(actor, quiescent);
    expect(snap.value).toBe('commitSpecGate');
    expect(calls).toEqual(['spec']);
  });
});

describe('gate and flag-wait guarantees', () => {
  test('gate events at a flag-wait are structural no-ops', async () => {
    const { machine } = scriptedMachine([{ type: 'phase.flag' }]);
    const actor = startActor(machine);
    const snap = await waitFor(actor, quiescent);
    expect(snap.value).toBe('frameFlagWait');

    expect(snap.can({ type: 'human.approve' })).toBe(false);
    expect(snap.can({ type: 'human.reject' })).toBe(false);
    actor.send({ type: 'human.approve' });
    expect(actor.getSnapshot().value).toBe('frameFlagWait');
  });

  test('answer events at a gate are structural no-ops', async () => {
    const { machine } = scriptedMachine([{ type: 'phase.advance' }]);
    const actor = startActor(machine);
    const snap = await waitFor(actor, quiescent);
    expect(snap.value).toBe('directionGate');

    expect(snap.can({ type: 'human.answer' })).toBe(false);
    actor.send({ type: 'human.answer' });
    expect(actor.getSnapshot().value).toBe('directionGate');
  });

  test('phase.* events at a gate are structural no-ops — advance_phase parks but cannot cross', async () => {
    // The load-bearing invariant: a gate state has no phase.* handler, so an
    // orchestrator tool's event (delivered here only by a buggy or replayed
    // path) leaves the run parked. Crossing needs human authority.
    const { machine } = scriptedMachine([{ type: 'phase.advance' }]);
    const actor = startActor(machine);
    const snap = await waitFor(actor, quiescent);
    expect(snap.value).toBe('directionGate');

    expect(snap.can({ type: 'phase.advance' })).toBe(false);
    expect(snap.can({ type: 'phase.flag' })).toBe(false);
    actor.send({ type: 'phase.advance' });
    actor.send({ type: 'phase.flag' });
    expect(actor.getSnapshot().value).toBe('directionGate');
  });

  test('phase.* events at a flag-wait are structural no-ops', async () => {
    const { machine } = scriptedMachine([{ type: 'phase.flag' }]);
    const actor = startActor(machine);
    const snap = await waitFor(actor, quiescent);
    expect(snap.value).toBe('frameFlagWait');

    expect(snap.can({ type: 'phase.advance' })).toBe(false);
    expect(snap.can({ type: 'phase.flag' })).toBe(false);
    actor.send({ type: 'phase.advance' });
    expect(actor.getSnapshot().value).toBe('frameFlagWait');
  });

  test('human.* events while a phase runs cross nothing — phase states have no human handler', () => {
    // The authority half of the vocabulary split: a phase state transitions
    // only on phase.* (from its driver), never on human.*. A phase driver that
    // never resolves holds the run in the phase state so the guarantee is
    // observable without racing the actor's send-back.
    const machine = duetMachine.provide({ actors: { phaseDriver: fromCallback(() => {}) } });
    const actor = startActor(machine);
    expect(actor.getSnapshot().value).toBe('frameLoop');
    for (const type of ['human.approve', 'human.reject', 'human.answer'] as const) {
      expect.soft(actor.getSnapshot().can({ type })).toBe(false);
      actor.send({ type });
    }
    expect(actor.getSnapshot().value).toBe('frameLoop');
    actor.stop();
  });

  test('a quiescent snapshot persists and restores across a process exit', async () => {
    const { machine } = scriptedMachine([{ type: 'phase.flag' }]);
    let actor = startActor(machine);
    await waitFor(actor, quiescent);

    const persisted = actor.getPersistedSnapshot();
    actor.stop();
    actor = createActor(machine, {
      input: { runId: 'test', cwd: '/tmp', hasSpec: false },
      snapshot: persisted,
    });
    actor.start();
    expect(actor.getSnapshot().value).toBe('frameFlagWait');
  });

  test('answer at a flag-wait resumes the same phase loop', async () => {
    const { machine, calls } = scriptedMachine([{ type: 'phase.flag' }, { type: 'phase.advance' }]);
    const actor = startActor(machine);
    await waitFor(actor, quiescent);

    actor.send({ type: 'human.answer' });
    const snap = await waitFor(actor, quiescent);
    expect(snap.value).toBe('directionGate');
    expect(calls).toEqual(['frame', 'frame']);
  });

  test('reject at a gate re-runs the loop it gates', async () => {
    const { machine, calls } = scriptedMachine([{ type: 'phase.advance' }, { type: 'phase.advance' }]);
    const actor = startActor(machine);
    await waitFor(actor, quiescent);

    actor.send({ type: 'human.reject' });
    const snap = await waitFor(actor, quiescent);
    expect(snap.value).toBe('directionGate');
    expect(calls).toEqual(['frame', 'frame']);
  });
});

describe('the interactive machine variant (Stage 1 — the session drives, the actor is inert)', () => {
  test('advances only on the events sent to it, and a phase-loop snapshot restores inert', () => {
    const actor = createActor(interactiveMachine, { input: { runId: 'test', cwd: '/tmp', hasSpec: false } });
    actor.start();
    // No driver runs — the inert actor never sendBacks, so the loop holds until
    // an event is applied (the real driver would advance it from runPhase).
    expect.soft(actor.getSnapshot().value).toBe('frameLoop');

    actor.send({ type: 'phase.advance' });
    expect.soft(actor.getSnapshot().value).toBe('directionGate');
    actor.send({ type: 'human.approve' });
    expect.soft(actor.getSnapshot().value).toBe('specLoop');

    const persisted = actor.getPersistedSnapshot();
    actor.stop();

    // Restoring the phase-loop rest re-invokes the inert actor harmlessly: it
    // rests at specLoop rather than running any phase work or advancing itself.
    const restored = createActor(interactiveMachine, {
      input: { runId: 'test', cwd: '/tmp', hasSpec: false },
      snapshot: persisted,
    });
    restored.start();
    expect.soft(restored.getSnapshot().value).toBe('specLoop');
    restored.stop();
  });

  test('a spec-entry interactive run rests at the spec loop from the start', () => {
    const actor = createActor(interactiveMachine, { input: { runId: 'test', cwd: '/tmp', hasSpec: true } });
    actor.start();
    expect(actor.getSnapshot().value).toBe('specLoop');
    actor.stop();
  });

  test('introduces no human.* path from a phase loop — gate-uncrossable is unchanged', () => {
    const actor = createActor(interactiveMachine, { input: { runId: 'test', cwd: '/tmp', hasSpec: false } });
    actor.start();
    for (const type of ['human.approve', 'human.reject', 'human.answer'] as const) {
      expect.soft(actor.getSnapshot().can({ type })).toBe(false);
    }
    actor.stop();
  });
});

describe('the full arc', () => {
  test('frame → spec → plan → implement → finish → done, with flags and rejects along the way', async () => {
    const { machine, calls } = scriptedMachine([
      { type: 'phase.flag' }, // frame entry → queued question
      { type: 'phase.advance' }, // frame resume after answer → direction gate
      { type: 'phase.advance' }, // frame re-entry after gate reject → gate again
      { type: 'phase.advance' }, // spec → commit-spec gate
      { type: 'phase.advance' }, // plan → plan-approval gate
      { type: 'phase.flag' }, // impl entry → queued question
      { type: 'phase.advance' }, // impl resume → ship gate
      { type: 'phase.advance' }, // finish (reconcile docs, open PR) → open-pr gate
      { type: 'phase.advance' }, // finish re-entry after gate reject → gate again
    ]);
    const actor = startActor(machine);

    let snap = await waitFor(actor, quiescent);
    expect(snap.value).toBe('frameFlagWait');

    actor.send({ type: 'human.answer' });
    snap = await waitFor(actor, quiescent);
    expect(snap.value).toBe('directionGate');

    actor.send({ type: 'human.reject' });
    snap = await waitFor(actor, quiescent);
    expect(snap.value).toBe('directionGate');

    actor.send({ type: 'human.approve' });
    snap = await waitFor(actor, quiescent);
    expect(snap.value).toBe('commitSpecGate');

    actor.send({ type: 'human.approve' });
    snap = await waitFor(actor, quiescent);
    expect(snap.value).toBe('planApprovalGate');

    actor.send({ type: 'human.approve' });
    snap = await waitFor(actor, quiescent);
    expect(snap.value).toBe('implementFlagWait');

    actor.send({ type: 'human.answer' });
    snap = await waitFor(actor, quiescent);
    expect(snap.value).toBe('shipGate');

    // Approving Ship enters finish, which reconciles docs and opens the PR
    // in one pass, landing at the (post-open) Open-PR gate.
    actor.send({ type: 'human.approve' });
    snap = await waitFor(actor, quiescent);
    expect(snap.value).toBe('openPrGate');

    // Reject re-enters finish to amend the open PR, landing back at the gate.
    actor.send({ type: 'human.reject' });
    snap = await waitFor(actor, quiescent);
    expect(snap.value).toBe('openPrGate');

    // finish gates the last phase, so approving its gate crosses straight to done.
    actor.send({ type: 'human.approve' });
    snap = await waitFor(actor, (s) => s.status === 'done');
    expect(snap.value).toBe('done');

    expect(calls).toEqual(['frame', 'frame', 'frame', 'spec', 'plan', 'implement', 'implement', 'finish', 'finish']);
  });
});

describe('the RIR arc', () => {
  test('research → Direction → implement → Ship → finish → Open-PR → done, three gates, no full-only states', async () => {
    const { machine, calls } = scriptedMachine(
      [{ type: 'phase.advance' }, { type: 'phase.advance' }, { type: 'phase.advance' }],
      'rir',
    );
    const actor = startActor(machine);

    let snap = await waitFor(actor, quiescent);
    expect.soft(snap.value).toBe('directionGate');

    actor.send({ type: 'human.approve' });
    snap = await waitFor(actor, quiescent);
    expect.soft(snap.value).toBe('shipGate');

    actor.send({ type: 'human.approve' });
    snap = await waitFor(actor, quiescent);
    expect.soft(snap.value).toBe('openPrGate'); // the finish phase's gate (reused from Full)

    actor.send({ type: 'human.approve' });
    snap = await waitFor(actor, (s) => s.status === 'done');
    expect.soft(snap.value).toBe('done');

    expect.soft(calls).toEqual(['research', 'implement', 'finish']);
    // No Full-only state leaks into the RIR machine. openPrGate, implementLoop, and
    // finishLoop are now SHARED (both arcs name their build phase `implement` and
    // finishing phase `finish`); only the spec/plan states stay Full-only.
    for (const s of ['specLoop', 'planLoop', 'commitSpecGate', 'planApprovalGate']) {
      expect.soft(machine.states[s], s).toBeUndefined();
    }
    // finish/implement ARE present in RIR now (workflow-scoped shared names).
    expect.soft(machine.states['finishLoop'], 'finishLoop').toBeDefined();
    expect.soft(machine.states['implementLoop'], 'implementLoop').toBeDefined();
  });
});

import { describe, expect, test } from 'vitest';
import { createActor, fromCallback, waitFor } from 'xstate';
import type { AnyMachineSnapshot } from 'xstate';
import { duetMachine } from '../src/harness/machine.ts';
import { PHASES } from '../src/phases.ts';
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

describe('phase table ⇄ machine coherence', () => {
  test('every phase contributes its loop, flag-wait, and gate, with the right tags', () => {
    for (const spec of PHASES) {
      expect.soft(duetMachine.states[`${spec.name}Loop`]?.tags, `${spec.name}Loop`).toEqual(['phase']);
      expect
        .soft(duetMachine.states[`${spec.name}FlagWait`]?.tags, `${spec.name}FlagWait`)
        .toEqual(['quiescent', 'flag-wait']);
      if (spec.gate) {
        expect.soft(duetMachine.states[spec.gate.state]?.tags, spec.gate.state).toEqual(['quiescent', 'gate']);
      }
    }
  });

  test('quiescent states are exactly the gates, flag-waits, and done — nothing else ever persists', () => {
    // The lifecycle loop persists snapshots wherever this tag appears; a
    // state tagged quiescent by mistake would persist a snapshot with a live
    // actor, which restore cannot resume (the persistence guardrail).
    const quiescent = Object.entries(duetMachine.states)
      .filter(([, node]) => node.tags.includes('quiescent'))
      .map(([name]) => name)
      .sort();
    const expected = [
      ...PHASES.flatMap((p) => [`${p.name}FlagWait`, ...(p.gate ? [p.gate.state] : [])]),
      'done',
    ].sort();
    expect(quiescent).toEqual(expected);
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

describe('the full arc', () => {
  test('frame → spec → plan → impl → docs → pr → open → done, with flags and rejects along the way', async () => {
    const { machine, calls } = scriptedMachine([
      { type: 'phase.flag' }, // frame entry → queued question
      { type: 'phase.advance' }, // frame resume after answer → direction gate
      { type: 'phase.advance' }, // frame re-entry after gate reject → gate again
      { type: 'phase.advance' }, // spec → commit-spec gate
      { type: 'phase.advance' }, // plan → plan-approval gate
      { type: 'phase.flag' }, // impl entry → queued question
      { type: 'phase.advance' }, // impl resume → ship gate
      { type: 'phase.advance' }, // docs → docs-plan gate
      { type: 'phase.advance' }, // pr → open-pr gate
      { type: 'phase.advance' }, // pr re-entry after gate reject → gate again
      { type: 'phase.advance' }, // open → done
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
    expect(snap.value).toBe('implFlagWait');

    actor.send({ type: 'human.answer' });
    snap = await waitFor(actor, quiescent);
    expect(snap.value).toBe('shipGate');

    actor.send({ type: 'human.approve' });
    snap = await waitFor(actor, quiescent);
    expect(snap.value).toBe('docsPlanGate');

    actor.send({ type: 'human.approve' });
    snap = await waitFor(actor, quiescent);
    expect(snap.value).toBe('openPrGate');

    actor.send({ type: 'human.reject' });
    snap = await waitFor(actor, quiescent);
    expect(snap.value).toBe('openPrGate');

    // The open phase runs after the last gate and advances straight to done.
    actor.send({ type: 'human.approve' });
    snap = await waitFor(actor, (s) => s.status === 'done');
    expect(snap.value).toBe('done');

    expect(calls).toEqual(['frame', 'frame', 'frame', 'spec', 'plan', 'impl', 'impl', 'docs', 'pr', 'pr', 'open']);
  });
});

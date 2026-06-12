import { describe, expect, test } from 'vitest';
import { createActor, waitFor } from 'xstate';
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
    // actor, which restore cannot resume (the Q15 guardrail).
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
    const { machine, calls } = scriptedMachine([{ outcome: 'advanced' }]);
    const actor = startActor(machine);
    const snap = await waitFor(actor, quiescent);
    expect(snap.value).toBe('directionGate');
    expect(calls).toEqual(['frame']);
  });

  test('spec-entry runs skip the frame phase and start at the spec loop', async () => {
    const { machine, calls } = scriptedMachine([{ outcome: 'advanced' }]);
    const actor = startActor(machine, true);
    const snap = await waitFor(actor, quiescent);
    expect(snap.value).toBe('commitSpecGate');
    expect(calls).toEqual(['spec']);
  });
});

describe('gate and flag-wait guarantees', () => {
  test('gate events at a flag-wait are structural no-ops', async () => {
    const { machine } = scriptedMachine([{ outcome: 'flagged' }]);
    const actor = startActor(machine);
    const snap = await waitFor(actor, quiescent);
    expect(snap.value).toBe('frameFlagWait');

    expect(snap.can({ type: 'human.approve' })).toBe(false);
    expect(snap.can({ type: 'human.reject' })).toBe(false);
    actor.send({ type: 'human.approve' });
    expect(actor.getSnapshot().value).toBe('frameFlagWait');
  });

  test('answer events at a gate are structural no-ops', async () => {
    const { machine } = scriptedMachine([{ outcome: 'advanced' }]);
    const actor = startActor(machine);
    const snap = await waitFor(actor, quiescent);
    expect(snap.value).toBe('directionGate');

    expect(snap.can({ type: 'human.answer' })).toBe(false);
    actor.send({ type: 'human.answer' });
    expect(actor.getSnapshot().value).toBe('directionGate');
  });

  test('a quiescent snapshot persists and restores across a process exit', async () => {
    const { machine } = scriptedMachine([{ outcome: 'flagged' }]);
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
    const { machine, calls } = scriptedMachine([{ outcome: 'flagged' }, { outcome: 'advanced' }]);
    const actor = startActor(machine);
    await waitFor(actor, quiescent);

    actor.send({ type: 'human.answer' });
    const snap = await waitFor(actor, quiescent);
    expect(snap.value).toBe('directionGate');
    expect(calls).toEqual(['frame', 'frame']);
  });

  test('reject at a gate re-runs the loop it gates', async () => {
    const { machine, calls } = scriptedMachine([{ outcome: 'advanced' }, { outcome: 'advanced' }]);
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
      { outcome: 'flagged' }, // frame entry → queued question
      { outcome: 'advanced' }, // frame resume after answer → direction gate
      { outcome: 'advanced' }, // frame re-entry after gate reject → gate again
      { outcome: 'advanced' }, // spec → commit-spec gate
      { outcome: 'advanced' }, // plan → plan-approval gate
      { outcome: 'flagged' }, // impl entry → queued question
      { outcome: 'advanced' }, // impl resume → ship gate
      { outcome: 'advanced' }, // docs → docs-plan gate
      { outcome: 'advanced' }, // pr → open-pr gate
      { outcome: 'advanced' }, // pr re-entry after gate reject → gate again
      { outcome: 'advanced' }, // open → done
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

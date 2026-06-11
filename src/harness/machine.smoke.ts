/**
 * Offline smoke test for the harness statechart — no LLM, no subprocesses.
 * Verifies the one hard guarantee the skeleton exists for: gates and
 * flag-waits transition only on the right human events (everything else is
 * a structural no-op), snapshots persist/restore across "process exits",
 * and the entry route sends spec-entry runs straight to the spec loop while
 * framing-only runs start at the frame phase.
 *
 * Run: node src/harness/machine.smoke.ts
 */
import assert from 'node:assert/strict';
import { createActor, fromPromise, waitFor } from 'xstate';
import { duetMachine } from './machine.ts';
import type { DriverInput, DriverOutput } from './driver.ts';

function scriptedMachine(script: DriverOutput[], calls: Array<{ phase: string }>) {
  return duetMachine.provide({
    actors: {
      phaseDriver: fromPromise<DriverOutput, DriverInput>(async ({ input }) => {
        calls.push({ phase: input.phase });
        const next = script.shift();
        if (!next) throw new Error('driver called more times than scripted');
        return next;
      }),
    },
  });
}

const quiescent = (s: { hasTag(tag: string): boolean; status: string }) =>
  s.hasTag('quiescent') || s.status === 'done';

// ─── Full framing-only arc: frame → … → open → done ───

const script: DriverOutput[] = [
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
];
const calls: Array<{ phase: string }> = [];
const machine = scriptedMachine(script, calls);

const input = { runId: 'smoke', cwd: '/tmp', hasSpec: false };
let actor = createActor(machine, { input });
actor.start();

// 1. Framing-only entry routes to the frame phase; the scripted flag lands
//    on frameFlagWait.
let snap = await waitFor(actor, quiescent);
assert.equal(snap.value, 'frameFlagWait');

// 2. Gate events at a flag-wait are structural no-ops.
assert.equal(snap.can({ type: 'human.approve' }), false);
assert.equal(snap.can({ type: 'human.reject' }), false);
actor.send({ type: 'human.approve' });
assert.equal(actor.getSnapshot().value, 'frameFlagWait', 'approve at flag-wait must be a no-op');

// 3. Persist / restore across a simulated process exit.
const persisted = actor.getPersistedSnapshot();
actor.stop();
actor = createActor(machine, { input, snapshot: persisted });
actor.start();
assert.equal(actor.getSnapshot().value, 'frameFlagWait', 'restore must land on the same quiescent state');

// 4. Answer resumes the frame loop; driver advances → direction gate.
actor.send({ type: 'human.answer' });
snap = await waitFor(actor, quiescent);
assert.equal(snap.value, 'directionGate');

// 5. Answer at a gate is a no-op; reject re-enters the loop.
assert.equal(snap.can({ type: 'human.answer' }), false);
actor.send({ type: 'human.answer' });
assert.equal(actor.getSnapshot().value, 'directionGate', 'answer at gate must be a no-op');
actor.send({ type: 'human.reject' });
snap = await waitFor(actor, quiescent);
assert.equal(snap.value, 'directionGate', 'reject re-runs the loop back to the gate');

// 6. Approve through spec and plan to the walk-away point.
actor.send({ type: 'human.approve' });
snap = await waitFor(actor, quiescent);
assert.equal(snap.value, 'commitSpecGate');
actor.send({ type: 'human.approve' });
snap = await waitFor(actor, quiescent);
assert.equal(snap.value, 'planApprovalGate');

// 7. Plan approval enters the AFK impl phase; flag → answer → ship gate.
actor.send({ type: 'human.approve' });
snap = await waitFor(actor, quiescent);
assert.equal(snap.value, 'implFlagWait');
actor.send({ type: 'human.answer' });
snap = await waitFor(actor, quiescent);
assert.equal(snap.value, 'shipGate');

// 8. Ship approval enters FINAL REVIEW: docs-plan gate, then open-pr gate.
actor.send({ type: 'human.approve' });
snap = await waitFor(actor, quiescent);
assert.equal(snap.value, 'docsPlanGate');
actor.send({ type: 'human.approve' });
snap = await waitFor(actor, quiescent);
assert.equal(snap.value, 'openPrGate');

// 9. Open-PR gate: reject re-runs the pr loop; approve runs the open phase
//    (push + gh pr create), which advances straight to done — no gate after.
actor.send({ type: 'human.reject' });
snap = await waitFor(actor, quiescent);
assert.equal(snap.value, 'openPrGate', 'reject re-runs the pr loop back to the gate');
actor.send({ type: 'human.approve' });
snap = await waitFor(actor, (s) => s.status === 'done');
assert.equal(snap.value, 'done');

// 10. The driver saw the phases in order, once per (re-)entry.
assert.deepEqual(
  calls.map((c) => c.phase),
  ['frame', 'frame', 'frame', 'spec', 'plan', 'impl', 'impl', 'docs', 'pr', 'pr', 'open'],
);

// ─── Spec-entry route: a run with a draft spec skips the frame phase ───

const specCalls: Array<{ phase: string }> = [];
const specMachine = scriptedMachine([{ outcome: 'advanced' }], specCalls);
const specActor = createActor(specMachine, { input: { runId: 'smoke2', cwd: '/tmp', hasSpec: true } });
specActor.start();
const specSnap = await waitFor(specActor, quiescent);
assert.equal(specSnap.value, 'commitSpecGate', 'spec-entry runs start at the spec loop');
assert.deepEqual(specCalls.map((c) => c.phase), ['spec']);
specActor.stop();

console.log('machine smoke: all assertions passed');

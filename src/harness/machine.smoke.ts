/**
 * Offline smoke test for the harness statechart — no LLM, no subprocesses.
 * Verifies the one hard guarantee the skeleton exists for: gates and
 * flag-waits transition only on the right human events (everything else is
 * a structural no-op), and snapshots persist/restore across "process exits".
 *
 * Run: node src/harness/machine.smoke.ts
 */
import assert from 'node:assert/strict';
import { createActor, fromPromise, waitFor } from 'xstate';
import { duetMachine } from './machine.ts';
import type { DriverInput, DriverOutput } from './driver.ts';

const script: DriverOutput[] = [
  { outcome: 'flagged' }, // spec entry → queued question
  { outcome: 'advanced' }, // spec resume after answer → gate
  { outcome: 'advanced' }, // spec re-entry after gate reject → gate again
  { outcome: 'flagged' }, // plan entry → queued question
  { outcome: 'advanced' }, // plan resume → final gate
];
const calls: Array<{ phase: string }> = [];

const testMachine = duetMachine.provide({
  actors: {
    phaseDriver: fromPromise<DriverOutput, DriverInput>(async ({ input }) => {
      calls.push({ phase: input.phase });
      const next = script.shift();
      if (!next) throw new Error('driver called more times than scripted');
      return next;
    }),
  },
});

const input = { runId: 'smoke', cwd: '/tmp' };
const quiescent = (s: { hasTag(tag: string): boolean; status: string }) =>
  s.hasTag('quiescent') || s.status === 'done';

let actor = createActor(testMachine, { input });
actor.start();

// 1. Fresh run: spec driver flags → specFlagWait.
let snap = await waitFor(actor, quiescent);
assert.equal(snap.value, 'specFlagWait');

// 2. Gate events at a flag-wait are structural no-ops.
assert.equal(snap.can({ type: 'human.approve' }), false);
assert.equal(snap.can({ type: 'human.reject' }), false);
actor.send({ type: 'human.approve' });
assert.equal(actor.getSnapshot().value, 'specFlagWait', 'approve at flag-wait must be a no-op');

// 3. Persist / restore across a simulated process exit.
const persisted = actor.getPersistedSnapshot();
actor.stop();
actor = createActor(testMachine, { input, snapshot: persisted });
actor.start();
assert.equal(actor.getSnapshot().value, 'specFlagWait', 'restore must land on the same quiescent state');

// 4. Answer resumes the spec loop; driver advances → commit-spec gate.
actor.send({ type: 'human.answer' });
snap = await waitFor(actor, quiescent);
assert.equal(snap.value, 'commitSpecGate');

// 5. Answer at a gate is a no-op; reject re-enters the loop.
assert.equal(snap.can({ type: 'human.answer' }), false);
actor.send({ type: 'human.answer' });
assert.equal(actor.getSnapshot().value, 'commitSpecGate', 'answer at gate must be a no-op');
actor.send({ type: 'human.reject' });
snap = await waitFor(actor, quiescent);
assert.equal(snap.value, 'commitSpecGate', 'reject re-runs the loop back to the gate');

// 6. Approve → plan phase → flag → answer → final gate → approve → done.
actor.send({ type: 'human.approve' });
snap = await waitFor(actor, quiescent);
assert.equal(snap.value, 'planFlagWait');
actor.send({ type: 'human.answer' });
snap = await waitFor(actor, quiescent);
assert.equal(snap.value, 'planApprovalGate');
actor.send({ type: 'human.approve' });
snap = await waitFor(actor, (s) => s.status === 'done');
assert.equal(snap.value, 'done');

// 7. The driver saw the phases in order, once per (re-)entry.
assert.deepEqual(
  calls.map((c) => c.phase),
  ['spec', 'spec', 'spec', 'plan', 'plan'],
);

console.log('machine smoke: all assertions passed');

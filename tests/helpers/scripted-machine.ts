import { createActor, fromCallback } from 'xstate';
import type { EventObject } from 'xstate';
import type { PhaseInput } from '../../src/orchestrator/hosts/host-runner.ts';
import type { PhaseEvent } from '../../src/run/phase-events.ts';
import { greenflagMachine, interactiveMachine, machineFor } from '../../src/run/machine.ts';
import type { WorkflowName } from '../../src/registry/workflows.ts';
import { saveMachineSnapshot } from '../../src/run/store.ts';
import type { RunState } from '../../src/run/store.ts';

/**
 * A workflow's machine with its phase driver scripted instead of running an LLM
 * session: each phase (re-)entry records the phase name and sends back the next
 * scripted phase.* event. Same statechart, same handlers — the seam is
 * machine.provide, exactly how the real driver (a callback actor that sendBacks
 * the phase's terminal event) is plugged in. Defaults to the full workflow.
 */
export function scriptedMachine(
  script: PhaseEvent[],
  workflow: WorkflowName = 'full',
): { machine: typeof greenflagMachine; calls: string[] } {
  const calls: string[] = [];
  const machine = machineFor(workflow).provide({
    actors: {
      phaseDriver: fromCallback<EventObject, PhaseInput>(({ input, sendBack }) => {
        calls.push(input.phase);
        const next = script.shift();
        if (!next) throw new Error('phase driver called more times than scripted');
        // Defer one microtask: a sendBack fired synchronously during the
        // callback's initial run can land before the parent subscribes. The
        // real driver defers naturally (it sendBacks after an async runPhase).
        queueMicrotask(() => sendBack(next));
      }),
    },
  });
  return { machine, calls };
}

/**
 * A workflow's machine whose phase driver WEDGES — it records the phase it
 * entered and then never emits a terminal phase.* event, so the actor sits in
 * the phase loop indefinitely. The model for a hung phase: driveToQuiescence's
 * quiescence timeout must convert this into a crash=flag, not a stranded run.
 */
export function wedgedMachine(workflow: WorkflowName = 'full'): { machine: typeof greenflagMachine; calls: string[] } {
  const calls: string[] = [];
  const machine = machineFor(workflow).provide({
    actors: {
      phaseDriver: fromCallback<EventObject, PhaseInput>(({ input }) => {
        calls.push(input.phase);
        // never sendBack — the phase hangs; the outer quiescence timeout fires.
      }),
    },
  });
  return { machine, calls };
}

/**
 * Persist a machine snapshot by driving the inert interactive machine (full's
 * shape) through `sends` — the lightweight way to PARK a run at a gate,
 * flag-wait, phase loop, or done without running a phase driver. The parity
 * machine pins guarantee the interactive machine shares the headless shape, so
 * a snapshot parked this way is exactly what a headless drive would persist.
 */
export function restInteractiveAt(
  state: RunState,
  sends: Array<{ type: 'phase.advance' } | { type: 'phase.flag' } | { type: 'human.approve' } | { type: 'human.reject' } | { type: 'human.answer' }>,
): void {
  const actor = createActor(interactiveMachine, {
    input: { runId: state.runId, cwd: state.cwd, hasSpec: Boolean(state.specPath) },
  });
  actor.start();
  for (const e of sends) actor.send(e);
  saveMachineSnapshot(state, actor.getPersistedSnapshot());
  actor.stop();
}

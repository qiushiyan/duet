import { fromCallback } from 'xstate';
import type { EventObject } from 'xstate';
import type { PhaseInput } from '../../src/harness/host-runner.ts';
import type { PhaseEvent } from '../../src/harness/phase-events.ts';
import { duetMachine, machineFor } from '../../src/harness/machine.ts';
import type { WorkflowName } from '../../src/phases.ts';

/**
 * A workflow's machine with its phase driver scripted instead of running an LLM
 * session: each phase (re-)entry records the phase name and sends back the next
 * scripted phase.* event. Same statechart, same handlers — the seam is
 * machine.provide, exactly how the real driver (a callback actor that sendBacks
 * the phase's terminal event) is plugged in. Defaults to the Full arc.
 */
export function scriptedMachine(
  script: PhaseEvent[],
  workflow: WorkflowName = 'full',
): { machine: typeof duetMachine; calls: string[] } {
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
export function wedgedMachine(workflow: WorkflowName = 'full'): { machine: typeof duetMachine; calls: string[] } {
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

import { fromPromise } from 'xstate';
import type { DriverInput, DriverOutput } from '../../src/harness/driver.ts';
import { duetMachine } from '../../src/harness/machine.ts';

/**
 * The duetMachine with its phase driver scripted instead of running an LLM
 * session: each phase (re-)entry shifts the next outcome off the script and
 * records the phase name. Same statechart, same guards — the seam is
 * machine.provide, exactly how the real driver is plugged in.
 */
export function scriptedMachine(script: DriverOutput[]): { machine: typeof duetMachine; calls: string[] } {
  const calls: string[] = [];
  const machine = duetMachine.provide({
    actors: {
      phaseDriver: fromPromise<DriverOutput, DriverInput>(async ({ input }) => {
        calls.push(input.phase);
        const next = script.shift();
        if (!next) throw new Error('phase driver called more times than scripted');
        return next;
      }),
    },
  });
  return { machine, calls };
}

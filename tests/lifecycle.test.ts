import { describe, expect } from 'vitest';
import type { DriverOutput } from '../src/harness/driver.ts';
import { driveToQuiescence } from '../src/harness/lifecycle.ts';
import { loadMachineSnapshot, loadRunState, saveRunState } from '../src/run-store.ts';
import { test } from './helpers/fixtures.ts';
import { scriptedMachine } from './helpers/scripted-machine.ts';

/**
 * The quiescence loop and gate pre-authorization (gates_at): pre-authorized
 * gates auto-cross on the human's standing authority with the crossing
 * recorded; attended gates and flag-waits stop the driver. The phase driver
 * is scripted (the machine seam the machine tests already use); the
 * notifier is a recording fake.
 */

function recordingNotify() {
  const notifications: string[] = [];
  return {
    notifications,
    notify: async (_title: string, message: string) => {
      notifications.push(message);
    },
  };
}

const advanced: DriverOutput = { outcome: 'advanced' };

describe('attended stops', () => {
  test('stops at the first attended gate', async ({ run }) => {
    const { machine } = scriptedMachine([advanced]);
    const { notify, notifications } = recordingNotify();

    const stop = await driveToQuiescence(run, undefined, { machine, notify });

    expect.soft(stop.snapshot.value).toBe('directionGate');
    expect.soft(stop.state.machineState).toBe('directionGate');
    expect.soft(stop.state.autoApprovals).toBeUndefined();
    expect.soft(notifications).toEqual(['Direction gate — synthesized direction ready']);
  });

  test('a flag-wait stops the driver even when the phase gate is pre-authorized', async ({ projectDir, run }) => {
    run.gatesAt = ['pr'];
    saveRunState(run);
    const { machine } = scriptedMachine([{ outcome: 'flagged' }]);
    const { notify } = recordingNotify();

    const stop = await driveToQuiescence(run, undefined, { machine, notify });
    expect(stop.snapshot.value).toBe('frameFlagWait');
    expect(loadRunState(projectDir, run.runId).machineState).toBe('frameFlagWait');
  });
});

describe('gate pre-authorization (gates_at)', () => {
  test('pre-authorized gates auto-cross to the next attended stop, each crossing recorded', async ({
    projectDir,
    run,
  }) => {
    run.gatesAt = ['pr']; // attend only the Open-PR gate
    saveRunState(run);
    const { machine, calls } = scriptedMachine([advanced, advanced, advanced, advanced, advanced, advanced]);
    const { notify, notifications } = recordingNotify();

    const stop = await driveToQuiescence(run, undefined, { machine, notify });

    expect.soft(stop.snapshot.value).toBe('openPrGate');
    expect.soft(calls).toEqual(['frame', 'spec', 'plan', 'impl', 'docs', 'pr']);
    expect.soft(loadRunState(projectDir, run.runId).autoApprovals?.map((a) => a.gate)).toEqual([
      'directionGate',
      'commitSpecGate',
      'planApprovalGate',
      'shipGate',
      'docsPlanGate',
    ]);
    // One notification per crossing plus the final attended stop.
    expect.soft(notifications).toHaveLength(6);
    expect.soft(notifications[0]).toContain('directionGate auto-approved (pre-authorized)');
  });

  test('a human event resumes a parked snapshot past its gate', async ({ run }) => {
    const first = scriptedMachine([advanced]);
    const quiet = recordingNotify();
    await driveToQuiescence(run, undefined, { machine: first.machine, notify: quiet.notify });

    // The persisted snapshot is what a later `duet continue --approve` restores.
    const second = scriptedMachine([advanced]);
    const resumed = await driveToQuiescence(
      run,
      { snapshot: loadMachineSnapshot(run), event: { type: 'human.approve' } },
      { machine: second.machine, notify: quiet.notify },
    );
    expect(resumed.snapshot.value).toBe('commitSpecGate');
    expect(second.calls).toEqual(['spec']);
  });

  test('crash-recovery re-entry at the same gate does not record the crossing twice', async ({ projectDir, run }) => {
    run.gatesAt = ['spec', 'pr'];
    saveRunState(run);

    // First drive: frame advances, directionGate auto-crosses, spec flags.
    const first = scriptedMachine([advanced, { outcome: 'flagged' }]);
    const quiet = recordingNotify();
    await driveToQuiescence(run, undefined, { machine: first.machine, notify: quiet.notify });
    expect(loadRunState(projectDir, run.runId).autoApprovals?.map((a) => a.gate)).toEqual(['directionGate']);

    // Simulated crash recovery: re-enter from scratch; frame re-runs and the
    // same gate is reached again.
    const second = scriptedMachine([advanced, { outcome: 'flagged' }]);
    const fresh = loadRunState(projectDir, run.runId);
    await driveToQuiescence(fresh, undefined, { machine: second.machine, notify: quiet.notify });
    expect(loadRunState(projectDir, run.runId).autoApprovals?.map((a) => a.gate)).toEqual(['directionGate']);
  });
});

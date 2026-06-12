import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { DEFAULT_BINDINGS } from '../src/config.ts';
import type { DriverOutput } from '../src/harness/driver.ts';
import { driveToQuiescence, probeRunPosition } from '../src/harness/lifecycle.ts';
import { createRun, loadMachineSnapshot, loadRunState, runDirOf, saveRunState } from '../src/run-store.ts';
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

describe('probeRunPosition', () => {
  const quiet = async () => {};

  test('a live driver pid means a phase is running, whatever the stale snapshot says', async ({
    projectDir,
    run,
    onTestFinished,
  }) => {
    // Park the run at the direction gate, then plant a live foreign pid —
    // the state a driver leaves mid-phase after crossing via --approve.
    await driveToQuiescence(run, undefined, { machine: scriptedMachine([advanced]).machine, notify: quiet });
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    onTestFinished(() => {
      child.kill();
    });
    const fresh = loadRunState(projectDir, run.runId);
    writeFileSync(join(runDirOf(projectDir, run.runId), 'driver.pid'), `${child.pid}\n`);

    expect(probeRunPosition(fresh)).toEqual({ kind: 'running', pid: child.pid, phase: 'frame' });

    // With the next phase's entry prompt built, the running phase is that one.
    fresh.phaseStarted.spec = true;
    expect(probeRunPosition(fresh)).toEqual({ kind: 'running', pid: child.pid, phase: 'spec' });
  });

  test('no snapshot and no driver is a crash in the first phase, by entry mode', ({ projectDir, run }) => {
    expect.soft(probeRunPosition(run)).toEqual({ kind: 'crashed', phase: 'frame' });

    const specEntry = createRun({ cwd: projectDir, bindings: DEFAULT_BINDINGS, specPath: 'docs/spec.md' });
    expect.soft(probeRunPosition(specEntry)).toEqual({ kind: 'crashed', phase: 'spec' });
  });

  test('a snapshot parked at a gate is the gate — unless the next phase already started (crashed past it)', async ({
    projectDir,
    run,
  }) => {
    await driveToQuiescence(run, undefined, { machine: scriptedMachine([advanced]).machine, notify: quiet });
    const fresh = loadRunState(projectDir, run.runId);
    expect(probeRunPosition(fresh)).toEqual({ kind: 'gate', phase: 'frame' });

    fresh.phaseStarted.spec = true;
    saveRunState(fresh);
    expect(probeRunPosition(fresh)).toEqual({ kind: 'crashed', phase: 'spec' });
  });

  test('a flag-wait with its question is a flag; with the answer consumed it is a mid-phase crash', async ({
    projectDir,
    run,
  }) => {
    run.pendingQuestion = { question: 'which scope?' };
    saveRunState(run);
    await driveToQuiescence(run, undefined, { machine: scriptedMachine([{ outcome: 'flagged' }]).machine, notify: quiet });

    const fresh = loadRunState(projectDir, run.runId);
    expect(probeRunPosition(fresh)).toEqual({ kind: 'flag', phase: 'frame' });

    delete fresh.pendingQuestion;
    saveRunState(fresh);
    expect(probeRunPosition(fresh)).toEqual({ kind: 'crashed', phase: 'frame' });
  });

  test('a finished run is done', async ({ projectDir, run }) => {
    // Attend only the un-skippable Open-PR gate; everything else auto-crosses.
    run.gatesAt = ['pr'];
    saveRunState(run);
    const { machine } = scriptedMachine([advanced, advanced, advanced, advanced, advanced, advanced, advanced]);
    await driveToQuiescence(run, undefined, { machine, notify: quiet });
    const atPrGate = await driveToQuiescence(
      loadRunState(projectDir, run.runId),
      { snapshot: loadMachineSnapshot(run), event: { type: 'human.approve' } },
      { machine, notify: quiet },
    );

    expect.soft(atPrGate.snapshot.status).toBe('done');
    expect.soft(probeRunPosition(loadRunState(projectDir, run.runId))).toEqual({ kind: 'done' });
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

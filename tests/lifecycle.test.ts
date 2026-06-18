import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { fromCallback } from 'xstate';
import type { EventObject } from 'xstate';
import { DEFAULT_BINDINGS } from '../src/config.ts';
import { runPhase } from '../src/harness/driver.ts';
import type { DriverInput, RunOrchestratorTurn } from '../src/harness/driver.ts';
import { duetMachine } from '../src/harness/machine.ts';
import type { PhaseEvent } from '../src/harness/phase-events.ts';
import { driveToQuiescence, probeRunPosition, waitForRunStop } from '../src/harness/lifecycle.ts';
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

const advanced: PhaseEvent = { type: 'phase.advance' };

/**
 * The duetMachine driving the REAL runPhase (with the SDK turn faked), rather
 * than a scripted phase event. scriptedMachine's driver sends a phase.* event
 * directly and so bypasses runPhase's terminal-marker entry short-circuit —
 * the exact path the spent-marker guard protects. This helper keeps that
 * short-circuit live, so a stale marker that the guard fails to clear WOULD
 * replay and swallow the human's input. `calls` records each session run.
 */
function realDriverMachine(
  turn: (ctx: Parameters<RunOrchestratorTurn>[0]) => Promise<SDKMessage[]>,
): { machine: typeof duetMachine; calls: string[] } {
  const calls: string[] = [];
  const runTurn: RunOrchestratorTurn = async function* (ctx) {
    calls.push(ctx.prompt);
    yield* await turn(ctx);
  };
  const machine = duetMachine.provide({
    actors: {
      phaseDriver: fromCallback<EventObject, DriverInput>(({ input, sendBack }) => {
        runPhase(input, runTurn)
          .then((event) => sendBack(event))
          .catch(() => sendBack({ type: 'phase.flag' }));
      }),
    },
  });
  return { machine, calls };
}

const success = (): SDKMessage =>
  ({ type: 'result', subtype: 'success', session_id: 'orc-session', total_cost_usd: 0.1 }) as SDKMessage;

const callTool = async (
  ctx: Parameters<RunOrchestratorTurn>[0],
  name: string,
  args: Record<string, unknown>,
): Promise<void> => {
  const tool = ctx.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  await tool.handler(args as never, {});
};

describe('the spent-marker guard (human authority must not be lost to a stale terminal marker)', () => {
  const quiet = async () => {};

  test('a flag marker surviving into an answered flag-wait is cleared — the answer re-runs the phase, no replayed flag', async ({
    projectDir,
    run,
  }) => {
    // Park at frame's flag-wait so the snapshot the human resumes from is durable.
    await driveToQuiescence(run, undefined, { machine: scriptedMachine([{ type: 'phase.flag' }]).machine, notify: quiet });

    // The crash window: the marker is cleared only AFTER the snapshot save
    // (deliver-before-clear), so a crash in between leaves it on disk. The human
    // then answers — `duet continue --answer` stages the message.
    const crashed = loadRunState(projectDir, run.runId);
    crashed.terminalMarker = { phase: 'frame', kind: 'flag' };
    crashed.pendingQuestion = { question: 'which scope?' };
    crashed.pendingMessage = { kind: 'answer', text: 'narrow it' };
    saveRunState(crashed);

    const driver = realDriverMachine(async (ctx) => {
      await callTool(ctx, 'advance_phase', { summary: 'resolved with the answer', artifacts: [] });
      return [success()];
    });
    const resumed = await driveToQuiescence(
      crashed,
      { snapshot: loadMachineSnapshot(crashed), event: { type: 'human.answer' } },
      { machine: driver.machine, notify: quiet },
    );

    expect.soft(driver.calls).toHaveLength(1); // the phase re-ran — the stale flag did NOT short-circuit it
    expect.soft(resumed.snapshot.value).toBe('directionGate'); // advanced past the answer, not bounced back to frameFlagWait
    expect.soft(loadRunState(projectDir, run.runId).terminalMarker).toBeUndefined();
  });

  test('an advance marker surviving into a rejected gate is cleared — the rejection re-runs the phase, no replayed advance', async ({
    projectDir,
    run,
  }) => {
    // Park at frame's gate so the resume snapshot sits past the advance.
    await driveToQuiescence(run, undefined, { machine: scriptedMachine([advanced]).machine, notify: quiet });

    const crashed = loadRunState(projectDir, run.runId);
    crashed.terminalMarker = { phase: 'frame', kind: 'advance' };
    crashed.pendingMessage = { kind: 'feedback', text: 'invert the scope' };
    saveRunState(crashed);

    const driver = realDriverMachine(async (ctx) => {
      // On the rework the orchestrator flags instead of advancing — a distinct
      // outcome from the replayed advance, which would re-reach directionGate.
      await callTool(ctx, 'ask_human', { question: 'about that rework — narrower how?' });
      return [success()];
    });
    const resumed = await driveToQuiescence(
      crashed,
      { snapshot: loadMachineSnapshot(crashed), event: { type: 'human.reject' } },
      { machine: driver.machine, notify: quiet },
    );

    expect.soft(driver.calls).toHaveLength(1); // the phase re-ran on the rejection
    expect.soft(resumed.snapshot.value).toBe('frameFlagWait'); // re-ran and flagged — NOT the replayed advance→directionGate
    expect.soft(loadRunState(projectDir, run.runId).terminalMarker).toBeUndefined();
  });

  test('live replay is preserved: a marker restored at a prior state (crash before the transition) is not cleared', async ({
    projectDir,
    run,
  }) => {
    // Before any phase parks, the marker is live — the snapshot does not yet
    // reflect the transition. The guard must NOT fire; the driver replays the
    // decision without re-running the (minutes-long) session.
    const live = loadRunState(projectDir, run.runId);
    live.terminalMarker = { phase: 'frame', kind: 'advance' };
    live.phaseSummaries.frame = { summary: 'decided before the crash', artifacts: [] };
    saveRunState(live);

    const driver = realDriverMachine(async () => {
      throw new Error('the session must not run — the live marker should replay');
    });
    const stop = await driveToQuiescence(loadRunState(projectDir, run.runId), undefined, {
      machine: driver.machine,
      notify: quiet,
    });

    expect.soft(driver.calls).toHaveLength(0); // replayed — the session never ran
    expect.soft(stop.snapshot.value).toBe('directionGate'); // the replayed advance reached the gate
    expect.soft(loadRunState(projectDir, run.runId).terminalMarker).toBeUndefined(); // cleared at quiescence, as normal
  });
});

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
    const { machine } = scriptedMachine([{ type: 'phase.flag' }]);
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

  test('a snapshot parked at a gate is the gate — unless the next phase already started (crashed past it, resumed by re-uttering the approve)', async ({
    projectDir,
    run,
  }) => {
    await driveToQuiescence(run, undefined, { machine: scriptedMachine([advanced]).machine, notify: quiet });
    const fresh = loadRunState(projectDir, run.runId);
    expect(probeRunPosition(fresh)).toEqual({ kind: 'gate', phase: 'frame' });

    fresh.phaseStarted.spec = true;
    saveRunState(fresh);
    expect(probeRunPosition(fresh)).toEqual({ kind: 'crashed', phase: 'spec', resumeEvent: 'approve' });
  });

  test('a flag-wait with its question is a flag; with the answer consumed it is a mid-phase crash resumed by re-uttering the answer', async ({
    projectDir,
    run,
  }) => {
    run.pendingQuestion = { question: 'which scope?' };
    saveRunState(run);
    await driveToQuiescence(run, undefined, { machine: scriptedMachine([{ type: 'phase.flag' }]).machine, notify: quiet });

    const fresh = loadRunState(projectDir, run.runId);
    expect(probeRunPosition(fresh)).toEqual({ kind: 'flag', phase: 'frame' });

    delete fresh.pendingQuestion;
    saveRunState(fresh);
    expect(probeRunPosition(fresh)).toEqual({ kind: 'crashed', phase: 'frame', resumeEvent: 'answer' });
  });

  test('a crashed-past-a-gate run resumes through the statechart on the re-uttered approve', async ({
    projectDir,
    run,
  }) => {
    // Reach the direction gate, approve it, then "crash" before spec's stop:
    // the snapshot stays at the gate while phaseStarted.spec is set.
    const first = scriptedMachine([advanced]);
    await driveToQuiescence(run, undefined, { machine: first.machine, notify: quiet });
    const crashed = loadRunState(projectDir, run.runId);
    crashed.phaseStarted.spec = true;
    saveRunState(crashed);

    // What bare `duet continue` does at a crashed position: re-utter the event.
    const position = probeRunPosition(crashed);
    expect(position.kind).toBe('crashed');
    const second = scriptedMachine([advanced]);
    const resumed = await driveToQuiescence(
      crashed,
      {
        snapshot: loadMachineSnapshot(crashed),
        ...(position.kind === 'crashed' && position.resumeEvent
          ? { event: { type: `human.${position.resumeEvent}` as const } }
          : {}),
      },
      { machine: second.machine, notify: quiet },
    );

    expect.soft(second.calls).toEqual(['spec']); // the crashed phase re-ran
    expect.soft(resumed.snapshot.value).toBe('commitSpecGate');
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

describe('waitForRunStop (the supervision primitive behind duet status --wait)', () => {
  test('returns immediately when the run is already at a stop', async ({ projectDir, run }) => {
    const position = await waitForRunStop(projectDir, run.runId, { intervalMs: 10 });
    expect(position.kind).toBe('crashed'); // no snapshot, no driver — already stopped
  });

  test('blocks while a driver is alive and resolves at the stop', async ({ projectDir, run, onTestFinished }) => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    onTestFinished(() => {
      child.kill();
    });
    writeFileSync(join(runDirOf(projectDir, run.runId), 'driver.pid'), `${child.pid}\n`);

    let resolved = false;
    const waiting = waitForRunStop(projectDir, run.runId, { intervalMs: 15 }).then((position) => {
      resolved = true;
      return position;
    });

    await new Promise((r) => setTimeout(r, 40)); // a few polls with the driver alive
    expect(resolved).toBe(false);

    child.kill(); // the "driver" dies → the run is at a stop
    const position = await waiting;
    expect(position.kind).not.toBe('running');
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
    const first = scriptedMachine([advanced, { type: 'phase.flag' }]);
    const quiet = recordingNotify();
    await driveToQuiescence(run, undefined, { machine: first.machine, notify: quiet.notify });
    expect(loadRunState(projectDir, run.runId).autoApprovals?.map((a) => a.gate)).toEqual(['directionGate']);

    // Simulated crash recovery: re-enter from scratch; frame re-runs and the
    // same gate is reached again.
    const second = scriptedMachine([advanced, { type: 'phase.flag' }]);
    const fresh = loadRunState(projectDir, run.runId);
    await driveToQuiescence(fresh, undefined, { machine: second.machine, notify: quiet.notify });
    expect(loadRunState(projectDir, run.runId).autoApprovals?.map((a) => a.gate)).toEqual(['directionGate']);
  });
});

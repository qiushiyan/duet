import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { describe, expect } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createActor, fromCallback } from 'xstate';
import type { EventObject } from 'xstate';
import { DEFAULT_BINDINGS } from '../src/config.ts';
import { runPhase } from '../src/harness/driver.ts';
import type { RunOrchestratorTurn } from '../src/harness/driver.ts';
import type { PhaseInput } from '../src/harness/host-runner.ts';
import { duetMachine, interactiveMachine } from '../src/harness/machine.ts';
import type { PhaseEvent } from '../src/harness/phase-events.ts';
import {
  crossInteractive,
  driveToQuiescence,
  enterAfk,
  freezeContractAt,
  interactiveContinueAction,
  probeRunPosition,
  validateInteractiveCrossing,
  waitForRunStop,
  waitForTurnOrStop,
} from '../src/harness/lifecycle.ts';
import { acceptanceContractPathForSpec } from '../src/phases.ts';
import { createRun, gateAttended, loadMachineSnapshot, loadRunState, markAbandoned, runDirOf, saveMachineSnapshot, saveRunState, stageHumanInput } from '../src/run-store.ts';
import type { RunState } from '../src/run-store.ts';
import { consultantBindings, test } from './helpers/fixtures.ts';
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
      phaseDriver: fromCallback<EventObject, PhaseInput>(({ input, sendBack }) => {
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

/** Persist an interactive phase-loop rest by driving the inert variant through `sends`. */
function restInteractiveAt(
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

describe('the spent-marker guard (human authority must not be lost to a stale terminal marker)', () => {
  const quiet = async () => {};

  test('a flag marker surviving into an answered flag-wait is cleared — the answer re-runs the phase, no replayed flag', async ({
    projectDir,
    run,
  }) => {
    // Park at frame's flag-wait so the snapshot the human resumes from is durable.
    await driveToQuiescence(run, undefined, { machine: scriptedMachine([{ type: 'phase.flag' }]).machine, notify: quiet });

    // The earliest crash boundary: machine.json is durably saved at frameFlagWait,
    // but the crash landed before the state.json machineState mirror was written
    // and the marker cleared — so machineState is absent/stale while the marker
    // survives. The guard must key spent-vs-live off the restored snapshot
    // (machine.json), not state.machineState; deleting it here proves that.
    const crashed = loadRunState(projectDir, run.runId);
    crashed.terminalMarker = { phase: 'frame', kind: 'flag' };
    crashed.pendingQuestion = { question: 'which scope?' };
    crashed.pendingMessage = { kind: 'answer', text: 'narrow it' };
    delete crashed.machineState;
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

    // Same earliest crash boundary: machine.json durably at directionGate, the
    // state.json machineState mirror never written (absent/stale), marker alive.
    const crashed = loadRunState(projectDir, run.runId);
    crashed.terminalMarker = { phase: 'frame', kind: 'advance' };
    crashed.pendingMessage = { kind: 'feedback', text: 'invert the scope' };
    delete crashed.machineState;
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
    run.gatesAt = ['finish'];
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

  test('a pre-feature run with no workflow field restores through the full machine', async ({ projectDir, run }) => {
    // The actual hydration path, not just workflowOf: drive to a persisted gate
    // snapshot, strip the workflow field from the saved state (an old/hand-written
    // state.json), and confirm probeRunPosition still resolves the same position
    // through machineFor('full').
    run.workflow = 'full';
    saveRunState(run);
    await driveToQuiescence(run, undefined, { machine: scriptedMachine([advanced]).machine, notify: quiet });
    expect.soft(probeRunPosition(loadRunState(projectDir, run.runId))).toEqual({ kind: 'gate', phase: 'frame' });

    const stripped = loadRunState(projectDir, run.runId);
    delete stripped.workflow;
    saveRunState(stripped);
    const migrated = loadRunState(projectDir, run.runId);
    expect.soft(migrated.workflow).toBeUndefined();
    expect.soft(probeRunPosition(migrated)).toEqual({ kind: 'gate', phase: 'frame' });
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
    // Attend the Open-PR (finish) gate; everything before it auto-crosses.
    run.gatesAt = ['finish'];
    saveRunState(run);
    // Five phase drives (frame, spec, plan, impl, finish) reach the openPrGate;
    // the approve below crosses it straight to done (finish is the last phase).
    const { machine } = scriptedMachine([advanced, advanced, advanced, advanced, advanced]);
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

describe('probeRunPosition — the interactive resting model (Stage 1)', () => {
  const quiet = async () => {};

  test('no snapshot, no marker → resting at the entry phase (frame, and spec for a spec-entry run)', ({
    projectDir,
    interactiveRun,
  }) => {
    expect.soft(probeRunPosition(interactiveRun)).toEqual({ kind: 'interactive', phase: 'frame' });

    const specEntry = createRun({ cwd: projectDir, bindings: DEFAULT_BINDINGS, specPath: 'docs/spec.md' });
    specEntry.orchestrationHost = 'interactive';
    saveRunState(specEntry);
    expect.soft(probeRunPosition(specEntry)).toEqual({ kind: 'interactive', phase: 'spec' });
  });

  test('a resting phase-loop snapshot reads as interactive at that phase — never crashed (the key assertion)', ({
    projectDir,
    interactiveRun,
  }) => {
    // Frame advanced, direction approved: the session is now driving spec.
    restInteractiveAt(interactiveRun, [{ type: 'phase.advance' }, { type: 'human.approve' }]);
    expect(probeRunPosition(loadRunState(projectDir, interactiveRun.runId))).toEqual({
      kind: 'interactive',
      phase: 'spec',
    });
  });

  test('an advance marker on the resting phase parks at that gate', ({ projectDir, interactiveRun }) => {
    // Realistic parked state: the session drove into spec (snapshot at specLoop)
    // and then advanced — the marker belongs to the phase the snapshot rests at.
    restInteractiveAt(interactiveRun, [{ type: 'phase.advance' }, { type: 'human.approve' }]);
    const parked = loadRunState(projectDir, interactiveRun.runId);
    parked.terminalMarker = { phase: 'spec', kind: 'advance' };
    saveRunState(parked);
    expect(probeRunPosition(parked)).toEqual({ kind: 'gate', phase: 'spec' });
  });

  test('a flag marker on the resting phase parks at that flag', ({ projectDir, interactiveRun }) => {
    restInteractiveAt(interactiveRun, [{ type: 'phase.advance' }, { type: 'human.approve' }]);
    const parked = loadRunState(projectDir, interactiveRun.runId);
    parked.terminalMarker = { phase: 'spec', kind: 'flag' };
    saveRunState(parked);
    expect(probeRunPosition(parked)).toEqual({ kind: 'flag', phase: 'spec' });
  });

  test('a first-FRAME advance marker with no snapshot parks at the frame gate', ({ projectDir, interactiveRun }) => {
    // The first phase has no snapshot until crossInteractive persists one, so
    // restPhase falls back to the entry phase — a {frame,advance} marker there
    // is live (it belongs to the resting entry phase).
    const parked = loadRunState(projectDir, interactiveRun.runId);
    parked.terminalMarker = { phase: 'frame', kind: 'advance' };
    saveRunState(parked);
    expect(probeRunPosition(parked)).toEqual({ kind: 'gate', phase: 'frame' });
  });

  test('a stale marker from the prior phase is ignored — reports the rest, not the old gate', ({
    projectDir,
    interactiveRun,
  }) => {
    // The deliver-before-clear crash window: crossInteractive saved the specLoop
    // rest but died before clearing frame's advance marker. The probe must read
    // the rest (interactive spec), not replay the moved-on frame gate.
    restInteractiveAt(interactiveRun, [{ type: 'phase.advance' }, { type: 'human.approve' }]);
    const crashed = loadRunState(projectDir, interactiveRun.runId);
    crashed.terminalMarker = { phase: 'frame', kind: 'advance' }; // stale — snapshot rests at specLoop
    saveRunState(crashed);
    expect(probeRunPosition(crashed)).toEqual({ kind: 'interactive', phase: 'spec' });
  });

  test('a live driver pid wins over the interactive rest — running (the --headless fallback case)', ({
    projectDir,
    interactiveRun,
    onTestFinished,
  }) => {
    restInteractiveAt(interactiveRun, [{ type: 'phase.advance' }, { type: 'human.approve' }]); // rest at specLoop
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    onTestFinished(() => {
      child.kill();
    });
    writeFileSync(join(runDirOf(projectDir, interactiveRun.runId), 'driver.pid'), `${child.pid}\n`);
    expect(probeRunPosition(loadRunState(projectDir, interactiveRun.runId))).toEqual({
      kind: 'running',
      pid: child.pid,
      phase: 'spec',
    });
  });

  test('after the interactive→headless handoff, the phase-loop snapshot reads as the handed-off phase — not a crash in the entry phase', ({
    projectDir,
    interactiveRun,
    onTestFinished,
  }) => {
    // The plan-gate handoff (full's handoffGate): crossInteractive persists the
    // NEXT phase's loop rest (implLoop), then orchestrationHost is cleared and a
    // headless _drive is spawned (cli.ts). The now-HEADLESS probe must read that
    // phase-loop snapshot as the phase the driver runs — the regression was that
    // the headless branch only handled quiescent (gate/flag) snapshots, so a
    // phase loop fell through to the entry-phase fallback and a mid-impl run
    // misreported as running/crashed in `frame`.
    restInteractiveAt(interactiveRun, [
      { type: 'phase.advance' }, { type: 'human.approve' }, // frame → spec
      { type: 'phase.advance' }, { type: 'human.approve' }, // spec → plan
      { type: 'phase.advance' }, { type: 'human.approve' }, // plan → impl (the handoff)
    ]);
    const handed = loadRunState(projectDir, interactiveRun.runId);
    delete handed.orchestrationHost; // the handoff: the run is headless from here
    saveRunState(handed);

    // No live driver yet → a mid-phase crash AT the handed-off phase (impl), which
    // bare `duet continue` re-enters from this very snapshot — not the entry phase.
    expect.soft(probeRunPosition(loadRunState(projectDir, interactiveRun.runId))).toEqual({
      kind: 'crashed',
      phase: 'impl',
    });

    // The live headless driver makes it `running` at that same phase — what the
    // real broken run showed as `running` in `spec` before the fix.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    onTestFinished(() => {
      child.kill();
    });
    writeFileSync(join(runDirOf(projectDir, interactiveRun.runId), 'driver.pid'), `${child.pid}\n`);
    expect.soft(probeRunPosition(loadRunState(projectDir, interactiveRun.runId))).toEqual({
      kind: 'running',
      pid: child.pid,
      phase: 'impl',
    });
  });

  test('a headless run is unchanged — the gate comes from the snapshot, and the marker is ignored', async ({
    projectDir,
    run,
  }) => {
    // The same snapshot+marker that mean "parked at the gate" for an interactive
    // run stay headless-as-today: the gate is derived from the snapshot value,
    // and the probe does not consume terminalMarker on the headless path.
    await driveToQuiescence(run, undefined, { machine: scriptedMachine([advanced]).machine, notify: quiet });
    const fresh = loadRunState(projectDir, run.runId);
    expect.soft(probeRunPosition(fresh)).toEqual({ kind: 'gate', phase: 'frame' });

    fresh.terminalMarker = { phase: 'spec', kind: 'advance' };
    saveRunState(fresh);
    expect.soft(probeRunPosition(fresh)).toEqual({ kind: 'gate', phase: 'frame' });
  });
});

describe('crossInteractive + the interactive continue model (Slice 4)', () => {
  function restInteractive(
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

  test('first crossing (no prior snapshot): frame advance + approve rests at spec, marker cleared', ({
    projectDir,
    interactiveRun,
  }) => {
    const state = loadRunState(projectDir, interactiveRun.runId);
    state.terminalMarker = { phase: 'frame', kind: 'advance' };
    saveRunState(state);
    crossInteractive(state, { type: 'human.approve' });

    const after = loadRunState(projectDir, interactiveRun.runId);
    expect.soft(after.terminalMarker).toBeUndefined();
    expect.soft(probeRunPosition(after)).toEqual({ kind: 'interactive', phase: 'spec' });
  });

  test('mid-arc: a spec advance + approve rests at plan', ({ projectDir, interactiveRun }) => {
    restInteractive(interactiveRun, [{ type: 'phase.advance' }, { type: 'human.approve' }]); // specLoop
    const state = loadRunState(projectDir, interactiveRun.runId);
    state.terminalMarker = { phase: 'spec', kind: 'advance' };
    saveRunState(state);
    crossInteractive(state, { type: 'human.approve' });
    expect(probeRunPosition(loadRunState(projectDir, interactiveRun.runId))).toEqual({ kind: 'interactive', phase: 'plan' });
  });

  test('reject re-enters the same phase loop, marker cleared', ({ projectDir, interactiveRun }) => {
    restInteractive(interactiveRun, [{ type: 'phase.advance' }, { type: 'human.approve' }]); // specLoop
    const state = loadRunState(projectDir, interactiveRun.runId);
    state.terminalMarker = { phase: 'spec', kind: 'advance' };
    saveRunState(state);
    crossInteractive(state, { type: 'human.reject' });
    const after = loadRunState(projectDir, interactiveRun.runId);
    expect.soft(after.terminalMarker).toBeUndefined();
    expect.soft(probeRunPosition(after)).toEqual({ kind: 'interactive', phase: 'spec' });
  });

  test('answer re-enters the same phase loop', ({ projectDir, interactiveRun }) => {
    restInteractive(interactiveRun, [{ type: 'phase.advance' }, { type: 'human.approve' }]); // specLoop
    const state = loadRunState(projectDir, interactiveRun.runId);
    state.terminalMarker = { phase: 'spec', kind: 'flag' };
    saveRunState(state);
    crossInteractive(state, { type: 'human.answer' });
    expect(probeRunPosition(loadRunState(projectDir, interactiveRun.runId))).toEqual({ kind: 'interactive', phase: 'spec' });
  });

  test('plan-gate approve reaches implLoop (marker-then-human ordering), not parked at the gate', ({
    projectDir,
    interactiveRun,
  }) => {
    restInteractive(interactiveRun, [
      { type: 'phase.advance' },
      { type: 'human.approve' }, // → specLoop
      { type: 'phase.advance' },
      { type: 'human.approve' }, // → planLoop
    ]);
    const state = loadRunState(projectDir, interactiveRun.runId);
    state.terminalMarker = { phase: 'plan', kind: 'advance' };
    saveRunState(state);
    crossInteractive(state, { type: 'human.approve' });

    const after = loadRunState(projectDir, interactiveRun.runId);
    // The durable snapshot reached impl — a naive spawnDrive(state,'approve') would
    // instead have sent the human event at planLoop (ignored), replayed the marker,
    // and parked at planApprovalGate. The marker-then-human ordering is the fix.
    expect.soft(after.terminalMarker).toBeUndefined();
    expect.soft(probeRunPosition(after)).toEqual({ kind: 'interactive', phase: 'impl' });
  });

  test('interactiveContinueAction (full): handoffGate-approve and any --headless hand off; earlier gates rest inline', () => {
    expect.soft(interactiveContinueAction('full', 'plan', 'approve', false)).toBe('handoff');
    expect.soft(interactiveContinueAction('full', 'frame', 'approve', false)).toBe('inline');
    expect.soft(interactiveContinueAction('full', 'spec', 'reject', false)).toBe('inline');
    expect.soft(interactiveContinueAction('full', 'plan', 'reject', false)).toBe('inline'); // a plan REJECT re-enters, not handoff
    expect.soft(interactiveContinueAction('full', 'spec', 'approve', true)).toBe('handoff'); // --headless always hands off
  });

  test('validateInteractiveCrossing: a gate admits approve/reject, a flag admits answer, a rest admits nothing', () => {
    expect.soft(validateInteractiveCrossing({ kind: 'gate', phase: 'spec' }, 'approve')).toBeUndefined();
    expect.soft(validateInteractiveCrossing({ kind: 'gate', phase: 'spec' }, 'reject')).toBeUndefined();
    expect.soft(validateInteractiveCrossing({ kind: 'gate', phase: 'spec' }, 'answer')).toContain('--answer');
    expect.soft(validateInteractiveCrossing({ kind: 'flag', phase: 'spec' }, 'answer')).toBeUndefined();
    expect.soft(validateInteractiveCrossing({ kind: 'flag', phase: 'spec' }, 'approve')).toContain('queued question');
    expect.soft(validateInteractiveCrossing({ kind: 'interactive', phase: 'spec' }, 'approve')).toContain("hasn't advanced");
  });

  test('never-trap: markAbandoned on an interactive run reads as abandoned, not stranded', ({
    projectDir,
    interactiveRun,
  }) => {
    restInteractive(interactiveRun, [{ type: 'phase.advance' }, { type: 'human.approve' }]);
    markAbandoned(loadRunState(projectDir, interactiveRun.runId));
    expect(probeRunPosition(loadRunState(projectDir, interactiveRun.runId))).toEqual({ kind: 'abandoned' });
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

describe('waitForTurnOrStop (the turn-aware wait behind status --wait)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test('wakes turn-ready when a pending record flips to ready mid-poll', async ({ projectDir, interactiveRun }) => {
    interactiveRun.pendingTurns = { reviewer: { tag: 'review-spec', startedAt: 't', status: 'running' } };
    saveRunState(interactiveRun);
    const waiting = waitForTurnOrStop(projectDir, interactiveRun.runId, { intervalMs: 15 });

    await sleep(30); // a couple polls while still running
    const s = loadRunState(projectDir, interactiveRun.runId);
    s.pendingTurns!.reviewer!.status = 'ready';
    saveRunState(s);

    expect(await waiting).toEqual({ kind: 'turn-ready', roles: ['reviewer'] });
  });

  test('an interactive run with a RUNNING turn does NOT wake until it settles (the immediate-wake regression guard)', async ({
    projectDir,
    interactiveRun,
  }) => {
    interactiveRun.pendingTurns = { implementer: { tag: 'write-spec', startedAt: 't', status: 'running' } };
    saveRunState(interactiveRun);
    let resolved = false;
    const waiting = waitForTurnOrStop(projectDir, interactiveRun.runId, { intervalMs: 15 }).then((r) => {
      resolved = true;
      return r;
    });

    await sleep(45); // several polls — the interactive position must NOT wake it
    expect(resolved).toBe(false);

    const s = loadRunState(projectDir, interactiveRun.runId);
    s.pendingTurns!.implementer!.status = 'failed';
    saveRunState(s);
    expect(await waiting).toEqual({ kind: 'turn-ready', roles: ['implementer'] });
  });

  test('an interactive run with no pending turn returns immediately (the rest is itself the answer)', async ({
    projectDir,
    interactiveRun,
  }) => {
    expect(await waitForTurnOrStop(projectDir, interactiveRun.runId, { intervalMs: 10 })).toEqual({
      kind: 'interactive',
      phase: 'frame',
    });
  });

  test('still returns a real stop position (a crashed headless run resolves at once)', async ({ projectDir, run }) => {
    expect((await waitForTurnOrStop(projectDir, run.runId, { intervalMs: 10 })).kind).toBe('crashed');
  });

  test('is read-only — polling while a turn runs mutates nothing on disk', async ({ projectDir, interactiveRun }) => {
    interactiveRun.pendingTurns = { reviewer: { tag: 'review-spec', startedAt: 't', status: 'running' } };
    saveRunState(interactiveRun);
    const statePath = join(runDirOf(projectDir, interactiveRun.runId), 'state.json');
    const before = readFileSync(statePath, 'utf8');

    const waiting = waitForTurnOrStop(projectDir, interactiveRun.runId, { intervalMs: 10 });
    await sleep(35); // several polls, no external writes
    expect(readFileSync(statePath, 'utf8')).toBe(before); // the wait wrote nothing

    // Resolve to clean up the pending timer.
    const s = loadRunState(projectDir, interactiveRun.runId);
    s.pendingTurns!.reviewer!.status = 'ready';
    saveRunState(s);
    await waiting;
  });
});

describe('gate pre-authorization (gates_at)', () => {
  test('pre-authorized gates auto-cross to the next attended stop, each crossing recorded', async ({
    projectDir,
    run,
  }) => {
    run.gatesAt = ['finish']; // attend only the Open-PR (finish) gate
    saveRunState(run);
    const { machine, calls } = scriptedMachine([advanced, advanced, advanced, advanced, advanced]);
    const { notify, notifications } = recordingNotify();

    const stop = await driveToQuiescence(run, undefined, { machine, notify });

    expect.soft(stop.snapshot.value).toBe('openPrGate');
    expect.soft(calls).toEqual(['frame', 'spec', 'plan', 'impl', 'finish']);
    // The four gates before finish auto-cross; finish opens the PR and
    // stops at its (attended) openPrGate.
    expect.soft(loadRunState(projectDir, run.runId).autoApprovals?.map((a) => a.gate)).toEqual([
      'directionGate',
      'commitSpecGate',
      'planApprovalGate',
      'shipGate',
    ]);
    // One notification per crossing plus the final attended stop.
    expect.soft(notifications).toHaveLength(5);
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
    run.gatesAt = ['spec', 'finish'];
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

describe('enterAfk — the mid-session AFK handoff (#1)', () => {
  /** An interactive run parked at the frame gate (no snapshot ⇒ entry-phase marker is live). */
  const atFrameGate = (projectDir: string, interactiveRun: RunState): RunState => {
    const parked = loadRunState(projectDir, interactiveRun.runId);
    parked.terminalMarker = { phase: 'frame', kind: 'advance' };
    saveRunState(parked);
    return parked;
  };

  test('from an ATTENDED interactive gate: sets the posture, crosses the gate, clears the interactive marker', async ({
    projectDir,
    interactiveRun,
  }) => {
    const parked = atFrameGate(projectDir, interactiveRun);
    expect.soft(probeRunPosition(parked)).toEqual({ kind: 'gate', phase: 'frame' });

    const split = await enterAfk(parked, ['spec']);

    const persisted = loadRunState(projectDir, interactiveRun.runId);
    expect.soft(persisted.gatesAt).toEqual(['spec']); // downstream posture re-set
    expect.soft(persisted.orchestrationHost).toBeUndefined(); // handed off to headless
    expect.soft(probeRunPosition(persisted)).not.toEqual({ kind: 'gate', phase: 'frame' }); // frame crossed
    expect.soft(split.attended).toEqual(['spec']);
    expect.soft(split.preAuthorized).toEqual(['frame', 'plan', 'impl', 'finish']);
  });

  test('is legal at a PRE-AUTHORIZED interactive gate — legality keys on the gate position, not gateAttended (the F1 case)', async ({
    projectDir,
    interactiveRun,
  }) => {
    // Make frame pre-authorized: gatesAt excludes it, so gateAttended(frame) is false.
    const parked = atFrameGate(projectDir, interactiveRun);
    parked.gatesAt = ['spec'];
    saveRunState(parked);
    expect.soft(gateAttended(parked, 'frame')).toBe(false); // pre-authorized, yet still an AFK position

    await expect(enterAfk(parked, [])).resolves.toBeDefined();
    expect.soft(loadRunState(projectDir, interactiveRun.runId).orchestrationHost).toBeUndefined();
  });

  test('refuses when not parked at a gate (a flag) and when the run is not interactive', async ({
    projectDir,
    interactiveRun,
    run,
  }) => {
    const flagged = loadRunState(projectDir, interactiveRun.runId);
    flagged.terminalMarker = { phase: 'frame', kind: 'flag' };
    saveRunState(flagged);
    await expect.soft(enterAfk(flagged, [])).rejects.toThrow(/queued question|gate/);

    // A headless run (no interactive marker) is already unattended — refused.
    await expect.soft(enterAfk(run, [])).rejects.toThrow(/not orchestrated interactively/);
  });

  test('the posture survives a co-staged approval rider (the stale-save guard)', async ({ projectDir, interactiveRun }) => {
    const parked = atFrameGate(projectDir, interactiveRun);
    // The hazard: setGatesAt then a whole-state save (a staged rider) must not
    // clobber the posture — setGatesAt syncs the passed copy, so the rider save
    // carries the new gatesAt forward.
    await enterAfk(parked, ['spec', 'plan']);
    stageHumanInput(parked, { kind: 'approval', text: 'take it the rest of the way' });

    const persisted = loadRunState(projectDir, interactiveRun.runId);
    expect.soft(persisted.gatesAt).toEqual(['spec', 'plan']);
    expect.soft(persisted.pendingMessage).toEqual({ kind: 'approval', text: 'take it the rest of the way' });
  });
});

describe('the severity hold — a high human decision withholds a NON-EXPLICIT crossing', () => {
  const highFrame = (run: RunState, severity: 'low' | 'high'): void => {
    run.phaseSummaries.frame = { summary: 's', artifacts: [], humanDecisions: [{ title: 'storage backend', severity }] };
    saveRunState(run);
  };

  test('driveToQuiescence WITHHOLDS the pre-authorized auto-cross on a high — converts to an attended stop', async ({
    run,
    projectDir,
  }) => {
    run.gatesAt = ['finish']; // frame is pre-authorized (would normally auto-cross)
    highFrame(run, 'high');
    const { machine } = scriptedMachine([advanced]);
    const { notify, notifications } = recordingNotify();

    const stop = await driveToQuiescence(run, undefined, { machine, notify });

    // Held at the gate: not auto-crossed, no auto-approval recorded, the high named.
    expect.soft(stop.snapshot.value).toBe('directionGate');
    expect.soft(loadRunState(projectDir, run.runId).autoApprovals).toBeUndefined();
    expect.soft(notifications.join('\n')).toContain('held');
    expect.soft(notifications.join('\n')).toContain('storage backend');
  });

  test('a low-only (or clean) pre-authorized gate auto-crosses exactly as today', async ({ run, projectDir }) => {
    run.gatesAt = ['spec']; // frame pre-authorized, spec attended → stops at the spec gate
    highFrame(run, 'low');
    const { machine } = scriptedMachine([advanced, advanced]);
    const { notify, notifications } = recordingNotify();

    await driveToQuiescence(run, undefined, { machine, notify });

    expect.soft(loadRunState(projectDir, run.runId).autoApprovals?.some((a) => a.gate === 'directionGate')).toBe(true);
    expect.soft(notifications.join('\n')).toContain('auto-approved');
  });

  test('a failed-contract high at the SHIP gate holds the pre-authorized auto-cross — the contract is load-bearing AFK protection', async ({
    run,
    projectDir,
  }) => {
    // A consultant-verify FAILURE lands as a high in the impl (Ship) packet. Under
    // an overnight posture (everything pre-authorized) it must convert the Ship
    // auto-cross into an attended stop, not ship past a broken target.
    run.gatesAt = []; // attend nothing — frame/spec/plan/impl all pre-authorized
    run.phaseSummaries.impl = {
      summary: 'shipped',
      artifacts: [],
      humanDecisions: [{ title: 'contract assertion A3 failed: bad-password login returns 500, not 401', severity: 'high' }],
    };
    saveRunState(run);
    const { machine } = scriptedMachine([advanced, advanced, advanced, advanced]);
    const { notify, notifications } = recordingNotify();

    const stop = await driveToQuiescence(run, undefined, { machine, notify });

    expect.soft(stop.snapshot.value).toBe('shipGate'); // held at Ship, not auto-crossed onward
    expect.soft(loadRunState(projectDir, run.runId).autoApprovals?.some((a) => a.gate === 'shipGate')).toBeFalsy();
    expect.soft(notifications.join('\n')).toContain('held');
    expect.soft(notifications.join('\n')).toContain('A3 failed');
  });

  test('enterAfk REFUSES handoff over a high, directing to the explicit substitute', async ({ projectDir, interactiveRun }) => {
    const parked = loadRunState(projectDir, interactiveRun.runId);
    parked.terminalMarker = { phase: 'frame', kind: 'advance' };
    parked.phaseSummaries.frame = { summary: 's', artifacts: [], humanDecisions: [{ title: 'pricing model', severity: 'high' }] };
    saveRunState(parked);

    await expect.soft(enterAfk(parked, [])).rejects.toThrow(/--approve --headless/);
    await expect.soft(enterAfk(parked, [])).rejects.toThrow(/pricing model/);
    // Not handed off — still interactive.
    expect.soft(loadRunState(projectDir, interactiveRun.runId).orchestrationHost).toBe('interactive');
  });

  test('enterAfk --gateless CROSSES a high (the explicit full-send) and persists the gateless flag', async ({
    projectDir,
    interactiveRun,
  }) => {
    const parked = loadRunState(projectDir, interactiveRun.runId);
    parked.terminalMarker = { phase: 'frame', kind: 'advance' };
    parked.phaseSummaries.frame = { summary: 's', artifacts: [], humanDecisions: [{ title: 'pricing model', severity: 'high' }] };
    saveRunState(parked);

    await enterAfk(parked, [], { gateless: true }); // an explicit full-send crosses the high, like --approve
    const after = loadRunState(projectDir, interactiveRun.runId);
    expect.soft(after.gateless).toBe(true); // the consultant axis persisted for the headless tail
    expect.soft(after.gatesAt).toEqual([]); // attend nothing downstream
    expect.soft(after.orchestrationHost).toBeUndefined(); // handed off to headless
    expect.soft(probeRunPosition(after)).not.toEqual({ kind: 'gate', phase: 'frame' }); // frame crossed
  });

  test('enterAfk --gateless REFUSES at the contract gate when no contract was authored — the one high it preserves', async ({
    projectDir,
    interactiveRun,
  }) => {
    // Park at the plan gate (the contract-author gate) with a consultant bound but
    // no contract frozen — the authoring-failed case. Gateless full-sends bets, but
    // crossing here would ship past an unset target with nothing for verify to hold,
    // so the walk-away must refuse.
    restInteractiveAt(interactiveRun, [{ type: 'phase.advance' }, { type: 'human.approve' }, { type: 'phase.advance' }, { type: 'human.approve' }]);
    const parked = loadRunState(projectDir, interactiveRun.runId);
    parked.terminalMarker = { phase: 'plan', kind: 'advance' };
    parked.specPath = 'docs/specs/x.md'; // a real plan gate has a spec; no contract was authored from it
    parked.bindings = { ...parked.bindings, consultant: { provider: 'claude', model: 'claude-opus-4-8', transport: 'headless' } };
    saveRunState(parked);
    expect.soft(probeRunPosition(parked)).toEqual({ kind: 'gate', phase: 'plan' }); // setup sanity

    await expect.soft(enterAfk(parked, [], { gateless: true })).rejects.toThrow(/backstop/);
    expect.soft(loadRunState(projectDir, interactiveRun.runId).orchestrationHost).toBe('interactive'); // not handed off
  });

  test('enterAfk --gateless CROSSES the contract gate when a contract is frozen — backstop in place', async ({
    projectDir,
    interactiveRun,
  }) => {
    restInteractiveAt(interactiveRun, [{ type: 'phase.advance' }, { type: 'human.approve' }, { type: 'phase.advance' }, { type: 'human.approve' }]);
    const parked = loadRunState(projectDir, interactiveRun.runId);
    parked.terminalMarker = { phase: 'plan', kind: 'advance' };
    parked.specPath = 'docs/specs/x.md';
    parked.bindings = { ...parked.bindings, consultant: { provider: 'claude', model: 'claude-opus-4-8', transport: 'headless' } };
    parked.acceptanceContract = { path: 'docs/specs/x.acceptance.md', commit: 'abc123' }; // authored + frozen
    saveRunState(parked);

    await enterAfk(parked, [], { gateless: true }); // backstop in place → the full-send crosses
    const after = loadRunState(projectDir, interactiveRun.runId);
    expect.soft(after.gateless).toBe(true);
    expect.soft(after.orchestrationHost).toBeUndefined(); // handed off
    expect.soft(probeRunPosition(after)).not.toEqual({ kind: 'gate', phase: 'plan' }); // plan crossed
  });

  test('an EXPLICIT crossInteractive crosses a high-carrying gate — explicit approval always crosses', ({
    projectDir,
    interactiveRun,
  }) => {
    const parked = loadRunState(projectDir, interactiveRun.runId);
    parked.terminalMarker = { phase: 'frame', kind: 'advance' };
    parked.phaseSummaries.frame = { summary: 's', artifacts: [], humanDecisions: [{ title: 'pricing model', severity: 'high' }] };
    saveRunState(parked);

    crossInteractive(parked, { type: 'human.approve' }); // never consults the severity hold
    expect(probeRunPosition(loadRunState(projectDir, interactiveRun.runId))).toEqual({ kind: 'interactive', phase: 'spec' });
  });
});

describe('freezeContractAt — the acceptance contract freeze at the contract gate', () => {
  const quiet = async () => {};

  const initGit = async (dir: string): Promise<void> => {
    await execa('git', ['init', '-q'], { cwd: dir });
    await execa('git', ['config', 'user.email', 'duet-test@example.com'], { cwd: dir });
    await execa('git', ['config', 'user.name', 'duet test'], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), '# repo\n');
    await execa('git', ['add', '-A'], { cwd: dir });
    await execa('git', ['commit', '-qm', 'initial'], { cwd: dir });
  };

  const headOf = async (dir: string): Promise<string> =>
    (await execa('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
  // In HEAD's committed tree — the precise "did the freeze commit it" check (a
  // staged-but-uncommitted file would be `git ls-files`-tracked but not `inHead`).
  const inHead = async (dir: string, path: string): Promise<boolean> =>
    (await execa('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: dir })).stdout.split('\n').includes(path);

  /**
   * A consultant-bound Full run with a committed spec and an AUTHORED-but-
   * uncommitted contract file — the consultant writes, never commits, so the
   * working tree at the plan gate is exactly what freeze must commit. A `draft`
   * marker (set in production by settleTurn when the consultant's contract turn
   * settles) is the authorship proof freeze now requires; `draft: false` models a
   * stale/pre-existing file this run never authored.
   */
  const contractRun = async (
    projectDir: string,
    opts: { consultant?: boolean; writeContract?: boolean; draft?: boolean } = {},
  ): Promise<{ state: RunState; specPath: string; contractPath: string }> => {
    await initGit(projectDir);
    const specPath = 'docs/specs/test.md';
    mkdirSync(join(projectDir, 'docs/specs'), { recursive: true });
    writeFileSync(join(projectDir, specPath), '# spec\n');
    await execa('git', ['add', '--', specPath], { cwd: projectDir });
    await execa('git', ['commit', '-qm', 'spec'], { cwd: projectDir });
    const state = createRun({
      cwd: projectDir,
      bindings: opts.consultant === false ? DEFAULT_BINDINGS : consultantBindings,
      framing: 'f',
      specPath,
    });
    const contractPath = acceptanceContractPathForSpec(specPath);
    if (opts.writeContract !== false) {
      writeFileSync(join(projectDir, contractPath), '[A1] When X, the system SHALL Y.\n  Verify by: run the tests\n');
    }
    if (opts.draft !== false && opts.consultant !== false) {
      state.acceptanceContractDraft = { path: contractPath, sessionId: 'c-author', authoredAt: '2026-06-24T00:00:00.000Z' };
      saveRunState(state);
    }
    return { state, specPath, contractPath };
  };

  test('commits the authored contract path-scoped and records {path, commit}', async ({ projectDir }) => {
    const { state, contractPath } = await contractRun(projectDir);
    // An in-progress plan in the same worktree must NOT be swept into the commit —
    // even when the implementer has STAGED it (the harder case than merely untracked).
    const planPath = 'docs/plan.md';
    writeFileSync(join(projectDir, planPath), '# plan WIP\n');
    await execa('git', ['add', '--', planPath], { cwd: projectDir });

    await freezeContractAt(state, 'plan');

    const head = await headOf(projectDir);
    expect.soft(state.acceptanceContract).toEqual({ path: contractPath, commit: head });
    // The freeze commit touched ONLY the contract file.
    const changed = (await execa('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: projectDir })).stdout.trim();
    expect.soft(changed).toBe(contractPath);
    // The staged plan is NOT in the freeze commit, so it survives for impl's own commit.
    expect.soft(await inHead(projectDir, planPath)).toBe(false);
    expect.soft(await inHead(projectDir, contractPath)).toBe(true);
    // Persisted to disk, not only the in-memory ref.
    expect.soft(loadRunState(projectDir, state.runId).acceptanceContract?.commit).toBe(head);
  });

  test('no-ops when no consultant is bound (default-off byte-for-byte)', async ({ projectDir }) => {
    const { state } = await contractRun(projectDir, { consultant: false });
    const head = await headOf(projectDir);

    await freezeContractAt(state, 'plan');

    expect.soft(state.acceptanceContract).toBeUndefined();
    expect.soft(await headOf(projectDir)).toBe(head); // no commit made
  });

  test('no-ops at a non-contract gate', async ({ projectDir }) => {
    const { state } = await contractRun(projectDir);
    const head = await headOf(projectDir);

    await freezeContractAt(state, 'spec'); // not the contract author phase

    expect.soft(state.acceptanceContract).toBeUndefined();
    expect.soft(await headOf(projectDir)).toBe(head);
  });

  test('no-ops when authoring produced no file (the missing-contract case)', async ({ projectDir }) => {
    const { state } = await contractRun(projectDir, { writeContract: false });
    const head = await headOf(projectDir);

    await freezeContractAt(state, 'plan');

    expect.soft(state.acceptanceContract).toBeUndefined();
    expect.soft(await headOf(projectDir)).toBe(head);
  });

  test('no-ops on a stale/pre-existing file this run never authored — no draft marker (finding 3)', async ({ projectDir }) => {
    // A contract file is present at the derived path, but no draft marker proves
    // THIS run authored it (e.g. it was committed by a prior run). Freeze must not
    // ratify it — even when the file is already committed and clean.
    const { state, contractPath } = await contractRun(projectDir, { draft: false });
    await execa('git', ['add', '--', contractPath], { cwd: projectDir });
    await execa('git', ['commit', '-qm', 'stale contract from a prior run'], { cwd: projectDir });
    const head = await headOf(projectDir);
    expect.soft(state.acceptanceContractDraft).toBeUndefined(); // this run authored nothing

    await freezeContractAt(state, 'plan');

    expect.soft(state.acceptanceContract).toBeUndefined(); // not frozen — no authorship proof
    expect.soft(await headOf(projectDir)).toBe(head);
  });

  test('is idempotent — a second freeze does not double-commit', async ({ projectDir }) => {
    const { state } = await contractRun(projectDir);

    await freezeContractAt(state, 'plan');
    const frozen = state.acceptanceContract?.commit;
    const headAfterFirst = await headOf(projectDir);

    await freezeContractAt(state, 'plan'); // second call — already frozen

    expect.soft(state.acceptanceContract?.commit).toBe(frozen);
    expect.soft(await headOf(projectDir)).toBe(headAfterFirst); // no new commit
  });

  test('the pre-authorized plan auto-cross freezes the contract (driveToQuiescence)', async ({ projectDir }) => {
    const { state, contractPath } = await contractRun(projectDir);
    state.gatesAt = ['impl']; // frame/spec/plan pre-authorized → plan auto-crosses; impl attended → stop
    saveRunState(state);
    const { machine } = scriptedMachine([advanced, advanced, advanced, advanced]);

    await driveToQuiescence(state, undefined, { machine, notify: quiet });

    const persisted = loadRunState(projectDir, state.runId);
    expect.soft(persisted.machineState).toBe('shipGate'); // stopped at the attended impl gate
    expect.soft(persisted.acceptanceContract?.path).toBe(contractPath); // frozen at the plan auto-cross
    expect.soft(await inHead(projectDir, contractPath)).toBe(true); // and committed
  });
});

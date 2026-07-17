import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { defaultBindingsFor } from '../src/voices/bindings.ts';
import type { PhaseEvent } from '../src/run/phase-events.ts';
import { driveToQuiescence } from '../src/surfaces/lifecycle.ts';
import { probeRunPosition } from '../src/run/position.ts';
import { createRun, loadMachineSnapshot, loadRunState, runDirOf, saveRunState } from '../src/run/store.ts';
import { test } from './helpers/fixtures.ts';
import { restInteractiveAt, scriptedMachine } from './helpers/scripted-machine.ts';

/**
 * The position probe (src/run/position.ts): running / gate / flag / crashed /
 * interactive / done, joined from driver liveness, the parked snapshot, and the
 * state evidence the driver writes continuously. Steer gating, crash recovery,
 * and the status model all derive from this one probe.
 */

const advanced: PhaseEvent = { type: 'phase.advance' };

describe('probeRunPosition', () => {
  const quiet = async () => {};

  test('a live driver pid means a phase is running, whatever the stale snapshot says', ({
    projectDir,
    run,
    onTestFinished,
  }) => {
    // Park the run at the direction gate, then plant a live foreign pid —
    // the state a driver leaves mid-phase after crossing via --approve.
    restInteractiveAt(run, [advanced]);
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

    const specEntry = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full'), specPath: 'docs/spec.md' });
    expect.soft(probeRunPosition(specEntry)).toEqual({ kind: 'crashed', phase: 'spec' });
  });

  test('a state file with no workflow field materializes full at load and restores through the full machine', async ({ projectDir, run }) => {
    // The actual hydration path, not just the normalize: drive to a persisted
    // gate snapshot, strip the workflow field from the saved state (a
    // remodel-era or hand-written state.json — createRun materializes it now),
    // and confirm the load materializes 'full' and probeRunPosition still
    // resolves the same position through machineFor('full').
    await driveToQuiescence(run, undefined, { machine: scriptedMachine([advanced]).machine, notify: quiet });
    expect.soft(probeRunPosition(loadRunState(projectDir, run.runId))).toEqual({ kind: 'gate', phase: 'frame' });

    const stripped = loadRunState(projectDir, run.runId);
    delete (stripped as { workflow?: string }).workflow;
    saveRunState(stripped);
    const migrated = loadRunState(projectDir, run.runId);
    expect.soft(migrated.workflow).toBe('full');
    expect.soft(probeRunPosition(migrated)).toEqual({ kind: 'gate', phase: 'frame' });
  });

  test('a snapshot parked at a gate is the gate — unless the next phase already started (crashed past it, resumed by re-uttering the approve)', ({
    projectDir,
    run,
  }) => {
    restInteractiveAt(run, [advanced]);
    const fresh = loadRunState(projectDir, run.runId);
    expect(probeRunPosition(fresh)).toEqual({ kind: 'gate', phase: 'frame' });

    fresh.phaseStarted.spec = true;
    saveRunState(fresh);
    expect(probeRunPosition(fresh)).toEqual({ kind: 'crashed', phase: 'spec', resumeEvent: 'approve' });
  });

  test('a flag-wait with its question is a flag; with the answer consumed it is a mid-phase crash resumed by re-uttering the answer', ({
    projectDir,
    run,
  }) => {
    run.pendingQuestion = { question: 'which scope?' };
    saveRunState(run);
    restInteractiveAt(run, [{ type: 'phase.flag' }]);

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
    // the snapshot stays at the gate while phaseStarted.spec is set. This one
    // deliberately drives the real quiescence loop — it proves the RESUME, not
    // just the probe's verdict.
    const quiet = async () => {};
    const first = scriptedMachine([advanced]);
    await driveToQuiescence(run, undefined, { machine: first.machine, notify: quiet });
    const crashed = loadRunState(projectDir, run.runId);
    crashed.phaseStarted.spec = true;
    saveRunState(crashed);

    // What bare `greenflag continue` does at a crashed position: re-utter the event.
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

  test('a finished run is done', ({ projectDir, run }) => {
    // Park a done snapshot directly (five advance+approve pairs walk frame →
    // … → finish → done); the auto-cross lifecycle that produces this state
    // for real is the gate pre-authorization suite's subject.
    restInteractiveAt(run, [
      advanced, { type: 'human.approve' },
      advanced, { type: 'human.approve' },
      advanced, { type: 'human.approve' },
      advanced, { type: 'human.approve' },
      advanced, { type: 'human.approve' },
    ]);
    expect(probeRunPosition(loadRunState(projectDir, run.runId))).toEqual({ kind: 'done' });
  });
});

describe('probeRunPosition — the interactive resting model', () => {
  test('no snapshot, no marker → resting at the entry phase (frame, and spec for a spec-entry run)', ({
    projectDir,
    interactiveRun,
  }) => {
    expect.soft(probeRunPosition(interactiveRun)).toEqual({ kind: 'interactive', phase: 'frame' });

    const specEntry = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full'), specPath: 'docs/spec.md' });
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
    // NEXT phase's loop rest (implementLoop), then orchestrationHost is cleared and a
    // headless _drive is spawned (cli.ts). The now-HEADLESS probe must read that
    // phase-loop snapshot as the phase the driver runs — the regression was that
    // the headless branch only handled quiescent (gate/flag) snapshots, so a
    // phase loop fell through to the entry-phase fallback and a mid-impl run
    // misreported as running/crashed in `frame`.
    restInteractiveAt(interactiveRun, [
      { type: 'phase.advance' }, { type: 'human.approve' }, // frame → spec
      { type: 'phase.advance' }, { type: 'human.approve' }, // spec → plan
      { type: 'phase.advance' }, { type: 'human.approve' }, // plan → implement (the handoff)
    ]);
    const handed = loadRunState(projectDir, interactiveRun.runId);
    delete handed.orchestrationHost; // the handoff: the run is headless from here
    saveRunState(handed);

    // No live driver yet → a mid-phase crash AT the handed-off phase (impl), which
    // bare `greenflag continue` re-enters from this very snapshot — not the entry phase.
    expect.soft(probeRunPosition(loadRunState(projectDir, interactiveRun.runId))).toEqual({
      kind: 'crashed',
      phase: 'implement',
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
      phase: 'implement',
    });
  });

  test('a headless run is unchanged — the gate comes from the snapshot, and the marker is ignored', ({
    projectDir,
    run,
  }) => {
    // The same snapshot+marker that mean "parked at the gate" for an interactive
    // run stay headless-as-today: the gate is derived from the snapshot value,
    // and the probe does not consume terminalMarker on the headless path.
    restInteractiveAt(run, [advanced]);
    const fresh = loadRunState(projectDir, run.runId);
    expect.soft(probeRunPosition(fresh)).toEqual({ kind: 'gate', phase: 'frame' });

    fresh.terminalMarker = { phase: 'spec', kind: 'advance' };
    saveRunState(fresh);
    expect.soft(probeRunPosition(fresh)).toEqual({ kind: 'gate', phase: 'frame' });
  });
});

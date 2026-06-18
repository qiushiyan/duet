import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createActor, waitFor } from 'xstate';
import type { AnyMachineSnapshot, Snapshot } from 'xstate';
import { notify as desktopNotify } from '../notify.ts';
import { PHASES, phaseOfGateState } from '../phases.ts';
import type { GatePhase, PhaseName } from '../phases.ts';
import {
  gateAttended,
  loadMachineSnapshot,
  loadRunState,
  runDirOf,
  saveMachineSnapshot,
  saveRunState,
} from '../run-store.ts';
import type { RunState } from '../run-store.ts';
import { describeStop } from '../status.ts';
import { duetMachine, flagWaitStateOf } from './machine.ts';

/**
 * The run lifecycle — how phases actually execute (docs/automation-design.md
 * §"Not a daemon — but alive through a phase"). `new` and gate-crossing
 * `continue` invocations return immediately: spawnDrive starts a detached
 * per-phase child (`duet _drive`) whose body is driveToQuiescence — it runs
 * the statechart to the next quiescent state (a gate, a queued flag, or
 * done), persists, notifies, and exits. Nothing runs between quiescent
 * stops; the pid file is how a second driver is refused.
 */

export type HumanEvent = { type: 'human.approve' | 'human.reject' | 'human.answer' };

const QUIESCENCE_TIMEOUT_MS = 6 * 60 * 60_000;

/**
 * Spawn the detached phase driver and return its pid. Its stdout/stderr go
 * to `.duet/runs/<id>/driver.log` (crash evidence lives there); the pid file
 * is how later invocations refuse to start a second concurrent driver.
 */
export function spawnDrive(state: RunState, eventType?: 'approve' | 'reject' | 'answer'): number {
  const runDir = runDirOf(state.cwd, state.runId);
  const out = openSync(join(runDir, 'driver.log'), 'a');
  const child = spawn(
    process.execPath,
    [process.argv[1]!, '_drive', state.runId, ...(eventType ? [eventType] : [])],
    { cwd: state.cwd, detached: true, stdio: ['ignore', out, out] },
  );
  closeSync(out);
  writeFileSync(join(runDir, 'driver.pid'), `${child.pid}\n`);
  child.unref();
  return child.pid!;
}

/** The driver pid when one is alive for this run, else undefined. */
export function aliveDriverPid(state: RunState): number | undefined {
  const path = join(runDirOf(state.cwd, state.runId), 'driver.pid');
  if (!existsSync(path)) return undefined;
  const pid = Number.parseInt(readFileSync(path, 'utf8'), 10);
  if (!Number.isFinite(pid)) return undefined;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined; // stale pid — the driver exited (or crashed)
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop a run's detached driver if one is alive: SIGTERM, then SIGKILL if it
 * lingers past the grace. Returns the pid it stopped, or undefined when no
 * driver was running. Only the driver pid is signalled — an in-flight worker
 * turn is left to finish harmlessly into its own transcript
 * (docs/automation-design.md §"Ending a run"), not killed with the group. The
 * caller (`duet abandon`) then marks or purges the run with the driver already
 * dead, so its state writes can't race the marker.
 */
export async function killDriver(
  state: RunState,
  opts: { graceMs?: number; pollMs?: number } = {},
): Promise<number | undefined> {
  const pid = aliveDriverPid(state);
  if (pid === undefined) return undefined;
  const graceMs = opts.graceMs ?? 5_000;
  const pollMs = opts.pollMs ?? 100;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return undefined; // raced us and exited between the liveness check and the signal
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return pid;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  // Lingered past the grace — escalate to the uncatchable signal.
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Exited between the last poll and here.
  }
  return pid;
}

/**
 * Where a run actually is, derived from the signals that exist on disk. The
 * machine snapshot alone cannot say: snapshots persist only at quiescent
 * states, so mid-phase it still shows the previous stop. The probe joins it
 * with driver liveness and the run-state evidence the driver writes
 * continuously (`phaseStarted`, `pendingQuestion`).
 *
 * A crashed position carries how `duet continue` resumes it: the snapshot is
 * parked at the stop whose crossing died, so recovery re-utters that
 * crossing — `approve` for a gate the human already approved, `answer` for a
 * flag whose answer was already consumed; absent means there is no snapshot
 * and the machine restarts from its entry point.
 */
export type RunPosition =
  | { kind: 'running'; pid: number; phase: PhaseName }
  | { kind: 'gate'; phase: GatePhase }
  | { kind: 'flag'; phase: PhaseName }
  | { kind: 'crashed'; phase: PhaseName; resumeEvent?: 'approve' | 'answer' }
  | { kind: 'abandoned' }
  | { kind: 'done' };

export function probeRunPosition(state: RunState): RunPosition {
  // A deliberate abandon wins over every disk signal: the driver was killed,
  // so the snapshot would otherwise read as a crash. `duet continue` clears
  // the marker to revive (the underlying stop re-derives from there).
  if (state.abandoned) return { kind: 'abandoned' };
  const stopped = stoppedPosition(state);
  const pid = aliveDriverPid(state);
  // process.pid is excluded: `_drive` prints status at its own exit, when the
  // run is genuinely at the stop it just persisted.
  if (pid !== undefined && pid !== process.pid && stopped.kind !== 'done') {
    return { kind: 'running', pid, phase: stopped.phase };
  }
  return stopped;
}

/** The position assuming no live driver — also the running phase's identity. */
function stoppedPosition(state: RunState): Exclude<RunPosition, { kind: 'running' | 'abandoned' }> {
  // The phase a snapshot-less machine starts in (spec-entry runs skip frame).
  const entryPhase: PhaseName = state.specPath ? 'spec' : 'frame';
  const snapshot = loadMachineSnapshot(state);
  if (!snapshot) {
    // The driver died (or was killed) before the first quiescent stop.
    return { kind: 'crashed', phase: entryPhase };
  }
  const restored = createActor(duetMachine, {
    input: { runId: state.runId, cwd: state.cwd, hasSpec: Boolean(state.specPath) },
    snapshot,
  }).getSnapshot();
  if (restored.status === 'done') return { kind: 'done' };
  const value = typeof restored.value === 'string' ? restored.value : JSON.stringify(restored.value);

  if (restored.hasTag('flag-wait')) {
    const phase = PHASES.find((p) => flagWaitStateOf(p.name) === value)?.name ?? entryPhase;
    // A flag-wait stop always has its queued question; a missing one means
    // the answer was consumed and the driver died mid-phase.
    return state.pendingQuestion ? { kind: 'flag', phase } : { kind: 'crashed', phase, resumeEvent: 'answer' };
  }

  const gatePhase = phaseOfGateState(value);
  if (gatePhase) {
    // The entry prompt of the NEXT phase was built — the gate was crossed,
    // then the driver died mid-phase. (A crash during gate-reject rework is
    // indistinguishable from waiting at the gate; the human re-decides there,
    // which recovers either way.)
    const next = PHASES[PHASES.findIndex((p) => p.name === gatePhase) + 1];
    if (next && state.phaseStarted[next.name]) {
      return { kind: 'crashed', phase: next.name, resumeEvent: 'approve' };
    }
    return { kind: 'gate', phase: gatePhase };
  }

  // Unreachable for snapshots we persist (quiescent states only) — treat a
  // foreign snapshot as a mid-phase crash so the run stays actionable.
  return { kind: 'crashed', phase: entryPhase };
}

/**
 * Block until the run reaches a stop — any position but `running` — polling
 * the probe on fresh state each round. The wait side of `duet status --wait`:
 * the one deterministic supervision cycle, owned by the CLI so watchers (the
 * concierge skill, a shell loop, a human) never reinvent polling. Read-only;
 * interrupting it cannot affect the run.
 */
export async function waitForRunStop(
  cwd: string,
  runId: string,
  opts: { intervalMs?: number } = {},
): Promise<RunPosition> {
  const intervalMs = opts.intervalMs ?? 5_000;
  for (;;) {
    const position = probeRunPosition(loadRunState(cwd, runId));
    if (position.kind !== 'running') return position;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export interface LifecycleDeps {
  /** Injectable for tests: a duetMachine with a scripted phaseDriver. */
  machine?: typeof duetMachine;
  notify?: typeof desktopNotify;
}

/**
 * Drive the statechart to the next attended quiescent stop. Gates whose
 * phase isn't in gates_at were pre-authorized at run start: record the
 * crossing, notify, and approve on the human's standing authority — the
 * driver lives through the whole pre-authorized stretch and exits at the
 * next attended stop. The statechart is untouched: gates still transition
 * only on human.* events; what the pre-authorization changes is when the
 * human's approval is uttered.
 *
 * Returns the stop's snapshot plus the freshly loaded state (the phase
 * driver wrote to disk while the actor ran).
 */
export async function driveToQuiescence(
  state: RunState,
  options?: { snapshot?: Snapshot<unknown>; event?: HumanEvent },
  deps: LifecycleDeps = {},
): Promise<{ snapshot: AnyMachineSnapshot; state: RunState }> {
  const machine = deps.machine ?? duetMachine;
  const notify = deps.notify ?? desktopNotify;

  // Spent-marker guard. If we are restoring at the marker phase's OWN gate or
  // flag-wait, the transition that marker drove already persisted — we are
  // parked past it, so the marker is a spent leftover from the crash window
  // between the snapshot save and the clear below. Clear it before the human
  // event re-enters the phase loop: otherwise a stale `flag` re-entered by an
  // answer (frameFlagWait → frameLoop) or a stale `advance` re-entered by a
  // reject (directionGate → frameLoop) would replay the old decision and
  // swallow the human's input — the run bounces straight back, authority lost.
  // A crash BEFORE the transition restores at a prior quiescent state (phase
  // loops are never persisted), so this guard does not fire there and the
  // driver still replays the live marker on loop re-entry (crash-before-
  // transition replay, src/harness/driver.ts / stdio-host.ts).
  const restoredMarker = state.terminalMarker;
  const restoredState = state.machineState;
  if (
    restoredMarker &&
    restoredState &&
    (phaseOfGateState(restoredState) === restoredMarker.phase ||
      restoredState === flagWaitStateOf(restoredMarker.phase))
  ) {
    delete state.terminalMarker;
    saveRunState(state);
  }

  const actor = createActor(machine, {
    input: { runId: state.runId, cwd: state.cwd, hasSpec: Boolean(state.specPath) },
    ...(options?.snapshot ? { snapshot: options.snapshot } : {}),
  });
  actor.start();
  if (options?.event) actor.send(options.event);

  for (;;) {
    const snapshot = await waitFor(
      actor,
      (s) => s.hasTag('quiescent') || s.status === 'done',
      { timeout: QUIESCENCE_TIMEOUT_MS },
    );

    saveMachineSnapshot(state, actor.getPersistedSnapshot());
    const fresh = loadRunState(state.cwd, state.runId);
    fresh.machineState = typeof snapshot.value === 'string' ? snapshot.value : JSON.stringify(snapshot.value);

    // Deliver-before-clear: the snapshot above now durably reflects the
    // transition the terminal marker drove, so the marker has done its job.
    // Clear it here — after the snapshot save, before any gates_at auto-cross
    // re-enters the next phase — so a pre-authorized continue can't carry a
    // stale marker into the next phase's runPhase (markerToEvent is phase-keyed,
    // but clearing keeps the on-disk state honest). If a crash lands in the
    // window between the snapshot save and this clear, the marker survives to
    // the next driveToQuiescence — where the spent-marker guard at entry clears
    // it before any human event can re-enter the loop and replay it (the
    // same-phase replay is NOT inherently harmless: see that guard above).
    if (fresh.terminalMarker) {
      delete fresh.terminalMarker;
      saveRunState(fresh);
    }

    const gatePhase = snapshot.status !== 'done' ? phaseOfGateState(fresh.machineState) : undefined;
    if (gatePhase && !gateAttended(fresh, gatePhase)) {
      // Dedupe on crash-recovery re-entry at the same gate.
      if (fresh.autoApprovals?.at(-1)?.gate !== fresh.machineState) {
        (fresh.autoApprovals ??= []).push({ gate: fresh.machineState, at: new Date().toISOString() });
      }
      saveRunState(fresh);
      console.log(`[gate] ${fresh.machineState} auto-approved — pre-authorized at run start (packet recorded)`);
      await notify(`duet ${fresh.runId}`, `${fresh.machineState} auto-approved (pre-authorized) — run continues`);
      actor.send({ type: 'human.approve' });
      continue;
    }

    saveRunState(fresh);
    actor.stop();
    await notify(`duet ${fresh.runId}`, describeStop(fresh, snapshot.status === 'done'));
    return { snapshot, state: fresh };
  }
}

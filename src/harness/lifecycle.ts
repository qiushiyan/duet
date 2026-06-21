import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createActor, waitFor } from 'xstate';
import type { AnyMachineSnapshot, Snapshot } from 'xstate';
import { notify as desktopNotify } from '../notify.ts';
import { PHASE, WORKFLOWS, entryOf, phaseOfGateState, phasesOf } from '../phases.ts';
import type { GatePhase, PhaseName, WorkflowName } from '../phases.ts';
import type { WorkerRole } from '../providers/types.ts';
import {
  gateAttended,
  loadMachineSnapshot,
  loadRunState,
  runDirOf,
  saveMachineSnapshot,
  saveRunState,
  workflowOf,
} from '../run-store.ts';
import type { RunState } from '../run-store.ts';
import { describeStop } from '../status.ts';
import { duetMachine, flagWaitStateOf, interactiveMachineFor, machineFor } from './machine.ts';
import { markerToEvent } from './phase-events.ts';

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
 *
 * `interactive` is the Stage-1 resting position: an interactive run (the human's
 * session is the orchestrator) between gates rests AT its phase loop — there is
 * no `_drive`, so a non-quiescent phase-loop snapshot is a legitimate rest, not
 * a crash. The marker, when set, names the parked gate/flag instead.
 */
export type RunPosition =
  | { kind: 'running'; pid: number; phase: PhaseName }
  | { kind: 'interactive'; phase: PhaseName }
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
  const wf = workflowOf(state);
  const entry = entryOf(wf);
  // The phase a snapshot-less machine starts in (a draft-spec run skips ahead
  // to the workflow's specSkipsTo, when it has one).
  const entryPhase = (state.specPath && entry.specSkipsTo ? entry.specSkipsTo : entry.firstPhase) as PhaseName;
  const snapshot = loadMachineSnapshot(state);

  // The interactive resting model (Stage 1): the human's session drives each
  // phase, so a non-quiescent phase-loop snapshot is a REST, not a crash. The
  // terminal marker — when it belongs to the RESTING phase — is the signal that
  // the run is parked at that phase's gate/flag (the interactive snapshot still
  // sits at the phase loop; it is never persisted AT the gate). A marker whose
  // phase no longer matches the rest is STALE: crossInteractive saves the
  // next-phase snapshot and then clears the marker as two writes, and a crash
  // between them leaves the prior phase's marker beside a moved-on snapshot — so
  // we key liveness off `marker.phase === restPhase` and ignore the leftover.
  // (The read-only probe has no spent-marker guard of its own — that one lives
  // in driveToQuiescence, which interactive runs don't go through.) Guarded on
  // orchestrationHost, so headless runs are untouched.
  if (state.orchestrationHost === 'interactive') {
    const restPhase = (snapshot && interactiveRestPhase(state, snapshot)) || entryPhase;
    const marker = state.terminalMarker;
    if (marker && marker.phase === restPhase) {
      return marker.kind === 'advance' && PHASE[marker.phase].gate
        ? { kind: 'gate', phase: marker.phase as GatePhase }
        : { kind: 'flag', phase: marker.phase };
    }
    // No live marker: resting at the phase loop the session is actively driving.
    return { kind: 'interactive', phase: restPhase };
  }

  if (!snapshot) {
    // The driver died (or was killed) before the first quiescent stop.
    return { kind: 'crashed', phase: entryPhase };
  }
  const restored = createActor(machineFor(wf), {
    input: { runId: state.runId, cwd: state.cwd, hasSpec: Boolean(state.specPath) },
    snapshot,
  }).getSnapshot();
  if (restored.status === 'done') return { kind: 'done' };
  const value = typeof restored.value === 'string' ? restored.value : JSON.stringify(restored.value);

  if (restored.hasTag('flag-wait')) {
    const phase = phasesOf(wf).find((p) => flagWaitStateOf(p.name) === value)?.name ?? entryPhase;
    // A flag-wait stop always has its queued question; a missing one means
    // the answer was consumed and the driver died mid-phase.
    return state.pendingQuestion ? { kind: 'flag', phase } : { kind: 'crashed', phase, resumeEvent: 'answer' };
  }

  const gatePhase = phaseOfGateState(wf, value);
  if (gatePhase) {
    // The entry prompt of the NEXT phase was built — the gate was crossed,
    // then the driver died mid-phase. (A crash during gate-reject rework is
    // indistinguishable from waiting at the gate; the human re-decides there,
    // which recovers either way.)
    const phases = phasesOf(wf);
    const next = phases[phases.findIndex((p) => p.name === gatePhase) + 1];
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
 * The phase an interactive resting snapshot sits in, read off its `<phase>Loop`
 * state value. Restores the snapshot WITHOUT starting the actor (the same
 * side-effect-free read stoppedPosition uses), so no phaseDriver is invoked
 * regardless of which machine variant persisted it. Returns undefined for a
 * snapshot that is not at a phase loop (e.g. a gate/done value), letting the
 * caller fall back to the entry phase.
 */
function interactiveRestPhase(state: RunState, snapshot: Snapshot<unknown>): PhaseName | undefined {
  const wf = workflowOf(state);
  const restored = createActor(machineFor(wf), {
    input: { runId: state.runId, cwd: state.cwd, hasSpec: Boolean(state.specPath) },
    snapshot,
  }).getSnapshot();
  const value = typeof restored.value === 'string' ? restored.value : JSON.stringify(restored.value);
  return phasesOf(wf).find((p) => `${p.name}Loop` === value)?.name;
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

/** A pending worker turn settled — what `duet status --wait` wakes on, beside a run stop. */
export type TurnReady = { kind: 'turn-ready'; roles: WorkerRole[] };

/**
 * The turn-aware wait behind `duet status --wait`: wake on a worker turn
 * settling (interactive host) OR a run stop, whichever comes first. Stop-only
 * polling (waitForRunStop) is wrong for the interactive host — an interactive
 * run probes as `interactive`, never `running`, so it would wake instantly on
 * exactly the host async send_prompt is for. The rule:
 *   - any pending record `ready`/`failed` → `turn-ready` (collect with check_turns);
 *   - a real stop (gate/flag/crashed/done/abandoned) → that position;
 *   - keep polling only while a headless driver is `running`, or an `interactive`
 *     run still has a turn `running`;
 *   - otherwise return the position (an interactive rest with nothing pending is
 *     itself the answer — there is nothing to wait for).
 * Read-only, like waitForRunStop; interrupting it cannot affect the run.
 */
export async function waitForTurnOrStop(
  cwd: string,
  runId: string,
  opts: { intervalMs?: number } = {},
): Promise<RunPosition | TurnReady> {
  const intervalMs = opts.intervalMs ?? 5_000;
  const ROLES: WorkerRole[] = ['implementer', 'reviewer'];
  for (;;) {
    const state = loadRunState(cwd, runId);
    const pending = state.pendingTurns ?? {};
    const ready = ROLES.filter((r) => pending[r]?.status === 'ready' || pending[r]?.status === 'failed');
    if (ready.length > 0) return { kind: 'turn-ready', roles: ready };
    const position = probeRunPosition(state);
    const turnRunning = ROLES.some((r) => pending[r]?.status === 'running');
    const keepPolling = position.kind === 'running' || (position.kind === 'interactive' && turnRunning);
    if (!keepPolling) return position;
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
  const machine = deps.machine ?? machineFor(workflowOf(state));
  const notify = deps.notify ?? desktopNotify;

  const actor = createActor(machine, {
    input: { runId: state.runId, cwd: state.cwd, hasSpec: Boolean(state.specPath) },
    ...(options?.snapshot ? { snapshot: options.snapshot } : {}),
  });
  actor.start();

  // Spent-marker guard. Keyed off the RESTORED snapshot value — the snapshot
  // the actor just hydrated from machine.json, the durable record of where the
  // machine resumed — NOT state.machineState, which is the state.json mirror
  // written only after saveMachineSnapshot and so stale/absent in the very
  // crash window this guards (machine.json saved at the gate, the mirror not
  // yet). If we resumed AT the marker phase's OWN gate or flag-wait, the
  // transition that marker drove already applied — we are parked past it, so
  // the marker is a spent leftover. Clear it before the human event re-enters
  // the phase loop: otherwise a stale `flag` re-entered by an answer
  // (frameFlagWait → frameLoop) or a stale `advance` re-entered by a reject
  // (directionGate → frameLoop) would replay the old decision and swallow the
  // human's input — the run bounces straight back, authority lost. A crash
  // BEFORE the transition restores at a prior quiescent state (phase loops are
  // never persisted), so the restored value is not this marker's gate/flag-wait,
  // the guard does not fire, and the driver still replays the live marker on
  // loop re-entry (crash-before-transition replay, driver.ts / stdio-host.ts).
  const restoredMarker = state.terminalMarker;
  const restoredValue = actor.getSnapshot().value;
  if (
    restoredMarker &&
    typeof restoredValue === 'string' &&
    (phaseOfGateState(workflowOf(state), restoredValue) === restoredMarker.phase ||
      restoredValue === flagWaitStateOf(restoredMarker.phase))
  ) {
    delete state.terminalMarker;
    saveRunState(state);
  }

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

    const gatePhase = snapshot.status !== 'done' ? phaseOfGateState(workflowOf(fresh), fresh.machineState) : undefined;
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

/**
 * Advance an interactive run's machine inline — the Stage-1 continue, with no
 * `_drive`. The human's session drives each phase, so a crossing is a pure disk
 * transition: restore the inert interactiveMachine at its resting phase loop,
 * consume the marker's recorded phase.* to reach the gate/flag, apply the
 * human's authority event, then persist the resulting next phase-loop rest and
 * clear the marker deliver-before-clear.
 *
 * Marker-then-human ordering is load-bearing: at a phase loop the human.* event
 * has no handler (only phase.* does), and only human.* crosses a gate/flag — so
 * the marker's phase.* must move the machine to the gate/flag BEFORE the human
 * event applies. (A naive `spawnDrive(state,'approve')` sends the human event
 * first, against a phase loop that ignores it, then replays the marker and parks
 * at the gate — never crossing. That is why an interactive crossing cannot go
 * through driveToQuiescence, which sends its event before the marker replays.)
 */
export function crossInteractive(state: RunState, humanEvent: HumanEvent): void {
  const wf = workflowOf(state);
  const snapshot = loadMachineSnapshot(state);
  const actor = createActor(interactiveMachineFor(wf), {
    input: { runId: state.runId, cwd: state.cwd, hasSpec: Boolean(state.specPath) },
    ...(snapshot ? { snapshot } : {}),
  });
  actor.start();
  // The actor rests at the phase loop the session was driving (or the entry
  // phase, fresh, on the first crossing). Consume the marker keyed off that
  // resting phase, so a stale marker can't drive a foreign phase's decision.
  const restValue = actor.getSnapshot().value;
  const restPhase =
    typeof restValue === 'string' ? phasesOf(wf).find((p) => `${p.name}Loop` === restValue)?.name : undefined;
  const markerEvent = restPhase ? markerToEvent(state.terminalMarker, restPhase) : null;
  if (markerEvent) actor.send(markerEvent);
  actor.send(humanEvent);
  // The interactive phase loop IS the rest (the provided actor is inert, so
  // restore is safe — machine.ts). Persist it, then clear the marker
  // deliver-before-clear: a crash between the two writes leaves a stale marker
  // the probe ignores, since it no longer matches the moved-on rest phase.
  saveMachineSnapshot(state, actor.getPersistedSnapshot());
  actor.stop();
  const fresh = loadRunState(state.cwd, state.runId);
  delete fresh.terminalMarker;
  saveRunState(fresh);
}

/**
 * Whether an interactive crossing rests inline (the connected session drives the
 * next phase via get_task) or hands off to a detached headless `_drive`. The
 * workflow's `handoffGate` is THE handoff — approving it enters the permanent
 * AFK substrate (Full: plan-approval → impl; RIR: Direction → implement) — as is
 * any explicit `--headless` fallback.
 */
export function interactiveContinueAction(
  workflow: WorkflowName,
  gatePhase: PhaseName,
  eventType: 'approve' | 'reject' | 'answer',
  headless: boolean,
): 'inline' | 'handoff' {
  return (gatePhase === WORKFLOWS[workflow].handoffGate && eventType === 'approve') || headless
    ? 'handoff'
    : 'inline';
}

/**
 * Validate an interactive decision against the marker-derived position — the
 * interactive rest is a phase loop with no human.* handler, so `restored.can()`
 * would reject every crossing. A gate admits approve/reject; a flag admits
 * answer; anywhere else, the orchestrator hasn't advanced and there is nothing
 * to cross. Returns a friendly error sentence, or undefined when the decision is
 * legal.
 */
export function validateInteractiveCrossing(
  position: RunPosition,
  eventType: 'approve' | 'reject' | 'answer',
): string | undefined {
  if (position.kind === 'gate') {
    return eventType === 'answer'
      ? 'is at a gate — use --approve or --reject "<feedback>", not --answer'
      : undefined;
  }
  if (position.kind === 'flag') {
    return eventType === 'answer' ? undefined : 'has a queued question — use --answer "<text>"';
  }
  return "isn't at a gate or flag yet — the orchestrator hasn't advanced, so there's nothing to cross";
}

import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { createActor, waitFor } from 'xstate';
import type { AnyMachineSnapshot, Snapshot } from 'xstate';
import { notify as desktopNotify } from '../notify.ts';
import {
  PHASE,
  WORKFLOWS,
  acceptanceContractPathForSpec,
  contractAuthorPhaseOf,
  entryOf,
  gatePhasesOf,
  phaseOfGateState,
  phasesOf,
} from '../phases.ts';
import type { GatePhase, PhaseName, WorkflowName } from '../phases.ts';
import type { WorkerRole } from '../providers/types.ts';
import { workerRolesFor } from '../roles.ts';
import {
  gateAttended,
  highDecisionsAt,
  loadMachineSnapshot,
  loadRunState,
  runDirOf,
  saveMachineSnapshot,
  saveRunState,
  setGatesAt,
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

  // A phase-loop snapshot reaches the HEADLESS probe only after an
  // interactive→headless handoff (`duet continue` at the handoff gate, `duet afk`,
  // or a bare `--headless` mid-phase drop): crossInteractive — or the prior
  // interactive rest — leaves the machine AT a phase loop (e.g. implLoop), then
  // orchestrationHost is cleared (cli.ts). The pure-headless path never persists a
  // phase loop (driveToQuiescence saves only at quiescent stops), so this branch's
  // gate/flag checks above don't cover it; map it to its own phase. A live driver
  // then surfaces it as `running` there (probeRunPosition); a dead one as a
  // mid-phase `crashed` that bare `duet continue` re-enters from this very
  // snapshot. Without this a handed-off mid-impl run misreports against the
  // entry-phase fallback below (running/crashed in `spec`, not `impl`).
  const loopPhase = phaseLoopOf(wf, value);
  if (loopPhase) return { kind: 'crashed', phase: loopPhase };

  // A genuinely foreign snapshot (not a phase loop, gate, or flag-wait) — treat
  // it as a mid-phase crash from the entry phase so the run stays actionable.
  return { kind: 'crashed', phase: entryPhase };
}

/**
 * The phase whose loop state (`<phase>Loop`) a machine value names, or undefined
 * when the value is not a phase loop (a gate / flag-wait / done value). The one
 * place the `<phase>Loop` naming convention is read — shared by the headless
 * probe (`stoppedPosition`), the interactive rest read (`interactiveRestPhase`),
 * and the interactive crossing (`crossInteractive`).
 */
function phaseLoopOf(wf: WorkflowName, value: string): PhaseName | undefined {
  return phasesOf(wf).find((p) => `${p.name}Loop` === value)?.name;
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
  return typeof restored.value === 'string' ? phaseLoopOf(wf, restored.value) : undefined;
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
  for (;;) {
    const state = loadRunState(cwd, runId);
    // The run's bound worker roles — the consultant included when bound, so a
    // dispatched consultant turn wakes `duet status --wait` like any other.
    const roles = workerRolesFor(state);
    const pending = state.pendingTurns ?? {};
    const ready = roles.filter((r) => pending[r]?.status === 'ready' || pending[r]?.status === 'failed');
    if (ready.length > 0) return { kind: 'turn-ready', roles: ready };
    const position = probeRunPosition(state);
    const turnRunning = roles.some((r) => pending[r]?.status === 'running');
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

  // Freeze on an EXPLICIT headless approve of the contract gate (the human
  // approved an attended/held plan gate, re-spawning the driver with the event):
  // the restored snapshot is parked at that gate, so freeze before the event
  // crosses it. The pre-authorized auto-cross is handled in the loop below.
  if (options?.event?.type === 'human.approve' && typeof restoredValue === 'string') {
    const enteringGate = phaseOfGateState(workflowOf(state), restoredValue);
    if (enteringGate) await freezeContractAt(state, enteringGate);
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
    // The severity hold: a `high` human decision withholds the pre-authorized
    // auto-cross (a non-explicit crossing), converting the gate to an attended
    // stop so the human weighs the call before it ships. An EXPLICIT approve
    // (crossInteractive) never consults this — only the manufactured one here.
    const held = gatePhase ? highDecisionsAt(fresh, gatePhase) : [];
    if (gatePhase && !gateAttended(fresh, gatePhase) && held.length === 0) {
      // Freeze on a pre-authorized AUTO-cross of the contract gate (accepted even
      // though the human never ratified it — the auto-cross is the standing
      // authority). No-op at every other gate. Before the cross, like the entry case.
      await freezeContractAt(fresh, gatePhase);
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
    if (gatePhase && !gateAttended(fresh, gatePhase) && held.length > 0) {
      // A pre-authorized gate that did NOT auto-cross because of a `high` — name
      // the held decision so the human sees why the overnight run stopped here.
      console.log(`[gate] ${fresh.machineState} held — a high human decision withheld the pre-authorized auto-cross`);
      await notify(`duet ${fresh.runId}`, `${fresh.machineState} held for you — a high decision needs you: ${held.map((d) => d.title).join('; ')}`);
      return { snapshot, state: fresh };
    }
    await notify(`duet ${fresh.runId}`, describeStop(fresh, snapshot.status === 'done'));
    return { snapshot, state: fresh };
  }
}

/**
 * Freeze the acceptance contract when an approve-crossing reaches its author
 * phase's gate (Full: the plan-approval gate). A discrete, self-guarding step the
 * approve paths call — kept OUT of the pure crossInteractive disk transition. It
 * no-ops unless this is the contract gate, a consultant is bound, a spec path is
 * known, and the consultant actually authored a contract FILE (authoring failed ⇒
 * no file ⇒ the orchestrator's missing-contract `high` surfaces it, not this).
 *
 * The consultant authors but never commits — single-writer-by-construction keeps
 * the orphan-safe discard-and-reseed premise (the consultant touches no git
 * history). So duet commits the authored file here, PATH-SCOPED so the in-progress
 * plan in the same worktree stays uncommitted, and records the freezing commit for
 * the impl verify checkpoint. Idempotent: a crash-recovery re-cross with the
 * contract already frozen is a no-op, and the commit sha is resolved from the
 * path's own history (not HEAD), surviving a crash between commit and state save.
 *
 * Freezes even on a pre-authorized (auto-crossed) plan gate the human never
 * ratified — the contract still freezes and keeps its independent + evidence-
 * verified value; only the human-signed-target leg is absent there (accepted).
 */
export async function freezeContractAt(state: RunState, gatePhase: PhaseName): Promise<void> {
  if (state.acceptanceContract) return; // already frozen — idempotent re-entry
  if (gatePhase !== contractAuthorPhaseOf(workflowOf(state))) return; // not the contract gate
  if (!state.bindings.consultant || !state.specPath) return; // default-off / nothing to derive from
  const path = acceptanceContractPathForSpec(state.specPath);
  // Require THIS run's authoring: a draft marker the consultant's contract turn
  // settled, at this derived path. A pre-existing/stale contract file from a prior
  // run (no draft marker, or a stale path) is NOT this run's contract — freezing it
  // would ratify a target nobody authored this run (the verify checkpoint then
  // checks the built system against it). Without the marker, no freeze; impl treats
  // it as "no contract" and the plan rail already required a high for the absence.
  if (state.acceptanceContractDraft?.path !== path) return;
  if (!existsSync(join(state.cwd, path))) return; // authoring produced no file
  const git = (args: string[]): Promise<{ stdout: string }> => execa('git', args, { cwd: state.cwd, timeout: 30_000 });
  const dirty = (await git(['status', '--porcelain', '--', path])).stdout.trim();
  if (dirty) {
    await git(['add', '--', path]);
    await git(['commit', '-m', `docs(contract): freeze acceptance contract (${state.runId})`, '--', path]);
  }
  // The contract's own last-touching commit — robust to HEAD having moved on and
  // to a crash between an earlier commit and this save (where HEAD ≠ the freeze).
  const commit = (await git(['log', '-1', '--format=%H', '--', path])).stdout.trim();
  // Fresh-load → set the one field → save (the setGatesAt discipline), so a
  // concurrently-staged pendingMessage on disk is not clobbered; mirror onto the
  // caller's ref so the same turn's downstream reads see the freeze.
  const fresh = loadRunState(state.cwd, state.runId);
  fresh.acceptanceContract = { path, commit };
  saveRunState(fresh);
  state.acceptanceContract = { path, commit };
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
  const restPhase = typeof restValue === 'string' ? phaseLoopOf(wf, restValue) : undefined;
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
 * The mid-session AFK handoff (#1): from ANY interactive gate parked on the
 * approve path — INCLUDING a pre-authorized one — re-set the downstream posture,
 * cross this gate, clear the interactive marker, and let the caller spawn the
 * detached headless driver. Legality keys on the gate POSITION (probeRunPosition
 * kind 'gate' + validateInteractiveCrossing), never on gateAttended: a
 * pre-authorized interactive gate is exactly where afk is the one tap that hands
 * off (the interactive host never auto-crosses). Posture is written first
 * (setGatesAt, fresh-load-safe), then the gate is crossed, then the interactive
 * marker is cleared (fresh-load, preserving the just-written posture/snapshot).
 * Returns the resulting attended/pre-authorized split for the caller to print as
 * informed consent.
 */
export async function enterAfk(
  state: RunState,
  posture: GatePhase[],
  opts: { gateless?: boolean } = {},
): Promise<{ attended: GatePhase[]; preAuthorized: GatePhase[] }> {
  if (state.orchestrationHost !== 'interactive') {
    throw new Error(
      `run ${state.runId} is not orchestrated interactively — duet afk hands off from an interactive gate; a headless run already runs unattended.`,
    );
  }
  const position = probeRunPosition(state);
  if (position.kind !== 'gate') {
    const why = validateInteractiveCrossing(position, 'approve') ?? "isn't parked at a gate";
    throw new Error(`run ${state.runId} ${why} — duet afk hands off only from a gate (steer a live phase, or answer a flag).`);
  }
  // The severity hold on the present→away transition: a BARE `duet afk` is a
  // blanket walk-away that must not silently turn a `high` into an unattended
  // approval — refuse it over a `high`, directing the human to the explicit
  // substitute. `duet afk --gateless` IS that explicit substitute: a deliberate
  // full-send the human chose having pre-decided the direction the high concerns,
  // so it crosses the high exactly as an explicit `--approve` does.
  if (!opts.gateless) {
    const held = highDecisionsAt(state, position.phase);
    if (held.length > 0) {
      throw new Error(
        `run ${state.runId} can't hand off to AFK from this gate — it carries a high human decision that needs you (${held
          .map((d) => d.title)
          .join('; ')}). duet afk would approve it unattended; approve this gate explicitly and then hand off (duet continue --approve --headless), or full-send with duet afk --gateless if you accept the call.`,
      );
    }
  }
  // Freeze the contract before this gate is crossed away — `duet afk` from the
  // plan gate is an approve-crossing of the contract gate (no-op elsewhere). The
  // backstop is preserved even under gateless, so this freezes regardless.
  await freezeContractAt(state, position.phase);
  setGatesAt(state, posture);
  crossInteractive(state, { type: 'human.approve' });
  const fresh = loadRunState(state.cwd, state.runId);
  delete fresh.orchestrationHost;
  // Persist the gateless flag so the headless tail runs the consultant as a
  // backstop only (the consultant axis; posture, the other axis, is `gatesAt`).
  if (opts.gateless) fresh.gateless = true;
  saveRunState(fresh);
  Object.assign(state, fresh);
  const gates = gatePhasesOf(workflowOf(state));
  return {
    attended: gates.filter((g) => posture.includes(g)),
    preAuthorized: gates.filter((g) => !posture.includes(g)),
  };
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

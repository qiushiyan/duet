import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createActor } from 'xstate';
import type { Snapshot } from 'xstate';
import { entryOf, gateOf, phaseOfGateState, phaseSpec, phasesOf } from '../registry/workflows.ts';
import type { GatePhase, PhaseName, WorkflowName } from '../registry/workflows.ts';
import { loadMachineSnapshot, runDirOf, workflowOf } from './store.ts';
import type { RunState } from './store.ts';
import { flagWaitStateOf, machineFor } from './machine.ts';

/**
 * The run-position probe — where a run actually is, derived from the signals
 * on disk (the quiescent machine snapshot, driver liveness, the terminal
 * marker, the run-state evidence the driver writes continuously), plus the
 * one-line stop description built from the same read. Pure derivation over
 * run-level facts: it restores machine snapshots WITHOUT starting an actor,
 * so no phase driver is ever invoked from here. Everything needing the
 * process lifecycle (spawn, kill, drive) lives in lifecycle.ts, which imports
 * downward into this module — never the reverse.
 */

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
      return marker.kind === 'advance' && phaseSpec(wf, marker.phase).gate
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
  // interactive rest — leaves the machine AT a phase loop (e.g. implementLoop), then
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
export function phaseLoopOf(wf: WorkflowName, value: string): PhaseName | undefined {
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


/** Whether a workflow's arc ends by opening a PR — true when a phase carries the Open-PR gate (both arcs do: full's `finish`, short's `finish`). */
export function opensPr(workflow: WorkflowName): boolean {
  return phasesOf(workflow).some((p) => p.gate?.state === 'openPrGate');
}

/** The run-complete line, workflow-aware — only a PR-opening arc claims a PR. */
export function completionLine(workflow: WorkflowName): string {
  return opensPr(workflow) ? 'run complete — the PR is open' : 'run complete';
}

/** One line describing why the run stopped — the notification body. */
export function describeStop(state: RunState, done: boolean): string {
  if (done) return completionLine(workflowOf(state));
  const machineState = state.machineState ?? '';
  if (state.pendingQuestion && machineState.includes('FlagWait')) {
    return `question queued: ${state.pendingQuestion.question}`;
  }
  const gatePhase = phaseOfGateState(workflowOf(state), machineState);
  if (gatePhase) return gateOf(workflowOf(state), gatePhase).ready;
  return `stopped at ${machineState}`;
}


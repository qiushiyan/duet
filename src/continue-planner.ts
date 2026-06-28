import { interactiveContinueAction, validateInteractiveCrossing } from './harness/lifecycle.ts';
import type { HumanEvent, RunPosition } from './harness/lifecycle.ts';
import { contractAuthorPhaseOf, phaseOfGateState } from './phases.ts';
import type { PhaseName } from './phases.ts';
import { gateAttended, workflowOf } from './run-store.ts';
import type { RunState } from './run-store.ts';

/**
 * `duet continue`'s decision, pure and lifted out of the action so it is testable
 * without spawning a process (no `_drive`, editor, or git). It generalizes the
 * `takeoverPlan` precedent in cli.ts: the action probes the world, hands the
 * planner already-resolved facts, and executes the returned `ContinueAction`.
 * All I/O — `resolveRun`, the snapshot load, `stageContinueText`,
 * `freezeContractAt`, `spawnDrive` — stays in the thin executor.
 */

export type ContinueEventType = 'approve' | 'reject' | 'answer';

/**
 * The restored-machine facts the headless branch reads, extracted from the
 * snapshot actor by the action so the planner stays plain data-in/data-out. A
 * `null` restored bundle means no snapshot was persisted yet.
 */
export interface RestoredFacts {
  /** `restored.value` — the machine state name (string) or a nested value object. */
  value: unknown;
  /** `restored.status` — `'active' | 'done' | …`. */
  status: string;
  /** `restored.hasTag('gate')` — whether the parked state is a gate (vs a flag-wait). */
  hasGateTag: boolean;
  /** `restored.can({ type: 'human.<event>' })` per event — the crossing legality. */
  canApprove: boolean;
  canReject: boolean;
  canAnswer: boolean;
}

/** The facts the action gathers (all probing done) and hands the pure planner. */
export interface ContinueFacts {
  /** The marker/snapshot-derived position, probed after the live-driver guard cleared. */
  position: RunPosition;
  /** The single decision flag folded from --approve/--reject/--answer (and their file forms). */
  eventType?: ContinueEventType;
  /** Whether --headless was passed. */
  headless: boolean;
  /** The restored-machine facts (headless host only); `null` when no snapshot exists. */
  restored: RestoredFacts | null;
}

/**
 * The decision `continue`'s action executes. The interactive crossing is ONE
 * action: the executor always stages text → freezes (when `freezeContractPhase`
 * is set) → `crossInteractive` → then branches on `after` (`'handoff'` spawns the
 * detached driver, `'inline'` rests on the connected session).
 */
export type ContinueAction =
  | { kind: 'interactive-cross'; event: HumanEvent; after: 'inline' | 'handoff'; freezeContractPhase?: PhaseName }
  | { kind: 'interactive-drop-headless' }
  | { kind: 'interactive-show-status' }
  | { kind: 'crash-recover'; resumeEvent?: 'approve' | 'answer' }
  | { kind: 'preauth-recover' }
  | { kind: 'gate-decision'; eventType: ContinueEventType }
  | { kind: 'show-status' }
  | { kind: 'fail'; message: string };

export function continuePlanner(state: RunState, facts: ContinueFacts): ContinueAction {
  const { position, eventType, headless, restored } = facts;

  // Stage 1: the interactive host — the connected session is the orchestrator.
  // Runs before the snapshot validation below, because the run's first gate has
  // no machine snapshot until crossInteractive persists one.
  if (state.orchestrationHost === 'interactive') {
    if (!eventType) {
      if (headless) {
        // bare --headless with no decision is a mid-phase drop to the headless
        // driver. At a gate/flag the human owes a decision first, not a drop.
        if (position.kind === 'gate' || position.kind === 'flag') {
          return {
            kind: 'fail',
            message: `the run is parked at its ${position.kind} — cross it with --headless --approve/--reject (a gate) or --answer (a flag); bare --headless is only for a mid-phase drop.`,
          };
        }
        return { kind: 'interactive-drop-headless' };
      }
      return { kind: 'interactive-show-status' };
    }
    const invalid = validateInteractiveCrossing(position, eventType);
    if (invalid) return { kind: 'fail', message: `run ${state.runId} ${invalid}.` };
    // Validation passing means the position is a gate or flag — both carry a phase.
    if (position.kind !== 'gate' && position.kind !== 'flag') {
      // Unreachable: validateInteractiveCrossing returns undefined only for gate/flag.
      return { kind: 'interactive-show-status' };
    }
    const phase = position.phase;
    const after = interactiveContinueAction(workflowOf(state), phase, eventType, headless);
    // Freeze the acceptance contract before an approve crosses its freeze gate —
    // the contract author phase, the only phase where freezeContractAt does work
    // (it no-ops elsewhere), so the executor freezes only when this is set.
    const freezeContract = eventType === 'approve' && phase === contractAuthorPhaseOf(workflowOf(state));
    return {
      kind: 'interactive-cross',
      event: { type: `human.${eventType}` },
      after,
      ...(freezeContract ? { freezeContractPhase: phase } : {}),
    };
  }

  // Headless host.
  // A crashed-mid-phase run with no decision: re-enter from the transcripts,
  // re-uttering the crossing the run state already evidences.
  if (position.kind === 'crashed' && !eventType) {
    return { kind: 'crash-recover', ...(position.resumeEvent ? { resumeEvent: position.resumeEvent } : {}) };
  }
  // Crashed before the first quiescent stop (or any no-snapshot run): there is
  // nothing restored to validate a gate decision against.
  if (!restored) {
    return {
      kind: 'fail',
      message: 'this run has no gate to act on (it stopped mid-phase) — rerun without flags to let it pick up from the transcripts',
    };
  }
  // A snapshot parked at a pre-authorized gate means the driver died after
  // reaching it but before the next attended stop — re-enter; it auto-crosses.
  const restoredGatePhase = typeof restored.value === 'string' ? phaseOfGateState(workflowOf(state), restored.value) : undefined;
  if (!eventType && restoredGatePhase && !gateAttended(state, restoredGatePhase) && restored.status !== 'done') {
    return { kind: 'preauth-recover' };
  }
  if (!eventType) return { kind: 'show-status' };
  // Validate the event against the restored state before committing side effects.
  if (restored.status === 'done') return { kind: 'fail', message: `run ${state.runId} is complete — nothing to continue` };
  const can = eventType === 'approve' ? restored.canApprove : eventType === 'reject' ? restored.canReject : restored.canAnswer;
  if (!can) {
    return {
      kind: 'fail',
      message:
        `--${eventType} is not valid at ${JSON.stringify(restored.value)} — ` +
        (restored.hasGateTag ? 'this is a gate: use --approve or --reject "<feedback>"' : 'a question is queued: use --answer "<text>"'),
    };
  }
  return { kind: 'gate-decision', eventType };
}

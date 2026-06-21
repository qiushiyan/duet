import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { PhaseName } from '../phases.ts';
import type { WorkerProvider, WorkerRole, WorkerTurn } from '../providers/types.ts';
import {
  clearPendingTurn,
  clearTurnActive,
  loadRunState,
  markPendingTurn,
  markTurnActive,
  markWorkerDispatched,
  settlePendingTurn,
} from '../run-store.ts';
import type { RunState } from '../run-store.ts';
import { renderTurnResult, settleTurn, startHeartbeat } from './tools.ts';

/**
 * The interactive host's pending-turn engine — what makes send_prompt async.
 * A deep module: behind four methods it hides the background promise, the
 * heartbeat, the durable settle, and the lease fence, so the tool handlers
 * (tools.ts) and the run-scoped server (mcp-server.ts) never touch any of them.
 *
 * It calls the SAME three lifecycle functions a blocking send_prompt does
 * (startHeartbeat / settleTurn / renderTurnResult), only spread across time:
 * startHeartbeat + launch at dispatch, settleTurn when the worker promise
 * resolves, renderTurnResult at collect. Every operation reads FRESH disk state
 * — the dispatcher outlives the tool call that dispatched a turn, so a stale
 * closed-over copy would resume the wrong session or commit against an old
 * round count.
 *
 * The background lifecycle is NON-THROWING end to end — literally total on every
 * exit: the synchronous dispatch setup is fenced (a faulting durable write or
 * heartbeat becomes a collectible `failed` turn, not a stuck live `running`
 * record), the launch rides Promise.resolve().then (a synchronous runTurn throw
 * joins the async rejection path), the lease gate goes through a non-throwing
 * leaseHeld wrapper (a faulting lease check reads as "not held", so finalize and
 * failSafe cannot throw on it), any launch/finalize fault is caught into a
 * terminal failSafe that flips the in-memory record `failed` (so the role is
 * never stranded `running` — check_turns / `duet status --wait` read `running`
 * as "still going"), the heartbeat is stopped in a finally, and collect isolates
 * each record so one role's fault never aborts the batch or half-collects
 * another. A stranded record under AFK would hang supervision forever, so this
 * boundary earns its keep.
 *
 * Lifetime is PHASE-scoped (rebuilt at a phase boundary by the run-scoped
 * server, mcp-server.ts), which is safe because the phase-exit gate forbids
 * advancing with a pending turn — so the old dispatcher is always empty when
 * `ctx` rebuilds.
 */

export type PendingStatus = 'running' | 'ready' | 'failed';

interface PendingRecord {
  meta: { role: WorkerRole; tag: string; isReviewRound: boolean };
  status: PendingStatus;
  /** The settled outcome, present once status leaves `running` (for collect). */
  outcome?: WorkerTurn | Error;
}

export interface TurnDispatcher {
  /** Fire a worker turn into the background and return at once (record → running). */
  dispatch(args: { role: WorkerRole; tag: string; body: string; isReviewRound: boolean }): void;
  /** This role's live record status, or undefined when it owns no live record. */
  statusOf(role: WorkerRole): PendingStatus | undefined;
  /** Render + clear every settled (ready/failed) record; leaves running ones. */
  collectReady(): Array<{ role: WorkerRole; result: CallToolResult }>;
  /** Whether any live record is non-collected (running/ready/failed). */
  hasPending(): boolean;
}

export interface TurnDispatcherDeps {
  /** A run handle (cwd/runId); the dispatcher loads fresh disk state per operation. */
  state: RunState;
  phase: PhaseName;
  /** The phase's review-round backstop cap — for renderTurnResult's near-cap nudge. */
  cap: number;
  providers: Record<WorkerRole, WorkerProvider>;
  log: (line: string) => void;
  home?: string;
  /**
   * Whether this server still holds the single-writer lease. The SECOND lease
   * boundary: toolsFor (mcp-server.ts) gates every tool call, but a background
   * settle is not a tool call, so the dispatcher fences it here — a superseded
   * server's settle is inert and writes nothing over the live run.
   */
  holdsLease: () => boolean;
}

export function createTurnDispatcher(deps: TurnDispatcherDeps): TurnDispatcher {
  const { state, phase, cap, providers, log, home, holdsLease } = deps;
  const records = new Map<WorkerRole, PendingRecord>();

  // A NON-THROWING lease check. The production thunk (mcp-server.ts) does a
  // loadRunState, which can fault — and finalize/failSafe both gate on it, so a
  // thrown check would re-introduce the very unhandled rejection this boundary
  // exists to prevent. A check that throws is logged and treated as "not held",
  // which is the safe reading: an unverifiable lease means write nothing, and a
  // superseded server already leaves its record for the new owner to handle as
  // an orphan. This makes finalize and failSafe literally unable to throw on the
  // lease gate.
  const leaseHeld = (): boolean => {
    try {
      return holdsLease();
    } catch (err) {
      log(`[check_turns] lease check faulted (${err instanceof Error ? err.message : String(err)}) — treating as not held`);
      return false;
    }
  };

  // Flip the live in-memory record off `running` to `failed` — a Map write, so
  // it cannot throw. This is the ONE step that unsticks a role no matter what
  // faulted (disk, lease check), so statusOf/collectReady stop reporting
  // `running` and check_turns can drain it. Disk writes are a SEPARATE,
  // lease-gated concern (the caller decides); this touches only memory.
  const markRecordFailed = (role: WorkerRole, err: Error): void => {
    const rec = records.get(role);
    if (rec) {
      rec.status = 'failed';
      rec.outcome = rec.outcome ?? err;
    }
  };

  // The lifecycle's terminal backstop: the launch, the synchronous dispatch
  // setup, or a finalize step threw — a disk fault, say. A role must NEVER be
  // left stranded `running`: check_turns and `duet status --wait` both read
  // `running` as "still going", so a stuck record hangs them forever under AFK.
  // The in-memory flip cannot throw, so it unsticks the role even if disk writes
  // keep faulting; the disk flip + activeTurns clear are best-effort and
  // lease-gated through the non-throwing leaseHeld (a superseded server still
  // writes nothing). Logs rather than rethrowing, so nothing escapes as an
  // unhandled rejection — failSafe is itself total.
  const failSafe = (role: WorkerRole, err: unknown): void => {
    const detail = err instanceof Error ? err.message : String(err);
    log(`[check_turns] ${role} turn lifecycle failed (${detail}) — marking it failed so the role is not stranded`);
    markRecordFailed(role, err instanceof Error ? err : new Error(detail));
    if (!leaseHeld()) return; // superseded (or unverifiable) — write nothing; the in-memory flip already unstuck us
    try {
      settlePendingTurn(state, role, 'failed');
    } catch {
      // disk still faulting — the in-memory flip above already unstuck the role
    }
    try {
      clearTurnActive(state, role);
    } catch {
      // best-effort hint cleanup
    }
  };

  return {
    dispatch({ role, tag, body, isReviewRound }) {
      const meta = { role, tag, isReviewRound };
      records.set(role, { meta, status: 'running' });
      // The synchronous dispatch setup is itself fenced. Its durable writes and
      // the heartbeat all touch disk/timers and can fault; if any did, the
      // background chain below would never be installed and the live record
      // would be left a stuck `running` — so a setup throw is caught, any
      // heartbeat already started is stopped, and failSafe turns the role into a
      // collectible `failed` turn instead. The noop init keeps stopHeartbeat
      // callable whether or not startHeartbeat was reached.
      let stopHeartbeat: () => void = () => {};
      try {
        // Dispatch-time durable writes. Already lease-gated: toolsFor ran
        // holdsLease() synchronously immediately before this handler, with no
        // await between, so these need no inner re-check.
        markWorkerDispatched(state); // one-way branch-fixed flag
        markPendingTurn(state, role, tag); // pending record → running
        markTurnActive(state, role, tag); // the doctor running/idle health hint
        // Build RunTurnOptions from FRESH disk state: a later turn's resume
        // session id must reflect what prior settles persisted, not a stale copy.
        const fresh = loadRunState(state.cwd, state.runId);
        const startedAt = Date.now();
        stopHeartbeat = startHeartbeat(
          { state: fresh, log, ...(home !== undefined ? { home } : {}) },
          { role, tag, startedAt },
        );
        const stop = stopHeartbeat;
        // The settled half: durable bookkeeping (success) or infra-failure log
        // (failure), then flip the in-memory record. The SECOND lease boundary
        // (see deps.holdsLease, via the non-throwing leaseHeld): when the lease
        // is not held, the settle writes NOTHING to disk — a genuinely
        // superseded server must leave its disk record `running` for the new
        // owner to orphan-handle. But it still flips the IN-MEMORY record off
        // `running`, so a LIVE server whose lease check merely faulted does not
        // strand the role (statusOf/collectReady can then drain it via
        // check_turns). Harmless on a truly superseded server: its tool calls are
        // SUPERSEDED-refused, so this in-memory record is never read there.
        const finalize = (outcome: WorkerTurn | Error): void => {
          if (!leaseHeld()) {
            markRecordFailed(role, outcome instanceof Error ? outcome : new Error('lease not held before settle'));
            return;
          }
          settleTurn({ state: loadRunState(state.cwd, state.runId), phase, providers, log }, meta, outcome);
          settlePendingTurn(state, role, outcome instanceof Error ? 'failed' : 'ready');
          const rec = records.get(role);
          if (rec) {
            rec.status = outcome instanceof Error ? 'failed' : 'ready';
            rec.outcome = outcome;
          }
        };
        // The whole background lifecycle is non-throwing. Promise.resolve().then
        // so a SYNCHRONOUS runTurn throw lands on the same rejection path as an
        // async one; the terminal catch turns any launch- or finalize-time fault
        // into a safe terminal state (failSafe) instead of an unhandled rejection
        // plus a record stranded `running`. stopHeartbeat rides a finally so the
        // 5-minute interval can never leak, on any exit.
        Promise.resolve()
          .then(() => providers[role].runTurn({ prompt: body, sessionId: fresh.workerSessions[role], readOnly: role === 'reviewer', cwd: fresh.cwd }))
          .then(
            (turn) => finalize(turn),
            (err) => finalize(err instanceof Error ? err : new Error(String(err))),
          )
          .catch((err) => failSafe(role, err))
          .finally(() => stop());
      } catch (err) {
        // Synchronous setup faulted before the background chain was installed.
        stopHeartbeat();
        failSafe(role, err);
      }
    },

    statusOf(role) {
      return records.get(role)?.status;
    },

    collectReady() {
      const out: Array<{ role: WorkerRole; result: CallToolResult }> = [];
      for (const [role, rec] of [...records]) {
        if (rec.status === 'running') continue;
        // Per-record isolation (the deletion path is part of the non-throwing
        // lifecycle): render → clear → delete → report, for THIS role only,
        // inside a guard. A disk fault rendering or clearing one role must not
        // abort the batch (which would silently drop the already-rendered
        // results of earlier roles) nor leave a half-collected split (cleared on
        // disk but never delivered). A record that throws here is left intact —
        // disk uncleared, in-memory kept — so it stays collectible on the next
        // call rather than vanishing. report only AFTER the disk clear succeeds.
        try {
          const result = renderTurnResult(
            { state: loadRunState(state.cwd, state.runId), phase },
            { role, isReviewRound: rec.meta.isReviewRound, cap },
            rec.outcome as WorkerTurn | Error,
          );
          clearPendingTurn(state, role); // re-opens the role for the next send_prompt
          records.delete(role);
          out.push({ role, result });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          log(`[check_turns] could not collect the ${role} turn (${detail}) — left intact, collectible on the next check_turns`);
        }
      }
      return out;
    },

    hasPending() {
      return records.size > 0;
    },
  };
}

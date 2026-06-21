import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { PhaseName } from '../phases.ts';
import type { WorkerProvider, WorkerRole, WorkerTurn } from '../providers/types.ts';
import {
  clearPendingTurn,
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

  return {
    dispatch({ role, tag, body, isReviewRound }) {
      const meta = { role, tag, isReviewRound };
      records.set(role, { meta, status: 'running' });
      // Dispatch-time durable writes. Already lease-gated: toolsFor ran
      // holdsLease() synchronously immediately before this handler, with no
      // await between, so these need no inner re-check.
      markWorkerDispatched(state); // one-way branch-fixed flag
      markPendingTurn(state, role, tag); // pending record → running
      markTurnActive(state, role, tag); // the doctor running/idle health hint
      // Build RunTurnOptions from FRESH disk state: a later turn's resume session
      // id must reflect what prior settles persisted, not a stale ctx copy.
      const fresh = loadRunState(state.cwd, state.runId);
      const startedAt = Date.now();
      const stopHeartbeat = startHeartbeat(
        { state: fresh, log, ...(home !== undefined ? { home } : {}) },
        { role, tag, startedAt },
      );
      const onSettle = (outcome: WorkerTurn | Error): void => {
        stopHeartbeat();
        // The second lease boundary (see deps.holdsLease): a superseded server's
        // settle writes nothing.
        if (!holdsLease()) return;
        settleTurn({ state: loadRunState(state.cwd, state.runId), phase, providers, log }, meta, outcome);
        settlePendingTurn(state, role, outcome instanceof Error ? 'failed' : 'ready');
        const rec = records.get(role);
        if (rec) {
          rec.status = outcome instanceof Error ? 'failed' : 'ready';
          rec.outcome = outcome;
        }
      };
      providers[role]
        .runTurn({ prompt: body, sessionId: fresh.workerSessions[role], readOnly: role === 'reviewer', cwd: fresh.cwd })
        .then(onSettle, (err) => onSettle(err instanceof Error ? err : new Error(String(err))));
    },

    statusOf(role) {
      return records.get(role)?.status;
    },

    collectReady() {
      const out: Array<{ role: WorkerRole; result: CallToolResult }> = [];
      for (const [role, rec] of [...records]) {
        if (rec.status === 'running') continue;
        out.push({
          role,
          result: renderTurnResult(
            { state: loadRunState(state.cwd, state.runId), phase },
            { role, isReviewRound: rec.meta.isReviewRound, cap },
            rec.outcome as WorkerTurn | Error,
          ),
        });
        clearPendingTurn(state, role); // re-opens the role for the next send_prompt
        records.delete(role);
      }
      return out;
    },

    hasPending() {
      return records.size > 0;
    },
  };
}

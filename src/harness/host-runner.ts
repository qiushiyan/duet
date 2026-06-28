import { loadRunState, saveRunState } from '../run-store.ts';
import type { RunState } from '../run-store.ts';
import { retryDecision } from '../worker-health.ts';
import type { ErrorClass } from '../worker-health.ts';
import { markerToEvent } from './phase-events.ts';
import type { PhaseEvent } from './phase-events.ts';
import type { PhaseName } from '../phases.ts';

/**
 * What the machine's `phaseDriver` actor hands each host to drive one phase:
 * which run, where, which phase. Owned here (the seam), not by either adapter —
 * both `driver.ts` and `stdio-host.ts` import it from this module.
 */
export interface PhaseInput {
  runId: string;
  cwd: string;
  phase: PhaseName;
}

/**
 * The host-neutral phase run loop. `runPhase` (the in-process Agent SDK driver,
 * driver.ts) and `runPhaseOverStdio` (the stdio MCP host, stdio-host.ts) are the
 * two adapters of the machine's `phaseDriver` actor; both used to re-derive the
 * same four rails around their own turn mechanics. Those rails live here now,
 * once, behind the small `PhaseHost` seam — what legitimately differs between
 * the hosts (how a turn is driven, how a failure is classified, whether it
 * retries) is exactly the seam, and nothing more.
 *
 * The four shared rails:
 *   A. entry marker-replay   — a terminal marker for THIS phase that survived a
 *      crash before the machine could transition is re-emitted without re-running
 *      the session (the packet it carries was persisted atomically with it);
 *   B. nudge-once            — a turn that ends without a terminal call gets
 *      exactly one nudge before it is treated as stuck;
 *   C. twice-ended → flag    — persistent silence becomes an actionable question;
 *   D. crash → flag (+retry) — a caught infra failure is classified and, iff the
 *      host is retryable, auto-retried through its own session-resume path; else
 *      it lands the run on a queued question (crash = flag, docs/engineering.md).
 */

/**
 * The outcome of driving the orchestrator for ONE turn, from the host's view:
 *  - `advanced` — the orchestrator called advance_phase (its terminal marker is
 *    `advance`);
 *  - `flagged`  — it called ask_human (marker = `flag`), OR the host self-flagged
 *    the turn (the in-process abnormal-subtype / budget stop, which queues its
 *    own pendingQuestion);
 *  - `continue` — the turn ended with no terminal decision, so it is
 *    nudge-eligible.
 * Each host reads its own terminal signal inside `driveTurn` — the in-process
 * host from the shared in-memory state its tool handlers mutate, the stdio host
 * by reloading the marker the subprocess wrote to disk — so the runner itself
 * never has to know which host it is driving.
 */
export type TurnOutcome = 'advanced' | 'flagged' | 'continue';

/** A host's live orchestrator session for one phase attempt. */
export interface HostedSession {
  /**
   * Drive one orchestrator turn — `phase` for the phase turn, then `nudge` for
   * the single nudge the runner issues if the phase turn did not terminate.
   */
  driveTurn(kind: 'phase' | 'nudge'): Promise<TurnOutcome>;
  /** Release the session's host resources (the stdio transport; a no-op in-process). */
  close(): Promise<void>;
}

/**
 * What a host supplies so the shared runner can drive it. The two real adapters
 * are the in-process Agent SDK driver (driver.ts) and the stdio MCP host
 * (stdio-host.ts); a third, scripted adapter lives in the tests
 * (`tests/host-runner.test.ts`) — so the rails are exercised through a trivial
 * fake session instead of a full SDK or a real `_mcp` subprocess.
 */
export interface PhaseHost {
  /**
   * Open a session for this attempt — consume staged input and build the prompt
   * (in-process), or connect the transport (stdio). Re-invoked per retry
   * iteration. Contract: on failure it MUST release any resource it acquired
   * before throwing, since the runner can only `close()` a session it received.
   */
  openSession(input: PhaseInput): Promise<HostedSession>;
  /**
   * Classify a caught infra failure for the flag's errorClass. The deliberate
   * asymmetry lives here (docs/engineering.md §"Infra classification & opt-in
   * retry"): the in-process driver passes the staleness-aware `classifyInfraError`,
   * the stdio host the bare `classifyError` taxonomy — it does not retry, so it
   * does not need the transcript refinement.
   */
  classifyFailure(state: RunState, detail: string): ErrorClass;
  /**
   * `true` ⇒ a transient infra class may auto-retry in-process (the headless
   * driver, reading `state.retryInfra` / `state.retryState`). `false` ⇒
   * classify-and-flag only (the stdio/interactive host, where a human is present
   * to resume).
   */
  retryable: boolean;
}

/**
 * Drive one phase to its terminal `PhaseEvent`, host-agnostically — the four
 * rails (A–D above) around a `PhaseHost`'s turn mechanics. Behavioral parity
 * across hosts is the point: the in-process and stdio hosts differ only behind
 * the seam.
 */
export async function runHostedPhase(input: PhaseInput, host: PhaseHost): Promise<PhaseEvent> {
  const { runId, cwd, phase } = input;

  // A — crash-before-transition replay. The marker is read off disk, so this is
  // the same channel whether the deciding session was in-process (its handler
  // saved it) or the stdio subprocess (it wrote it across the boundary).
  const entry = markerToEvent(loadRunState(cwd, runId).terminalMarker, phase);
  if (entry) return concludeEpisode(cwd, runId, entry);

  for (;;) {
    let session: HostedSession | undefined;
    try {
      session = await host.openSession(input);
      let outcome = await session.driveTurn('phase');
      if (outcome === 'continue') {
        // B — exactly one nudge to the same session; C if it is still silent.
        outcome = await session.driveTurn('nudge');
        if (outcome === 'continue') outcome = flagTwiceEnded(cwd, runId, phase);
      }
      const event: PhaseEvent = outcome === 'advanced' ? { type: 'phase.advance' } : { type: 'phase.flag' };
      return concludeEpisode(cwd, runId, event);
    } catch (err) {
      // First-terminal-wins: a terminal decision persisted just before the
      // session threw IS this phase's outcome (markers are phase-scoped), so a
      // late infra error never overwrites it into a false flag or a spurious
      // retry. Read off disk — true in-process (the handler saved it) and across
      // the stdio boundary (the subprocess wrote it).
      const decided = markerToEvent(loadRunState(cwd, runId).terminalMarker, phase);
      if (decided) return concludeEpisode(cwd, runId, decided);

      const detail = err instanceof Error ? err.message : String(err);
      console.log(`[driver] ✗ ${phase} phase crashed: ${detail}`);
      const state = loadRunState(cwd, runId);
      const errorClass = host.classifyFailure(state, detail);
      if (host.retryable) {
        // The retry policy is the single `retryDecision` mechanism: default-off,
        // transient classes back off and retry, auth-once, the rest flag,
        // exhaustion always flags. Only a retryable host consults it.
        const decision = retryDecision(errorClass, state.retryState, state.retryInfra ?? 0);
        if (decision.action === 'retry') {
          state.retryState = decision.nextRetryState;
          saveRunState(state);
          console.log(
            `[driver] infra ${errorClass} — auto-retry ${decision.nextRetryState.attempts}/${state.retryInfra} after ${Math.round(decision.delayMs / 1000)}s`,
          );
          await new Promise((resolve) => setTimeout(resolve, decision.delayMs));
          // Retry = resume: openSession re-consumes nothing (the staged input was
          // consumed and persisted on attempt 0), so the resumed turn never replays.
          continue;
        }
        flagInfra(cwd, runId, phase, detail, decision.errorClass);
        return { type: 'phase.flag' };
      }
      flagInfra(cwd, runId, phase, detail, errorClass);
      return { type: 'phase.flag' };
    } finally {
      // Only a session the host actually returned is closed; an openSession that
      // threw is responsible for releasing its own resources (the contract above).
      await session?.close();
    }
  }
}

/**
 * Conclude a phase's retry episode: a terminal/clean outcome ends it, so reset
 * the per-episode retry budget (persisted across re-spawns only while an episode
 * is live). The single concluding path behind every terminal exit — entry
 * replay, a marker honored in the catch, and a clean driveTurn outcome — so the
 * cleanup can't drift between them. Reload-mutate-save: it preserves the gate
 * packet / queued question a terminal turn just wrote, touching only retryState
 * (never the terminal marker — its deliver-before-clear lifecycle is the
 * machine's, unchanged).
 */
function concludeEpisode(cwd: string, runId: string, event: PhaseEvent): PhaseEvent {
  const state = loadRunState(cwd, runId);
  if (state.retryState) {
    delete state.retryState;
    saveRunState(state);
  }
  return event;
}

/**
 * Queue an infra-caused question iff none is already queued — the crash = flag /
 * first-question-wins guard shared by the twice-ended and crash paths. An
 * already-queued question (the orchestrator's own ask_human, a budget stop, an
 * abnormal-subtype self-flag) is never overwritten. Reload-mutate-save so it can't
 * clobber a question another path wrote; the two callers below own only their text.
 */
function queueInfraQuestion(cwd: string, runId: string, question: string, errorClass: ErrorClass): void {
  const state = loadRunState(cwd, runId);
  if (!state.pendingQuestion) {
    state.pendingQuestion = { question, cause: 'infra', errorClass };
    saveRunState(state);
  }
}

/**
 * Rail C — the orchestrator twice ended its turn (the phase turn and the one
 * nudge) without advancing or asking, so the run is stuck.
 */
function flagTwiceEnded(cwd: string, runId: string, phase: PhaseName): TurnOutcome {
  queueInfraQuestion(
    cwd,
    runId,
    `The ${phase} phase's orchestrator twice ended its turn without advancing the phase or asking a question — the run is stuck. Run duet doctor for per-role health, or check the orchestrator log; answer with how to proceed.`,
    'unknown',
  );
  return 'flagged';
}

/**
 * Rail D's escalation — a caught infra failure lands the run on an actionable
 * queued question, never a silent state (crash = flag). The log pointer stays
 * host-neutral ("the run's logs"): this loop is shared, so it can't name one
 * host's log file.
 */
function flagInfra(cwd: string, runId: string, phase: PhaseName, detail: string, errorClass: ErrorClass): void {
  queueInfraQuestion(
    cwd,
    runId,
    `The ${phase} phase failed at the infrastructure layer (${detail}). Run duet doctor for per-role health, or check the run's logs; answer with how to proceed — the orchestrator session resumes from its last completed turn.`,
    errorClass,
  );
}

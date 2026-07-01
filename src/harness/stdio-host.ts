import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fromCallback } from 'xstate';
import type { EventObject } from 'xstate';
import { loadRunState } from '../run-store.ts';
import { classifyError } from '../worker-health.ts';
import { runHostedPhase } from './host-runner.ts';
import type { HostedSession, PhaseHost, PhaseInput, TurnOutcome } from './host-runner.ts';
import { duetMachine } from './machine.ts';
import { markerToEvent } from './phase-events.ts';
import type { PhaseEvent } from './phase-events.ts';

/**
 * The stdio host — the SDK-over-stdio sibling of the in-process driver, and the
 * stdio `PhaseHost` adapter over the shared run loop (`runHostedPhase`,
 * src/harness/host-runner.ts). `openSession` connects an orchestrator client to a
 * real `duet _mcp <runId> <phase>` subprocess (the kernel tool server); each
 * `driveTurn` runs the external orchestrator over that boundary, then reads the
 * terminal marker the subprocess wrote and maps it to a TurnOutcome — the same
 * channel the in-process driver uses (src/harness/phase-events.ts), never
 * tool-result-text scraping.
 *
 * Behavioral parity with the in-process driver is the point, and the four run-loop
 * rails it shares (entry marker-replay, nudge-once, the twice-ended flag, crash →
 * flag) now live ONCE in host-runner.ts; this module supplies only what differs:
 * how a turn is driven (over the stdio boundary), how a failure is classified
 * (the bare `classifyError` taxonomy — it does not auto-retry, so it needs no
 * transcript refinement), and `retryable: false` (a human is present on the
 * interactive host, so it classifies and hands back rather than retrying). This is
 * the seam Stage 1's interactive host slots into; production `_drive` stays
 * in-process and is unchanged.
 */

const CLI_ENTRY = fileURLToPath(new URL('../cli.ts', import.meta.url));

export interface OrchestrateContext {
  /** The MCP client wired to the kernel subprocess — call the orchestrator tools through it. */
  client: Client;
  /** The phase being driven (the orchestrator-client seam is phase-aware). */
  phase: PhaseInput['phase'];
  /**
   * Which orchestrator turn this is for the phase: 0 is the phase turn, 1 is
   * the single nudge the run loop issues when turn 0 ended without a terminal
   * call (advance_phase / ask_human) — the cross-boundary analog of the
   * in-process driver's nudge-once. A live Stage-1 host sends the phase prompt on
   * attempt 0 and the nudge prompt to the same session on attempt 1; how it
   * delivers that nudge is the host's concern, not the seam's.
   */
  attempt: number;
  /** Kill the kernel subprocess — for exercising boundary failure. */
  killPeer: () => void;
}

/**
 * The orchestrator-client seam: drive the run by calling tools over `client`.
 * In Stage 1 this is the interactive Claude Code session; in Stage-0 tests it
 * is a scripted client (the same role the RunOrchestratorTurn seam plays
 * in-process).
 */
export type Orchestrate = (ctx: OrchestrateContext) => Promise<void>;

export async function runPhaseOverStdio(input: PhaseInput, orchestrate: Orchestrate): Promise<PhaseEvent> {
  return runHostedPhase(input, makeStdioHost(orchestrate));
}

/**
 * The stdio `PhaseHost`. The run loop (host-runner.ts) owns the rails; this
 * supplies the per-turn mechanics over the MCP boundary plus the two facts that
 * make it the interactive-side host: `retryable: false` (a human resumes) and a
 * bare-taxonomy `classifyFailure` (docs/engineering.md §"Infra classification &
 * bounded auto-retry"). Boundary failure becomes the run loop's crash = flag: a dead
 * peer or transport error thrown out of `connect`/`orchestrate` is caught there
 * and persisted as an actionable question, so crash = flag survives the boundary.
 */
function makeStdioHost(orchestrate: Orchestrate): PhaseHost {
  return {
    retryable: false,
    classifyFailure: (_state, detail) => classifyError(detail),
    async openSession({ runId, cwd, phase }): Promise<HostedSession> {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [CLI_ENTRY, '_mcp', runId, phase],
        cwd,
        stderr: 'inherit', // the subprocess narrates to its stderr; stdout is the JSON-RPC channel
      });
      const client = new Client({ name: 'duet-stdio-host', version: '0.1.0' });
      const killPeer = () => {
        if (transport.pid) {
          try {
            process.kill(transport.pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }
      };
      try {
        await client.connect(transport);
      } catch (err) {
        // openSession contract (host-runner.ts): release the transport before
        // propagating, since the run loop only closes a session it received. The
        // throw becomes the run loop's crash = flag.
        try {
          await transport.close();
        } catch {
          // best-effort; the child may already be gone
        }
        throw err;
      }
      return {
        async driveTurn(kind): Promise<TurnOutcome> {
          // The client stays connected across both turns, so attempt 1's nudge
          // continues the same session — the boundary analog of re-prompting in
          // place. A transport error here throws to the run loop's crash = flag.
          await orchestrate({ client, phase, attempt: kind === 'phase' ? 0 : 1, killPeer });
          // The subprocess persisted any terminal decision before its tool result
          // returned, so read it off disk (the in-process host reads shared memory).
          const event = markerToEvent(loadRunState(cwd, runId).terminalMarker, phase);
          return event ? (event.type === 'phase.advance' ? 'advanced' : 'flagged') : 'continue';
        },
        async close(): Promise<void> {
          try {
            await transport.close();
          } catch {
            // best-effort teardown; the child may already be gone
          }
        },
      };
    },
  };
}

/**
 * The duetMachine with its phase driver running over the stdio boundary instead
 * of in-process — the same machine.provide seam scriptedMachine and the real
 * in-process driver use, so the lifecycle (driveToQuiescence: park, persist,
 * gates_at auto-cross, deliver-before-clear marker handling) is reused unchanged.
 */
export function stdioPhaseMachine(orchestrate: Orchestrate): typeof duetMachine {
  return duetMachine.provide({
    actors: {
      phaseDriver: fromCallback<EventObject, PhaseInput>(({ input, sendBack }) => {
        runPhaseOverStdio(input, orchestrate)
          .then((event) => sendBack(event))
          .catch(() => sendBack({ type: 'phase.flag' }));
      }),
    },
  });
}

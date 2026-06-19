import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fromCallback } from 'xstate';
import type { EventObject } from 'xstate';
import { loadRunState, saveRunState } from '../run-store.ts';
import type { DriverInput } from './driver.ts';
import { duetMachine } from './machine.ts';
import { markerToEvent } from './phase-events.ts';
import type { PhaseEvent } from './phase-events.ts';

/**
 * The stdio host runner — the boundary owner, and the SDK-over-stdio sibling of
 * the in-process runPhase. It connects an orchestrator client to a real
 * `duet _mcp <runId> <phase>` subprocess (the kernel tool server), runs the
 * orchestrator to quiescence, then reads the persisted terminal marker the
 * subprocess wrote and resolves the phase.* event — the same channel the
 * in-process driver uses (src/harness/phase-events.ts), never tool-result-text
 * scraping. Behavioral parity with the in-process driver is the point, so it
 * mirrors both of that driver's pre-/post-session rails: the crash-before-
 * transition marker replay on entry, and nudge-once before flagging a silent
 * turn. It owns boundary failure: a dead peer (or any transport error) is
 * converted to a persisted question, so crash = flag survives the new process
 * boundary. This is the seam Stage 1's interactive host slots into; production
 * _drive stays in-process and is unchanged.
 */

const CLI_ENTRY = fileURLToPath(new URL('../cli.ts', import.meta.url));

export interface OrchestrateContext {
  /** The MCP client wired to the kernel subprocess — call the orchestrator tools through it. */
  client: Client;
  /** The phase being driven (the orchestrator-client seam is phase-aware). */
  phase: DriverInput['phase'];
  /**
   * Which orchestrator turn this is for the phase: 0 is the phase turn, 1 is
   * the single nudge the host issues when turn 0 ended without a terminal call
   * (advance_phase / ask_human) — the cross-boundary analog of the in-process
   * driver's nudge-once (src/harness/driver.ts). A live Stage-1 host sends the
   * phase prompt on attempt 0 and the nudge prompt to the same session on
   * attempt 1; how it delivers that nudge is the host's concern, not the seam's.
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

export async function runPhaseOverStdio(
  { runId, cwd, phase }: DriverInput,
  orchestrate: Orchestrate,
): Promise<PhaseEvent> {
  // Crash-before-transition replay — the mirror of the in-process driver
  // (src/harness/driver.ts): a terminal marker for THIS phase survived from a
  // session that decided before the machine could transition, so re-emit that
  // decision without re-running the external orchestrator turn (the packet it
  // carries was persisted atomically with it). A SPENT marker from the
  // crash-after-snapshot window was already cleared by the lifecycle's
  // spent-marker guard before any re-entry, so a marker still present here is
  // live — no supersede exception is needed (the in-process entry is identical).
  const replay = markerToEvent(loadRunState(cwd, runId).terminalMarker, phase);
  if (replay) return replay;

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

    // Nudge-once parity with the in-process driver (src/harness/driver.ts): an
    // orchestrator turn that ends without a terminal call is not yet a flag —
    // give it exactly one nudge, and only treat persistent silence as a flag.
    // attempt 0 is the phase turn; attempt 1 is the single nudge. The client
    // stays connected across both, so the nudge continues the same session
    // (the boundary analog of re-prompting in place). The terminal decision is
    // read off disk after each turn — the subprocess persisted it before its
    // tool result came back.
    for (let attempt = 0; attempt < 2; attempt++) {
      await orchestrate({ client, phase, attempt, killPeer });
      const event = markerToEvent(loadRunState(cwd, runId).terminalMarker, phase);
      if (event) return event;
    }

    // Twice ended over the boundary without a terminal call — stuck. Mirror the
    // in-process "twice ended" flag, persisting the same actionable question.
    const state = loadRunState(cwd, runId);
    if (!state.pendingQuestion) {
      state.pendingQuestion = {
        question: `The ${phase} phase's orchestrator twice ended its turn over the MCP boundary without advancing the phase or asking a question — the run is stuck. Check the logs and answer with how to proceed.`,
      };
      saveRunState(state);
    }
    return { type: 'phase.flag' };
  } catch (err) {
    // Boundary failure (dead peer, transport error) is this runner's crash=flag:
    // convert it to an actionable persisted question, never a silent state.
    const detail = err instanceof Error ? err.message : String(err);
    const state = loadRunState(cwd, runId);
    if (!state.pendingQuestion) {
      state.pendingQuestion = {
        question: `The ${phase} phase's orchestrator boundary failed (${detail}). The kernel or the orchestrator client died mid-turn; check driver.log and the orchestrator log, then answer with how to proceed — the session resumes from its last completed turn.`,
      };
      saveRunState(state);
    }
    return { type: 'phase.flag' };
  } finally {
    try {
      await transport.close();
    } catch {
      // best-effort teardown; the child may already be gone
    }
  }
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
      phaseDriver: fromCallback<EventObject, DriverInput>(({ input, sendBack }) => {
        runPhaseOverStdio(input, orchestrate)
          .then((event) => sendBack(event))
          .catch(() => sendBack({ type: 'phase.flag' }));
      }),
    },
  });
}

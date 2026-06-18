import { describe, expect } from 'vitest';
import { driveToQuiescence } from '../src/harness/lifecycle.ts';
import { runPhaseOverStdio, stdioPhaseMachine } from '../src/harness/stdio-host.ts';
import type { Orchestrate } from '../src/harness/stdio-host.ts';
import { listPendingSteers, loadRunState, saveRunState, stageSteer } from '../src/run-store.ts';
import { test } from './helpers/fixtures.ts';

/**
 * Behavioral parity over the boundary — the risk this work exists to retire.
 * The orchestrator's tools run in a REAL `duet _mcp` subprocess (a genuine
 * separate stdio peer), driven by a scripted MCP client; the kernel parks,
 * persists, and converts failure exactly as the in-process path does. The
 * client is the orchestrator-client seam (Stage 1 = the interactive session);
 * everything below it — the MCP transport, the subprocess, the kernel — is real.
 *
 * These spawn node subprocesses, so each test carries a generous timeout.
 */

const quiet = async () => {};
const TIMEOUT = 30_000;

const advanceFrame: Orchestrate = async ({ client }) => {
  await client.callTool({ name: 'advance_phase', arguments: { summary: 'direction over stdio', artifacts: [] } });
};

const textOf = (result: unknown): string =>
  ((result as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? '').join('\n');

describe('control events survive the stdio MCP boundary', () => {
  test(
    'advance_phase over stdio parks the run at the gate with the packet persisted',
    async ({ run }) => {
      const { snapshot, state } = await driveToQuiescence(run, undefined, {
        machine: stdioPhaseMachine(advanceFrame),
        notify: quiet,
      });
      expect.soft(snapshot.value).toBe('directionGate'); // parked, not crossed
      expect.soft(state.phaseSummaries.frame?.summary).toBe('direction over stdio');
      expect.soft(state.terminalMarker).toBeUndefined(); // cleared at quiescence (deliver-before-clear)
    },
    TIMEOUT,
  );

  test(
    'ask_human over stdio lands at the flag-wait with the question persisted',
    async ({ run }) => {
      const ask: Orchestrate = async ({ client }) => {
        await client.callTool({ name: 'ask_human', arguments: { question: 'scope over stdio?' } });
      };
      const { snapshot, state } = await driveToQuiescence(run, undefined, {
        machine: stdioPhaseMachine(ask),
        notify: quiet,
      });
      expect.soft(snapshot.value).toBe('frameFlagWait');
      expect.soft(state.pendingQuestion?.question).toBe('scope over stdio?');
    },
    TIMEOUT,
  );

  test(
    'the cooperative-pause result crosses the boundary and turn-ending steer suppression holds',
    async ({ projectDir, run }) => {
      stageSteer(run, 'staged before the terminal call');
      let result: unknown;
      const event = await runPhaseOverStdio({ runId: run.runId, cwd: projectDir, phase: 'frame' }, async ({ client }) => {
        result = await client.callTool({ name: 'advance_phase', arguments: { summary: 's', artifacts: [] } });
      });

      expect.soft(event).toEqual({ type: 'phase.advance' });
      const text = textOf(result);
      expect.soft(text).toContain('End your turn'); // the nudge reached the client across the transport
      expect.soft(text).not.toContain('<human_steer'); // suppressed on a turn-ending result
      // The steer stayed pending (rides the next prompt) — not consumed by the dying turn.
      expect.soft(listPendingSteers(loadRunState(projectDir, run.runId)).map((s) => s.text)).toEqual([
        'staged before the terminal call',
      ]);
    },
    TIMEOUT,
  );

  test(
    'killing the kernel subprocess mid-turn converts to a persisted question (crash = flag)',
    async ({ projectDir, run }) => {
      const event = await runPhaseOverStdio({ runId: run.runId, cwd: projectDir, phase: 'frame' }, async ({ client, killPeer }) => {
        killPeer();
        await client.callTool({ name: 'ask_human', arguments: { question: 'never arrives' } });
      });

      expect.soft(event).toEqual({ type: 'phase.flag' });
      expect.soft(loadRunState(projectDir, run.runId).pendingQuestion?.question).toContain('boundary failed');
    },
    TIMEOUT,
  );

  test(
    'a pre-authorized gate auto-crosses only after parking over the boundary',
    async ({ run }) => {
      // frame's directionGate is pre-authorized (not in gatesAt); spec is attended.
      run.gatesAt = ['spec', 'pr'];
      saveRunState(run);

      const advanceThenAsk: Orchestrate = async ({ client, phase }) => {
        if (phase === 'frame') {
          await client.callTool({ name: 'advance_phase', arguments: { summary: 'frame done', artifacts: [] } });
        } else {
          await client.callTool({ name: 'ask_human', arguments: { question: `pausing in ${phase}` } });
        }
      };

      const { snapshot, state } = await driveToQuiescence(loadRunState(run.cwd, run.runId), undefined, {
        machine: stdioPhaseMachine(advanceThenAsk),
        notify: quiet,
      });

      // The directionGate was auto-crossed (recorded), and the run then parked at
      // the next phase's flag-wait — auto-cross happened only after the park.
      expect.soft(state.autoApprovals?.some((a) => a.gate === 'directionGate')).toBe(true);
      expect.soft(snapshot.value).toBe('specFlagWait');
    },
    TIMEOUT,
  );
});

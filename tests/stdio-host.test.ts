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
      // crash = flag over the boundary. The question text is the shared
      // host-runner's `flagInfra` (the in-process driver and the stdio host now
      // converge on one wording — the run loop is extracted), with the transport
      // detail carried inline and cause:'infra'.
      const q = loadRunState(projectDir, run.runId).pendingQuestion;
      expect.soft(q?.question).toContain('failed at the infrastructure layer');
      expect.soft(q?.question).toContain('Connection closed');
      expect.soft(q?.cause).toBe('infra');
    },
    TIMEOUT,
  );

  test(
    'a pre-authorized gate auto-crosses only after parking over the boundary',
    async ({ run }) => {
      // frame's directionGate is pre-authorized (not in gatesAt); spec is attended.
      run.gatesAt = ['spec', 'finish'];
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

describe('crash-before-transition replay over the boundary', () => {
  test(
    'a terminal marker for this phase on entry replays without spawning the kernel or running orchestrate',
    async ({ projectDir, run }) => {
      // The mirror of the in-process driver's entry replay (driver.ts): a marker
      // for this phase survived a crash before the machine transitioned. Re-emit
      // it without re-running the external turn. (A SPENT marker would already
      // have been cleared by the lifecycle's spent-marker guard, so a marker seen
      // here is live — no supersede exception, exactly like the in-process entry.)
      const planted = loadRunState(projectDir, run.runId);
      planted.terminalMarker = { phase: 'frame', kind: 'advance' };
      saveRunState(planted);

      let orchestrateCalled = false;
      const event = await runPhaseOverStdio({ runId: run.runId, cwd: projectDir, phase: 'frame' }, async () => {
        orchestrateCalled = true;
      });

      expect.soft(event).toEqual({ type: 'phase.advance' });
      expect.soft(orchestrateCalled).toBe(false); // the external turn was not re-run (no subprocess spawned)
    },
    TIMEOUT,
  );
});

describe('nudge-once parity over the boundary', () => {
  test(
    'a silent orchestrate turn gets exactly one nudge; advancing on the nudge crosses as advance',
    async ({ projectDir, run }) => {
      const attempts: number[] = [];
      const event = await runPhaseOverStdio(
        { runId: run.runId, cwd: projectDir, phase: 'frame' },
        async ({ client, attempt }) => {
          attempts.push(attempt);
          // attempt 0 is silent (a quiet turn, no terminal call); the host nudges
          // once and the orchestrator advances on attempt 1 — same connected session.
          if (attempt === 1) {
            await client.callTool({ name: 'advance_phase', arguments: { summary: 'done after the nudge', artifacts: [] } });
          }
        },
      );

      expect.soft(attempts).toEqual([0, 1]); // nudged exactly once
      expect.soft(event).toEqual({ type: 'phase.advance' });
    },
    TIMEOUT,
  );

  test(
    'two silent orchestrate turns are a stuck run — flagged with the twice-ended question',
    async ({ projectDir, run }) => {
      const attempts: number[] = [];
      const event = await runPhaseOverStdio(
        { runId: run.runId, cwd: projectDir, phase: 'frame' },
        async ({ attempt }) => {
          attempts.push(attempt);
          // never calls a terminal tool — silent on both the turn and the nudge
        },
      );

      expect.soft(attempts).toEqual([0, 1]); // the single nudge happened, then it flagged
      expect.soft(event).toEqual({ type: 'phase.flag' });
      expect.soft(loadRunState(projectDir, run.runId).pendingQuestion?.question).toContain('twice ended its turn');
    },
    TIMEOUT,
  );
});

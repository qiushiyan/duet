import { describe, expect } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { runPhase } from '../src/harness/driver.ts';
import type { RunOrchestratorTurn } from '../src/harness/driver.ts';
import { listPendingSteers, loadRunState, saveRunState, stageSteer } from '../src/run-store.ts';
import { test } from './helpers/fixtures.ts';

/**
 * The driver's outcome mapping, tested through the injectable SDK seam: a
 * scripted session yields messages and may invoke the same tool handlers the
 * real orchestrator would. Workers never run (the frame phase needs none for
 * advance_phase, which has no review-round requirement there).
 */

const success = (over: Partial<{ session_id: string; total_cost_usd: number; subtype: string }> = {}): SDKMessage =>
  ({ type: 'result', subtype: 'success', session_id: 'orc-session', total_cost_usd: 0.1, ...over }) as SDKMessage;

const assistantText = (text: string): SDKMessage =>
  ({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) as SDKMessage;

/** Build a session whose i-th turn runs the i-th script entry. */
function scriptedSession(
  ...turns: Array<(ctx: Parameters<RunOrchestratorTurn>[0]) => Promise<SDKMessage[]>>
): { runTurn: RunOrchestratorTurn; prompts: string[] } {
  const prompts: string[] = [];
  const runTurn: RunOrchestratorTurn = async function* (ctx) {
    prompts.push(ctx.prompt);
    const turn = turns[prompts.length - 1];
    if (!turn) throw new Error(`session received more turns than scripted (${prompts.length})`);
    yield* await turn(ctx);
  };
  return { runTurn, prompts };
}

const callTool = async (
  ctx: Parameters<RunOrchestratorTurn>[0],
  name: string,
  args: Record<string, unknown>,
): Promise<void> => {
  const tool = ctx.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  await tool.handler(args as never, {});
};

describe('outcome mapping', () => {
  test('advanced when the orchestrator advances the phase', async ({ projectDir, run }) => {
    const { runTurn } = scriptedSession(async (ctx) => {
      await callTool(ctx, 'advance_phase', { summary: 'direction synthesized', artifacts: [] });
      return [success()];
    });

    const result = await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, runTurn);
    expect(result).toEqual({ outcome: 'advanced' });
    expect(loadRunState(projectDir, run.runId).phaseSummaries.frame?.summary).toBe('direction synthesized');
  });

  test('flagged when the orchestrator queues a question', async ({ projectDir, run }) => {
    const { runTurn } = scriptedSession(async (ctx) => {
      await callTool(ctx, 'ask_human', { question: 'which scope?' });
      return [success()];
    });

    const result = await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, runTurn);
    expect(result).toEqual({ outcome: 'flagged' });
    expect(loadRunState(projectDir, run.runId).pendingQuestion?.question).toBe('which scope?');
  });

  test('an abnormal session end flags the human with the subtype, keeping cost and session id', async ({
    projectDir,
    run,
  }) => {
    const { runTurn } = scriptedSession(async () => [
      success({ subtype: 'error_max_budget_usd', total_cost_usd: 15, session_id: 'orc-9' }),
    ]);

    const result = await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, runTurn);
    expect(result).toEqual({ outcome: 'flagged' });
    const state = loadRunState(projectDir, run.runId);
    expect.soft(state.pendingQuestion?.question).toContain('ended abnormally (error_max_budget_usd)');
    expect.soft(state.orchestratorSessionId).toBe('orc-9');
    expect.soft(state.costs.orchestratorUsd).toBe(15);
  });
});

describe('the silent-turn nudge', () => {
  test('a silent turn gets one nudge; advancing on the nudge counts', async ({ projectDir, run }) => {
    const { runTurn, prompts } = scriptedSession(
      async () => [assistantText('thinking out loud'), success()],
      async (ctx) => {
        await callTool(ctx, 'advance_phase', { summary: 'done after nudge', artifacts: [] });
        return [success()];
      },
    );

    const result = await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, runTurn);
    expect(result).toEqual({ outcome: 'advanced' });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Your turn ended without calling advance_phase or ask_human');
  });

  test('two silent turns are a stuck run — flagged with a synthetic question', async ({ projectDir, run }) => {
    const { runTurn, prompts } = scriptedSession(
      async () => [success()],
      async () => [success()],
    );

    const result = await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, runTurn);
    expect(result).toEqual({ outcome: 'flagged' });
    expect(prompts).toHaveLength(2);
    expect(loadRunState(projectDir, run.runId).pendingQuestion?.question).toContain('the run is stuck');
  });
});

describe('infrastructure failure', () => {
  test('a session crash flags the human with the failure, not a silent dead end', async ({ projectDir, run }) => {
    const runTurn: RunOrchestratorTurn = async function* () {
      yield assistantText('starting');
      throw new Error('ECONNRESET mid-stream');
    };

    const result = await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, runTurn);
    expect(result).toEqual({ outcome: 'flagged' });
    expect(loadRunState(projectDir, run.runId).pendingQuestion?.question).toContain(
      'crashed at the infrastructure layer (ECONNRESET mid-stream)',
    );
  });

  test('a crash never overwrites a question the orchestrator already queued', async ({ projectDir, run }) => {
    const { runTurn } = scriptedSession(async (ctx) => {
      await callTool(ctx, 'ask_human', { question: 'the real question' });
      throw new Error('stream died after the tool call');
    });

    const result = await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, runTurn);
    expect(result).toEqual({ outcome: 'flagged' });
    expect(loadRunState(projectDir, run.runId).pendingQuestion?.question).toBe('the real question');
  });
});

describe('the approval rider (approve-with-adjustments rides the next prompt)', () => {
  const advance = () =>
    scriptedSession(async (ctx) => {
      await callTool(ctx, 'advance_phase', { summary: 's', artifacts: [] });
      return [success()];
    });

  test('a rider staged with the approval lands in the next phase entry prompt, framed as approving feedback', async ({
    projectDir,
    run,
  }) => {
    await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, advance().runTurn);
    const staged = loadRunState(projectDir, run.runId);
    staged.pendingMessage = { kind: 'approval', text: 'agreed — but cap questions at 3' };
    saveRunState(staged);

    const spec = advance();
    await runPhase({ runId: run.runId, cwd: projectDir, phase: 'spec' }, spec.runTurn);

    expect.soft(spec.prompts[0]).toContain('Draft the spec'); // the entry prompt, intact
    expect.soft(spec.prompts[0]).toContain('<approval_rider>');
    expect.soft(spec.prompts[0]).toContain('cap questions at 3');
    expect.soft(spec.prompts[0]).toContain('gate feedback in approving form');
  });

  test('a rider on a crash-recovery re-approve rides the take-stock prompt', async ({ projectDir, run }) => {
    await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, advance().runTurn);
    const staged = loadRunState(projectDir, run.runId);
    staged.pendingMessage = { kind: 'approval', text: 'rider after the crash' };
    saveRunState(staged);

    const recovery = advance();
    await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, recovery.runTurn);
    expect.soft(recovery.prompts[0]).toContain('Continue the phase');
    expect.soft(recovery.prompts[0]).toContain('rider after the crash');
  });
});

describe('steer carry-forward (steers that missed their phase ride the next prompt)', () => {
  const advanceScript = () =>
    scriptedSession(async (ctx) => {
      await callTool(ctx, 'advance_phase', { summary: 's', artifacts: [] });
      return [success()];
    });

  test('a steer staged between phases lands in the next entry prompt with provenance — and is consumed', async ({
    projectDir,
    run,
  }) => {
    await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, advanceScript().runTurn);
    const staged = loadRunState(projectDir, run.runId);
    stageSteer(staged, 'skip the migration for now', 'frame');

    const spec = advanceScript();
    await runPhase({ runId: run.runId, cwd: projectDir, phase: 'spec' }, spec.runTurn);

    expect.soft(spec.prompts[0]).toContain('Draft the spec'); // the entry prompt, intact
    expect.soft(spec.prompts[0]).toContain('staged_during="frame phase"');
    expect.soft(spec.prompts[0]).toContain('skip the migration for now');
    expect.soft(spec.prompts[0]).toContain('judge its freshness');
    expect.soft(listPendingSteers(loadRunState(projectDir, run.runId))).toEqual([]);
  });

  test('a steer staged while a question waited rides the answer-resume prompt alongside the answer', async ({
    projectDir,
    run,
  }) => {
    const entry = scriptedSession(async (ctx) => {
      await callTool(ctx, 'ask_human', { question: 'scope?' });
      return [success()];
    });
    await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, entry.runTurn);

    const staged = loadRunState(projectDir, run.runId);
    stageSteer(staged, 'late thought: keep it small', 'frame');
    staged.pendingMessage = { kind: 'answer', text: 'narrow it' };
    saveRunState(staged);

    const resume = advanceScript();
    await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, resume.runTurn);
    expect.soft(resume.prompts[0]).toContain('The human answered your queued question: "narrow it"');
    expect.soft(resume.prompts[0]).toContain('late thought: keep it small');
  });

  test('gate-feedback resume and crash-recovery re-entry carry pending steers the same way', async ({
    projectDir,
    run,
  }) => {
    await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, advanceScript().runTurn);

    // Reject path: feedback staged, steer pending.
    let staged = loadRunState(projectDir, run.runId);
    stageSteer(staged, 'note for the rework');
    staged.pendingMessage = { kind: 'feedback', text: 'invert the scope' };
    saveRunState(staged);
    const rework = advanceScript();
    await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, rework.runTurn);
    expect.soft(rework.prompts[0]).toContain('"invert the scope"');
    expect.soft(rework.prompts[0]).toContain('note for the rework');

    // Crash-recovery path: nothing staged, steer pending, nudge prompt carries it.
    staged = loadRunState(projectDir, run.runId);
    stageSteer(staged, 'note for the recovery');
    const recovery = advanceScript();
    await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, recovery.runTurn);
    expect.soft(recovery.prompts[0]).toContain('Continue the phase');
    expect.soft(recovery.prompts[0]).toContain('note for the recovery');
  });
});

describe('prompt selection and session continuity', () => {
  test('the first invocation gets the phase entry prompt, framing included', async ({ projectDir, run }) => {
    const session = scriptedSession(async (ctx) => {
      await callTool(ctx, 'advance_phase', { summary: 's', artifacts: [] });
      return [success()];
    });
    await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, session.runTurn);

    expect(session.prompts).toHaveLength(1);
    expect.soft(session.prompts[0]).toContain('run the FRAME phase');
    expect.soft(session.prompts[0]).toContain('test framing');
  });

  test('staged gate feedback re-enters the phase quoting the human verbatim', async ({ projectDir, run }) => {
    // First invocation marks the phase started.
    const entry = scriptedSession(
      async (ctx) => {
        await callTool(ctx, 'advance_phase', { summary: 's', artifacts: [] });
        return [success()];
      },
    );
    await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, entry.runTurn);

    // The CLI stages reject feedback; the next invocation carries it.
    const staged = loadRunState(projectDir, run.runId);
    staged.pendingMessage = { kind: 'feedback', text: 'invert the scope' };
    saveRunState(staged);

    const reentry = scriptedSession(async (ctx) => {
      await callTool(ctx, 'advance_phase', { summary: 's2', artifacts: [] });
      return [success()];
    });
    await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, reentry.runTurn);
    expect.soft(reentry.prompts[0]).toContain('"invert the scope"');
    expect.soft(reentry.prompts[0]).toContain('direction analysis');
  });

  test('a staged answer resumes with the answer and reaches a waiting ask_human', async ({ projectDir, run }) => {
    const entry = scriptedSession(async (ctx) => {
      await callTool(ctx, 'ask_human', { question: 'scope?' });
      return [success()];
    });
    await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, entry.runTurn);

    const staged = loadRunState(projectDir, run.runId);
    staged.pendingMessage = { kind: 'answer', text: 'narrow it' };
    saveRunState(staged);

    let askHumanResult = '';
    const resume = scriptedSession(async (ctx) => {
      const tool = ctx.tools.find((t) => t.name === 'ask_human');
      const result = await tool!.handler({ question: 'confirming: narrow?' } as never, {});
      askHumanResult = (result.content[0] as { text: string }).text;
      await callTool(ctx, 'advance_phase', { summary: 'done', artifacts: [] });
      return [success()];
    });
    const result = await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, resume.runTurn);

    expect.soft(resume.prompts[0]).toContain('The human answered your queued question: "narrow it"');
    expect.soft(askHumanResult).toBe('The human answered: narrow it');
    expect.soft(result).toEqual({ outcome: 'advanced' });
    expect.soft(loadRunState(projectDir, run.runId).pendingQuestion).toBeUndefined();
  });

  test('re-entry with nothing staged (crash recovery) asks the orchestrator to take stock', async ({
    projectDir,
    run,
  }) => {
    const entry = scriptedSession(async (ctx) => {
      await callTool(ctx, 'ask_human', { question: 'q' });
      return [success()];
    });
    await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, entry.runTurn);

    const recovery = scriptedSession(async (ctx) => {
      await callTool(ctx, 'advance_phase', { summary: 'recovered', artifacts: [] });
      return [success()];
    });
    await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, recovery.runTurn);
    expect(recovery.prompts[0]).toContain('Continue the phase');
  });

  test('the orchestrator session id persists and resumes across invocations', async ({ projectDir, run }) => {
    const first = scriptedSession(async (ctx) => {
      await callTool(ctx, 'ask_human', { question: 'q' });
      return [success({ session_id: 'orc-abc' })];
    });
    await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, first.runTurn);
    expect(loadRunState(projectDir, run.runId).orchestratorSessionId).toBe('orc-abc');

    let resumedWith: string | undefined;
    const second = scriptedSession(async (ctx) => {
      resumedWith = ctx.options.resume;
      await callTool(ctx, 'advance_phase', { summary: 'done', artifacts: [] });
      return [success({ session_id: 'orc-abc' })];
    });
    await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, second.runTurn);
    expect(resumedWith).toBe('orc-abc');
  });
});

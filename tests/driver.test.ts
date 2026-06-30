import { join } from 'node:path';
import { describe, expect, onTestFinished, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { buildOrchestratorOptions, runPhase } from '../src/harness/driver.ts';
import type { RunOrchestratorTurn } from '../src/harness/driver.ts';
import { claudeApiError, claudeAssistantText, jsonl, plantClaudeTranscript } from './helpers/transcripts.ts';
import {
  ORCHESTRATOR_SYSTEM_PROMPT,
  buildPhaseBrief,
  feedbackResumePrompt,
  framePhaseEntryPrompt,
  implementPhaseEntryPrompt,
  openPrPhaseEntryPrompt,
  planPhaseEntryPrompt,
  researchPhaseEntryPrompt,
  specPhaseEntryPrompt,
} from '../src/harness/orchestrator-prompts.ts';
import { PHASE } from '../src/phases.ts';
import type { PhaseName } from '../src/phases.ts';
import { budgetFor, loadRunState, saveRunState } from '../src/run-store.ts';
import { listPendingSteers, stageSteer } from '../src/steer-store.ts';
import { test } from './helpers/fixtures.ts';

/**
 * The driver's phase-event mapping, tested through the injectable SDK seam: a
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

/**
 * Mimic the lifecycle's marker-clear at quiescence between two direct runPhase
 * invocations. In a real run driveToQuiescence saves the snapshot and clears
 * the terminal marker (deliver-before-clear) before the next invocation re-enters;
 * these tests drive runPhase directly, skipping the machine, so they clear it
 * here. Otherwise the surviving marker would short-circuit the next same-phase
 * invocation — that short-circuit is the crash-before-transition replay path,
 * exercised separately, not the normal re-entry these tests model.
 */
const quiesce = (cwd: string, runId: string): void => {
  const s = loadRunState(cwd, runId);
  delete s.terminalMarker;
  saveRunState(s);
};

describe('buildPhaseBrief (the shared entry-prompt dispatch — headless parity)', () => {
  test('returns each phase’s entry prompt with the phase table’s round cap', ({ run }) => {
    // The extraction is a pure move: the headless basePrompt and the interactive
    // get_task both build the brief here, dispatching the right *PhaseEntryPrompt
    // with the right cap. A wrong-phase or wrong-cap dispatch would break this.
    expect.soft(buildPhaseBrief(run, 'frame')).toBe(framePhaseEntryPrompt(run, PHASE.frame.roundCap));
    expect.soft(buildPhaseBrief(run, 'spec')).toBe(specPhaseEntryPrompt(run, PHASE.spec.roundCap));
    expect.soft(buildPhaseBrief(run, 'plan')).toBe(planPhaseEntryPrompt(run, PHASE.plan.roundCap));
    expect.soft(buildPhaseBrief(run, 'finish')).toBe(openPrPhaseEntryPrompt(run, PHASE.finish.roundCap, 'finish'));
    expect.soft(buildPhaseBrief(run, 'research')).toBe(researchPhaseEntryPrompt(run, PHASE.research.roundCap));
    expect.soft(buildPhaseBrief(run, 'implement')).toBe(implementPhaseEntryPrompt(run, PHASE.implement.roundCap));
    expect.soft(buildPhaseBrief(run, 'publish')).toBe(openPrPhaseEntryPrompt(run, PHASE.publish.roundCap, 'publish'));
  });

  // Belt-and-braces for the exhaustive `satisfies Record<PhaseName, …>` — the
  // compiler is the real guard, but a phase with a stub/throwing builder would
  // still surface here.
  test.for(Object.keys(PHASE) as PhaseName[])('%s builds a non-empty brief', (phase, { run }) => {
    expect(buildPhaseBrief(run, phase).trim().length).toBeGreaterThan(0);
  });

  // The two load-bearing contracts of the shared openPr brief (full's finish,
  // rir's publish), pinned by stable tokens rather than prose: an *idempotent*
  // open — check for an existing PR before `gh pr create`, so a crash-resume or
  // gate-reject re-entry amends in place rather than erroring on a second create
  // — and the `Verification (pending)` checklist that carries the env-verify
  // reminder onto a PR opened after an auto-crossed Ship gate. (The old literal
  // tests pinned the surrounding prose and were brittle; these pin the contract.)
  test.for(['finish', 'publish'] as const)(
    '%s opens the PR idempotently and leads with the verification checklist',
    (phase, { run }) => {
      const brief = buildPhaseBrief(run, phase);
      expect.soft(brief).toMatch(/gh pr (view|list)/); // existence check first
      expect.soft(brief).toContain('gh pr create'); // then open
      expect.soft(brief).toContain('Verification (pending)');
    },
  );
});

describe('feedbackResumePrompt — the human feedback reaches the worker', () => {
  // The load-bearing behavior of a gate rejection is that the human's exact words
  // reach the re-entry prompt verbatim (the editor-in-chief is never paraphrased) —
  // that is what this test pins. The branching it layers on (re-run review rounds
  // vs apply directly, amend an already-open PR vs not) is keyed off registry facts
  // the prompt reads at runtime (reviewLoop, roundCap, gate.state), so a reword
  // can't silently flip it; the prose itself is deliberately not re-pinned here —
  // that re-pinning was the brittleness the old literal tests carried.
  test.for(['spec', 'plan', 'impl', 'finish', 'research', 'implement', 'publish'] as const)(
    '%s carries the human feedback verbatim',
    (phase) => {
      const feedback = 'the 404 path is swallowed — surface it instead';
      expect(feedbackResumePrompt(phase, feedback)).toContain(feedback);
    },
  );
});

describe('the orchestrator system prompt is arc-neutral', () => {
  test('the review-loop language defers to the phase rather than universalizing -again/round-2', () => {
    // It still names Full's mechanisms (discipline preserved) but scopes them to
    // the phase, and names RIR's single writable round alongside.
    expect.soft(ORCHESTRATOR_SYSTEM_PROMPT).toContain('the phase brief names which');
    expect.soft(ORCHESTRATOR_SYSTEM_PROMPT).toContain('apply-review');
    expect.soft(ORCHESTRATOR_SYSTEM_PROMPT).toContain('single-round phase');
    // Full's discipline is not weakened — review-*/update-*/respond-*/-again still taught.
    expect.soft(ORCHESTRATOR_SYSTEM_PROMPT).toContain('update-*');
    expect.soft(ORCHESTRATOR_SYSTEM_PROMPT).toContain('-again');
  });
});

describe('orchestrator context capture', () => {
  test('the last assistant usage against modelUsage’s window lands in the run state', async ({
    projectDir,
    run,
  }) => {
    const withUsage = {
      type: 'assistant',
      message: {
        usage: { input_tokens: 50_000, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 1_000, output_tokens: 2_000 },
        content: [],
      },
    } as unknown as SDKMessage;
    const { runTurn } = scriptedSession(async (ctx) => {
      await callTool(ctx, 'advance_phase', { summary: 's', artifacts: [] });
      return [
        withUsage,
        {
          type: 'result',
          subtype: 'success',
          session_id: 'orc-session',
          total_cost_usd: 0.1,
          modelUsage: { 'claude-opus-4-8': { contextWindow: 200_000 } },
        } as unknown as SDKMessage,
      ];
    });

    await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, runTurn);
    expect(loadRunState(projectDir, run.runId).contextUsage?.orchestrator).toMatchObject({
      usedTokens: 83_000,
      windowTokens: 200_000,
    });
  });
});

describe('phase-event mapping', () => {
  test('advanced when the orchestrator advances the phase', async ({ projectDir, run }) => {
    const { runTurn } = scriptedSession(async (ctx) => {
      await callTool(ctx, 'advance_phase', { summary: 'direction synthesized', artifacts: [] });
      return [success()];
    });

    const result = await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, runTurn);
    expect(result).toEqual({ type: 'phase.advance' });
    expect(loadRunState(projectDir, run.runId).phaseSummaries.frame?.summary).toBe('direction synthesized');
  });

  test('flagged when the orchestrator queues a question', async ({ projectDir, run }) => {
    const { runTurn } = scriptedSession(async (ctx) => {
      await callTool(ctx, 'ask_human', { question: 'which scope?' });
      return [success()];
    });

    const result = await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, runTurn);
    expect(result).toEqual({ type: 'phase.flag' });
    expect(loadRunState(projectDir, run.runId).pendingQuestion?.question).toBe('which scope?');
  });

  test('an orchestrator budget cap queues a resumable budget stop (cause budget, no errorClass), keeping cost and session id', async ({
    projectDir,
    run,
  }) => {
    const { runTurn } = scriptedSession(async () => [
      success({ subtype: 'error_max_budget_usd', total_cost_usd: 15, session_id: 'orc-9' }),
    ]);

    const result = await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, runTurn);
    expect(result).toEqual({ type: 'phase.flag' });
    const state = loadRunState(projectDir, run.runId);
    expect.soft(state.pendingQuestion?.question).toContain('budget cap');
    expect.soft(state.pendingQuestion?.cause).toBe('budget'); // its own cause — resumable, not infra
    expect.soft(state.pendingQuestion?.errorClass).toBeUndefined(); // budget is not an infra taxonomy class
    expect.soft(state.orchestratorSessionId).toBe('orc-9');
    expect.soft(state.costs.orchestratorUsd).toBe(15);
  });
});

describe('the terminal marker (first-terminal-wins, replay-safe)', () => {
  test('advance_phase then ask_human in one turn emits exactly one event — advance wins', async ({
    projectDir,
    run,
  }) => {
    const { runTurn } = scriptedSession(async (ctx) => {
      await callTool(ctx, 'advance_phase', { summary: 'done', artifacts: [] });
      await callTool(ctx, 'ask_human', { question: 'wait, actually?' }); // refused — phase already ending
      return [success()];
    });

    const event = await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, runTurn);
    expect(event).toEqual({ type: 'phase.advance' });
    const state = loadRunState(projectDir, run.runId);
    expect.soft(state.terminalMarker).toEqual({ phase: 'frame', kind: 'advance' });
    expect.soft(state.pendingQuestion).toBeUndefined(); // the second terminal call never queued
  });

  test('a marker for this phase on re-entry re-drives the transition without re-running the session', async ({
    projectDir,
    run,
  }) => {
    // Crash after the marker was written but before the machine transitioned:
    // the decision is re-emitted; the (minutes-long) session must not run again.
    const staged = loadRunState(projectDir, run.runId);
    staged.terminalMarker = { phase: 'frame', kind: 'advance' };
    staged.phaseSummaries.frame = { summary: 'recorded before the crash', artifacts: [] };
    saveRunState(staged);

    const mustNotRun: RunOrchestratorTurn = async function* () {
      throw new Error('the session must not run on a same-phase marker re-entry');
    };
    const event = await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, mustNotRun);
    expect(event).toEqual({ type: 'phase.advance' });
  });

  test('a marker for a different phase is stale — ignored, the session runs normally', async ({
    projectDir,
    run,
  }) => {
    // The deliver-before-clear window: a marker from the prior phase survived a
    // crash into the next phase. markerToEvent rejects the phase mismatch, so it
    // does not short-circuit — this phase's session runs and overwrites it.
    const staged = loadRunState(projectDir, run.runId);
    staged.terminalMarker = { phase: 'frame', kind: 'advance' }; // foreign to spec
    staged.rounds.spec = 1; // spec advance needs a review round
    saveRunState(staged);

    const session = scriptedSession(async (ctx) => {
      await callTool(ctx, 'advance_phase', { summary: 'spec done', artifacts: [] });
      return [success()];
    });
    const event = await runPhase({ runId: run.runId, cwd: projectDir, phase: 'spec' }, session.runTurn);
    expect(event).toEqual({ type: 'phase.advance' });
    expect.soft(session.prompts).toHaveLength(1); // the session DID run — no short-circuit
    expect.soft(loadRunState(projectDir, run.runId).terminalMarker).toEqual({ phase: 'spec', kind: 'advance' });
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
    expect(result).toEqual({ type: 'phase.advance' });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Your turn ended without calling advance_phase or ask_human');
  });

  test('two silent turns are a stuck run — flagged with a synthetic question', async ({ projectDir, run }) => {
    const { runTurn, prompts } = scriptedSession(
      async () => [success()],
      async () => [success()],
    );

    const result = await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, runTurn);
    expect(result).toEqual({ type: 'phase.flag' });
    expect(prompts).toHaveLength(2);
    expect(loadRunState(projectDir, run.runId).pendingQuestion?.question).toContain('the run is stuck');
  });
});

describe('infrastructure failure', () => {
  test('a session crash flags the human with the failure, not a silent dead end', async ({ projectDir, run }) => {
    // Retry explicitly off so the transient failure flags immediately — this test
    // pins the flag classification, not the retry loop (S6 made retry default-on).
    run.retryInfra = 0;
    saveRunState(run);
    const runTurn: RunOrchestratorTurn = async function* () {
      yield assistantText('starting');
      throw new Error('ECONNRESET mid-stream');
    };

    const result = await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, runTurn);
    expect(result).toEqual({ type: 'phase.flag' });
    const q = loadRunState(projectDir, run.runId).pendingQuestion;
    expect.soft(q?.question).toContain('failed at the infrastructure layer (ECONNRESET mid-stream)');
    // With retry explicitly off, the flag is classified infra (#4a) but behaves as before.
    expect.soft(q?.cause).toBe('infra');
    expect.soft(q?.errorClass).toBe('network');
  });

  test('a crash never overwrites a question the orchestrator already queued', async ({ projectDir, run }) => {
    const { runTurn } = scriptedSession(async (ctx) => {
      await callTool(ctx, 'ask_human', { question: 'the real question' });
      throw new Error('stream died after the tool call');
    });

    const result = await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, runTurn);
    expect(result).toEqual({ type: 'phase.flag' });
    const q = loadRunState(projectDir, run.runId).pendingQuestion;
    expect.soft(q?.question).toBe('the real question');
    expect.soft(q?.cause).toBe('human'); // the orchestrator's question wins and stays human-owned
  });

  test('an abnormal orchestrator result is an infra flag, errorClass unknown (never retried)', async ({ projectDir, run }) => {
    run.retryInfra = 5;
    saveRunState(run);
    const runTurn: RunOrchestratorTurn = async function* () {
      yield success({ subtype: 'error_max_turns' });
    };
    const result = await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, runTurn);
    expect(result).toEqual({ type: 'phase.flag' });
    const q = loadRunState(projectDir, run.runId).pendingQuestion;
    expect.soft(q?.cause).toBe('infra');
    expect.soft(q?.errorClass).toBe('unknown'); // a budget/turn cap is not a taxonomy class
  });
});

describe('opt-in infra auto-retry (#4b)', () => {
  const network = () => {
    throw new Error('fetch failed: ECONNRESET');
  };

  test('with retry explicitly OFF (--retry-infra 0), a transient failure flags immediately, no retry', async ({ projectDir, run }) => {
    // S6 made retry default-on (materialized 3); 0 is the explicit opt-out, and an
    // old/absent state.json (host-runner reads `?? 0`) stays off the same way.
    run.retryInfra = 0;
    saveRunState(run);
    const { runTurn } = scriptedSession(async () => network());
    const result = await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, runTurn);
    expect(result).toEqual({ type: 'phase.flag' });
    expect(loadRunState(projectDir, run.runId).retryState).toBeUndefined();
  });

  test('with retry ON, a recoverable failure then success completes with no flag, retryState reset', async ({ projectDir, run }) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    run.retryInfra = 2;
    saveRunState(run);
    const { runTurn } = scriptedSession(
      async () => network(),
      async (ctx) => {
        await callTool(ctx, 'advance_phase', { summary: 'done', artifacts: [] });
        return [success()];
      },
    );
    const p = runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, runTurn);
    await vi.advanceTimersByTimeAsync(5_000); // let the backoff elapse → retry
    expect(await p).toEqual({ type: 'phase.advance' });
    expect(loadRunState(projectDir, run.runId).retryState).toBeUndefined(); // reset on clean outcome
  });

  test('exhaustion flags after the cap', async ({ projectDir, run }) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    run.retryInfra = 2;
    saveRunState(run);
    const { runTurn } = scriptedSession(async () => network(), async () => network(), async () => network());
    const p = runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, runTurn);
    await vi.advanceTimersByTimeAsync(60_000); // cascade through both retries
    expect(await p).toEqual({ type: 'phase.flag' });
    expect(loadRunState(projectDir, run.runId).pendingQuestion?.cause).toBe('infra');
  });

  test('S6: each auto-retry appends an autoRetries ledger entry (the morning-review record)', async ({ projectDir, run }) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    run.retryInfra = 2;
    saveRunState(run);
    // Two transient failures then a clean advance: two retries → two ledger entries.
    const { runTurn } = scriptedSession(
      async () => network(),
      async () => network(),
      async (ctx) => {
        await callTool(ctx, 'advance_phase', { summary: 'done', artifacts: [] });
        return [success()];
      },
    );
    const p = runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, runTurn);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await p).toEqual({ type: 'phase.advance' });
    const ledger = loadRunState(projectDir, run.runId).autoRetries ?? [];
    expect.soft(ledger).toHaveLength(2);
    expect.soft(ledger.map((r) => r.errorClass)).toEqual(['network', 'network']);
    expect.soft(ledger.map((r) => r.attempt)).toEqual([1, 2]); // the attempt number after each retry
    expect.soft(ledger.every((r) => r.phase === 'frame')).toBe(true);
  });

  test('S6: an old-shape state.json with no retryInfra stays OFF (host-runner reads `?? 0`)', async ({ projectDir, run }) => {
    // The materialization is at createRun, so a pre-feature / hand-written run with
    // no retryInfra is byte-for-byte off — it flags immediately, never retries.
    delete run.retryInfra;
    saveRunState(run);
    const { runTurn } = scriptedSession(async () => network());
    const result = await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, runTurn);
    expect.soft(result).toEqual({ type: 'phase.flag' });
    expect.soft(loadRunState(projectDir, run.runId).retryState).toBeUndefined();
    expect.soft(loadRunState(projectDir, run.runId).autoRetries).toBeUndefined();
  });

  test('login-required is never retried even with budget', async ({ projectDir, run }) => {
    run.retryInfra = 5;
    saveRunState(run);
    const { runTurn } = scriptedSession(async () => {
      throw new Error('API Error: 403 Request not allowed. Please run /login');
    });
    const result = await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, runTurn);
    expect(result).toEqual({ type: 'phase.flag' });
    expect(loadRunState(projectDir, run.runId).pendingQuestion?.errorClass).toBe('login-required');
  });

  test('auth retries once, then a second consecutive auth escalates as login-required', async ({ projectDir, run }) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    run.retryInfra = 5;
    saveRunState(run);
    const { runTurn } = scriptedSession(
      async () => {
        throw new Error('403 Request not allowed');
      },
      async () => {
        throw new Error('403 Request not allowed');
      },
    );
    const p = runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, runTurn);
    await vi.advanceTimersByTimeAsync(5_000); // one retry elapses
    expect(await p).toEqual({ type: 'phase.flag' });
    // Escalated after EXACTLY one retry — persistent auth becomes login-required.
    expect(loadRunState(projectDir, run.runId).pendingQuestion?.errorClass).toBe('login-required');
  });
});

describe('a terminal decision survives a post-call stream throw (#1 — first-terminal-wins)', () => {
  test('advance_phase then the stream throws → phase.advance, never a false infra flag (retry off)', async ({ projectDir, run }) => {
    const { runTurn } = scriptedSession(async (ctx) => {
      await callTool(ctx, 'advance_phase', { summary: 'done', artifacts: [] });
      throw new Error('fetch failed: ECONNRESET'); // recoverable class, but the decision already exists
    });
    const result = await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, runTurn);
    expect(result).toEqual({ type: 'phase.advance' });
    const s = loadRunState(projectDir, run.runId);
    expect.soft(s.pendingQuestion).toBeUndefined(); // not turned into an infra stop
    expect.soft(s.terminalMarker).toEqual({ phase: 'frame', kind: 'advance' });
  });

  test('advance_phase then a recoverable throw → phase.advance, never retried (retry on)', async ({ projectDir, run }) => {
    run.retryInfra = 5;
    saveRunState(run);
    // Only ONE turn is scripted: were the marker ignored, the recoverable class
    // would retry and re-enter drivePhase, exhausting the script (a thrown error).
    const { runTurn, prompts } = scriptedSession(async (ctx) => {
      await callTool(ctx, 'advance_phase', { summary: 'done', artifacts: [] });
      throw new Error('fetch failed: ECONNRESET');
    });
    const result = await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, runTurn);
    expect(result).toEqual({ type: 'phase.advance' });
    expect.soft(prompts).toHaveLength(1); // no retry turn ran
    expect.soft(loadRunState(projectDir, run.runId).retryState).toBeUndefined(); // episode concluded
  });

  test('ask_human then a recoverable throw → phase.flag, stays cause:human, never retried (retry on)', async ({ projectDir, run }) => {
    run.retryInfra = 5;
    saveRunState(run);
    const { runTurn, prompts } = scriptedSession(async (ctx) => {
      await callTool(ctx, 'ask_human', { question: 'the real question' });
      throw new Error('fetch failed: ECONNRESET');
    });
    const result = await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, runTurn);
    expect(result).toEqual({ type: 'phase.flag' });
    const q = loadRunState(projectDir, run.runId).pendingQuestion;
    expect.soft(q?.question).toBe('the real question');
    expect.soft(q?.cause).toBe('human'); // not reclassified to infra by the throw
    expect.soft(prompts).toHaveLength(1); // no retry turn ran
  });

  // The same guarantee on the in-band path: an abnormal SDK *result* subtype (not
  // a throw) that coincides with a just-recorded decision. streamTurn's
  // abnormal-subtype self-flag must honor the marker rather than overwrite it.
  test('ask_human then an abnormal result subtype → phase.flag, the human’s question wins (not the budget stop)', async ({ projectDir, run }) => {
    const { runTurn } = scriptedSession(async (ctx) => {
      await callTool(ctx, 'ask_human', { question: 'the real question' });
      return [success({ subtype: 'error_max_budget_usd' })]; // turn exits over budget AFTER the decision
    });
    const result = await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, runTurn);
    expect(result).toEqual({ type: 'phase.flag' });
    const q = loadRunState(projectDir, run.runId).pendingQuestion;
    expect.soft(q?.question).toBe('the real question'); // not clobbered by the budget-cap question
    expect.soft(q?.cause).toBe('human'); // not reclassified to budget
  });

  test('advance_phase then an abnormal result subtype → phase.advance, not masked by a budget flag', async ({ projectDir, run }) => {
    const { runTurn } = scriptedSession(async (ctx) => {
      await callTool(ctx, 'advance_phase', { summary: 'done', artifacts: [] });
      return [success({ subtype: 'error_max_budget_usd' })];
    });
    const result = await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, runTurn);
    expect(result).toEqual({ type: 'phase.advance' });
    expect.soft(loadRunState(projectDir, run.runId).pendingQuestion).toBeUndefined(); // no spurious budget stop
  });

  test('the entry replay concludes the retry episode — a stale retryState is cleared', async ({ projectDir, run }) => {
    const staged = loadRunState(projectDir, run.runId);
    staged.terminalMarker = { phase: 'frame', kind: 'advance' };
    staged.retryState = { attempts: 2, lastClass: 'network' };
    saveRunState(staged);
    const event = await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, async function* () {
      throw new Error('the session must not run on a same-phase marker re-entry');
    });
    expect(event).toEqual({ type: 'phase.advance' });
    expect(loadRunState(projectDir, run.runId).retryState).toBeUndefined();
  });
});

describe('classifyInfraError — a recovered transcript error never names an opaque throw (#2)', () => {
  test('opaque throw + a recent-but-superseded transcript error → flags unknown, never retries (retry on)', async ({ projectDir, run }) => {
    const home = join(projectDir, 'home');
    vi.stubEnv('HOME', home); // classifyInfraError reads the orchestrator tail via homedir()
    run.retryInfra = 5;
    run.orchestratorSessionId = 'orc-1';
    saveRunState(run);
    // A recent terminal ECONNRESET, THEN later normal activity (recovered): the
    // error is recent but superseded, so it must not be read as the live cause.
    const transcript = jsonl(
      claudeApiError('API Error: fetch failed: ECONNRESET', { ts: new Date(Date.now() - 60_000).toISOString() }),
      claudeAssistantText('recovered and continued', { ts: new Date(Date.now() - 5_000).toISOString() }),
    );
    plantClaudeTranscript(home, 'orc-1', transcript);
    const { runTurn, prompts } = scriptedSession(async () => {
      throw new Error('the SDK wrapper failed opaquely');
    });
    const result = await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, runTurn);
    expect(result).toEqual({ type: 'phase.flag' });
    const q = loadRunState(projectDir, run.runId).pendingQuestion;
    expect.soft(q?.cause).toBe('infra');
    expect.soft(q?.errorClass).toBe('unknown'); // NOT 'network' inherited from the recovered error
    expect.soft(prompts).toHaveLength(1); // unknown is never retried
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
    quiesce(projectDir, run.runId);
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
    quiesce(projectDir, run.runId);

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
    quiesce(projectDir, run.runId);

    // Reject path: feedback staged, steer pending.
    let staged = loadRunState(projectDir, run.runId);
    stageSteer(staged, 'note for the rework');
    staged.pendingMessage = { kind: 'feedback', text: 'invert the scope' };
    saveRunState(staged);
    const rework = advanceScript();
    await runPhase({ runId: run.runId, cwd: projectDir, phase: 'frame' }, rework.runTurn);
    expect.soft(rework.prompts[0]).toContain('"invert the scope"');
    expect.soft(rework.prompts[0]).toContain('note for the rework');
    quiesce(projectDir, run.runId);

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
    quiesce(projectDir, run.runId);

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
    quiesce(projectDir, run.runId);

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
    expect.soft(result).toEqual({ type: 'phase.advance' });
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
    quiesce(projectDir, run.runId); // models the flag-wait quiescence before the crash + recovery

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
    quiesce(projectDir, run.runId);

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

describe('provider-agnostic onboarding — workers get document paths, not slash commands (F9)', () => {
  test('the onboarding entry prompts name a path and never instruct slash-command expansion', ({ run }) => {
    const frame = framePhaseEntryPrompt(run, PHASE.frame.roundCap);
    const research = researchPhaseEntryPrompt(run, PHASE.research.roundCap);
    const finish = openPrPhaseEntryPrompt(run, PHASE.finish.roundCap, 'finish');

    for (const p of [frame, research, finish]) {
      expect.soft(p).not.toContain('CLI expands it'); // the now-wrong slash-command instruction is gone
      expect.soft(p).not.toContain("include its /name");
    }
    // frame/research: paths-not-commands + surface an incomplete framing via ask_human.
    expect.soft(frame).toContain('document PATHS');
    expect.soft(frame).toMatch(/incomplete[\s\S]*ask_human/);
    expect.soft(research).toContain('document PATHS');
    // finish: the reconcile-docs step relays the framing's named doc method (path
    // or skill) faithfully rather than a self-invented one — provider-agnostic by
    // staying with what the framing named (the 4912afe reconcile rewrite reframed
    // the old "never a slash command" guard this way) — and a doc-scope product
    // call still surfaces via ask_human.
    expect.soft(finish).toContain('path or skill faithfully');
    expect.soft(finish).toMatch(/doc-scope product call[\s\S]*ask_human/);
  });
});

describe('buildOrchestratorOptions (S2 — the forced watchdog on the orchestrator session)', () => {
  test('its env forces API_FORCE_IDLE_TIMEOUT=1 and keeps CLAUDE_CODE_STREAM_CLOSE_TIMEOUT', ({ run }) => {
    const options = buildOrchestratorOptions(run, budgetFor(run, 'frame'));
    expect.soft(options.env?.API_FORCE_IDLE_TIMEOUT).toBe('1');
    // the existing stream-close window survives the merge (both ride the same env).
    expect.soft(options.env?.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT).toBe(String(2 * 60 * 60_000));
    // merged over process.env, not a replacement.
    expect.soft(options.env?.PATH).toBe(process.env.PATH);
  });
});

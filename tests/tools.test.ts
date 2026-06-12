import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { describe, expect, vi } from 'vitest';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { createPhaseTools } from '../src/harness/tools.ts';
import type { PhaseName } from '../src/phases.ts';
import { loadRunState, runDirOf } from '../src/run-store.ts';
import type { RunState } from '../src/run-store.ts';
import { FakeWorker, test } from './helpers/fixtures.ts';

/**
 * The protocol rails, tested through the orchestrator's real interface: the
 * tool handlers themselves. Workers are FakeWorker adapters on the
 * WorkerProvider seam; the filesystem is the run dir fixture.
 */

type ToolResult = Awaited<ReturnType<SdkMcpToolDefinition['handler']>>;

function harness(
  run: RunState,
  opts: { phase?: PhaseName; stagedAnswer?: string; implementer?: FakeWorker; reviewer?: FakeWorker } = {},
) {
  const implementer = opts.implementer ?? new FakeWorker('claude');
  const reviewer = opts.reviewer ?? new FakeWorker('codex');
  const lines: string[] = [];
  const { tools, outcome } = createPhaseTools({
    state: run,
    phase: opts.phase ?? 'spec',
    providers: { implementer, reviewer },
    log: (line) => lines.push(line),
    ...(opts.stagedAnswer !== undefined ? { stagedAnswer: opts.stagedAnswer } : {}),
  });
  const call = (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no such tool: ${name}`);
    return tool.handler(args as never, {});
  };
  return { call, outcome, implementer, reviewer, lines };
}

const text = (result: ToolResult): string => (result.content[0] as { text: string }).text;

describe('send_prompt', () => {
  test('routes to the addressed worker and returns its response', async ({ run }) => {
    const { call, reviewer } = harness(run);
    const result = await call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'review this' });

    expect(result.isError).toBeUndefined();
    expect(text(result)).toBe('scripted response');
    expect(reviewer.calls).toEqual([
      { prompt: 'review this', sessionId: undefined, readOnly: true, cwd: run.cwd },
    ]);
  });

  test('continues the same worker session across calls and lets the implementer write', async ({ run }) => {
    const { call, implementer } = harness(run);
    await call('send_prompt', { role: 'implementer', tag: 'write-spec', body: 'draft it' });
    await call('send_prompt', { role: 'implementer', tag: 'custom', body: 'continue' });

    expect(implementer.calls[0]?.readOnly).toBe(false);
    expect(implementer.calls[1]?.sessionId).toBe('session-1');
  });

  test('accumulates claude cost in dollars and codex cost in tokens', async ({ projectDir, run }) => {
    const implementer = new FakeWorker('claude', [{ costUsd: 1.25 }]);
    const reviewer = new FakeWorker('codex', [{ tokens: { input: 1000, output: 50 } }]);
    const { call } = harness(run, { implementer, reviewer });

    await call('send_prompt', { role: 'implementer', tag: 'write-spec', body: 'draft' });
    await call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'review' });

    const persisted = loadRunState(projectDir, run.runId);
    expect.soft(persisted.costs.claudeWorkersUsd).toBe(1.25);
    expect.soft(persisted.costs.codexTokens).toEqual({ input: 1000, output: 50 });
  });

  test('logs both sides of the exchange into the voice log', async ({ projectDir, run }) => {
    const { call } = harness(run);
    await call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'review the spec' });

    const log = readFileSync(join(runDirOf(projectDir, run.runId), 'reviewer.log'), 'utf8');
    expect.soft(log).toContain('◀ prompt (tag=review-spec, from orchestrator)');
    expect.soft(log).toContain('review the spec');
    expect.soft(log).toContain('▶ response (session session-1)');
  });

  test('a worker failure names the layer, prescribes retry-then-flag, and counts nothing', async ({ run }) => {
    const reviewer = new FakeWorker('codex', [new Error('spawn codex ENOENT')]);
    const { call } = harness(run, { reviewer });
    const result = await call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'review' });

    expect(result.isError).toBe(true);
    expect.soft(text(result)).toContain('infrastructure layer (spawn codex ENOENT)');
    expect.soft(text(result)).toContain('Retry this same send_prompt call once');
    expect.soft(run.rounds.spec ?? 0).toBe(0);
    expect.soft(run.sentSnippets?.spec?.reviewer ?? []).toEqual([]);
  });

  test('emits a heartbeat while a long worker turn runs', async ({ run, onTestFinished }) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers(); // restore even when an assertion fails
    });
    let finish!: (turn: { text: string; sessionId: string }) => void;
    const slow = new FakeWorker('codex');
    slow.runTurn = () => new Promise((resolve) => (finish = resolve));

    const { call, lines } = harness(run, { reviewer: slow });
    const pending = call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'review' });

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(lines.some((l) => l.includes('⏳ reviewer turn running — 5m elapsed'))).toBe(true);

    finish({ text: 'done', sessionId: 's' });
    await pending;
  });
});

describe('template economy (once per phase per worker)', () => {
  test('re-sending a base template gets one steering refusal, then the identical call passes', async ({ run }) => {
    const { call, reviewer } = harness(run);
    const args = { role: 'reviewer', tag: 'review-spec', body: 'full template' };

    await call('send_prompt', args);
    const warned = await call('send_prompt', args);
    expect(warned.isError).toBe(true);
    expect.soft(text(warned)).toContain('already sent review-spec to the reviewer this phase');
    expect.soft(text(warned)).toContain('repeat this exact call and it will go through');

    const allowed = await call('send_prompt', args);
    expect(allowed.isError).toBeUndefined();
    expect(reviewer.calls).toHaveLength(2);
  });

  test.for(['review-spec-again', 'custom'])(
    'tag "%s" is a delta, never warned',
    async (tag, { run }) => {
      const { call } = harness(run);
      const args = { role: 'reviewer', tag, body: 'delta' };
      await call('send_prompt', args);
      const second = await call('send_prompt', args);
      expect(second.isError).toBeUndefined();
    },
  );

  test('the discipline survives a new driver invocation (persisted send history)', async ({ projectDir, run }) => {
    const first = harness(run);
    await first.call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'template' });

    // A later invocation loads its own state copy and builds fresh tools.
    const reloaded = loadRunState(projectDir, run.runId);
    const second = harness(reloaded);
    const warned = await second.call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'template' });
    expect(warned.isError).toBe(true);
  });
});

describe('review-round backstop cap', () => {
  test('review prompts to the reviewer count rounds; other prompts never do', async ({ run }) => {
    const { call } = harness(run);
    await call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'round 1' });
    await call('send_prompt', { role: 'implementer', tag: 'update-spec', body: 'not a round' });
    await call('send_prompt', { role: 'reviewer', tag: 'custom', body: 'not a round either' });
    expect(run.rounds.spec).toBe(1);
  });

  test('at the cap, a new round is refused toward advance_phase or ask_human', async ({ run }) => {
    run.rounds.spec = 6;
    const { call, reviewer } = harness(run);
    const result = await call('send_prompt', { role: 'reviewer', tag: 'review-spec-again', body: 'one more' });

    expect(result.isError).toBe(true);
    expect.soft(text(result)).toContain('backstop cap of 6 review rounds');
    expect.soft(text(result)).toContain('advance_phase');
    expect.soft(text(result)).toContain('ask_human');
    expect.soft(reviewer.calls).toHaveLength(0);
  });
});

describe('ask_human (the cooperative pause)', () => {
  test('queues the question, persists it, and tells the orchestrator to end its turn', async ({ projectDir, run }) => {
    const { call, outcome } = harness(run);
    const result = await call('ask_human', { question: 'ship behind a flag?', context: 'billing implications' });

    expect.soft(outcome.questionQueued).toBe(true);
    expect.soft(text(result)).toContain('End your turn');
    // Persisted at the moment of the call — the human-visible artifact
    // exists before the model regains control.
    expect.soft(loadRunState(projectDir, run.runId).pendingQuestion).toEqual({
      question: 'ship behind a flag?',
      context: 'billing implications',
    });
  });

  test('a staged answer feeds the first ask_human without pausing; the next one queues', async ({ run }) => {
    const { call, outcome } = harness(run, { stagedAnswer: 'yes, behind a flag' });

    const first = await call('ask_human', { question: 'ship behind a flag?' });
    expect.soft(text(first)).toBe('The human answered: yes, behind a flag');
    expect.soft(outcome.questionQueued).toBe(false);

    await call('ask_human', { question: 'a second question' });
    expect(outcome.questionQueued).toBe(true);
  });
});

describe('create_branch (the branch policy)', () => {
  test('creates and switches before any worker is prompted', async ({ projectDir, run }) => {
    await execa('git', ['init', '-b', 'main'], { cwd: projectDir });
    const { call } = harness(run);
    const result = await call('create_branch', { name: 'feat/queued-flags' });

    expect(result.isError).toBeUndefined();
    expect(run.branch).toBe('feat/queued-flags');
    const { stdout } = await execa('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: projectDir });
    expect(stdout.trim()).toBe('feat/queued-flags');
  });

  test('is structurally unavailable once a worker has been prompted', async ({ projectDir, run }) => {
    await execa('git', ['init', '-b', 'main'], { cwd: projectDir });
    const { call } = harness(run);
    await call('send_prompt', { role: 'implementer', tag: 'custom', body: 'hello' });

    const result = await call('create_branch', { name: 'feat/too-late' });
    expect(result.isError).toBe(true);
    expect.soft(text(result)).toContain('branch is fixed');
    expect.soft(run.branch).toBeUndefined();
  });

  test('a git failure names the layer and the recovery path', async ({ run }) => {
    // projectDir is not a git repo — the git layer fails.
    const { call } = harness(run);
    const result = await call('create_branch', { name: 'feat/no-repo' });

    expect(result.isError).toBe(true);
    expect.soft(text(result)).toContain('git layer');
    expect.soft(text(result)).toContain('ask_human');
  });
});

describe('advance_phase (the gate packet)', () => {
  test('refuses in a review-loop phase before any review round', async ({ run }) => {
    const { call, outcome } = harness(run, { phase: 'spec' });
    const result = await call('advance_phase', { summary: 'all good', artifacts: [] });

    expect(result.isError).toBe(true);
    expect.soft(text(result)).toContain('No review round has run');
    expect.soft(outcome.advanceRequested).toBe(false);
  });

  test('records the gate packet and reports a live gate ahead', async ({ projectDir, run }) => {
    run.rounds.spec = 2;
    const { call, outcome } = harness(run, { phase: 'spec' });
    const result = await call('advance_phase', {
      summary: 'reviewer flagged X, fixed; Y rejected with rationale',
      artifacts: ['docs/specs/feature.md'],
      spec_path: 'docs/specs/feature.md',
    });

    expect.soft(outcome.advanceRequested).toBe(true);
    expect.soft(text(result)).toContain('the run moves to the human gate');
    const persisted = loadRunState(projectDir, run.runId);
    expect.soft(persisted.phaseSummaries.spec?.summary).toContain('reviewer flagged X');
    expect.soft(persisted.specPath).toBe('docs/specs/feature.md');
  });

  test('a pre-authorized gate is reported as auto-crossing, not as a live decision', async ({ run }) => {
    run.gatesAt = ['pr'];
    run.rounds.spec = 1;
    const { call } = harness(run, { phase: 'spec' });
    const result = await call('advance_phase', { summary: 'converged', artifacts: [] });

    expect(text(result)).toContain('pre-authorized');
    expect(text(result)).not.toContain('gate decision arrives');
  });

  test('synthesis phases may advance without a review round; open completes the run', async ({ run }) => {
    const frame = harness(run, { phase: 'frame' });
    const frameResult = await frame.call('advance_phase', { summary: 'direction', artifacts: [] });
    expect(frameResult.isError).toBeUndefined();

    const open = harness(run, { phase: 'open' });
    const openResult = await open.call('advance_phase', { summary: 'PR: https://example.com/pr/1', artifacts: [] });
    expect(text(openResult)).toContain('the run is complete');
  });
});

describe('the library and the journal', () => {
  test('list_snippets annotates templates already sent this phase', async ({ run }) => {
    const { call } = harness(run);
    await call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'template' });

    const library = text(await call('list_snippets'));
    expect(library).toContain('<snippet key="review-spec" already_sent_this_phase_to="reviewer">');
  });

  test('propose_snippet_edit queues for the end-of-run review, never applies now', async ({ projectDir, run }) => {
    const { call } = harness(run);
    const result = await call('propose_snippet_edit', {
      snippet_key: 'review-spec',
      proposed_body: 'better body',
      rationale: 'kept missing the data model',
    });

    expect.soft(text(result)).toContain('Proposal queued (1 pending)');
    expect.soft(loadRunState(projectDir, run.runId).snippetProposals).toHaveLength(1);
  });

  test('write_note appends to the shared notes journal', async ({ projectDir, run }) => {
    const { call } = harness(run);
    await call('write_note', { observation: 'review-spec did not fit a refactor-only change' });

    const notes = readFileSync(join(runDirOf(projectDir, run.runId), 'notes.md'), 'utf8');
    expect(notes).toContain('[orchestrator] review-spec did not fit a refactor-only change');
  });
});

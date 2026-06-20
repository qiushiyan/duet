import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { describe, expect, vi } from 'vitest';
import { z } from 'zod';
import { buildPhaseBrief } from '../src/harness/orchestrator-prompts.ts';
import { createPhaseTools } from '../src/harness/tools.ts';
import type { KernelTool } from '../src/harness/tools.ts';
import type { PhaseName } from '../src/phases.ts';
import { listPendingSteers, loadRunState, runDirOf, saveRunState, stageHumanInput, stageSteer } from '../src/run-store.ts';
import type { RunState } from '../src/run-store.ts';
import { FakeWorker, test } from './helpers/fixtures.ts';
import { claudeApiRetry, claudeUserToolResult, jsonl, plantClaudeTranscript } from './helpers/transcripts.ts';

/**
 * The protocol rails, tested through the orchestrator's real interface: the
 * tool handlers themselves. Workers are FakeWorker adapters on the
 * WorkerProvider seam; the filesystem is the run dir fixture.
 */

type ToolResult = Awaited<ReturnType<KernelTool['handler']>>;

function harness(
  run: RunState,
  opts: { phase?: PhaseName; stagedAnswer?: string; implementer?: FakeWorker; reviewer?: FakeWorker; home?: string } = {},
) {
  const implementer = opts.implementer ?? new FakeWorker('claude');
  const reviewer = opts.reviewer ?? new FakeWorker('codex');
  const lines: string[] = [];
  const { tools } = createPhaseTools({
    state: run,
    phase: opts.phase ?? 'spec',
    providers: { implementer, reviewer },
    log: (line) => lines.push(line),
    ...(opts.stagedAnswer !== undefined ? { stagedAnswer: opts.stagedAnswer } : {}),
    ...(opts.home !== undefined ? { home: opts.home } : {}),
  });
  const call = (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no such tool: ${name}`);
    return tool.handler(args as never, {});
  };
  // The terminal decision now lives on the run state the handlers mutate (the
  // persisted marker), not a returned outcome flag — assertions read run.terminalMarker.
  return { call, implementer, reviewer, lines };
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
    // The claude turn reported a cost and the codex turn never counts toward it,
    // so the known total is complete.
    expect.soft(persisted.costs.claudeWorkersCostPartial).toBe(false);
  });

  test('a claude turn reporting no cost marks the total partial (P5: unavailable, not faked)', async ({
    projectDir,
    run,
  }) => {
    const implementer = new FakeWorker('claude'); // default script → no costUsd, like an interactive turn
    const { call } = harness(run, { implementer });
    await call('send_prompt', { role: 'implementer', tag: 'write-spec', body: 'draft' });

    const persisted = loadRunState(projectDir, run.runId);
    expect.soft(persisted.costs.claudeWorkersCostPartial).toBe(true);
    expect.soft(persisted.costs.claudeWorkersUsd).toBe(0);
  });

  test('logs both sides of the exchange into the voice log', async ({ projectDir, run }) => {
    const { call } = harness(run);
    await call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'review the spec' });

    const log = readFileSync(join(runDirOf(projectDir, run.runId), 'reviewer.log'), 'utf8');
    expect.soft(log).toContain('◀ prompt (tag=review-spec, from orchestrator)');
    expect.soft(log).toContain('review the spec');
    expect.soft(log).toContain('▶ response (session session-1)');
  });

  test('a turn reporting context fill records the hint, the sidecar, and the voice-log suffix', async ({
    projectDir,
    run,
  }) => {
    const reviewer = new FakeWorker('codex', [{ context: { usedTokens: 62_228, windowTokens: 258_400 } }]);
    const { call } = harness(run, { reviewer });
    await call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'review' });

    const persisted = loadRunState(projectDir, run.runId);
    expect.soft(persisted.contextUsage?.reviewer).toMatchObject({ usedTokens: 62_228, windowTokens: 258_400 });
    expect
      .soft(readFileSync(join(runDirOf(projectDir, run.runId), 'context', 'reviewer'), 'utf8'))
      .toBe('24%\n');
    expect
      .soft(readFileSync(join(runDirOf(projectDir, run.runId), 'reviewer.log'), 'utf8'))
      .toContain('▶ response (session session-1) · context 24%');
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

describe('send_prompt activeTurns hint (the persisted in-flight signal, #2)', () => {
  test('sets activeTurns at turn start and clears it in finally', async ({ run, projectDir }) => {
    let finish!: (t: { text: string; sessionId: string }) => void;
    const slow = new FakeWorker('claude');
    slow.runTurn = () => new Promise((r) => (finish = r));
    const { call } = harness(run, { implementer: slow });

    const pending = call('send_prompt', { role: 'implementer', tag: 'write-spec', body: 'draft' });
    // Mid-turn: a separate doctor process can read the in-flight role off disk.
    expect.soft(loadRunState(projectDir, run.runId).activeTurns?.implementer).toMatchObject({ tag: 'write-spec' });

    finish({ text: 'done', sessionId: 's' });
    await pending;
    expect.soft(loadRunState(projectDir, run.runId).activeTurns?.implementer).toBeUndefined();
  });

  test('clears activeTurns even when the turn fails', async ({ run, projectDir }) => {
    const boom = new FakeWorker('claude', [new Error('spawn claude ENOENT')]);
    const { call } = harness(run, { implementer: boom });
    await call('send_prompt', { role: 'implementer', tag: 'write-spec', body: 'draft' });
    expect(loadRunState(projectDir, run.runId).activeTurns?.implementer).toBeUndefined();
  });

  test('parallel cross-role sends each set their own entry without clobbering (fresh-merge)', async ({ run, projectDir }) => {
    let finishImpl!: (t: { text: string; sessionId: string }) => void;
    let finishRev!: (t: { text: string; sessionId: string }) => void;
    const impl = new FakeWorker('claude');
    impl.runTurn = () => new Promise((r) => (finishImpl = r));
    const rev = new FakeWorker('codex');
    rev.runTurn = () => new Promise((r) => (finishRev = r));
    const { call } = harness(run, { implementer: impl, reviewer: rev });

    const a = call('send_prompt', { role: 'implementer', tag: 'write-spec', body: 'x' });
    const b = call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'y' });
    const mid = loadRunState(projectDir, run.runId).activeTurns;
    expect.soft(mid?.implementer).toMatchObject({ tag: 'write-spec' });
    expect.soft(mid?.reviewer).toMatchObject({ tag: 'review-spec' });

    finishImpl({ text: 'i', sessionId: 'si' });
    finishRev({ text: 'r', sessionId: 'sr' });
    await Promise.all([a, b]);
    const after = loadRunState(projectDir, run.runId).activeTurns ?? {};
    expect.soft(after.implementer).toBeUndefined();
    expect.soft(after.reviewer).toBeUndefined();
  });
});

describe('send_prompt heartbeat enrichment (#2 — best-effort)', () => {
  test('once a session exists, the heartbeat carries transcript recency + retry count', async ({ run, projectDir, onTestFinished }) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const base = Date.parse('2026-06-20T12:00:00.000Z');
    vi.setSystemTime(base);
    const home = join(projectDir, 'home');
    run.workerSessions = { implementer: 'impl-1' }; // not the first turn
    saveRunState(run);
    plantClaudeTranscript(
      home,
      'impl-1',
      jsonl(claudeUserToolResult({ ts: new Date(base).toISOString() }), claudeApiRetry({ ts: new Date(base + 10_000).toISOString() })),
    );

    let finish!: (t: { text: string; sessionId: string }) => void;
    const slow = new FakeWorker('claude');
    slow.runTurn = () => new Promise((r) => (finish = r));
    const { call, lines } = harness(run, { implementer: slow, home });
    const pending = call('send_prompt', { role: 'implementer', tag: 'tdd-plan', body: 'plan' });
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    const hb = lines.find((l) => l.includes('⏳ implementer turn running — 5m elapsed'));
    expect.soft(hb).toContain('last activity');
    expect.soft(hb).toContain('RETRYING (1 retries)'); // the count, never a fabricated class

    finish({ text: 'done', sessionId: 'impl-1' });
    await pending;
  });

  test('the first turn (no session id yet) stays elapsed-only', async ({ run, onTestFinished }) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    let finish!: (t: { text: string; sessionId: string }) => void;
    const slow = new FakeWorker('claude');
    slow.runTurn = () => new Promise((r) => (finish = r));
    const { call, lines } = harness(run, { implementer: slow }); // fresh run: no workerSessions
    const pending = call('send_prompt', { role: 'implementer', tag: 'write-spec', body: 'draft' });
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    const hb = lines.find((l) => l.includes('⏳ implementer turn running — 5m elapsed'));
    expect.soft(hb).toBeDefined();
    expect.soft(hb).not.toContain('last activity');
    expect.soft(hb).not.toContain('retries');

    finish({ text: 'done', sessionId: 'impl-1' });
    await pending;
  });

  test('a missing transcript degrades to elapsed-only and the turn still succeeds', async ({ run, projectDir, onTestFinished }) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const home = join(projectDir, 'home'); // nothing planted
    run.workerSessions = { implementer: 'missing-id' };
    saveRunState(run);

    let finish!: (t: { text: string; sessionId: string }) => void;
    const slow = new FakeWorker('claude');
    slow.runTurn = () => new Promise((r) => (finish = r));
    const { call, lines } = harness(run, { implementer: slow, home });
    const pending = call('send_prompt', { role: 'implementer', tag: 'tdd-plan', body: 'x' });
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    const hb = lines.find((l) => l.includes('⏳ implementer turn running — 5m elapsed'));
    expect.soft(hb).toBeDefined();
    expect.soft(hb).not.toContain('last activity'); // no readable transcript → no suffix, no throw

    finish({ text: 'done', sessionId: 'impl-1' });
    const result = await pending;
    expect.soft(result.isError).toBeFalsy();
  });
});

describe('parallel worker turns (cross-role concurrent, same-role serial)', () => {
  /** A worker whose turns resolve only when the test says so. */
  function slowWorker(name: 'claude' | 'codex') {
    const worker = new FakeWorker(name);
    const finishers: Array<(turn: { text: string; sessionId: string }) => void> = [];
    worker.runTurn = (opts) => {
      worker.calls.push(opts);
      return new Promise((resolve) => finishers.push(resolve));
    };
    return { worker, finish: (i = 0) => finishers[i]!({ text: 'done', sessionId: `s${i}` }) };
  }

  test('turns to different roles genuinely overlap', async ({ run }) => {
    const impl = slowWorker('claude');
    const rev = slowWorker('codex');
    const { call } = harness(run, { implementer: impl.worker, reviewer: rev.worker });

    const implTurn = call('send_prompt', { role: 'implementer', tag: 'think-holistic', body: 'analyze' });
    const revTurn = call('send_prompt', { role: 'reviewer', tag: 'think-holistic', body: 'analyze' });
    await new Promise((r) => setTimeout(r, 0));

    // Both workers received their prompt while neither turn has finished.
    expect.soft(impl.worker.calls).toHaveLength(1);
    expect.soft(rev.worker.calls).toHaveLength(1);

    impl.finish();
    rev.finish();
    const [implResult, revResult] = await Promise.all([implTurn, revTurn]);
    expect.soft(implResult.isError).toBeUndefined();
    expect.soft(revResult.isError).toBeUndefined();
  });

  test('a second turn to the same role is refused while one is in flight, and legal after it returns', async ({
    run,
  }) => {
    const impl = slowWorker('claude');
    const { call } = harness(run, { implementer: impl.worker });

    const first = call('send_prompt', { role: 'implementer', tag: 'custom', body: 'turn one' });
    await new Promise((r) => setTimeout(r, 0));
    const refused = await call('send_prompt', { role: 'implementer', tag: 'custom', body: 'turn two' });

    expect.soft(refused.isError).toBe(true);
    expect.soft(text(refused)).toContain('already in flight');
    expect.soft(text(refused)).toContain('one persistent session');
    expect.soft(impl.worker.calls).toHaveLength(1); // the second prompt never reached the worker

    impl.finish();
    await first;
    const after = call('send_prompt', { role: 'implementer', tag: 'custom', body: 'turn two, again' });
    await new Promise((r) => setTimeout(r, 0));
    impl.finish(1);
    expect((await after).isError).toBeUndefined();
  });

  test('send_prompt and list_snippets carry the concurrency annotation the CLI scheduler reads', ({ run }) => {
    // readOnlyHint is the concurrency hint, not a purity claim — the claude
    // CLI serializes MCP tools without it (see the note in tools.ts). Losing
    // the annotation would silently re-serialize parallel worker turns.
    const { tools } = createPhaseTools({
      state: run,
      phase: 'frame',
      providers: { implementer: new FakeWorker('claude'), reviewer: new FakeWorker('codex') },
      log: () => {},
    });
    for (const name of ['send_prompt', 'list_snippets']) {
      expect.soft(tools.find((t) => t.name === name)?.annotations?.readOnlyHint, name).toBe(true);
    }
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
    const { call } = harness(run);
    const result = await call('ask_human', { question: 'ship behind a flag?', context: 'billing implications' });

    // The flag marker rides the same atomic write as the question.
    expect.soft(run.terminalMarker).toEqual({ phase: 'spec', kind: 'flag' });
    expect.soft(text(result)).toContain('End your turn');
    // Persisted at the moment of the call — the human-visible artifact
    // exists before the model regains control.
    const persisted = loadRunState(projectDir, run.runId);
    expect.soft(persisted.pendingQuestion).toEqual({
      question: 'ship behind a flag?',
      context: 'billing implications',
      cause: 'human', // ask_human flags are human-owned (#4a)
    });
    expect.soft(persisted.terminalMarker).toEqual({ phase: 'spec', kind: 'flag' });
  });

  test('a staged answer feeds the first ask_human without pausing; the next one queues', async ({ run }) => {
    const { call } = harness(run, { stagedAnswer: 'yes, behind a flag' });

    const first = await call('ask_human', { question: 'ship behind a flag?' });
    expect.soft(text(first)).toBe('The human answered: yes, behind a flag');
    // The staged-answer fast-path is NOT terminal — no marker, the phase continues.
    expect.soft(run.terminalMarker).toBeUndefined();

    await call('ask_human', { question: 'a second question' });
    expect(run.terminalMarker).toEqual({ phase: 'spec', kind: 'flag' });
  });

  test('first-terminal-wins: a second terminal call after one is recorded is refused', async ({ run }) => {
    const { call } = harness(run, { phase: 'frame' }); // frame has no review-round requirement
    const first = await call('advance_phase', { summary: 'done', artifacts: [] });
    expect.soft(first.isError).toBeUndefined();
    expect.soft(run.terminalMarker).toEqual({ phase: 'frame', kind: 'advance' });

    // The phase is already ending — ask_human now is refused, and the marker
    // stays the first decision (advance), so exactly one phase.* event emits.
    const second = await call('ask_human', { question: 'wait, actually?' });
    expect.soft(second.isError).toBe(true);
    expect.soft(text(second)).toContain('already ending');
    expect.soft(run.terminalMarker).toEqual({ phase: 'frame', kind: 'advance' });
  });
});

describe('advance_phase human_decisions (signal-only gate-decision echo, #3)', () => {
  test('persists the decisions onto the gate packet', async ({ projectDir, run }) => {
    const { call } = harness(run, { phase: 'frame' });
    await call('advance_phase', { summary: 's', artifacts: [], human_decisions: [{ title: 'pick the backend', severity: 'low' }] });
    expect(loadRunState(projectDir, run.runId).phaseSummaries.frame?.humanDecisions).toEqual([
      { title: 'pick the backend', severity: 'low' },
    ]);
  });

  test('omits the field when no decisions are passed (additive)', async ({ projectDir, run }) => {
    const { call } = harness(run, { phase: 'frame' });
    await call('advance_phase', { summary: 's', artifacts: [] });
    expect(loadRunState(projectDir, run.runId).phaseSummaries.frame).not.toHaveProperty('humanDecisions');
  });

  test('is signal-only: a high decision does not change the terminal decision (gate-crossing unaffected)', async ({ run }) => {
    const { call } = harness(run, { phase: 'frame' });
    const result = await call('advance_phase', { summary: 's', artifacts: [], human_decisions: [{ title: 'storage backend', severity: 'high' }] });
    expect.soft(result.isError).toBeUndefined();
    // The terminal marker is the normal advance — a high decision neither holds
    // nor crosses; only the human's tap crosses, and the marker is unchanged.
    expect.soft(run.terminalMarker).toEqual({ phase: 'frame', kind: 'advance' });
  });

  test('the schema rejects a severity outside low|high', ({ run }) => {
    const { tools } = createPhaseTools({ state: run, phase: 'frame', providers: { implementer: new FakeWorker('claude'), reviewer: new FakeWorker('codex') }, log: () => {} });
    const schema = z.object(tools.find((t) => t.name === 'advance_phase')!.inputSchema);
    expect.soft(schema.safeParse({ summary: 's', artifacts: [], human_decisions: [{ title: 't', severity: 'urgent' }] }).success).toBe(false);
    expect.soft(schema.safeParse({ summary: 's', artifacts: [], human_decisions: [{ title: 't', severity: 'high' }] }).success).toBe(true);
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
    const { call } = harness(run, { phase: 'spec' });
    const result = await call('advance_phase', { summary: 'all good', artifacts: [] });

    expect(result.isError).toBe(true);
    expect.soft(text(result)).toContain('No review round has run');
    expect.soft(run.terminalMarker).toBeUndefined();
  });

  test('records the gate packet and reports a live gate ahead', async ({ projectDir, run }) => {
    run.rounds.spec = 2;
    const { call } = harness(run, { phase: 'spec' });
    const result = await call('advance_phase', {
      summary: 'reviewer flagged X, fixed; Y rejected with rationale',
      artifacts: ['docs/specs/feature.md'],
      spec_path: 'docs/specs/feature.md',
    });

    expect.soft(run.terminalMarker).toEqual({ phase: 'spec', kind: 'advance' });
    expect.soft(text(result)).toContain('the run moves to the human gate');
    const persisted = loadRunState(projectDir, run.runId);
    expect.soft(persisted.phaseSummaries.spec?.summary).toContain('reviewer flagged X');
    expect.soft(persisted.specPath).toBe('docs/specs/feature.md');
    // The advance marker is persisted atomically with the gate packet.
    expect.soft(persisted.terminalMarker).toEqual({ phase: 'spec', kind: 'advance' });
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

describe('steer delivery (every phase-continuing tool result)', () => {
  const blockOf = (result: ToolResult): string =>
    result.content
      .map((c) => (c as { text?: string }).text ?? '')
      .filter((t) => t.includes('<human_steer'))
      .join('\n');

  test('a staged steer arrives on the next tool result, verbatim and tagged — then never twice', async ({
    run,
  }) => {
    const { call } = harness(run);
    const steer = stageSteer(run, 'drop the retry tests');

    const first = await call('write_note', { observation: 'n1' });
    const block = blockOf(first);
    expect.soft(block).toContain(`<human_steer staged_at="${steer.stagedAt}">`);
    expect.soft(block).toContain('drop the retry tests');
    expect.soft(block).toContain('editor-in-chief');
    expect.soft(listPendingSteers(run)).toEqual([]);

    const second = await call('write_note', { observation: 'n2' });
    expect(blockOf(second)).toBe('');
  });

  test('delivery rides refusal results too', async ({ run }) => {
    const { call } = harness(run);
    const args = { role: 'reviewer', tag: 'review-spec', body: 'full template' };
    await call('send_prompt', args);

    stageSteer(run, 'mid-phase note');
    const refusal = await call('send_prompt', args); // the warn-once template refusal
    expect.soft(refusal.isError).toBe(true);
    expect.soft(blockOf(refusal)).toContain('mid-phase note');
  });

  test('multiple staged steers deliver together, in staging order', async ({ run }) => {
    const { call } = harness(run);
    stageSteer(run, 'first note');
    stageSteer(run, 'second note');

    const block = blockOf(await call('write_note', { observation: 'n' }));
    expect.soft(block).toContain('first note');
    expect.soft(block).toContain('second note');
    expect.soft(block.indexOf('first note')).toBeLessThan(block.indexOf('second note'));
  });

  test('a steer staged while a worker turn is in flight lands on that turn’s own result', async ({ run }) => {
    let finish!: (turn: { text: string; sessionId: string }) => void;
    const slow = new FakeWorker('codex');
    slow.runTurn = () => new Promise((resolve) => (finish = resolve));
    const { call } = harness(run, { reviewer: slow });

    const pending = call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'review' });
    await new Promise((r) => setTimeout(r, 0)); // let the turn start
    stageSteer(run, 'staged mid-turn');
    finish({ text: 'done', sessionId: 's' });

    expect(blockOf(await pending)).toContain('staged mid-turn');
  });

  test('advance_phase’s acknowledgement never carries steers — they stay pending for carry-forward', async ({
    run,
  }) => {
    const { call } = harness(run, { phase: 'frame' });
    stageSteer(run, 'arrived during the final call');

    const ack = await call('advance_phase', { summary: 'done', artifacts: [] });
    expect.soft(blockOf(ack)).toBe('');
    expect.soft(listPendingSteers(run).map((s) => s.text)).toEqual(['arrived during the final call']);
  });

  test('a queued ask_human’s acknowledgement never carries steers — they stay pending', async ({ run }) => {
    const { call } = harness(run);
    stageSteer(run, 'arrived as the run paused');

    const ack = await call('ask_human', { question: 'scope?' });
    expect.soft(blockOf(ack)).toBe('');
    expect.soft(listPendingSteers(run)).toHaveLength(1);
  });

  test('ask_human answered from a staged answer continues the phase — and does deliver', async ({ run }) => {
    const { call } = harness(run, { stagedAnswer: 'narrow it' });
    stageSteer(run, 'also: keep the old name');

    const result = await call('ask_human', { question: 'scope?' });
    expect.soft(blockOf(result)).toContain('keep the old name');
    expect.soft(listPendingSteers(run)).toEqual([]);
  });

  test('delivery lands in the orchestrator voice log', async ({ projectDir, run }) => {
    const { call } = harness(run);
    stageSteer(run, 'logged note');
    await call('write_note', { observation: 'n' });

    const log = readFileSync(join(runDirOf(projectDir, run.runId), 'orchestrator.log'), 'utf8');
    expect.soft(log).toContain('human steer delivered');
    expect.soft(log).toContain('logged note');
  });
});

describe('get_task (the brief surface, side-effecting exactly-once)', () => {
  test('mid-phase, folds a staged input once and marks phaseStarted; a later call returns the base brief alone', async ({
    projectDir,
    run,
  }) => {
    stageHumanInput(run, { kind: 'approval', text: 'agreed — cap questions at 3' });
    const { call } = harness(run, { phase: 'spec' });

    const first = await call('get_task');
    expect.soft(first.isError).toBeUndefined();
    expect.soft(text(first)).toContain('Draft the spec'); // the spec entry brief, in full
    expect.soft(text(first)).toContain('<approval_rider>'); // the staged input, folded as a block
    expect.soft(text(first)).toContain('cap questions at 3');
    expect.soft(run.phaseStarted.spec).toBe(true);
    // Consumed once and persisted — a crash can't replay it.
    expect.soft(loadRunState(projectDir, run.runId).pendingMessage).toBeUndefined();

    const second = await call('get_task');
    // The base brief, byte-equal to the renderer, with nothing left to fold.
    expect.soft(text(second)).toBe(buildPhaseBrief(run, 'spec'));
    expect.soft(text(second)).not.toContain('<approval_rider>');
    expect.soft(run.phaseStarted.spec).toBe(true); // still set once
  });

  test('same-phase re-entry: a freshly staged reject/answer folds even though the phase is long started', async ({
    run,
  }) => {
    run.phaseStarted.spec = true; // the phase has been running for a while
    const { call } = harness(run, { phase: 'spec' });
    stageHumanInput(run, { kind: 'feedback', text: 'invert the scope' });

    const folded = await call('get_task');
    expect.soft(text(folded)).toContain('Draft the spec'); // the brief, in full
    expect.soft(text(folded)).toContain('invert the scope'); // the feedback, folded
    expect.soft(text(folded)).toContain('editor-in-chief');

    const after = await call('get_task');
    expect.soft(text(after)).toBe(buildPhaseBrief(run, 'spec')); // consumed once
  });

  test('parked at a gate, it reports the park and performs no side effect', async ({ run }) => {
    run.terminalMarker = { phase: 'spec', kind: 'advance' };
    stageHumanInput(run, { kind: 'feedback', text: 'should not be consumed' });
    delete run.phaseStarted.spec;
    const { call } = harness(run, { phase: 'spec' });

    const parked = await call('get_task');
    expect.soft(text(parked)).toContain('parked at its gate');
    expect.soft(text(parked)).toContain('duet continue');
    // No side effects: the phase is not marked started, the input not consumed.
    expect.soft(run.phaseStarted.spec).toBeUndefined();
    expect.soft(run.pendingMessage).toEqual({ kind: 'feedback', text: 'should not be consumed' });
  });

  test('parked at a flag, it points at the answer channel', async ({ run }) => {
    run.terminalMarker = { phase: 'spec', kind: 'flag' };
    const { call } = harness(run, { phase: 'spec' });
    const parked = await call('get_task');
    expect.soft(text(parked)).toContain('queued question');
    expect.soft(text(parked)).toContain('--answer');
  });

  test('carries no readOnlyHint — it mutates', ({ run }) => {
    const { tools } = createPhaseTools({
      state: run,
      phase: 'spec',
      providers: { implementer: new FakeWorker('claude'), reviewer: new FakeWorker('codex') },
      log: () => {},
    });
    expect(tools.find((t) => t.name === 'get_task')?.annotations?.readOnlyHint).toBeUndefined();
  });
});

describe('the post-terminal quiescence rail', () => {
  test('every phase-continuing tool is refused once this phase’s terminal marker is set, with no side effect', async ({
    projectDir,
    run,
  }) => {
    await execa('git', ['init', '-b', 'main'], { cwd: projectDir });
    run.terminalMarker = { phase: 'spec', kind: 'advance' };
    const implementer = new FakeWorker('claude');
    const reviewer = new FakeWorker('codex');
    const { call } = harness(run, { phase: 'spec', implementer, reviewer });

    for (const [name, args] of [
      ['send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'x' }],
      ['list_snippets', {}],
      ['create_branch', { name: 'feat/nope' }],
      ['propose_snippet_edit', { snippet_key: 'k', proposed_body: 'b', rationale: 'r' }],
      ['write_note', { observation: 'n' }],
    ] as const) {
      const result = await call(name, args);
      expect.soft(result.isError, name).toBe(true);
      expect.soft(text(result), name).toContain(`${name} is refused here`);
    }
    // None of them ran: no worker turn, no branch, no proposal, no note.
    expect.soft(implementer.calls).toHaveLength(0);
    expect.soft(reviewer.calls).toHaveLength(0);
    expect.soft(run.branch).toBeUndefined();
    const persisted = loadRunState(projectDir, run.runId);
    expect.soft(persisted.snippetProposals).toHaveLength(0);

    // The status/re-anchor read stays open.
    expect.soft((await call('get_task')).isError).toBeUndefined();
  });

  test('is a no-op with no marker, and with a stale marker from a different phase', async ({ run }) => {
    const noMarker = harness(run, { phase: 'spec' });
    expect.soft((await noMarker.call('write_note', { observation: 'runs fine' })).isError).toBeUndefined();

    run.terminalMarker = { phase: 'frame', kind: 'advance' }; // foreign to spec
    const stale = harness(run, { phase: 'spec' });
    const result = await stale.call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'x' });
    expect.soft(result.isError).toBeUndefined(); // the stale marker does not refuse this phase's work
    expect.soft(text(result)).toBe('scripted response');
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

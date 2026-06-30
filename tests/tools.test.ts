import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { describe, expect, vi } from 'vitest';
import { z } from 'zod';
import { CONSULTANT_IDENTITY_CLAUSE, ORCHESTRATOR_SYSTEM_PROMPT, buildPhaseBrief, orchestratorSystemPrompt } from '../src/harness/orchestrator-prompts.ts';
import {
  COMPACT_TIMEOUT_MS,
  block,
  contractCheckpointRail,
  createPhaseTools,
  error,
  firstRefusal,
  isCompactBody,
  ok,
  perTurnTimeoutFor,
  orphanRail,
  pendingTurnGateRail,
  projectDetail,
  refuse,
  result,
  reviewCapRail,
  sameRoleInFlightRail,
  stageSessionId,
  terminalAlreadySetRail,
  verifyCheckpointRail,
  warnOnceTemplateRail,
} from '../src/harness/tools.ts';
import type { KernelTool, RailCtx } from '../src/harness/tools.ts';
import { LESSONS_DIR } from '../src/snippets.ts';
import { createTurnDispatcher } from '../src/harness/turn-dispatcher.ts';
import type { TurnDispatcher } from '../src/harness/turn-dispatcher.ts';
import { BudgetCutoffError } from '../src/providers/types.ts';
import type { WorkerRole } from '../src/providers/types.ts';
import { PHASE } from '../src/phases.ts';
import type { PhaseName } from '../src/phases.ts';
import { createRun, loadRunState, markPendingTurn, runDirOf, saveRunState, stageHumanInput } from '../src/run-store.ts';
import { listPendingSteers, stageSteer } from '../src/steer-store.ts';
import type { RunState } from '../src/run-store.ts';
import { DEFAULT_BINDINGS } from '../src/config.ts';
import { DeferredWorker, FakeWorker, SyncThrowWorker, consultantBindings, test } from './helpers/fixtures.ts';
import { claudeApiRetry, claudeToolUse, claudeUserToolResult, codexExecCommand, jsonl, plantClaudeTranscript, plantCodexRollout } from './helpers/transcripts.ts';

/**
 * The protocol rails, tested through the orchestrator's real interface: the
 * tool handlers themselves. Workers are FakeWorker adapters on the
 * WorkerProvider seam; the filesystem is the run dir fixture.
 */

type ToolResult = Awaited<ReturnType<KernelTool['handler']>>;

interface HarnessOpts {
  phase?: PhaseName;
  stagedAnswer?: string;
  implementer?: FakeWorker | DeferredWorker | SyncThrowWorker;
  reviewer?: FakeWorker | DeferredWorker | SyncThrowWorker;
  /** The optional consultant worker — present only when the run binds one. */
  consultant?: FakeWorker | DeferredWorker | SyncThrowWorker;
  home?: string;
  /** Turn on the interactive async path: send_prompt dispatches, check_turns collects. */
  async?: boolean;
  /** The dispatcher's lease check (the background-settle fence); defaults to always-held. */
  holdsLease?: () => boolean;
  /** Seed the in-memory same-role-in-flight set (the `rails` injection seam). Test-only:
   *  absent → the factory gets no `rails` and owns a fresh pair, exactly as production. */
  turnsInFlight?: Set<WorkerRole>;
}

function harness(run: RunState, opts: HarnessOpts = {}) {
  const implementer = opts.implementer ?? new FakeWorker('claude');
  const reviewer = opts.reviewer ?? new FakeWorker('codex');
  const providers = { implementer, reviewer, ...(opts.consultant ? { consultant: opts.consultant } : {}) };
  const phase = opts.phase ?? 'spec';
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  // The interactive host injects a real dispatcher (the same module production
  // wires into ctx) — not a mock; its presence is the host switch.
  const dispatcher: TurnDispatcher | undefined = opts.async
    ? createTurnDispatcher({
        state: run,
        phase,
        cap: PHASE[phase].roundCap,
        providers,
        log,
        ...(opts.home !== undefined ? { home: opts.home } : {}),
        holdsLease: opts.holdsLease ?? (() => true),
      })
    : undefined;
  const { tools } = createPhaseTools({
    state: run,
    phase,
    providers,
    log,
    ...(opts.stagedAnswer !== undefined ? { stagedAnswer: opts.stagedAnswer } : {}),
    ...(opts.home !== undefined ? { home: opts.home } : {}),
    ...(dispatcher ? { async: { dispatcher } } : {}),
    ...(opts.turnsInFlight ? { rails: { turnsInFlight: opts.turnsInFlight, resendWarned: new Set<string>() } } : {}),
  });
  const call = (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no such tool: ${name}`);
    return tool.handler(args as never, {});
  };
  // The terminal decision now lives on the run state the handlers mutate (the
  // persisted marker), not a returned outcome flag — assertions read run.terminalMarker.
  return { call, implementer, reviewer, consultant: opts.consultant, lines, dispatcher };
}

/** Let a DeferredWorker's just-resolved settle continuation drain (microtask flush). */
const flush = () => new Promise((r) => setTimeout(r, 0));

const text = (result: ToolResult): string => (result.content[0] as { text: string }).text;

// A default rail context for the rail unit tests; `over` patches the fields a case cares about.
const railCtx = (state: RunState, over: Partial<RailCtx> = {}): RailCtx => ({
  state,
  phase: 'spec',
  cap: 3,
  // Default to the async host (a dispatcher present) — the common case for these
  // rails. The blocking host (asyncHost:false) is exercised explicitly below.
  asyncHost: true,
  inFlight: () => false,
  orphanedOnDisk: () => false,
  sentThisPhase: () => [],
  resendWarned: new Set<string>(),
  clearOrphan: () => {},
  log: () => {},
  ...over,
});

// The result-builder contract (#1-floor): the 58 hand-built envelopes collapsed
// onto these. The compile-time guarantee — `refuse()` with no text is a type
// error — is pinned by `pnpm typecheck`, not here; these characterize the
// runtime shapes (multi-block success, the two kinds of isError, the
// conditional flag).
describe('result builders', () => {
  test('ok is a multi-block success with no isError flag', () => {
    const r = ok(block('a'), block('b'));
    expect(r).toEqual({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] });
    expect('isError' in r).toBe(false);
  });

  test('refuse and error both produce the isError:true envelope (their only difference — refuse rejects empty text — is the compile-time guarantee above)', () => {
    expect(refuse('next move here')).toEqual({ content: [{ type: 'text', text: 'next move here' }], isError: true });
    expect(error(block('the turn failed'))).toEqual({ content: [{ type: 'text', text: 'the turn failed' }], isError: true });
  });

  test('result sets the flag only when isError is truthy, else omits it', () => {
    const errored = result([block('x')], { isError: true });
    expect(errored).toEqual({ content: [{ type: 'text', text: 'x' }], isError: true });
    const clean = result([block('x')], { isError: false });
    expect(clean).toEqual({ content: [{ type: 'text', text: 'x' }] });
    expect('isError' in clean).toBe(false);
  });
});

describe('isCompactBody / perTurnTimeoutFor (S7 — the body-derived compact rule)', () => {
  test('a /compact body (leading whitespace tolerated) is compact and gets the short cap', () => {
    expect.soft(isCompactBody('/compact keep the spec, drop the journey')).toBe(true);
    expect.soft(isCompactBody('  /compact foo')).toBe(true);
    expect.soft(perTurnTimeoutFor('/compact foo')).toBe(COMPACT_TIMEOUT_MS);
    expect.soft(COMPACT_TIMEOUT_MS).toBe(8 * 60_000);
  });

  test('a normal body is not compact and gets no override (the phase cap stands)', () => {
    expect.soft(isCompactBody('review the spec')).toBe(false);
    expect.soft(isCompactBody('please run /compact later')).toBe(false); // not at the start
    expect.soft(perTurnTimeoutFor('review the spec')).toBeUndefined();
  });
});

// The named rails as an INTERNAL SEAM of the tools deep module (#1-deep). These
// are additive — the no-regression oracle is the full-handler tests below; these
// characterize each rail's negative-space case and the load-bearing order. The
// boolean oracles are the rails' injected dependency (a real
// dispatcher/turnsInFlight-derived adapter in production, a stub here) — mocking
// at the seam, not our own module.
describe('rails (the #1-deep internal-seam surface)', () => {

  test('sameRoleInFlightRail refuses a live same-role send, passes otherwise', ({ run }) => {
    const live = sameRoleInFlightRail({ role: 'reviewer', tag: 'x', isReviewRound: false }, railCtx(run, { inFlight: () => true }));
    expect(live?.isError).toBe(true);
    expect(text(live!)).toContain('already in flight');
    expect(sameRoleInFlightRail({ role: 'reviewer', tag: 'x', isReviewRound: false }, railCtx(run))).toBeNull();
  });

  test('orphanRail refuses a takeover-policy orphan WITHOUT clearing it', ({ run }) => {
    const clearOrphan = vi.fn();
    const r = orphanRail({ role: 'reviewer', tag: 'x', isReviewRound: false }, railCtx(run, { orphanedOnDisk: () => true, clearOrphan }));
    expect(r?.isError).toBe(true);
    expect(clearOrphan).not.toHaveBeenCalled();
  });

  test('orphanRail clears a discard-and-reseed orphan and returns null (its lone side effect)', ({ consultantRun }) => {
    const clearOrphan = vi.fn();
    const r = orphanRail({ role: 'consultant', tag: 'x', isReviewRound: false }, railCtx(consultantRun, { orphanedOnDisk: () => true, clearOrphan }));
    expect(r).toBeNull();
    expect(clearOrphan).toHaveBeenCalledWith('consultant'); // driven by orphanRecoveryFor, not a role literal
  });

  test('reviewCapRail refuses at the cap, passes below it or on a non-review send', ({ run }) => {
    run.rounds.spec = 3;
    const r = reviewCapRail({ role: 'reviewer', tag: 'review-spec', isReviewRound: true }, railCtx(run, { phase: 'spec', cap: 3 }));
    expect(r?.isError).toBe(true);
    expect(text(r!)).toContain('backstop cap of 3 review rounds');
    run.rounds.spec = 2;
    expect(reviewCapRail({ role: 'reviewer', tag: 'review-spec', isReviewRound: true }, railCtx(run, { phase: 'spec', cap: 3 }))).toBeNull();
    run.rounds.spec = 3;
    expect(reviewCapRail({ role: 'reviewer', tag: 'custom', isReviewRound: false }, railCtx(run, { phase: 'spec', cap: 3 }))).toBeNull();
  });

  test('warnOnceTemplateRail refuses the first identical resend, then allows the deliberate retry', ({ run }) => {
    const ctx = railCtx(run, { sentThisPhase: () => ['review-spec'], resendWarned: new Set() });
    expect(warnOnceTemplateRail({ role: 'reviewer', tag: 'review-spec', isReviewRound: true }, ctx)?.isError).toBe(true);
    expect(warnOnceTemplateRail({ role: 'reviewer', tag: 'review-spec', isReviewRound: true }, ctx)).toBeNull();
  });

  test('the shared terminal group refuses a second terminal call and a stranded phase-exit', ({ run }) => {
    run.terminalMarker = { phase: 'spec', kind: 'advance' };
    expect(terminalAlreadySetRail({ verb: 'advance the phase' }, railCtx(run, { phase: 'spec' }))?.isError).toBe(true);
    delete run.terminalMarker;
    expect(terminalAlreadySetRail({ verb: 'advance the phase' }, railCtx(run, { phase: 'spec' }))).toBeNull();
    // Async host (a dispatcher owns turns): an uncollected turn strands the phase exit.
    const stranded = pendingTurnGateRail({ verb: 'advance the phase' }, railCtx(run, { asyncHost: true, inFlight: () => true }));
    expect(stranded?.isError).toBe(true);
    expect(text(stranded!)).toContain("can't advance the phase");
    // Blocking host (no dispatcher): the gate is structurally OFF. `inFlight` reads the
    // in-memory turnsInFlight set there, but a blocking send_prompt runs to completion
    // before a terminal call, so it must NOT gate a phase exit — even with inFlight true.
    expect(pendingTurnGateRail({ verb: 'advance the phase' }, railCtx(run, { asyncHost: false, inFlight: () => true }))).toBeNull();
  });

  test('the contract/verify checkpoints refuse a silent skip (a high is the escape hatch)', ({ consultantRun }) => {
    const contract = contractCheckpointRail({ verb: 'advance the phase' }, railCtx(consultantRun, { phase: 'plan' }));
    expect(contract?.isError).toBe(true);
    expect(text(contract!)).toContain('owes its acceptance contract');
    expect(
      contractCheckpointRail(
        { verb: 'advance the phase', humanDecisions: [{ title: 'no contract', severity: 'high' }] },
        railCtx(consultantRun, { phase: 'plan' }),
      ),
    ).toBeNull();

    consultantRun.acceptanceContract = { path: 'x', commit: 'abc' };
    const verify = verifyCheckpointRail({ verb: 'advance the phase' }, railCtx(consultantRun, { phase: 'impl' }));
    expect(verify?.isError).toBe(true);
    expect(text(verify!)).toContain('has not been verified');
  });

  test('the ORDERING invariant: a turn both in-flight and orphaned refuses as in-flight, not orphan', ({ run }) => {
    const r = firstRefusal(
      { role: 'reviewer', tag: 'x', isReviewRound: false },
      railCtx(run, { inFlight: () => true, orphanedOnDisk: () => true }),
      sameRoleInFlightRail,
      orphanRail,
      reviewCapRail,
      warnOnceTemplateRail,
    );
    expect(text(r!)).toContain('already in flight');
    expect(text(r!)).not.toContain('orphaned');
  });
});

describe('send_prompt', () => {
  test('routes to the addressed worker and returns its response', async ({ run }) => {
    const { call, reviewer } = harness(run);
    const result = await call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'review this' });

    expect(result.isError).toBeUndefined();
    expect(text(result)).toBe('scripted response');
    expect(reviewer.calls).toEqual([
      { prompt: 'review this', sessionId: undefined, readOnly: true, cwd: run.cwd, onSessionId: expect.any(Function) },
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

  test('the footer reports a claude turn in dollars — context, cost, round (F5)', async ({ run }) => {
    // A claude worker (the implementer) reports costUsd — the footer's $ figure.
    const implementer = new FakeWorker('claude', [{ costUsd: 1.25, context: { usedTokens: 50, windowTokens: 200 } }]);
    const { call } = harness(run, { implementer });
    const result = await call('send_prompt', { role: 'implementer', tag: 'write-spec', body: 'draft' });
    const joined = result.content.map((c) => (c as { text: string }).text).join('\n');
    expect.soft(joined).toContain('context 25%'); // 50/200
    expect.soft(joined).toMatch(/claude \$1\.25/);
    expect.soft(joined).toContain('round 0/'); // write-spec is not a review round
  });

  test('the footer reports a codex turn in TOKENS, never a phantom $0.00 (F5 — the codex fix)', async ({ run }) => {
    // A real codex worker (the default reviewer) reports tokens and NO costUsd —
    // the pre-fix footer read only claudeWorkersUsd and showed "workers $0.00"
    // while codex tokens accumulated. The footer must surface the tokens instead.
    const reviewer = new FakeWorker('codex', [{ tokens: { input: 1500, output: 300 }, context: { usedTokens: 50, windowTokens: 200 } }]);
    const { call } = harness(run, { reviewer });
    const result = await call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'review' });
    const joined = result.content.map((c) => (c as { text: string }).text).join('\n');
    expect.soft(joined).toContain('codex 2k/300 tok'); // fmtTokens(1500)=2k, 300
    expect.soft(joined).not.toContain('$0.00'); // no phantom claude dollars
    expect.soft(joined).not.toContain('workers $'); // the misleading single-figure label is gone
    expect.soft(joined).toContain('round 1/'); // the review round just settled
  });

  test('the footer rides a budget-truncated checkpoint (F5 + #4)', async ({ run }) => {
    // A budget cutoff only happens on a claude worker (the cap is a claude flag),
    // so the checkpoint turn settles its claude cost and the footer reports it
    // alongside the checkpoint note.
    const implementer = new FakeWorker('claude', [
      { budgetTruncated: true, sessionId: 'sess-b', costUsd: 0.18, text: 'committed work', context: { usedTokens: 80, windowTokens: 200 } },
    ]);
    const { call } = harness(run, { implementer });
    const result = await call('send_prompt', { role: 'implementer', tag: 'write-spec', body: 'draft' });
    const joined = result.content.map((c) => (c as { text: string }).text).join('\n');
    expect.soft(joined).toContain('budget reached'); // the checkpoint note still rides
    expect.soft(joined).toMatch(/\[context 40% · claude \$0\.18 · round 0\/\d+\]/); // and the footer too
  });

  test('a mid-response interruption surfaces the partial work + a continue-not-resend note, and captures the session', async ({ projectDir, run }) => {
    const implementer = new FakeWorker('claude', [{ interrupted: true, sessionId: 'sess-mid', text: 'partial spec content' }]);
    const { call } = harness(run, { implementer });
    const result = await call('send_prompt', { role: 'implementer', tag: 'write-spec', body: 'draft' });
    const joined = result.content.map((c) => (c as { text: string }).text).join('\n');
    expect.soft(result.isError).toBeUndefined(); // a settled checkpoint, not an error
    expect.soft(joined).toContain('partial spec content'); // the resumable partial work
    expect.soft(joined).toContain('do not re-send the original prompt'); // continue, don't resend
    // The session is captured so the orchestrator can resume it with a continuation.
    expect.soft(loadRunState(projectDir, run.runId).workerSessions.implementer).toBe('sess-mid');
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

  test('the settle step persists no round and no sent tag on an infra failure (the success-only rule the async path leans on)', async ({
    projectDir,
    run,
  }) => {
    const reviewer = new FakeWorker('codex', [new Error('spawn codex ENOENT')]);
    const { call } = harness(run, { reviewer });
    await call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'review' });

    // Asserted against DISK, not the in-memory copy: settleTurn's failure path
    // must commit nothing — a failed turn is no round, and its tag stays
    // un-sent so the prescribed retry is clean (no duplicate-template warning).
    const persisted = loadRunState(projectDir, run.runId);
    expect.soft(persisted.rounds.spec ?? 0).toBe(0);
    expect.soft(persisted.sentSnippets?.spec?.reviewer ?? []).toEqual([]);
  });

  test('a budget-truncated turn settles normally (session, cost, round) and renders a checkpoint, not infra', async ({
    projectDir,
    run,
  }) => {
    // A budget cutoff only happens on a claude worker (the cap is a claude flag),
    // so the cut role here is a claude-bound reviewer (a valid config) — the
    // settlement test must model the provider that can actually hit the cap.
    const reviewer = new FakeWorker('claude', [{ budgetTruncated: true, sessionId: 'sess-b', costUsd: 0.18, text: 'committed work' }]);
    const { call } = harness(run, { reviewer });
    const result = await call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'review' });

    expect.soft(result.isError).toBeFalsy(); // a checkpoint is not an error
    const joined = result.content.map((c) => (c as { text: string }).text).join('\n');
    expect.soft(joined).toContain('budget reached'); // the checkpoint note (content[1])
    expect.soft(joined).not.toContain('never saw your prompt');
    expect.soft(joined).not.toContain('Retry this same send_prompt');

    // The work is on disk and the session is resumable — settled like any turn.
    const persisted = loadRunState(projectDir, run.runId);
    expect.soft(persisted.workerSessions.reviewer).toBe('sess-b');
    expect.soft(persisted.costs.claudeWorkersUsd).toBeGreaterThan(0);
    expect.soft(persisted.rounds.spec).toBe(1);
  });

  test('S5: an aborted reviewer turn settles as a resumable checkpoint — session kept, base snippet sent, NO round, abort marker, resume-not-resend', async ({
    projectDir,
    run,
  }) => {
    const reviewer = new FakeWorker('codex', [{ aborted: true, sessionId: 'sess-ab' }]);
    const { call } = harness(run, { reviewer });
    const result = await call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'review' });
    const joined = result.content.map((c) => (c as { text: string }).text).join('\n');

    expect.soft(result.isError).toBeFalsy(); // a settled checkpoint, not an infra error
    expect.soft(joined).toContain('do NOT re-send the original prompt'); // resume, don't re-send
    expect.soft(joined).not.toContain('never saw your prompt'); // not the infra envelope

    const persisted = loadRunState(projectDir, run.runId);
    expect.soft(persisted.workerSessions.reviewer).toBe('sess-ab'); // the resumable handle is captured
    expect.soft(persisted.rounds.spec ?? 0).toBe(0); // NO review round — the abort delivered none
    expect.soft(persisted.sentSnippets?.spec?.reviewer ?? []).toContain('review-spec'); // base snippet marked sent (a later full re-send must warn)

    const log = readFileSync(join(runDirOf(projectDir, run.runId), 'reviewer.log'), 'utf8');
    expect.soft(log).toContain('⚠ turn aborted (resumable)'); // the abort marker, not a ▶ response
    expect.soft(log).not.toContain('▶ response');
  });

  test('S5: an aborted consultant turn at the contract checkpoint does NOT set the acceptance-contract draft', async ({
    projectDir,
    consultantRun,
  }) => {
    // With a spec path present, a SUCCESSFUL consultant contract turn would author
    // the draft (settleTurn). An aborted turn completed no checkpoint, so it must not.
    consultantRun.specPath = 'docs/spec.md';
    saveRunState(consultantRun);
    const consultant = new FakeWorker('claude', [{ aborted: true, sessionId: 'sess-c' }]);
    const { call } = harness(consultantRun, { consultant, phase: 'plan' });
    await call('send_prompt', { role: 'consultant', tag: 'consultant-contract', body: 'audit' });

    const persisted = loadRunState(projectDir, consultantRun.runId);
    expect.soft(persisted.acceptanceContractDraft).toBeUndefined(); // checkpoint NOT recorded
    expect.soft(persisted.workerSessions.consultant).toBe('sess-c'); // but the session is still captured (resumable)
  });

  test('S7: a /compact send carries the short 8-min cap; a normal send carries no override (blocking host)', async ({
    run,
  }) => {
    const implementer = new FakeWorker('claude');
    const { call } = harness(run, { implementer });
    await call('send_prompt', { role: 'implementer', tag: 'custom', body: '/compact keep the spec, drop the journey' });
    await call('send_prompt', { role: 'implementer', tag: 'write-spec', body: 'draft the spec' });

    expect.soft(implementer.calls[0]?.timeoutMs).toBe(8 * 60_000); // the /compact send
    expect.soft(implementer.calls[1]?.timeoutMs).toBeUndefined(); // the normal send
  });

  test('S7: an accepted-but-failed /compact resets the implementer session and prescribes recover-context (body-derived, tag=custom)', async ({
    projectDir,
    run,
  }) => {
    // tag=custom proves the reset is BODY-derived, never tag-derived.
    const implementer = new FakeWorker('claude', [{ aborted: true, sessionId: 'sess-compact' }]);
    const { call } = harness(run, { implementer });
    const result = await call('send_prompt', { role: 'implementer', tag: 'custom', body: '/compact drop the journey' });
    const joined = result.content.map((c) => (c as { text: string }).text).join('\n');

    // The bloated session is reset (not resumed) so the next send mints fresh.
    expect.soft(loadRunState(projectDir, run.runId).workerSessions.implementer).toBeUndefined();
    expect.soft(joined).toContain('recover-context'); // the recovery prescription, not the generic resume
    expect.soft(joined).not.toContain('Resume that session with a short continuation');
  });

  test('S7 / Finding-2: an aborted /compact resets the PERSISTENT reviewer too, and the copy names the reviewer (not the implementer)', async ({
    projectDir,
    run,
  }) => {
    // The reset is role-policy-gated (shouldResetAfterCompactAbort), NOT hard-coded
    // to the implementer: a reviewer's /compact aborts identically, so settleTurn
    // must reset the REVIEWER session and renderTurnResult must name the reviewer.
    // The bug this pins: render claimed "duet has RESET the implementer" for ANY
    // aborted compact while settle reset nobody but the implementer — the two sites
    // disagreeing. Both now read the one predicate, so they move together.
    run.workerSessions = { implementer: 'impl-keep', reviewer: 'rev-old' };
    saveRunState(run);
    const reviewer = new FakeWorker('claude', [{ aborted: true, sessionId: 'rev-compact' }]);
    const { call } = harness(run, { reviewer });
    const result = await call('send_prompt', { role: 'reviewer', tag: 'custom', body: '/compact drop the journey' });
    const joined = result.content.map((c) => (c as { text: string }).text).join('\n');

    const after = loadRunState(projectDir, run.runId);
    expect.soft(after.workerSessions.reviewer).toBeUndefined(); // the persistent reviewer was reset
    expect.soft(after.workerSessions.implementer).toBe('impl-keep'); // the OTHER role untouched
    expect.soft(joined).toContain('RESET the reviewer'); // the copy names the ACTUAL role…
    expect.soft(joined).not.toContain('RESET the implementer'); // …never the old hard-coded implementer
    expect.soft(joined).toContain('recover-context'); // the same recovery prescription
  });

  test('S7: a PRE-FLIGHT /compact failure does NOT reset the session and prescribes retry-verbatim', async ({
    projectDir,
    run,
  }) => {
    // A never-accepted /compact (an infra Error) — the old session never saw the
    // compact and is still the one to compact, so it must NOT be reset.
    run.workerSessions = { implementer: 'sess-prior' };
    saveRunState(run);
    const implementer = new FakeWorker('claude', [new Error('spawn claude ENOENT')]);
    const { call } = harness(run, { implementer });
    const result = await call('send_prompt', { role: 'implementer', tag: 'custom', body: '/compact drop the journey' });
    const joined = result.content.map((c) => (c as { text: string }).text).join('\n');

    expect.soft(loadRunState(projectDir, run.runId).workerSessions.implementer).toBe('sess-prior'); // unchanged
    expect.soft(joined).toContain('Retry this same send_prompt'); // the infra retry-verbatim envelope
    expect.soft(joined).not.toContain('recover-context');
  });

  test('S7: a non-/compact aborted turn is NOT reset, even with a misleading compact-ish tag (not tag-derived)', async ({
    projectDir,
    run,
  }) => {
    // A normal aborted turn carrying tag=compact-for-impl: the BODY isn't /compact,
    // so it's a plain resumable checkpoint — no reset, the generic resume note.
    const implementer = new FakeWorker('claude', [{ aborted: true, sessionId: 'sess-x' }]);
    const { call } = harness(run, { implementer });
    const result = await call('send_prompt', { role: 'implementer', tag: 'compact-for-impl', body: 'build the next slice' });
    const joined = result.content.map((c) => (c as { text: string }).text).join('\n');

    expect.soft(loadRunState(projectDir, run.runId).workerSessions.implementer).toBe('sess-x'); // resumable, not reset
    expect.soft(joined).toContain('Resume that session with a short continuation'); // the generic resume note
    expect.soft(joined).not.toContain('recover-context');
  });

  test('a BudgetCutoffError settles nothing and renders a budget-control recovery, distinct from infra', async ({
    projectDir,
    run,
  }) => {
    const reviewer = new FakeWorker('codex', [new BudgetCutoffError('cap reached with no recoverable session')]);
    const { call } = harness(run, { reviewer });
    const result = await call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'review' });

    expect.soft(text(result)).toContain('budget-control stop');
    expect.soft(text(result)).not.toContain('infrastructure layer'); // not the infra envelope
    expect.soft(text(result)).not.toContain('Retry this same send_prompt');

    // No settlement: no session, no round, no cost.
    const persisted = loadRunState(projectDir, run.runId);
    expect.soft(persisted.workerSessions.reviewer).toBeUndefined();
    expect.soft(persisted.rounds.spec ?? 0).toBe(0);
    expect.soft(persisted.costs.claudeWorkersUsd).toBe(0);
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

describe('send_prompt fan-out (role array — the framing analysis pass)', () => {
  test('headless: fans one body to both build-analysts and returns a combined, role-labeled result', async ({ projectDir, run }) => {
    const impl = new FakeWorker('claude');
    const rev = new FakeWorker('codex');
    const { call } = harness(run, { phase: 'frame', implementer: impl, reviewer: rev });

    const result = await call('send_prompt', { role: ['implementer', 'reviewer'], tag: 'think-holistic', body: 'analyze the problem' });

    // One body reaches each worker verbatim — the whole point of the fan-out.
    expect.soft(impl.calls).toHaveLength(1);
    expect.soft(rev.calls).toHaveLength(1);
    expect.soft(impl.calls[0]?.prompt).toBe('analyze the problem');
    expect.soft(rev.calls[0]?.prompt).toBe('analyze the problem');

    // The combined result labels each role's blocks under its own header.
    const joined = result.content.map((c) => (c as { text: string }).text).join('\n');
    expect.soft(joined).toContain('── implementer ──');
    expect.soft(joined).toContain('── reviewer ──');
    expect.soft(result.isError).toBeUndefined();

    // Both turns settled (each session persisted) and each tag registered — the
    // template-economy bookkeeping is per role.
    const persisted = loadRunState(projectDir, run.runId);
    expect.soft(persisted.workerSessions.implementer).toBeDefined();
    expect.soft(persisted.workerSessions.reviewer).toBeDefined();
    expect.soft(persisted.sentSnippets?.frame?.implementer).toContain('think-holistic');
    expect.soft(persisted.sentSnippets?.frame?.reviewer).toContain('think-holistic');
  });

  test('headless: the two worker turns run concurrently, not one-after-the-other', async ({ run }) => {
    const impl = new DeferredWorker('claude');
    const rev = new DeferredWorker('codex');
    const { call } = harness(run, { phase: 'frame', implementer: impl, reviewer: rev });

    const pending = call('send_prompt', { role: ['implementer', 'reviewer'], tag: 'think-holistic', body: 'analyze' });
    await flush();
    // Both turns are in flight before EITHER has resolved — the fan-out launched
    // them concurrently rather than awaiting the first before starting the second
    // (the regression the readOnlyHint scheduler hint fixed for parallel sends).
    expect.soft(impl.calls).toHaveLength(1);
    expect.soft(rev.calls).toHaveLength(1);

    impl.resolve();
    rev.resolve();
    expect.soft((await pending).isError).toBeUndefined();
  });

  test('interactive: a fan-out dispatches each role into the background; check_turns collects them', async ({ run }) => {
    const impl = new FakeWorker('claude');
    const rev = new FakeWorker('codex');
    const { call } = harness(run, { phase: 'frame', implementer: impl, reviewer: rev, async: true });

    const dispatched = await call('send_prompt', { role: ['implementer', 'reviewer'], tag: 'think-holistic', body: 'analyze' });
    expect.soft(text(dispatched)).toContain('Dispatched to the implementer and reviewer');
    expect.soft(impl.calls).toHaveLength(1);
    expect.soft(rev.calls).toHaveLength(1);

    await flush();
    const collected = await call('check_turns');
    const joined = collected.content.map((c) => (c as { text?: string }).text ?? '').join('\n');
    expect.soft(joined).toContain('── implementer ──');
    expect.soft(joined).toContain('── reviewer ──');
  });

  test('a busy role anywhere in the array refuses the whole fan-out — no turn is dispatched (validate-all-first)', async ({ run }) => {
    const impl = new DeferredWorker('claude');
    const rev = new FakeWorker('codex');
    const { call } = harness(run, { phase: 'frame', implementer: impl, reviewer: rev, async: true });

    // The implementer is dispatched and uncollected (running) on the interactive host.
    await call('send_prompt', { role: 'implementer', tag: 'custom', body: 'first' });
    const refused = await call('send_prompt', { role: ['implementer', 'reviewer'], tag: 'think-holistic', body: 'analyze' });

    expect.soft(refused.isError).toBe(true);
    expect.soft(text(refused)).toContain('already in flight');
    // The reviewer was never sent — validation runs over every target before any dispatch.
    expect.soft(rev.calls).toHaveLength(0);

    impl.resolve(); // let the in-flight turn settle so no interval leaks
    await flush();
  });

  test('an empty role array is refused with a prescribed fix', async ({ run }) => {
    const { call } = harness(run, { phase: 'frame' });
    const refused = await call('send_prompt', { role: [], tag: 'think-holistic', body: 'x' });
    expect.soft(refused.isError).toBe(true);
    expect.soft(text(refused)).toContain('at least one worker');
  });
});

describe('projectDetail (the check_turns context guard)', () => {
  // A leaked provider failure envelope: KB of init payload + per-event ids wrapped
  // around a one-line signal, inside the prescribed-recovery framing.
  const envelope = JSON.stringify([
    { type: 'system', subtype: 'init', tools: Array(40).fill('SomeNoisyToolName'), slash_commands: Array(40).fill('cmd'), uuid: 'init-uuid' },
    { type: 'assistant', uuid: 'msg-uuid', message: { content: [{ type: 'text', text: 'z'.repeat(500) }] } },
    { type: 'result', subtype: 'success', is_error: true, session_id: 's-1', result: 'API Error: Connection closed mid-response' },
  ]);
  const leaked = `The reviewer worker's turn failed at the infrastructure layer (Command failed with exit code 1: claude -p\n\n${envelope}). Retry once, then ask_human.`;

  test('projects a leaked envelope to its high-value fields — signal kept, noise and framing-recovery preserved', () => {
    const out = projectDetail(leaked);
    expect.soft(out).toContain('API Error: Connection closed mid-response'); // the signal
    expect.soft(out).toContain('Retry once, then ask_human'); // the recovery framing survives
    expect.soft(out).not.toContain('SomeNoisyToolName'); // init-payload noise dropped
    expect.soft(out).not.toContain('msg-uuid'); // per-event ids dropped
    expect.soft(out.length).toBeLessThan(leaked.length / 3); // far smaller than the dump
  });

  test('leaves a normal worker response untouched', () => {
    const prose = 'Here is my grounded analysis of the problem.\n'.repeat(60); // well under the runaway ceiling
    expect(projectDetail(prose)).toBe(prose);
  });

  test('a true runaway (no envelope) keeps the head and tail and names the raw escape hatch', () => {
    const big = `HEAD-MARKER${'z'.repeat(80_000)}TAIL-MARKER`;
    const out = projectDetail(big);
    expect.soft(out.length).toBeLessThan(big.length);
    expect.soft(out).toContain('HEAD-MARKER'); // head kept
    expect.soft(out).toContain('TAIL-MARKER'); // tail kept — not a top-to-bottom trim
    expect.soft(out).toContain('raw=true'); // the escape hatch is named
  });

  test('check_turns projects a leaked dump by default and returns it whole with raw=true', async ({ run }) => {
    const rev = new FakeWorker('codex', [new Error(envelope), new Error(envelope)]);
    const { call } = harness(run, { phase: 'frame', reviewer: rev, async: true });

    await call('send_prompt', { role: 'reviewer', tag: 'custom', body: 'go' });
    await flush();
    const def = await call('check_turns');
    const dtext = def.content.map((c) => (c as { text?: string }).text ?? '').join('\n');
    expect.soft(dtext).toContain('API Error: Connection closed mid-response'); // signal kept
    expect.soft(dtext).not.toContain('SomeNoisyToolName'); // noise dropped by default

    await call('send_prompt', { role: 'reviewer', tag: 'custom', body: 'again' });
    await flush();
    const rawOut = await call('check_turns', { raw: true });
    const rtext = rawOut.content.map((c) => (c as { text?: string }).text ?? '').join('\n');
    expect.soft(rtext).toContain('SomeNoisyToolName'); // raw=true returns the full dump
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
  test('once the turn announces its id, the heartbeat carries transcript recency + retry count', async ({ run, projectDir, onTestFinished }) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const base = Date.parse('2026-06-20T12:00:00.000Z');
    vi.setSystemTime(base);
    const home = join(projectDir, 'home');
    plantClaudeTranscript(
      home,
      'impl-1',
      jsonl(claudeUserToolResult({ ts: new Date(base).toISOString() }), claudeApiRetry({ ts: new Date(base + 10_000).toISOString() })),
    );

    let finish!: (t: { text: string; sessionId: string }) => void;
    const slow = new FakeWorker('claude');
    // The worker announces its id at turn start (as the real adapters do) — the
    // heartbeat then locates the transcript by it, no settled workerSessions id.
    slow.runTurn = (opts) => {
      opts.onSessionId?.('impl-1');
      return new Promise((r) => (finish = r));
    };
    const { call, lines } = harness(run, { implementer: slow, home });
    const pending = call('send_prompt', { role: 'implementer', tag: 'start-plan', body: 'plan' });
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    const hb = lines.find((l) => l.includes('⏳ implementer turn running — 5m elapsed'));
    expect.soft(hb).toContain('last activity');
    expect.soft(hb).toContain('RETRYING (1 retries)'); // the count, never a fabricated class

    finish({ text: 'done', sessionId: 'impl-1' });
    await pending;
  });

  test('before the provider announces the turn id, the heartbeat stays elapsed-only', async ({ run, onTestFinished }) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    let finish!: (t: { text: string; sessionId: string }) => void;
    const slow = new FakeWorker('claude');
    slow.runTurn = () => new Promise((r) => (finish = r)); // never announces an id
    const { call, lines } = harness(run, { implementer: slow });
    const pending = call('send_prompt', { role: 'implementer', tag: 'write-spec', body: 'draft' });
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    const hb = lines.find((l) => l.includes('⏳ implementer turn running — 5m elapsed'));
    expect.soft(hb).toBeDefined();
    expect.soft(hb).not.toContain('last activity');
    expect.soft(hb).not.toContain('retries');

    finish({ text: 'done', sessionId: 'impl-1' });
    await pending;
  });

  test('an announced id with no transcript degrades to elapsed-only and the turn still succeeds', async ({ run, projectDir, onTestFinished }) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const home = join(projectDir, 'home'); // nothing planted at the announced id

    let finish!: (t: { text: string; sessionId: string }) => void;
    const slow = new FakeWorker('claude');
    slow.runTurn = (opts) => {
      opts.onSessionId?.('missing-id'); // id known, but no transcript on disk
      return new Promise((r) => (finish = r));
    };
    const { call, lines } = harness(run, { implementer: slow, home });
    const pending = call('send_prompt', { role: 'implementer', tag: 'start-plan', body: 'x' });
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    const hb = lines.find((l) => l.includes('⏳ implementer turn running — 5m elapsed'));
    expect.soft(hb).toBeDefined();
    expect.soft(hb).not.toContain('last activity'); // no readable transcript → no suffix, no throw

    finish({ text: 'done', sessionId: 'impl-1' });
    const result = await pending;
    expect.soft(result.isError).toBeFalsy();
  });

  test('mirrors a control-plane "awaiting <role>" line onto the orchestrator pane', async ({ run, projectDir, onTestFinished }) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const home = join(projectDir, 'home');
    run.workerSessions = { implementer: 'impl-1' };
    saveRunState(run);

    let finish!: (t: { text: string; sessionId: string }) => void;
    const slow = new FakeWorker('claude');
    slow.runTurn = () => new Promise((r) => (finish = r));
    const { call } = harness(run, { implementer: slow, home });
    const pending = call('send_prompt', { role: 'implementer', tag: 'start-plan', body: 'plan' });
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    // Voice-log only (no driver-log dup) — the orchestrator pane otherwise
    // freezes while it blocks on the worker turn it reads no files during. This
    // is the HEADLESS host (no dispatcher) where the orchestrator truly blocks.
    const orchestratorLog = readFileSync(join(runDirOf(run.cwd, run.runId), 'orchestrator.log'), 'utf8');
    expect(orchestratorLog).toContain('⏳ awaiting implementer — 5m');

    finish({ text: 'done', sessionId: 'impl-1' });
    await pending;
  });

  test('the async (interactive) host emits NO "awaiting" mirror — fire-and-collect, the orchestrator is not blocked', async ({ run, projectDir, onTestFinished }) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const home = join(projectDir, 'home');
    run.workerSessions = { implementer: 'impl-1' };
    saveRunState(run);
    const worker = new DeferredWorker('claude'); // stays in flight so the 5-min heartbeat fires
    const { call, dispatcher } = harness(run, { implementer: worker, home, async: true });
    await call('send_prompt', { role: 'implementer', tag: 'start-plan', body: 'plan' }); // dispatches and returns
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    // The worker heartbeat DID fire (the test isn't vacuous) — but no orchestrator
    // mirror, because on the async host the orchestrator never blocks awaiting it.
    expect.soft(readFileSync(join(runDirOf(run.cwd, run.runId), 'implementer.log'), 'utf8')).toContain('⏳ turn running');
    const orchPath = join(runDirOf(run.cwd, run.runId), 'orchestrator.log');
    const orchestratorLog = existsSync(orchPath) ? readFileSync(orchPath, 'utf8') : '';
    expect.soft(orchestratorLog).not.toContain('awaiting');

    worker.resolve({ sessionId: 'impl-1' });
    await vi.advanceTimersByTimeAsync(0); // drain the settle so the heartbeat interval is cleared
    dispatcher?.collectReady();
  });
});

describe('send_prompt live-activity poll (the 30s ⋯ line)', () => {
  /** Plant a transcript, run a slow turn, advance time, return the activity lines seen. */
  async function activityLines(
    run: RunState,
    projectDir: string,
    plant: (home: string, base: number) => void,
    advanceMs: number,
  ): Promise<{ lines: string[]; finish: () => void; pending: Promise<ToolResult> }> {
    const base = Date.parse('2026-06-20T12:00:00.000Z');
    vi.setSystemTime(base);
    const home = join(projectDir, 'home');
    // No workerSessions: this is a FIRST turn. The worker announces its id at
    // turn start (onSessionId), which is what the poll now locates by.
    plant(home, base);

    let finish!: (t: { text: string; sessionId: string }) => void;
    const slow = new FakeWorker('claude');
    slow.runTurn = (opts) => {
      opts.onSessionId?.('impl-1');
      return new Promise((r) => (finish = r));
    };
    const { call, lines } = harness(run, { implementer: slow, home });
    const pending = call('send_prompt', { role: 'implementer', tag: 'start-plan', body: 'build' });
    await vi.advanceTimersByTimeAsync(advanceMs);
    return {
      lines: lines.filter((l) => l.includes('⋯')),
      finish: () => finish({ text: 'done', sessionId: 'impl-1' }),
      pending,
    };
  }

  test('surfaces the worker’s current action into the voice log within a poll tick', async ({ run, projectDir, onTestFinished }) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { lines, finish, pending } = await activityLines(
      run,
      projectDir,
      (home, base) => plantClaudeTranscript(home, 'impl-1', jsonl(claudeToolUse([{ name: 'Read', input: { file_path: '/repo/src/foo.ts' }, id: 'toolu_1' }], { ts: new Date(base).toISOString() }))),
      30_000,
    );
    expect(lines.some((l) => l.includes('⋯ reading /repo/src/foo.ts'))).toBe(true);
    finish();
    await pending;
  });

  test('relativizes a worker path under the repo root (the canonical artifact form)', async ({ run, projectDir, onTestFinished }) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const abs = join(run.cwd, 'src/foo.ts'); // an absolute path under the run's cwd, as claude emits
    const { lines, finish, pending } = await activityLines(
      run,
      projectDir,
      (home, base) => plantClaudeTranscript(home, 'impl-1', jsonl(claudeToolUse([{ name: 'Read', input: { file_path: abs }, id: 'toolu_rel' }], { ts: new Date(base).toISOString() }))),
      30_000,
    );
    expect.soft(lines.some((l) => l.includes('⋯ reading src/foo.ts'))).toBe(true); // repo-relative
    expect.soft(lines.some((l) => l.includes(abs))).toBe(false); // never the absolute form
    finish();
    await pending;
  });

  test('does not re-emit an unchanged action across ticks (change-detected)', async ({ run, projectDir, onTestFinished }) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { lines, finish, pending } = await activityLines(
      run,
      projectDir,
      (home, base) => plantClaudeTranscript(home, 'impl-1', jsonl(claudeToolUse([{ name: 'Read', input: { file_path: '/repo/a.ts' }, id: 'toolu_a' }], { ts: new Date(base).toISOString() }))),
      90_000, // three ticks, same transcript
    );
    expect(lines.filter((l) => l.includes('⋯ reading /repo/a.ts')).length).toBe(1);
    finish();
    await pending;
  });

  test('a FIRST turn surfaces activity once the provider announces its id (the regression)', async ({ run, projectDir, onTestFinished }) => {
    // The headline: a fresh run with NO workerSessions for the implementer — the
    // exact state that used to go dark for a whole turn. The worker announces its
    // id at turn start and the poll finds the transcript planted at it.
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    expect.soft(run.workerSessions.implementer).toBeUndefined(); // genuinely a first turn
    const { lines, finish, pending } = await activityLines(
      run,
      projectDir,
      (home, base) => plantClaudeTranscript(home, 'impl-1', jsonl(claudeToolUse([{ name: 'Read', input: { file_path: '/repo/first.ts' }, id: 'toolu_first' }], { ts: new Date(base).toISOString() }))),
      30_000,
    );
    expect(lines.some((l) => l.includes('⋯ reading /repo/first.ts'))).toBe(true);
    finish();
    await pending;
  });

  test('before the provider announces the turn id, no activity line is emitted', async ({ run, onTestFinished }) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    let finish!: (t: { text: string; sessionId: string }) => void;
    const slow = new FakeWorker('claude');
    slow.runTurn = () => new Promise((r) => (finish = r)); // never announces an id
    const { call, lines } = harness(run, { implementer: slow });
    const pending = call('send_prompt', { role: 'implementer', tag: 'write-spec', body: 'draft' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lines.some((l) => l.includes('⋯'))).toBe(false);
    finish({ text: 'done', sessionId: 'impl-1' });
    await pending;
  });

  test('an announced id with no transcript degrades to no line and the turn still succeeds', async ({ run, projectDir, onTestFinished }) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const home = join(projectDir, 'home'); // nothing planted at the announced id
    let finish!: (t: { text: string; sessionId: string }) => void;
    const slow = new FakeWorker('claude');
    slow.runTurn = (opts) => {
      opts.onSessionId?.('missing');
      return new Promise((r) => (finish = r));
    };
    const { call, lines } = harness(run, { implementer: slow, home });
    const pending = call('send_prompt', { role: 'implementer', tag: 'start-plan', body: 'x' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lines.some((l) => l.includes('⋯'))).toBe(false);
    finish({ text: 'done', sessionId: 'impl-1' });
    const result = await pending;
    expect.soft(result.isError).toBeFalsy();
  });

  test('a codex worker surfaces activity too (the provider is derived from the binding, not a role check)', async ({ run, projectDir, onTestFinished }) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const base = Date.parse('2026-06-20T12:00:00.000Z');
    vi.setSystemTime(base);
    const home = join(projectDir, 'home');
    // The reviewer is codex by default — plant a codex rollout at the announced id.
    plantCodexRollout(home, 'rev-1', jsonl(codexExecCommand('rg --files-with-matches needle src', { callId: 'call_x', ts: new Date(base).toISOString() })));
    let finish!: (t: { text: string; sessionId: string }) => void;
    const slow = new FakeWorker('codex');
    slow.runTurn = (opts) => {
      opts.onSessionId?.('rev-1');
      return new Promise((r) => (finish = r));
    };
    const { call, lines } = harness(run, { reviewer: slow, home });
    const pending = call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'review' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lines.some((l) => l.includes('⋯ searching') && l.includes('reviewer'))).toBe(true);
    finish({ text: 'done', sessionId: 'rev-1' });
    await pending;
  });

  test('the async (interactive) host surfaces activity on a first turn too (same wiring, via the dispatcher)', async ({ run, projectDir, onTestFinished }) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const base = Date.parse('2026-06-20T12:00:00.000Z');
    vi.setSystemTime(base);
    const home = join(projectDir, 'home');
    plantClaudeTranscript(home, 'live-async', jsonl(claudeToolUse([{ name: 'Read', input: { file_path: '/repo/async.ts' }, id: 'toolu_async' }], { ts: new Date(base).toISOString() })));
    let finish!: (t: { text: string; sessionId: string }) => void;
    const worker = new FakeWorker('claude');
    worker.runTurn = (opts) => {
      opts.onSessionId?.('live-async');
      return new Promise((r) => (finish = r));
    };
    const { call, lines, dispatcher } = harness(run, { implementer: worker, home, async: true });
    await call('send_prompt', { role: 'implementer', tag: 'write-spec', body: 'draft' }); // dispatches and returns
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lines.some((l) => l.includes('⋯ reading /repo/async.ts'))).toBe(true);
    finish({ text: 'done', sessionId: 'live-async' });
    await vi.advanceTimersByTimeAsync(0); // drain the settle so the heartbeat interval is cleared
    dispatcher?.collectReady();
  });

  test('the ephemeral consultant locates THIS turn’s id, never its stale settled session', async ({ consultantRun, projectDir, onTestFinished }) => {
    // The consultant reseeds every turn, so workerSessions.consultant holds the
    // PRIOR session. The poll must follow the announced live id, not fall back to
    // that stale id (which would surface the wrong — or no — transcript).
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const base = Date.parse('2026-06-20T12:00:00.000Z');
    vi.setSystemTime(base);
    const home = join(projectDir, 'home');
    consultantRun.workerSessions = { consultant: 'stale-prior' };
    saveRunState(consultantRun);
    // The stale session has an OLD action; the live one has the current action.
    plantClaudeTranscript(home, 'stale-prior', jsonl(claudeToolUse([{ name: 'Read', input: { file_path: '/repo/old.ts' }, id: 'toolu_old' }], { ts: new Date(base).toISOString() })));
    plantClaudeTranscript(home, 'live-now', jsonl(claudeToolUse([{ name: 'Read', input: { file_path: '/repo/current.ts' }, id: 'toolu_now' }], { ts: new Date(base).toISOString() })));
    let finish!: (t: { text: string; sessionId: string }) => void;
    const slow = new FakeWorker('claude');
    slow.runTurn = (opts) => {
      opts.onSessionId?.('live-now');
      return new Promise((r) => (finish = r));
    };
    const { call, lines } = harness(consultantRun, { consultant: slow, home, phase: 'plan' });
    const pending = call('send_prompt', { role: 'consultant', tag: 'consultant-contract', body: 'audit' });
    await vi.advanceTimersByTimeAsync(30_000);
    const activity = lines.filter((l) => l.includes('⋯'));
    expect.soft(activity.some((l) => l.includes('current.ts'))).toBe(true); // the live transcript
    expect.soft(activity.some((l) => l.includes('old.ts'))).toBe(false); // never the stale one
    finish({ text: 'done', sessionId: 'live-now' });
    await pending;
  });

  test('the located cache follows a mid-turn session-id change, never sticks to the first', async ({ run, projectDir, onTestFinished }) => {
    // codex resume announces once from the resume id, again from thread.started; if
    // they differ the second wins. The cache is keyed by the id it located for, so
    // a re-announce drops it and re-locates — it doesn't keep reading the first file.
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const base = Date.parse('2026-06-20T12:00:00.000Z');
    vi.setSystemTime(base);
    const home = join(projectDir, 'home');
    plantClaudeTranscript(home, 'sess-old', jsonl(claudeToolUse([{ name: 'Read', input: { file_path: '/repo/old.ts' }, id: 'toolu_old' }], { ts: new Date(base).toISOString() })));
    plantClaudeTranscript(home, 'sess-new', jsonl(claudeToolUse([{ name: 'Read', input: { file_path: '/repo/new.ts' }, id: 'toolu_new' }], { ts: new Date(base).toISOString() })));
    let finish!: (t: { text: string; sessionId: string }) => void;
    const worker = new FakeWorker('claude');
    worker.runTurn = (opts) => {
      opts.onSessionId?.('sess-old'); // first announce → poll locates old
      setTimeout(() => opts.onSessionId?.('sess-new'), 40_000); // a mid-turn re-announce
      return new Promise((r) => (finish = r));
    };
    const { call, lines } = harness(run, { implementer: worker, home });
    const pending = call('send_prompt', { role: 'implementer', tag: 'write-spec', body: 'x' });
    await vi.advanceTimersByTimeAsync(30_000); // tick 1: locates + emits old
    await vi.advanceTimersByTimeAsync(30_000); // re-announce at 40s; tick 2 at 60s re-locates new
    const activity = lines.filter((l) => l.includes('⋯'));
    expect.soft(activity.some((l) => l.includes('old.ts'))).toBe(true); // followed the first id
    expect.soft(activity.some((l) => l.includes('new.ts'))).toBe(true); // then the second (cache re-keyed)
    finish({ text: 'done', sessionId: 'sess-new' });
    await pending;
  });
});

describe('stageSessionId (the best-effort telemetry guard)', () => {
  test('a staging fault is swallowed — onSessionId never fails the worker turn', ({ run }) => {
    // onSessionId is invoked at load-bearing moments (claude before spawn, codex
    // inside its stream reduction), so a thrown staging write would fail the turn.
    // Remove the run dir so recordTurnSessionId's loadRunState throws.
    const logs: string[] = [];
    rmSync(runDirOf(run.cwd, run.runId), { recursive: true, force: true });
    const stage = stageSessionId(run, 'implementer', (l) => logs.push(l));
    expect.soft(() => stage('some-id')).not.toThrow();
    expect.soft(logs.some((l) => l.includes('could not stage'))).toBe(true);
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
    run.rounds.spec = 3;
    const { call, reviewer } = harness(run);
    const result = await call('send_prompt', { role: 'reviewer', tag: 'review-spec-again', body: 'one more' });

    expect(result.isError).toBe(true);
    expect.soft(text(result)).toContain('backstop cap of 3 review rounds');
    expect.soft(text(result)).toContain('advance_phase');
    expect.soft(text(result)).toContain('ask_human');
    expect.soft(reviewer.calls).toHaveLength(0);
  });
});

describe('the consultant role (ephemeral, read-only, additive)', () => {
  test('ephemerality (blocking host): a later consultant turn carries no resume session id', async ({ consultantRun }) => {
    const consultant = new FakeWorker('claude');
    const { call } = harness(consultantRun, { phase: 'spec', consultant });

    await call('send_prompt', { role: 'consultant', tag: 'custom', body: 'bet audit 1' });
    await call('send_prompt', { role: 'consultant', tag: 'custom', body: 'bet audit 2' });

    // The first settle recorded a session id, yet the second turn still launches
    // fresh — ephemerality by construction, not by forgetting to track it.
    expect.soft(consultant.calls[0]?.sessionId).toBeUndefined();
    expect.soft(consultant.calls[1]?.sessionId).toBeUndefined();
    expect.soft(consultantRun.workerSessions.consultant).toBeDefined();
  });

  test('ephemerality (interactive host): the dispatcher launches each consultant turn fresh', async ({ consultantRun }) => {
    const consultant = new DeferredWorker('claude');
    const { call } = harness(consultantRun, { phase: 'spec', consultant, async: true });

    await call('send_prompt', { role: 'consultant', tag: 'custom', body: 'audit 1' });
    consultant.resolve({ sessionId: 'c-1' });
    await flush();
    await call('check_turns'); // collect → re-opens the role
    await call('send_prompt', { role: 'consultant', tag: 'custom', body: 'audit 2' });

    // Both launches went out with no resume id, even though the first settle
    // tracked 'c-1' — the dispatcher reads sessionIdFor, not workerSessions.
    expect.soft(consultant.calls[0]?.sessionId).toBeUndefined();
    expect.soft(consultant.calls[1]?.sessionId).toBeUndefined();
  });

  test('latest-session tracked: workerSessions.consultant holds the newest id; consultant.log names each', async ({
    projectDir,
    consultantRun,
  }) => {
    const consultant = new FakeWorker('claude');
    const { call } = harness(consultantRun, { phase: 'spec', consultant });

    await call('send_prompt', { role: 'consultant', tag: 'custom', body: 'audit 1' });
    await call('send_prompt', { role: 'consultant', tag: 'custom', body: 'audit 2' });

    const persisted = loadRunState(projectDir, consultantRun.runId);
    expect.soft(persisted.workerSessions.consultant).toBe('session-2'); // the latest, not the first
    // The find-on-disk mechanism: each checkpoint's session id is named in the
    // consultant's own voice log (the Voice widening routes it to consultant.log).
    const log = readFileSync(join(runDirOf(projectDir, consultantRun.runId), 'consultant.log'), 'utf8');
    expect.soft(log).toContain('session session-1');
    expect.soft(log).toContain('session session-2');
  });

  test('a consultant turn at the contract phase records the authorship draft marker (the freeze/rail evidence)', async ({
    projectDir,
    consultantRun,
  }) => {
    consultantRun.specPath = 'docs/specs/x.md';
    saveRunState(consultantRun);
    const { call } = harness(consultantRun, { phase: 'plan', consultant: new FakeWorker('claude') });

    await call('send_prompt', { role: 'consultant', tag: 'consultant-contract', body: 'author the contract' });

    const persisted = loadRunState(projectDir, consultantRun.runId);
    expect.soft(persisted.acceptanceContractDraft?.path).toBe('docs/specs/x.acceptance.md'); // derived from specPath
    expect.soft(persisted.acceptanceContractDraft?.sessionId).toBeDefined();
  });

  test('a consultant turn at the verify phase stamps verifiedAt on the frozen contract (the impl-rail evidence)', async ({
    projectDir,
    consultantRun,
  }) => {
    consultantRun.acceptanceContract = { path: 'docs/specs/x.acceptance.md', commit: 'abc' };
    saveRunState(consultantRun);
    const { call } = harness(consultantRun, { phase: 'impl', consultant: new FakeWorker('claude') });

    await call('send_prompt', { role: 'consultant', tag: 'consultant-verify', body: 'verify the contract' });

    const persisted = loadRunState(projectDir, consultantRun.runId);
    expect.soft(persisted.acceptanceContract?.verifiedAt).toBeDefined(); // verification RAN
    expect.soft(persisted.acceptanceContract?.commit).toBe('abc'); // the freeze record is preserved
  });

  test('a code-changing impl turn after a verify clears verifiedAt — a fix forces a fresh re-verify before advance', async ({
    projectDir,
    consultantRun,
  }) => {
    // The self-heal loop: a verify ran, the orchestrator routed the failing assertion
    // to the implementer; that fix must invalidate the stale verification so the impl
    // rail can't auto-cross Ship on the pre-fix verify (the Codex adversarial-review
    // window). Closing it structurally, not by trusting the orchestrator to re-verify.
    consultantRun.acceptanceContract = { path: 'docs/specs/x.acceptance.md', commit: 'abc', verifiedAt: 'now' };
    saveRunState(consultantRun);
    const { call } = harness(consultantRun, { phase: 'impl', implementer: new FakeWorker('claude') });

    await call('send_prompt', { role: 'implementer', tag: 'respond-review', body: 'fix the failing assertion' });

    const persisted = loadRunState(projectDir, consultantRun.runId);
    expect.soft(persisted.acceptanceContract?.verifiedAt).toBeUndefined(); // stale verify dropped by the fix
    expect.soft(persisted.acceptanceContract?.commit).toBe('abc'); // the freeze record survives
    // With verifiedAt gone and no high, the rail refuses advance until a fresh verify re-stamps it.
    const verify = verifyCheckpointRail({ verb: 'advance the phase' }, railCtx(persisted, { phase: 'impl' }));
    expect.soft(verify).not.toBeNull();
  });

  test('a read-only (reviewer) turn at verify leaves verifiedAt intact — only a code change invalidates it', async ({
    projectDir,
    consultantRun,
  }) => {
    consultantRun.acceptanceContract = { path: 'docs/specs/x.acceptance.md', commit: 'abc', verifiedAt: 'now' };
    saveRunState(consultantRun);
    const { call } = harness(consultantRun, { phase: 'impl', reviewer: new FakeWorker('codex') });

    await call('send_prompt', { role: 'reviewer', tag: 'review-implementation', body: 'look again' });

    const persisted = loadRunState(projectDir, consultantRun.runId);
    expect.soft(persisted.acceptanceContract?.verifiedAt).toBe('now'); // a read-only turn doesn't change code, so no invalidation
  });

  test('additivity: a consultant turn never counts a review round nor satisfies the loop requirement', async ({
    consultantRun,
  }) => {
    const consultant = new FakeWorker('claude');
    const { call } = harness(consultantRun, { phase: 'spec', consultant });

    // Even a review-prefixed tag to the CONSULTANT does not count — countsReviewRound
    // gates on the role, so the consultant is additive, never substitutive.
    await call('send_prompt', { role: 'consultant', tag: 'review-spec', body: 'bet audit' });
    expect.soft(consultantRun.rounds.spec ?? 0).toBe(0);

    // spec is a review-loop phase; with only a consultant turn run, advance_phase
    // still refuses — the embedded reviewer round is still owed.
    const refused = await call('advance_phase', { summary: 'looks fine', artifacts: [] });
    expect.soft(refused.isError).toBe(true);
    expect.soft(text(refused)).toContain('No review round has run');
  });

  test('a consultant turn runs read-only', async ({ consultantRun }) => {
    const consultant = new FakeWorker('claude');
    const { call } = harness(consultantRun, { phase: 'spec', consultant });
    await call('send_prompt', { role: 'consultant', tag: 'custom', body: 'audit' });
    expect(consultant.calls[0]?.readOnly).toBe(true);
  });
});

describe('send_prompt enum visibility (consultant only when bound)', () => {
  const sendPromptTool = (run: RunState, withConsultant: boolean) => {
    const providers = {
      implementer: new FakeWorker('claude'),
      reviewer: new FakeWorker('codex'),
      ...(withConsultant ? { consultant: new FakeWorker('claude') } : {}),
    };
    const { tools } = createPhaseTools({ state: run, phase: 'spec', providers, log: () => {} });
    return tools.find((t) => t.name === 'send_prompt')!;
  };

  test('unbound: the schema is byte-for-byte today’s — consultant is not a routable role', ({ run }) => {
    const tool = sendPromptTool(run, false);
    const schema = z.object(tool.inputSchema);
    expect.soft(schema.safeParse({ role: 'consultant', tag: 't', body: 'b' }).success).toBe(false);
    expect.soft(schema.safeParse({ role: 'reviewer', tag: 't', body: 'b' }).success).toBe(true);
    expect.soft(tool.description).not.toContain('consultant');
    expect.soft(tool.description).not.toContain('ephemeral');
    // The description teaches the array fan-out; unbound, the canonical case is
    // the two build-analysts and the consultant is never named.
    expect.soft(tool.description).toContain('role as an array');
    expect.soft(tool.description).toContain('["implementer", "reviewer"]');
  });

  test('bound: consultant becomes a routable role and the description names its ephemerality', ({ consultantRun }) => {
    const tool = sendPromptTool(consultantRun, true);
    const schema = z.object(tool.inputSchema);
    expect.soft(schema.safeParse({ role: 'consultant', tag: 't', body: 'b' }).success).toBe(true);
    expect.soft(tool.description).toContain('consultant');
    expect.soft(tool.description.toLowerCase()).toContain('ephemeral');
    // Bound: the description still teaches the fan-out, and adds that the
    // consultant is a SEPARATE send, never inside the array.
    expect.soft(tool.description).toContain('["implementer", "reviewer"]');
    expect.soft(tool.description).toContain('never inside the array');
  });
});

describe('orchestratorSystemPrompt (the bound-only identity clause)', () => {
  test('unbound: byte-for-byte the base prompt — no consultant at identity altitude', ({ run }) => {
    expect.soft(orchestratorSystemPrompt(run)).toBe(ORCHESTRATOR_SYSTEM_PROMPT);
    expect.soft(orchestratorSystemPrompt(run).toLowerCase()).not.toContain('consultant');
  });

  test('bound: appends the consultant clause, naming it additive and ephemeral', ({ consultantRun }) => {
    const prompt = orchestratorSystemPrompt(consultantRun);
    expect.soft(prompt.startsWith(ORCHESTRATOR_SYSTEM_PROMPT)).toBe(true); // base preserved, clause appended
    expect.soft(prompt).toContain('## The consultant');
    expect.soft(prompt.toLowerCase()).toContain('ephemeral');
    expect.soft(prompt.toLowerCase()).toContain('additive, never substitutive');
  });
});

// Finding 1: the run-facing guard the leak slipped through — list_snippets at
// the tool altitude. An unbound run's library must name no consultant snippet
// (body or key, in any section); a bound run shows the phase's checkpoint.
describe('list_snippets default-off (consultant snippets are gated per-run)', () => {
  test('unbound: the rendered library names no consultant snippet, default or all=true', async ({ run }) => {
    const { call } = harness(run, { phase: 'frame' });
    const def = text(await call('list_snippets'));
    expect.soft(def).not.toContain('consultant');
    const all = text(await call('list_snippets', { all: true }));
    expect.soft(all).not.toContain('consultant');
  });

  test('bound: the owning phase’s checkpoint snippet surfaces as a full body', async ({ consultantRun }) => {
    const { call } = harness(consultantRun, { phase: 'frame', consultant: new FakeWorker('claude') });
    const def = text(await call('list_snippets'));
    expect.soft(def).toContain('<snippet key="consultant-frame">');
  });
});

describe('consultant enumeration (both hosts surface it)', () => {
  test('a settled consultant turn fixes the branch (the headless-settled case) and empties the branch paragraph', async ({
    projectDir,
    consultantRun,
  }) => {
    await execa('git', ['init', '-b', 'main'], { cwd: projectDir });
    const consultant = new FakeWorker('claude');
    const { call } = harness(consultantRun, { phase: 'frame', consultant });

    // A consultant turn IS a worker prompt — and it can settle before create_branch
    // runs, the case the async workerDispatched flag doesn't cover.
    await call('send_prompt', { role: 'consultant', tag: 'custom', body: 'frame analysis' });

    const refused = await call('create_branch', { name: 'feat/too-late' });
    expect.soft(refused.isError).toBe(true);
    expect.soft(text(refused)).toContain('branch is fixed');
    // The first-phase brief no longer offers the branch paragraph either.
    expect.soft(buildPhaseBrief(consultantRun, 'frame')).not.toContain('the run works on exactly one branch');
  });

  test('check_turns enumerates a still-running consultant turn on the interactive host', async ({ consultantRun }) => {
    const consultant = new DeferredWorker('claude');
    const { call } = harness(consultantRun, { phase: 'spec', consultant, async: true });
    await call('send_prompt', { role: 'consultant', tag: 'custom', body: 'audit' });

    const checked = await call('check_turns');
    const joined = checked.content.map((c) => (c as { text?: string }).text ?? '').join('\n');
    expect.soft(joined).toContain('consultant'); // the scan (ROLES = workerRolesFor) reaches it
    expect.soft(joined).toContain('still running');
  });
});

describe('consultant checkpoint brief injection (orchestrator-only, additive)', () => {
  // The cohort lives in the orchestrator brief (F3) — so buildPhaseBrief DOES
  // name the consultant when bound, and is byte-for-byte today's when not.
  // Finding 3: the consultant is a PRIMARY numbered step when bound (a model
  // executing the list can't skip it), not an appended note after a step that
  // says "two". So the bound brief's analysis/synthesis steps change shape.
  test('the frame brief makes the consultant a primary send step when bound — three sends, not an appended note', ({ run, consultantRun }) => {
    const bound = buildPhaseBrief(consultantRun, 'frame');
    // The build-analysts share one fan-out send; the consultant is a separate
    // send (its own consultant-frame body), and compare-notes still anonymizes.
    expect.soft(bound).toContain('one fan-out call');
    expect.soft(bound).toContain('consultant-frame');
    expect.soft(bound).toContain('separate send');
    expect.soft(bound).toContain('anonymized peers');

    const unbound = buildPhaseBrief(run, 'frame');
    expect.soft(unbound.toLowerCase()).not.toContain('consultant');
    // Unbound: the fan-out to the two build-analysts, no consultant send.
    expect.soft(unbound).toContain('one fan-out call');
    expect.soft(unbound).toContain('["implementer", "reviewer"]');
  });

  test('the RIR research brief takes the same conditional shape', ({ run, consultantRun }) => {
    const bound = buildPhaseBrief(consultantRun, 'research');
    expect.soft(bound).toContain('one fan-out call');
    expect.soft(bound).toContain('consultant-frame'); // research maps to the frame checkpoint mode
    expect.soft(bound).toContain('separate send');
    expect.soft(bound).toContain('anonymized peers');

    const unbound = buildPhaseBrief(run, 'research');
    expect.soft(unbound.toLowerCase()).not.toContain('consultant');
    expect.soft(unbound).toContain('one fan-out call');
  });

  test('the spec brief gains the bet-audit step (folding severity into human_decisions) when bound; unbound is clean', ({
    run,
    consultantRun,
  }) => {
    const bound = buildPhaseBrief(consultantRun, 'spec'); // framing-only run → the draft entry variant
    expect.soft(bound).toContain('Consultant checkpoint');
    expect.soft(bound).toContain('consultant-spec');
    expect.soft(bound).toContain('human_decisions');
    expect.soft(bound).toContain('never re-grade');
    expect.soft(buildPhaseBrief(run, 'spec').toLowerCase()).not.toContain('consultant');
  });

  test('the impl brief VERIFIES the frozen contract when bound + frozen; notes a skip when bound + unfrozen; unbound is clean', ({
    run,
    consultantRun,
  }) => {
    // Bound + a frozen contract on state → the verify step points at the contract,
    // names consultant-verify, and routes a failed assertion to a high.
    consultantRun.acceptanceContract = { path: 'docs/specs/x.acceptance.md', commit: 'abc123' };
    const frozen = buildPhaseBrief(consultantRun, 'impl');
    expect.soft(frozen).toContain('Consultant checkpoint');
    expect.soft(frozen).toContain('consultant-verify');
    expect.soft(frozen).toContain('docs/specs/x.acceptance.md');
    expect.soft(frozen).toContain('high human_decision');
    expect.soft(frozen).not.toContain('consultant-impl'); // Full's impl verifies, it does not re-run the open-ended audit

    // Bound + no frozen contract → a noted skip, never silent, never a fallback audit.
    delete consultantRun.acceptanceContract;
    const unfrozen = buildPhaseBrief(consultantRun, 'impl');
    expect.soft(unfrozen).toContain('Consultant checkpoint');
    expect.soft(unfrozen).toContain('no frozen acceptance contract');

    // Unbound → byte-for-byte clean.
    expect.soft(buildPhaseBrief(run, 'impl').toLowerCase()).not.toContain('consultant');
  });

  test('the plan brief AUTHORS the contract when bound (write-not-commit, spec-only, missing→high); unbound is clean', ({
    run,
    consultantRun,
  }) => {
    // The author step derives the contract path from the spec path; the plan brief
    // also embeds the spec file, so it must exist on disk in the run's cwd.
    consultantRun.specPath = 'docs/specs/x.md';
    mkdirSync(join(consultantRun.cwd, 'docs/specs'), { recursive: true });
    writeFileSync(join(consultantRun.cwd, 'docs/specs/x.md'), '# spec\n');
    const bound = buildPhaseBrief(consultantRun, 'plan');
    expect.soft(bound).toContain('Consultant checkpoint');
    expect.soft(bound).toContain('consultant-contract');
    expect.soft(bound).toContain('docs/specs/x.acceptance.md'); // the derived target path
    expect.soft(bound).toContain('blind to the plan and the code'); // spec-only independence
    expect.soft(bound).toContain('NOT commit'); // the consultant writes, never commits
    expect.soft(bound).toContain('human_decision'); // missing-contract → high

    // Finding 4 (blindness): the author dispatch must come AFTER the spec commit but
    // BEFORE the planning prompt, so a compliant orchestrator authors before it has
    // seen the plan. Assert the order in the rendered brief.
    const specCommitAt = bound.indexOf('commit the approved spec');
    const authorAt = bound.indexOf('author the acceptance contract');
    const planPromptAt = bound.indexOf('start-plan');
    expect.soft(specCommitAt).toBeGreaterThanOrEqual(0);
    expect.soft(authorAt).toBeGreaterThan(specCommitAt);
    expect.soft(planPromptAt).toBeGreaterThan(authorAt);

    // Unbound → byte-for-byte clean.
    expect.soft(buildPhaseBrief(run, 'plan').toLowerCase()).not.toContain('consultant');
  });
});

// Guarantee 1 (no consultant ⇒ byte-for-byte unchanged) and Guarantee 2 (bound ⇒
// the contract is active author→verify) asserted at the TOOL surface — get_task
// (the brief the orchestrator actually reads) and list_snippets — not only the
// buildPhaseBrief helper. The send_prompt schema/identity guarantees are above.
describe('acceptance contract at the tool altitude (get_task + list_snippets)', () => {
  test('unbound: get_task for plan and impl carries no contract or consultant text', async ({ run }) => {
    for (const phase of ['plan', 'impl'] as const) {
      const { call } = harness(run, { phase });
      const brief = text(await call('get_task')).toLowerCase();
      expect.soft(brief, `${phase} brief`).not.toContain('consultant');
      expect.soft(brief, `${phase} brief`).not.toContain('acceptance contract');
    }
  });

  test('bound: get_task for plan AUTHORS the contract through the tool', async ({ consultantRun }) => {
    consultantRun.specPath = 'docs/specs/x.md';
    mkdirSync(join(consultantRun.cwd, 'docs/specs'), { recursive: true });
    writeFileSync(join(consultantRun.cwd, 'docs/specs/x.md'), '# spec\n');
    const { call } = harness(consultantRun, { phase: 'plan', consultant: new FakeWorker('claude') });

    const brief = text(await call('get_task'));

    expect.soft(brief).toContain('consultant-contract');
    expect.soft(brief).toContain('docs/specs/x.acceptance.md'); // the derived target
    expect.soft(brief).toContain('NOT commit'); // write-not-commit
  });

  test('bound: get_task for impl VERIFIES the frozen contract through the tool', async ({ consultantRun }) => {
    consultantRun.acceptanceContract = { path: 'docs/specs/x.acceptance.md', commit: 'deadbeef' };
    saveRunState(consultantRun);
    const { call } = harness(consultantRun, { phase: 'impl', consultant: new FakeWorker('claude') });

    const brief = text(await call('get_task'));

    expect.soft(brief).toContain('consultant-verify');
    expect.soft(brief).toContain('docs/specs/x.acceptance.md'); // the frozen ref
    expect.soft(brief).toContain('high human_decision'); // a failed assertion holds the crossing
  });

  test('bound: list_snippets surfaces the contract checkpoint snippet in its owning phase', async ({ consultantRun }) => {
    const consultant = new FakeWorker('claude');
    const atPlan = text(await harness(consultantRun, { phase: 'plan', consultant }).call('list_snippets'));
    expect.soft(atPlan).toContain('<snippet key="consultant-contract">');
    const atImpl = text(await harness(consultantRun, { phase: 'impl', consultant }).call('list_snippets'));
    expect.soft(atImpl).toContain('<snippet key="consultant-verify">');
  });
});

// Guarantee 1, the arc that DEFERRED the contract: a consultant-bound RIR run must
// not see contract/verify at any tool surface — the feature does not leak into rir.
describe('RIR + consultant: the contract feature does not leak into the deferred arc', () => {
  const rirConsultantRun = (projectDir: string): RunState =>
    createRun({ cwd: projectDir, workflow: 'rir', bindings: consultantBindings, framing: 'f' });

  test('orchestratorSystemPrompt is byte-for-byte the BASE consultant clause — no contract/verify text', ({ projectDir }) => {
    const prompt = orchestratorSystemPrompt(rirConsultantRun(projectDir));
    // The base clause, not the full-only contract addendum — byte-for-byte.
    expect.soft(prompt).toBe(`${ORCHESTRATOR_SYSTEM_PROMPT}\n\n${CONSULTANT_IDENTITY_CLAUSE}`);
    expect.soft(prompt.toLowerCase()).not.toContain('acceptance contract');
    expect.soft(prompt.toLowerCase()).not.toContain('execute-to-observe');
    // Contrast: a bound FULL run DOES gain the addendum (proves it is arc-scoped, not absent).
    const full = orchestratorSystemPrompt(
      createRun({ cwd: projectDir, workflow: 'full', bindings: consultantBindings, framing: 'f' }),
    );
    expect.soft(full.toLowerCase()).toContain('acceptance contract');
  });

  test('list_snippets (phase view and all=true) names no contract/verify snippet, but keeps RIR’s own', async ({
    projectDir,
  }) => {
    const consultant = new FakeWorker('claude');
    for (const view of [{}, { all: true }] as const) {
      const lib = text(await harness(rirConsultantRun(projectDir), { phase: 'research', consultant }).call('list_snippets', view));
      expect.soft(lib, JSON.stringify(view)).not.toContain('consultant-contract');
      expect.soft(lib, JSON.stringify(view)).not.toContain('consultant-verify');
      expect.soft(lib, JSON.stringify(view)).not.toContain('consultant-spec'); // also Full-only — per-arc honesty
    }
    // all=true still exposes the consultant snippets RIR's own checkpoints reach.
    const all = text(await harness(rirConsultantRun(projectDir), { phase: 'research', consultant }).call('list_snippets', { all: true }));
    expect.soft(all).toContain('consultant-frame');
    expect.soft(all).toContain('consultant-impl');
  });
});

// Guarantee 2 MECHANICALLY (not by prompt): advance_phase cannot proceed past the
// contract chain on a Full+consultant run — author at plan, verify at impl — unless
// the orchestrator records a high (which itself holds the AFK crossing). This is
// the gap the review named: prior tests proved the brief ASKS; these prove the tool
// REFUSES. Each clears the review-round rail first (rounds[phase] = 1).
describe('advance_phase acceptance-contract rail (Full + consultant)', () => {
  const advance = { summary: 's', artifacts: [] };
  const high = { ...advance, human_decisions: [{ title: 'no contract', severity: 'high' as const }] };

  test('plan REFUSES with no authored contract (no draft marker) and no high', async ({ consultantRun }) => {
    consultantRun.rounds.plan = 1;
    const { call } = harness(consultantRun, { phase: 'plan', consultant: new FakeWorker('claude') });
    const res = await call('advance_phase', advance);
    expect.soft(res.isError).toBe(true);
    expect.soft(text(res)).toContain('acceptance contract');
  });

  test('plan ADVANCES once this run authored (a draft marker exists)', async ({ consultantRun }) => {
    consultantRun.rounds.plan = 1;
    consultantRun.acceptanceContractDraft = { path: 'docs/specs/x.acceptance.md', sessionId: 'c', authoredAt: 'now' };
    const { call } = harness(consultantRun, { phase: 'plan', consultant: new FakeWorker('claude') });
    const res = await call('advance_phase', advance);
    expect.soft(res.isError).toBeFalsy();
  });

  test('plan ADVANCES with no contract when a high is recorded (the escape hatch that holds the AFK crossing)', async ({
    consultantRun,
  }) => {
    consultantRun.rounds.plan = 1;
    const { call } = harness(consultantRun, { phase: 'plan', consultant: new FakeWorker('claude') });
    const res = await call('advance_phase', high);
    expect.soft(res.isError).toBeFalsy();
  });

  test('impl REFUSES when a frozen contract was not verified (no verifiedAt) and no high', async ({ consultantRun }) => {
    consultantRun.rounds.impl = 1;
    consultantRun.acceptanceContract = { path: 'docs/specs/x.acceptance.md', commit: 'abc' };
    const { call } = harness(consultantRun, { phase: 'impl', consultant: new FakeWorker('claude') });
    const res = await call('advance_phase', advance);
    expect.soft(res.isError).toBe(true);
    expect.soft(text(res)).toContain('not been verified');
  });

  test('impl ADVANCES once verification ran (verifiedAt stamped)', async ({ consultantRun }) => {
    consultantRun.rounds.impl = 1;
    consultantRun.acceptanceContract = { path: 'docs/specs/x.acceptance.md', commit: 'abc', verifiedAt: 'now' };
    const { call } = harness(consultantRun, { phase: 'impl', consultant: new FakeWorker('claude') });
    const res = await call('advance_phase', advance);
    expect.soft(res.isError).toBeFalsy();
  });

  test('impl with NO frozen contract is the noted-skip case — no verify rail (the absence was a high at plan)', async ({
    consultantRun,
  }) => {
    consultantRun.rounds.impl = 1; // no acceptanceContract on state
    const { call } = harness(consultantRun, { phase: 'impl', consultant: new FakeWorker('claude') });
    const res = await call('advance_phase', advance);
    expect.soft(res.isError).toBeFalsy();
  });

  test('the rail is consultant-only: an unbound Full plan advances with no contract', async ({ run }) => {
    run.rounds.plan = 1;
    const { call } = harness(run, { phase: 'plan' });
    const res = await call('advance_phase', advance);
    expect.soft(res.isError).toBeFalsy();
  });
});

describe('consultant orphan recovery (discard-and-reseed)', () => {
  const allText = (result: ToolResult): string => result.content.map((c) => (c as { text?: string }).text ?? '').join('\n');

  test('a stale consultant record is cleared and the new body re-dispatched in one call — no refusal', async ({
    consultantRun,
  }) => {
    // An orphan on disk the fresh dispatcher does not own (a prior server died).
    markPendingTurn(consultantRun, 'consultant', 'consultant-spec');
    const consultant = new DeferredWorker('claude');
    const { call } = harness(consultantRun, { phase: 'spec', consultant, async: true });

    const result = await call('send_prompt', { role: 'consultant', tag: 'custom', body: 'reseeded body' });

    expect.soft(result.isError).toBeUndefined();
    expect.soft(allText(result)).toContain('Dispatched to the consultant'); // dispatched, not refused
    expect.soft(consultant.calls[0]?.prompt).toBe('reseeded body'); // the fresh body the orchestrator re-supplied
  });

  test('a consultant orphan blocks advance_phase, and the refusal gives the reseed recovery — not takeover as the only path (finding 2)', async ({
    consultantRun,
  }) => {
    markPendingTurn(consultantRun, 'consultant', 'consultant-spec');
    const consultant = new DeferredWorker('claude');
    const { call } = harness(consultantRun, { phase: 'spec', consultant, async: true });

    const blocked = await call('advance_phase', { summary: 's', artifacts: [] });
    expect.soft(blocked.isError).toBe(true);
    expect.soft(text(blocked)).toContain("can't advance the phase"); // still gated — not exempt
    // The policy-aware recovery: resend reseeds, no human action needed — the
    // gate no longer steers a discard-and-reseed orphan to a takeover it doesn't need.
    expect.soft(text(blocked)).toContain('resend');
    expect.soft(text(blocked).toLowerCase()).toContain('ephemeral');
    expect.soft(text(blocked)).toContain('no human action is needed');
  });

  test('a consultant orphan blocks ask_human with the same reseed recovery copy (finding 2)', async ({
    consultantRun,
  }) => {
    markPendingTurn(consultantRun, 'consultant', 'consultant-spec');
    const consultant = new DeferredWorker('claude');
    const { call } = harness(consultantRun, { phase: 'spec', consultant, async: true });

    const blocked = await call('ask_human', { question: 'q' });
    expect.soft(blocked.isError).toBe(true);
    expect.soft(text(blocked)).toContain("can't queue a question");
    expect.soft(text(blocked)).toContain('resend');
    expect.soft(text(blocked).toLowerCase()).toContain('ephemeral');
  });

  test('a persistent-role orphan still gets the takeover recovery (the policy branch is real)', async ({
    run,
  }) => {
    // A reviewer orphan on disk (persistent role) → takeover, not reseed.
    markPendingTurn(run, 'reviewer', 'review-spec');
    const { call } = harness(run, { phase: 'spec', async: true });

    const blocked = await call('advance_phase', { summary: 's', artifacts: [] });
    expect.soft(blocked.isError).toBe(true);
    expect.soft(text(blocked)).toContain('duet takeover reviewer');
    expect.soft(text(blocked).toLowerCase()).toContain('resumable');
    // The reviewer is not ephemeral — the reseed framing must NOT appear for it.
    expect.soft(text(blocked)).not.toContain('reseeds');
  });

  test('check_turns surfaces a consultant orphan as "just resend", read-only-framed (not the takeover refusal)', async ({
    consultantRun,
  }) => {
    markPendingTurn(consultantRun, 'consultant', 'consultant-spec');
    const consultant = new DeferredWorker('claude');
    const { call } = harness(consultantRun, { phase: 'spec', consultant, async: true });

    const checked = await call('check_turns');
    const joined = allText(checked);
    expect.soft(joined).toContain('just resend');
    expect.soft(joined).toContain('ephemeral and read-only'); // distinct from the persistent "may still be editing the repo"
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
    expect.soft(text(first)).toContain('yes, behind a flag'); // the staged answer is surfaced; the exact prefix wording isn't the contract
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

  test('first-terminal-wins (symmetric): an advance_phase after ask_human flagged is refused', async ({ run }) => {
    const { call } = harness(run, { phase: 'frame' });
    const first = await call('ask_human', { question: 'which migration?' });
    expect.soft(first.isError).toBeUndefined();
    expect.soft(run.terminalMarker).toEqual({ phase: 'frame', kind: 'flag' });

    // The phase is already ending on a queued flag — advance_phase is now refused
    // by the SAME shared terminal group (proven on both terminal tools), and the
    // flag marker stands as the first decision.
    const second = await call('advance_phase', { summary: 'done', artifacts: [] });
    expect.soft(second.isError).toBe(true);
    expect.soft(text(second)).toContain('already ending');
    expect.soft(run.terminalMarker).toEqual({ phase: 'frame', kind: 'flag' });
  });
});

describe('advance_phase human_decisions (the tool stays signal-only; the hold lives in the crossing path)', () => {
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

  test('advance_phase itself records a normal advance regardless of severity — the hold is in lifecycle, not the tool (slice 5)', async ({ run }) => {
    const { call } = harness(run, { phase: 'frame' });
    const result = await call('advance_phase', { summary: 's', artifacts: [], human_decisions: [{ title: 'storage backend', severity: 'high' }] });
    expect.soft(result.isError).toBeUndefined();
    // The terminal marker is the normal advance — advance_phase does not gate on
    // severity. The severity HOLD lives in the crossing path (driveToQuiescence /
    // enterAfk / status, exercised in lifecycle.test.ts and status.test.ts), so
    // the tool stays signal-only and only the recorded packet differs.
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
    run.gatesAt = ['finish'];
    run.rounds.spec = 1;
    const { call } = harness(run, { phase: 'spec' });
    const result = await call('advance_phase', { summary: 'converged', artifacts: [] });

    expect(text(result)).toContain('pre-authorized');
    expect(text(result)).not.toContain('gate decision arrives');
    expect(text(result)).toContain('continues immediately'); // headless: the run auto-continues here
  });

  test('a pre-authorized gate on the interactive host names the handoff, not auto-continuation (F1)', async ({ run }) => {
    run.gatesAt = ['finish'];
    run.rounds.spec = 1;
    // The interactive host: a dispatcher is present (the host switch). A
    // pre-authorized gate does NOT auto-continue here — only the headless driver
    // auto-crosses — so the message must say to hand off, not to wait for the
    // next phase.
    const { call } = harness(run, { phase: 'spec', async: true });
    const result = await call('advance_phase', { summary: 'converged', artifacts: [] });

    expect.soft(text(result)).toContain('pre-authorized');
    expect.soft(text(result)).toContain('duet afk'); // hand off to run the rest unattended
    expect.soft(text(result)).not.toContain('continues immediately');
  });

  test('non-review-loop phases may advance without a review round (frame synthesizes, finish ships)', async ({ run }) => {
    const frame = harness(run, { phase: 'frame' });
    const frameResult = await frame.call('advance_phase', { summary: 'direction', artifacts: [] });
    expect(frameResult.isError).toBeUndefined();

    // finish has reviewLoop:false, so advance_phase requires no review round; it
    // lands on the Open-PR gate (the run completes when that gate crosses — see
    // lifecycle.test.ts), so the tool records the advance rather than erroring.
    const finish = harness(run, { phase: 'finish' });
    const finishResult = await finish.call('advance_phase', { summary: 'PR: https://example.com/pr/1', artifacts: [] });
    expect.soft(finishResult.isError).toBeUndefined();
    expect.soft(text(finishResult)).toContain('Phase advance recorded');
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
    ] as const) {
      const result = await call(name, args);
      expect.soft(result.isError, name).toBe(true);
      expect.soft(text(result), name).toContain(`${name} is refused here`);
    }
    // None of them ran: no worker turn, no branch, no proposal.
    expect.soft(implementer.calls).toHaveLength(0);
    expect.soft(reviewer.calls).toHaveLength(0);
    expect.soft(run.branch).toBeUndefined();
    const persisted = loadRunState(projectDir, run.runId);
    expect.soft(persisted.snippetProposals).toHaveLength(0);

    // write_note is NOT refused (F2): a pure note append has no statechart
    // effect, so it works at the gate moment a friction observation crystallizes.
    const noted = await call('write_note', { observation: 'friction at the gate' });
    expect.soft(noted.isError).toBeUndefined();
    expect.soft(readFileSync(join(runDirOf(projectDir, run.runId), 'notes.md'), 'utf8')).toContain('friction at the gate');

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

  test('list_snippets renders the run’s own arc (a RIR run sees RIR phases, not Full’s)', async ({ projectDir }) => {
    // Finding #2 — exercise the tool surface, not just renderSnippetLibrary: a
    // workflow:'rir' run on the research phase indexes the RIR arc only.
    const rir = createRun({ cwd: projectDir, bindings: DEFAULT_BINDINGS, workflow: 'rir', framing: 'build a thing' });
    const { call } = harness(rir, { phase: 'research' });
    const library = text(await call('list_snippets'));

    expect.soft(library.startsWith('<snippet_library phase="research">')).toBe(true);
    expect.soft(library).toContain('<snippet key="think-holistic">'); // research's own template, in full
    expect.soft(library).toContain('<phase name="implement">'); // the next RIR phase, indexed by key
    expect.soft(library).not.toContain('<phase name="plan">'); // no Full-only phase leaks in
    expect.soft(library).not.toContain('<phase name="spec">');
  });

  test('list_snippets resolves the vendored methodology path at the tool surface (no token, no ~/.claude)', async ({ run }) => {
    // The run-surface altitude for {{lessons_dir}} resolution: snippets.test.ts
    // layer 3 guards renderSnippetLibrary (the faster library-local check); this
    // guards what list_snippets actually hands a worker on the plan phase, where
    // start-plan/review-plan cite the vendored lessons in full.
    const { call } = harness(run, { phase: 'plan' });
    const library = text(await call('list_snippets'));

    expect.soft(library, 'an unresolved {{lessons_dir}} token reached the tool result').not.toContain('{{lessons_dir}}');
    expect.soft(library, 'a ~/.claude path reached the tool result').not.toContain('~/.claude');
    expect.soft(library, 'the resolved vendored path a worker receives').toContain(join(LESSONS_DIR, 'codebase-design/deep-modules.md'));
  });

  test('list_snippets serves a project .duet/snippets.toml override (the contextual wire is connected)', async ({ run }) => {
    // The integration altitude: snippets.test.ts proves the merge; this proves
    // tools.ts threads the run's cwd into the resolver so the project override is
    // discovered and served (with no provenance marker on the wire).
    mkdirSync(join(run.cwd, '.duet'), { recursive: true });
    writeFileSync(join(run.cwd, '.duet', 'snippets.toml'), '[[snippets]]\nkey = "review-plan"\nexpand = "PROJECT-OVERRIDDEN review-plan body"\n');
    const { call } = harness(run, { phase: 'plan' });
    const library = text(await call('list_snippets'));
    expect.soft(library).toContain('PROJECT-OVERRIDDEN review-plan body');
    expect.soft(library).toContain('<snippet key="review-plan">'); // tag shape unchanged — provenance never reaches the worker
  });

  test('list_snippets fails closed on an unknown-key override — a readable tool error, not a crashed turn', async ({ run }) => {
    mkdirSync(join(run.cwd, '.duet'), { recursive: true });
    writeFileSync(join(run.cwd, '.duet', 'snippets.toml'), '[[snippets]]\nkey = "no-such-key"\nexpand = "x"\n');
    const { call } = harness(run, { phase: 'plan' });
    const result = await call('list_snippets');
    expect.soft(result.isError).toBe(true);
    expect.soft(text(result)).toContain('no-such-key');
    expect.soft(text(result)).toContain('could not be loaded');
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

describe('async send_prompt + check_turns (the interactive host)', () => {
  const allText = (result: ToolResult): string =>
    result.content.map((c) => (c as { text?: string }).text ?? '').join('\n');

  test('send_prompt returns BEFORE the worker turn completes — the session stays live', async ({ run }) => {
    expect.assertions(3);
    const reviewer = new DeferredWorker('codex');
    const { call } = harness(run, { reviewer, async: true });

    const result = await call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'review' });
    // The dispatch returned while the worker turn is still pending — the whole point.
    expect.soft(reviewer.pending).toBe(1);
    expect.soft(result.isError).toBeUndefined();
    expect.soft(allText(result)).toContain('Dispatched to the reviewer');
  });

  test('check_turns reports still-running, then delivers the text and commits the durable bookkeeping at settle', async ({
    projectDir,
    run,
  }) => {
    const reviewer = new DeferredWorker('codex');
    const { call } = harness(run, { reviewer, async: true });
    await call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'review' });

    // Before the worker settles: nothing to deliver, the role is still running.
    const early = await call('check_turns');
    expect.soft(allText(early)).toContain('still running');
    expect.soft(allText(early)).not.toContain('scripted response');

    reviewer.resolve({ sessionId: 'rev-1' });
    await flush();
    // Settle committed the durable bookkeeping (round, sent tag, session id) — even
    // before collect, so duet status stays truthful the instant the worker finished.
    const settled = loadRunState(projectDir, run.runId);
    expect.soft(settled.rounds.spec).toBe(1);
    expect.soft(settled.sentSnippets?.spec?.reviewer).toEqual(['review-spec']);
    expect.soft(settled.workerSessions.reviewer).toBe('rev-1');

    // Collect delivers the worker's text and clears the pending record.
    const collected = await call('check_turns');
    expect.soft(allText(collected)).toContain('scripted response');
    expect.soft(loadRunState(projectDir, run.runId).pendingTurns?.reviewer).toBeUndefined();
  });

  test('S7: an accepted-but-failed /compact resets the implementer and prescribes recover-context, on the async path', async ({
    projectDir,
    run,
  }) => {
    run.workerSessions = { implementer: 'sess-prior' };
    saveRunState(run);
    const implementer = new DeferredWorker('claude');
    const { call } = harness(run, { implementer, async: true });
    await call('send_prompt', { role: 'implementer', tag: 'custom', body: '/compact drop the journey' });

    // The short /compact cap rode the dispatched turn (dispatcher path).
    expect.soft(implementer.calls[0]?.timeoutMs).toBe(8 * 60_000);

    // The compact aborts (accepted-but-failed) — it stays collectible, the reset
    // lands at settle, and collect renders the recover-context prescription.
    implementer.resolve({ aborted: true, sessionId: 'sess-compact' });
    await flush();
    expect.soft(loadRunState(projectDir, run.runId).workerSessions.implementer).toBeUndefined(); // reset at settle

    const collected = await call('check_turns');
    expect.soft(allText(collected)).toContain('recover-context');
    expect.soft(loadRunState(projectDir, run.runId).pendingTurns?.implementer).toBeUndefined(); // collected clean

    // The next send to the (re-opened) implementer mints fresh — no resume of the bloated session.
    await call('send_prompt', { role: 'implementer', tag: 'custom', body: 'reread and continue' });
    expect.soft(implementer.calls[1]?.sessionId).toBeUndefined();
  });

  test('the same-role guard spans the lifecycle: running and ready-uncollected refuse; collecting re-opens', async ({
    run,
  }) => {
    const reviewer = new DeferredWorker('codex');
    const { call } = harness(run, { reviewer, async: true });
    await call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'r1' });

    // running → refused
    const whileRunning = await call('send_prompt', { role: 'reviewer', tag: 'custom', body: 'x' });
    expect.soft(whileRunning.isError).toBe(true);
    expect.soft(allText(whileRunning)).toContain('already in flight');
    expect.soft(reviewer.calls).toHaveLength(1); // never reached the worker

    // ready-uncollected → still refused (must read the prior answer + land the merge first)
    reviewer.resolve({ sessionId: 'rev-1' });
    await flush();
    expect.soft((await call('send_prompt', { role: 'reviewer', tag: 'custom', body: 'x' })).isError).toBe(true);

    // collect → re-opens; a fresh dispatch now reaches the worker
    await call('check_turns');
    expect.soft((await call('send_prompt', { role: 'reviewer', tag: 'custom', body: 'x2' })).isError).toBeUndefined();
    expect.soft(reviewer.calls).toHaveLength(2);
  });

  test('a failed turn also holds the guard until collected, then re-opens', async ({ run }) => {
    const reviewer = new DeferredWorker('codex');
    const { call } = harness(run, { reviewer, async: true });
    await call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'r1' });
    reviewer.reject(new Error('spawn codex ENOENT'));
    await flush();

    // failed-uncollected → refused
    expect.soft((await call('send_prompt', { role: 'reviewer', tag: 'custom', body: 'x' })).isError).toBe(true);
    // collect the failure → re-opens
    await call('check_turns');
    expect.soft((await call('send_prompt', { role: 'reviewer', tag: 'custom', body: 'x2' })).isError).toBeUndefined();
  });

  test('cross-role turns run concurrently — check_turns returns both, with cost and tokens merged', async ({
    projectDir,
    run,
  }) => {
    const implementer = new DeferredWorker('claude');
    const reviewer = new DeferredWorker('codex');
    const { call } = harness(run, { implementer, reviewer, async: true });

    await call('send_prompt', { role: 'implementer', tag: 'write-spec', body: 'draft' });
    await call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'review' });
    expect.soft(implementer.pending).toBe(1);
    expect.soft(reviewer.pending).toBe(1); // both in flight at once

    implementer.resolve({ sessionId: 'impl-1', costUsd: 1.25 });
    reviewer.resolve({ sessionId: 'rev-1', tokens: { input: 1000, output: 50 } });
    await flush();

    const both = allText(await call('check_turns'));
    expect.soft(both).toContain('── implementer ──');
    expect.soft(both).toContain('── reviewer ──');

    const disk = loadRunState(projectDir, run.runId);
    expect.soft(disk.costs.claudeWorkersUsd).toBe(1.25);
    expect.soft(disk.costs.codexTokens).toEqual({ input: 1000, output: 50 });
    expect.soft(disk.workerSessions).toMatchObject({ implementer: 'impl-1', reviewer: 'rev-1' });
  });

  test('check_turns delivers the per-turn footer too (F5 covers the async host)', async ({ run }) => {
    const reviewer = new DeferredWorker('codex');
    const { call } = harness(run, { reviewer, async: true });
    await call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'review' });
    reviewer.resolve({ sessionId: 'rev-1', tokens: { input: 2000, output: 400 }, context: { usedTokens: 100, windowTokens: 200 } });
    await flush();
    const collected = allText(await call('check_turns'));
    expect.soft(collected).toMatch(/\[context 50% · codex 2k\/400 tok · round 1\/\d+\]/);
  });

  test('a failed settle commits no round and no sent tag; the retry of the same tag is clean (rail preserved)', async ({
    projectDir,
    run,
  }) => {
    const reviewer = new DeferredWorker('codex');
    const { call } = harness(run, { reviewer, async: true });
    await call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'review' });
    reviewer.reject(new Error('spawn codex ENOENT'));
    await flush();

    // check_turns delivers the prescribed-recovery infra error.
    const collected = await call('check_turns');
    expect.soft(allText(collected)).toContain('infrastructure layer (spawn codex ENOENT)');
    expect.soft(allText(collected)).toContain('Retry this same send_prompt call once');

    const disk = loadRunState(projectDir, run.runId);
    expect.soft(disk.rounds.spec ?? 0).toBe(0); // no round
    expect.soft(disk.sentSnippets?.spec?.reviewer ?? []).toEqual([]); // no sent tag

    // The prescribed retry of the SAME tag does not trip the duplicate-template warning.
    const retry = await call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'review' });
    expect.soft(retry.isError).toBeUndefined();
    expect.soft(allText(retry)).toContain('Dispatched');
  });

  test('the branch-fixed flag is durable and one-way: a dispatch fixes the branch, a failed-then-collected turn keeps it fixed', async ({
    run,
  }) => {
    const implementer = new DeferredWorker('claude');
    const { call } = harness(run, { implementer, async: true });

    await call('send_prompt', { role: 'implementer', tag: 'write-spec', body: 'draft' });
    const afterDispatch = await call('create_branch', { name: 'feat/too-late' });
    expect.soft(afterDispatch.isError).toBe(true);
    expect.soft(allText(afterDispatch)).toContain('branch is fixed');

    // The turn FAILS and is collected (its pending record is cleared) — but the
    // branch stays fixed, because workerDispatched is one-way and never cleared.
    implementer.reject(new Error('spawn claude ENOENT'));
    await flush();
    await call('check_turns');
    const afterFailure = await call('create_branch', { name: 'feat/still-too-late' });
    expect.soft(afterFailure.isError).toBe(true);
    expect.soft(allText(afterFailure)).toContain('branch is fixed');
  });

  test('phase-exit (advance_phase & ask_human) is refused while a turn is running/failed/ready, allowed once drained', async ({
    run,
  }) => {
    const implementer = new DeferredWorker('claude');
    const { call } = harness(run, { phase: 'frame', implementer, async: true });

    await call('send_prompt', { role: 'implementer', tag: 'custom', body: 'x' });
    // running
    expect.soft((await call('advance_phase', { summary: 's', artifacts: [] })).isError).toBe(true);
    expect.soft((await call('ask_human', { question: 'q?' })).isError).toBe(true);

    // failed-uncollected
    implementer.reject(new Error('boom'));
    await flush();
    expect.soft((await call('advance_phase', { summary: 's', artifacts: [] })).isError).toBe(true);
    await call('check_turns'); // drain the failure

    // ready-uncollected
    await call('send_prompt', { role: 'implementer', tag: 'custom', body: 'y' });
    implementer.resolve({ sessionId: 'i1' });
    await flush();
    expect.soft((await call('advance_phase', { summary: 's', artifacts: [] })).isError).toBe(true);

    // drained → advance succeeds
    await call('check_turns');
    const adv = await call('advance_phase', { summary: 's', artifacts: [] });
    expect.soft(adv.isError).toBeUndefined();
    expect.soft(run.terminalMarker).toEqual({ phase: 'frame', kind: 'advance' });
  });

  test('phase-exit on the BLOCKING host is never gated by the in-memory in-flight set (structurally async-only)', async ({
    run,
  }) => {
    // The blocking host has no dispatcher: a send_prompt runs to completion before the
    // orchestrator can call a terminal tool, so there is never an uncollected turn to
    // strand. The phase-exit gate must therefore be OFF here regardless of the in-memory
    // turnsInFlight set (which the same-role send guard, not this gate, owns). Seed that
    // set live and confirm neither terminal tool is refused — the preservation oracle for
    // the base's unconditional `if (!dispatcher) return null`.
    const turnsInFlight = new Set<WorkerRole>(['implementer']);
    const { call } = harness(run, { phase: 'frame', turnsInFlight }); // async omitted → blocking host

    const adv = await call('advance_phase', { summary: 's', artifacts: [] });
    expect.soft(adv.isError).toBeUndefined();
    expect.soft(run.terminalMarker).toEqual({ phase: 'frame', kind: 'advance' });

    delete run.terminalMarker;
    const ask = await call('ask_human', { question: 'q?' });
    expect.soft(ask.isError).toBeUndefined();
  });

  test('the settle is lease-fenced: a superseded server (holdsLease false) writes nothing', async ({ projectDir, run }) => {
    const reviewer = new DeferredWorker('codex');
    const { call } = harness(run, { reviewer, async: true, holdsLease: () => false });
    await call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'review' });

    reviewer.resolve({ sessionId: 'rev-1' });
    await flush();

    // The background settle ran but the lease was lost — so it committed nothing:
    // no round, no session id, and the record never flipped off `running`.
    const disk = loadRunState(projectDir, run.runId);
    expect.soft(disk.rounds.spec ?? 0).toBe(0);
    expect.soft(disk.workerSessions.reviewer).toBeUndefined();
    expect.soft(disk.pendingTurns?.reviewer?.status).toBe('running');
  });

  // Round-2: the lease gate is non-throwing. The production holdsLease does a
  // loadRunState that can fault; the leaseHeld wrapper reads a thrown check as
  // "not held" so finalize and failSafe stay total. Seam-reachable via the
  // injected holdsLease thunk (the harness already parameterizes it); the
  // failSafe arm uses the same wrapper, and the synchronous-setup-fault arm is a
  // run-store fault (not a seam) — both design-guaranteed, not fault-injected.
  test('a throwing lease check stays total: no disk write, no unhandled rejection, and the live record drains off running (never stranded)', async ({
    projectDir,
    run,
  }) => {
    const rejections: unknown[] = [];
    const onRejection = (e: unknown): void => {
      rejections.push(e);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const reviewer = new DeferredWorker('codex');
      const { call, dispatcher } = harness(run, {
        reviewer,
        async: true,
        holdsLease: () => {
          throw new Error('state-file fault during lease check');
        },
      });
      await call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'review' });
      reviewer.resolve({ sessionId: 'rev-1' });
      await flush();
      await flush(); // let any stray rejection surface

      // Unverifiable lease → no durable settle bookkeeping: a genuinely
      // superseded server must leave its disk record `running` for the new owner
      // to orphan-handle, so the settle writes nothing here either.
      const disk = loadRunState(projectDir, run.runId);
      expect.soft(disk.rounds.spec ?? 0).toBe(0);
      expect.soft(disk.workerSessions.reviewer).toBeUndefined();
      expect.soft(disk.pendingTurns?.reviewer?.status).toBe('running'); // disk untouched
      // …but on a LIVE server whose check merely faulted, the in-memory record is
      // NOT stranded `running` — it flipped failed, so check_turns can drain it.
      expect.soft(dispatcher!.statusOf('reviewer')).toBe('failed');

      const collected = await call('check_turns');
      expect.soft(allText(collected)).toContain('infrastructure layer'); // drained as a failed turn
      expect.soft(dispatcher!.statusOf('reviewer')).toBeUndefined(); // collected → role re-opened
      // The drain cleared the pending record but committed NO settle bookkeeping.
      const after = loadRunState(projectDir, run.runId);
      expect.soft(after.rounds.spec ?? 0).toBe(0);
      expect.soft(after.workerSessions.reviewer).toBeUndefined();
      expect.soft(after.pendingTurns?.reviewer).toBeUndefined();
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect.soft(rejections).toEqual([]); // the lease gate did not throw out of the chain
  });

  test('reconnect orphan: a record on disk with no live owner is refused on send, blocks phase-exit, and is surfaced by check_turns', async ({
    projectDir,
    run,
  }) => {
    // Seed a pending record on disk, then build a FRESH dispatcher (empty
    // in-memory) over the run — exactly the post-reconnect state.
    run.pendingTurns = { reviewer: { tag: 'review-spec', startedAt: '2026-06-21T00:00:00.000Z', status: 'running' } };
    saveRunState(run);
    const { call, reviewer, dispatcher } = harness(run, { async: true });
    expect.soft(dispatcher?.hasPending()).toBe(false); // the fresh dispatcher owns nothing

    // (a) a same-role send is refused with the orphan copy and never reaches the worker
    const send = await call('send_prompt', { role: 'reviewer', tag: 'custom', body: 'x' });
    expect.soft(send.isError).toBe(true);
    expect.soft(allText(send)).toContain('orphaned');
    expect.soft((reviewer as FakeWorker).calls).toHaveLength(0);

    // (b) advance_phase AND ask_human are refused (the disk half of the gate)
    expect.soft((await call('advance_phase', { summary: 's', artifacts: [] })).isError).toBe(true);
    expect.soft((await call('ask_human', { question: 'q?' })).isError).toBe(true);

    // (c) check_turns surfaces the orphan rather than say "nothing in flight"
    const checked = await call('check_turns');
    expect.soft(allText(checked)).toContain('orphaned');
    expect.soft(allText(checked)).not.toContain('No worker turns are in flight');
    // The orphan persists — never auto-collected, never auto-cleared.
    expect.soft(loadRunState(projectDir, run.runId).pendingTurns?.reviewer?.status).toBe('running');
  });

  test('the orphan refusal is session-aware: a SESSION orphan points at takeover and names the resume race', async ({
    run,
  }) => {
    run.workerSessions = { reviewer: 'rev-prev' }; // a session was captured before the crash
    run.pendingTurns = { reviewer: { tag: 'review-spec', startedAt: 't', status: 'running' } };
    saveRunState(run);
    const { call } = harness(run, { async: true });

    const send = await call('send_prompt', { role: 'reviewer', tag: 'custom', body: 'x' });
    expect.soft(send.isError).toBe(true);
    expect.soft(allText(send)).toContain('duet takeover reviewer');
    expect.soft(allText(send)).toContain('race the orphaned worker'); // the resume-race hazard
  });

  test('a NO-SESSION orphan refusal states the race honestly (old worker may still be editing the repo; dropping abandons)', async ({
    run,
  }) => {
    run.pendingTurns = { implementer: { tag: 'write-spec', startedAt: 't', status: 'running' } }; // no workerSessions.implementer
    saveRunState(run);
    const { call } = harness(run, { async: true });

    const send = await call('send_prompt', { role: 'implementer', tag: 'custom', body: 'x' });
    expect.soft(send.isError).toBe(true);
    expect.soft(allText(send)).toContain('editing the repo');
    expect.soft(allText(send)).toContain('ABANDONS');
    expect.soft(allText(send)).toContain('duet takeover implementer');
  });

  test('the heartbeat stops at settle — no further "running" lines accrue before collect', async ({ run, onTestFinished }) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const reviewer = new DeferredWorker('codex');
    const { call, lines } = harness(run, { reviewer, async: true });
    await call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'review' });

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const beforeSettle = lines.filter((l) => l.includes('⏳ reviewer turn running')).length;
    expect.soft(beforeSettle).toBeGreaterThanOrEqual(1);

    reviewer.resolve({ sessionId: 'rev-1' });
    await vi.advanceTimersByTimeAsync(0); // let the settle continuation run (clears the interval)
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const afterSettle = lines.filter((l) => l.includes('⏳ reviewer turn running')).length;
    expect.soft(afterSettle).toBe(beforeSettle); // settle stopped the heartbeat
  });

  test('steers ride a check_turns result (the phase-continuing steer surface)', async ({ run }) => {
    const reviewer = new DeferredWorker('codex');
    const { call } = harness(run, { reviewer, async: true });
    await call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'review' });
    reviewer.resolve({ sessionId: 'rev-1' });
    await flush();

    stageSteer(run, 'narrow the scope');
    const result = await call('check_turns');
    expect.soft(allText(result)).toContain('scripted response'); // the collected turn
    expect.soft(allText(result)).toContain('narrow the scope'); // the steer rode along
    expect.soft(listPendingSteers(run)).toEqual([]); // consumed once
  });

  // The non-throwing background lifecycle (review finding 1). The reachable
  // faults are exercised through the WorkerProvider seam: a synchronous launch
  // throw, and a mixed ready/failed batch. The deeper failSafe + collect
  // isolation guard a finalize/render disk fault inside settleTurn/clearPendingTurn
  // — run-store, NOT one of the six seams — so that branch is design-guaranteed
  // (terminal .catch + per-record try/catch, see turn-dispatcher.ts) and called
  // out here, not fault-injected.
  test('a synchronous runTurn throw is normalized in the background — send_prompt does not throw, the role flips failed (never stranded running), then collects', async ({
    run,
  }) => {
    const rejections: unknown[] = [];
    const onRejection = (e: unknown): void => {
      rejections.push(e);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const reviewer = new SyncThrowWorker('codex');
      const { call, dispatcher } = harness(run, { reviewer, async: true });
      // Pre-fix this threw out of dispatch (the bare runTurn() call) and rejected
      // the handler; post-fix the launch rides Promise.resolve().then, so the
      // throw is normalized in the background and dispatch returns cleanly.
      const dispatched = await call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'review' });
      expect.soft(dispatched.isError).toBeFalsy();
      expect.soft(text(dispatched)).toContain('Dispatched to the reviewer');
      await flush();
      // The role is NOT stranded running — the failure path flipped it, in memory
      // and on disk, so check_turns / status --wait can never hang on it.
      expect.soft(dispatcher!.statusOf('reviewer')).toBe('failed');
      expect.soft(loadRunState(run.cwd, run.runId).pendingTurns?.reviewer?.status).toBe('failed');
      // check_turns delivers the prescribed infra-failure recovery and re-opens the role.
      const collected = await call('check_turns');
      expect.soft(allText(collected)).toContain('infrastructure layer');
      expect.soft(dispatcher!.statusOf('reviewer')).toBeUndefined();
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect.soft(rejections).toEqual([]); // the terminal path leaks no unhandled rejection
  });

  test('a mixed batch — one role ready, one failed — collects in a single check_turns, each record handled independently', async ({
    run,
  }) => {
    const implementer = new DeferredWorker('claude');
    const reviewer = new DeferredWorker('codex');
    const { call, dispatcher } = harness(run, { implementer, reviewer, async: true });
    await call('send_prompt', { role: 'implementer', tag: 'draft', body: 'draft the spec' });
    await call('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'review' });
    implementer.resolve({ text: 'the draft', sessionId: 'impl-1' });
    reviewer.reject(new Error('codex exec boom'));
    await flush();
    expect.soft(dispatcher!.statusOf('implementer')).toBe('ready');
    expect.soft(dispatcher!.statusOf('reviewer')).toBe('failed');

    const collected = await call('check_turns');
    const out = allText(collected);
    expect.soft(out).toContain('── implementer ──');
    expect.soft(out).toContain('the draft'); // the success delivered
    expect.soft(out).toContain('── reviewer ──');
    expect.soft(out).toContain('infrastructure layer'); // the failure's recovery, NOT suppressed by the sibling
    // Both records collected and re-opened in the one pass.
    expect.soft(dispatcher!.statusOf('implementer')).toBeUndefined();
    expect.soft(dispatcher!.statusOf('reviewer')).toBeUndefined();
    const after = loadRunState(run.cwd, run.runId).pendingTurns ?? {};
    expect.soft(after.implementer).toBeUndefined();
    expect.soft(after.reviewer).toBeUndefined();
  });
});

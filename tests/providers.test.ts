import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { COMPACT_CONFIRMATION, ClaudeWorker, claudeArgs, claudeExecaOptions, parseClaudeTurn, recoverClaudeFailure } from '../src/providers/claude.ts';
import { CodexWorker, codexThreadOptions, parseRolloutContext, reconstructCodexTurn, recoverCodexAbort } from '../src/providers/codex.ts';
import { ContextDeadlineExceededError, WALL_CLOCK_DRAIN_GRACE_MS, WALL_CLOCK_TICK_MS, WallClockExceededError } from '../src/providers/wall-clock.ts';
import { classifyError } from '../src/worker-health.ts';
import type { ThreadEvent } from '@openai/codex-sdk';
import { InteractiveClaudeWorker, claudeProjectSlug, parseInteractiveTurn, sessionIdForNonce } from '../src/providers/interactive-claude.ts';
import { claudePaneLaunchCommand } from '../src/providers/pane.ts';
import { createWorkers, providerFor } from '../src/providers/index.ts';
import { BudgetCutoffError } from '../src/providers/types.ts';
import { DEFAULT_BINDINGS } from '../src/config.ts';
import type { RoleBindings } from '../src/config.ts';
import type { PhaseName } from '../src/phases.ts';
import { FakePane } from './helpers/fake-pane.ts';
import {
  assistantFinal,
  compactBoundary,
  session,
  toolStep,
  userMessage,
  userTurn,
} from './helpers/interactive-transcript.ts';

// execa is the provider's true external boundary (mock allowed there). No test
// in this file spawns the real `claude`/`tmux` (the InteractiveClaudeWorker
// tests inject a FakePane), so a file-global mock is safe — it is configured
// only by the ClaudeWorker.runTurn budget tests below.
const mockExeca = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: mockExeca }));

// The codex SDK is the codex provider's true external boundary — mocked so the
// S3 integration test can hand runTurn a hanging stream and drive its wall-clock
// wrap with fake timers (there is no other CodexWorker test, so the whole-file
// mock is inert elsewhere; the pure codex helpers don't touch the client).
const codexRunStreamed = vi.hoisted(() => vi.fn());
vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    startThread() {
      return { id: 'codex-thread', runStreamed: codexRunStreamed };
    }
    resumeThread() {
      return { id: 'codex-thread', runStreamed: codexRunStreamed };
    }
  },
}));

// The captured real budget-cutoff shape (probe 2026-06-22, claude 2.1.185): exit
// 1, and stdout is the full [system, assistant, result] array. The result element
// has subtype error_max_budget_usd, is_error true, NO `result` field, but
// session_id + total_cost_usd + modelUsage present; the partial text lives in the
// assistant element. A future CLI change to this shape should fail these loudly.
const budgetResultElement = (sessionId: string | null) => ({
  type: 'result',
  subtype: 'error_max_budget_usd',
  is_error: true,
  ...(sessionId !== null ? { session_id: sessionId } : {}),
  total_cost_usd: 0.1776,
  modelUsage: { 'claude-opus-4-8[1m]': { contextWindow: 1_000_000 } },
  errors: ['Reached maximum budget ($0.000001)'],
});
const budgetAssistantElement = {
  type: 'assistant',
  message: {
    content: [{ type: 'text', text: 'committed the partial work before the cap' }],
    usage: { input_tokens: 8491, cache_read_input_tokens: 15626, cache_creation_input_tokens: 12597, output_tokens: 55 },
  },
};
const budgetStdout = (sessionId: string | null): string =>
  JSON.stringify([{ type: 'system' }, budgetAssistantElement, budgetResultElement(sessionId)]);

describe('parseClaudeTurn (the CLI output boundary)', () => {
  const result = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'the worker said this',
    session_id: 'sess-1',
    total_cost_usd: 0.42,
    usage: { input_tokens: 100, output_tokens: 20 },
  };

  test('parses the current array-of-messages format', () => {
    const stdout = JSON.stringify([{ type: 'system' }, { type: 'assistant' }, result]);
    expect(parseClaudeTurn(stdout, 'prompt')).toEqual({
      text: 'the worker said this',
      sessionId: 'sess-1',
      costUsd: 0.42,
      tokens: { input: 100, output: 20 },
    });
  });

  test('parses the older bare-envelope format', () => {
    expect(parseClaudeTurn(JSON.stringify(result), 'prompt').text).toBe('the worker said this');
  });

  test('a non-budget failed turn surfaces the subtype and the partial result (still throws)', () => {
    const stdout = JSON.stringify([{ ...result, subtype: 'error_during_execution', is_error: true, result: 'crashed' }]);
    expect(() => parseClaudeTurn(stdout, 'prompt')).toThrow('claude worker turn failed (error_during_execution): crashed');
  });

  test('a budget cutoff WITH a session id returns a budget-truncated checkpoint, not a throw', () => {
    const turn = parseClaudeTurn(budgetStdout('sess-budget'), 'do it');
    expect.soft(turn.budgetTruncated).toBe(true);
    expect.soft(turn.sessionId).toBe('sess-budget');
    expect.soft(turn.costUsd).toBe(0.1776);
    expect.soft(turn.text).toBe('committed the partial work before the cap'); // recovered from the assistant element
    expect.soft(turn.context).toEqual({ usedTokens: 8491 + 15626 + 12597 + 55, windowTokens: 1_000_000 });
  });

  test('a budget cutoff with NO session id throws BudgetCutoffError (the fallback tier), not generic infra', () => {
    expect(() => parseClaudeTurn(budgetStdout(null), 'do it')).toThrow(BudgetCutoffError);
  });

  test('output with no result message names the problem', () => {
    expect(() => parseClaudeTurn(JSON.stringify([{ type: 'assistant' }]), 'p')).toThrow(/contained no result message/);
  });

  test('non-JSON output points at a CLI format change', () => {
    expect(() => parseClaudeTurn('Segmentation fault', 'p')).toThrow(/was not JSON/);
  });

  test('an empty /compact turn is substituted with a named confirmation', () => {
    const stdout = JSON.stringify([{ ...result, result: '' }]);
    const turn = parseClaudeTurn(stdout, '/compact keep the plan decisions');
    expect(turn.text).toContain('session compacted');

    // The same empty result on a normal prompt stays empty — no invented text.
    expect(parseClaudeTurn(stdout, 'normal prompt').text).toBe('');
  });
});

describe('claudeExecaOptions (the cleanup tripwire — review finding 3)', () => {
  // A pure-function guard on the named risk: execa's `cleanup` default (true)
  // is what makes a killed/superseded _mcp parent take its worker child down.
  // Pinned through the real builder, no execa fake; the live SIGTERM test is
  // the human's verify-phase run.
  test('never sets cleanup:false (the parent-exit child cleanup default stands)', () => {
    const o = claudeExecaOptions({ cwd: '/repo', prompt: 'do the thing' }, { timeoutMs: 60_000 });
    expect.soft(o.cleanup).not.toBe(false);
  });

  test('relays cwd + prompt and carries the kill rails (timeout, forceKillAfterDelay)', () => {
    const o = claudeExecaOptions({ cwd: '/repo', prompt: 'body' }, { timeoutMs: 60_000 });
    expect.soft(o.cwd).toBe('/repo');
    expect.soft(o.input).toBe('body');
    expect.soft(o.timeout).toBe(60_000);
    expect.soft(o.forceKillAfterDelay).toBe(10_000);
  });

  test('defaults the timeout to 15 minutes when the config omits it', () => {
    expect(claudeExecaOptions({ prompt: 'p' }, {}).timeout).toBe(15 * 60_000);
  });

  // S1 — the per-turn timeoutMs contract. The effective cap is
  // `opts.timeoutMs ?? config.timeoutMs ?? 15-min floor`; a per-turn override
  // (e.g. /compact's short cap) wins over the construction-time phase cap.
  test('a per-turn timeoutMs override wins over the construction cap', () => {
    const o = claudeExecaOptions({ prompt: 'p', timeoutMs: 8 * 60_000 }, { timeoutMs: 90 * 60_000 });
    expect(o.timeout).toBe(8 * 60_000);
  });

  test('a per-turn override wins even over the 15-min floor (no construction cap)', () => {
    const o = claudeExecaOptions({ prompt: 'p', timeoutMs: 8 * 60_000 }, {});
    expect(o.timeout).toBe(8 * 60_000);
  });

  test('absent a per-turn override, the construction cap stands (byte-for-byte today)', () => {
    const o = claudeExecaOptions({ prompt: 'p' }, { timeoutMs: 90 * 60_000 });
    expect(o.timeout).toBe(90 * 60_000);
  });

  // S2 — force the native byte-stream idle watchdog on for the headless worker.
  test('forces API_FORCE_IDLE_TIMEOUT=1 on the worker env, merged over process.env', () => {
    const o = claudeExecaOptions({ prompt: 'p' }, { timeoutMs: 60_000 });
    expect.soft(o.env?.API_FORCE_IDLE_TIMEOUT).toBe('1');
    // merged over process.env, not a replacement — PATH (always present) survives.
    expect.soft(o.env?.PATH).toBe(process.env.PATH);
  });
});

describe('claudePaneLaunchCommand (S2 — the forced watchdog on the interactive launch)', () => {
  test('carries API_FORCE_IDLE_TIMEOUT=1 as a command-level env prefix, keeping the flags', () => {
    const cmd = claudePaneLaunchCommand({ model: 'claude-opus-4-8' });
    // The env assignment leads the command so sh sets it for THIS claude only
    // (not inherited from the tmux server env).
    expect.soft(cmd[0]).toBe('API_FORCE_IDLE_TIMEOUT=1');
    expect.soft(cmd[1]).toBe('claude');
    expect.soft(cmd).toContain('--model');
    expect.soft(cmd).toContain('claude-opus-4-8');
    expect.soft(cmd).toContain('--permission-mode');
    expect.soft(cmd).toContain('bypassPermissions');
  });

  test('resumes a session id when present, still carrying the watchdog prefix', () => {
    const cmd = claudePaneLaunchCommand({ model: 'm', sessionId: 'sess-9' });
    expect.soft(cmd[0]).toBe('API_FORCE_IDLE_TIMEOUT=1');
    expect.soft(cmd).toContain('--resume');
    expect.soft(cmd).toContain('sess-9');
  });
});

describe('the watchdog is Claude-only (S2 — never leaked into codex)', () => {
  test('codexThreadOptions carries no API_FORCE_IDLE_TIMEOUT (a Claude API knob)', () => {
    const opts = codexThreadOptions({ cwd: '/repo' });
    expect(JSON.stringify(opts)).not.toContain('API_FORCE_IDLE_TIMEOUT');
  });
});

describe('parseInteractiveTurn (the interactive-transcript boundary)', () => {
  test('extracts the final assistant text and session id for a plain turn', () => {
    const tail = session('sess-i', userTurn('do the thing', 'nonce-1'), assistantFinal('the worker did it'));
    expect(parseInteractiveTurn(tail, { nonce: 'nonce-1' })).toEqual({
      text: 'the worker did it',
      sessionId: 'sess-i',
    });
  });

  test('a tool-using turn returns the final assistant text, not intermediate narration', () => {
    const tail = session(
      'sess-i',
      userTurn('edit the file', 'nonce-1'),
      toolStep('Edit', 'file written'),
      assistantFinal('done — the edit is in'),
    );
    expect(parseInteractiveTurn(tail, { nonce: 'nonce-1' })?.text).toBe('done — the edit is in');
  });

  test('tokens and context come from the final assistant message.usage (the claudeContextUsage reuse)', () => {
    const tail = session(
      'sess-i',
      userTurn('analyze', 'nonce-1'),
      assistantFinal('analysis', {
        usage: { input_tokens: 60_000, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 2_000, output_tokens: 500 },
        contextWindow: 200_000,
      }),
    );
    const turn = parseInteractiveTurn(tail, { nonce: 'nonce-1' });
    expect.soft(turn?.tokens).toEqual({ input: 60_000, output: 500 });
    expect.soft(turn?.context).toEqual({ usedTokens: 82_500, windowTokens: 200_000 });
  });

  test('an incomplete turn (no final assistant yet) returns undefined', () => {
    const tail = session('sess-i', userTurn('start', 'nonce-1'), toolStep('Bash', 'still running'));
    expect(parseInteractiveTurn(tail, { nonce: 'nonce-1' })).toBeUndefined();
  });

  test('a /compact turn returns the synthetic confirmation and the unchanged session id', () => {
    const tail = session('sess-i', userTurn('/compact keep the plan decisions', 'nonce-1'), compactBoundary());
    expect(parseInteractiveTurn(tail, { nonce: 'nonce-1' })).toEqual({
      text: COMPACT_CONFIRMATION,
      sessionId: 'sess-i',
    });
  });

  test('a cut or partial trailing JSONL line is tolerated', () => {
    const tail =
      session('sess-i', userTurn('do it', 'nonce-1'), assistantFinal('done')) + '{"type":"assistant","mess';
    expect(parseInteractiveTurn(tail, { nonce: 'nonce-1' })?.text).toBe('done');
  });

  test('nonce isolation: only the turn whose user record carries the asked nonce is returned', () => {
    const tail = session(
      'sess-i',
      userTurn('first task', 'nonce-1'),
      assistantFinal('first answer'),
      userMessage('an unrelated user message with no nonce'),
      userTurn('second task', 'nonce-2'),
      assistantFinal('second answer'),
    );
    expect.soft(parseInteractiveTurn(tail, { nonce: 'nonce-2' })?.text).toBe('second answer');
    expect.soft(parseInteractiveTurn(tail, { nonce: 'nonce-1' })?.text).toBe('first answer');
  });
});

describe('sessionIdForNonce (the interactive early-id extractor)', () => {
  test('reads the id from the nonce-bearing record before any turn-close', () => {
    // Only the turn-open + a mid-turn tool step — no final assistant yet. The id
    // is still extractable, which is the whole point (announce mid-turn).
    const tail = session('sess-live', userTurn('do the thing', 'nonce-1'), toolStep('Read', 'still reading'));
    expect(sessionIdForNonce(tail, 'nonce-1')).toBe('sess-live');
  });

  test('is undefined until the nonce-bearing record is visible', () => {
    const tail = session('sess-live', userMessage('an unrelated message'));
    expect(sessionIdForNonce(tail, 'nonce-1')).toBeUndefined();
  });
});

describe('InteractiveClaudeWorker (driving over FakePane + a tmpdir, no live auth)', () => {
  const withFakeTimers = async (fn: () => Promise<void>): Promise<void> => {
    vi.useFakeTimers();
    try {
      await fn();
    } finally {
      vi.useRealTimers();
    }
  };
  const tmpRoot = (): string => mkdtempSync(join(tmpdir(), 'duet-iclaude-'));

  /** Wire a worker over a tmpdir root and a captured FakePane (spawn-per-turn → one pane). */
  const wire = (
    dir: string,
    paneOpts: ConstructorParameters<typeof FakePane>[1] & {},
    workerOpts: { timeoutMs?: number } = {},
  ): { worker: InteractiveClaudeWorker; pane: () => FakePane } => {
    let pane!: FakePane;
    const worker = new InteractiveClaudeWorker({
      model: 'claude-opus-4-8',
      timeoutMs: workerOpts.timeoutMs ?? 60_000,
      transcriptRoot: dir,
      newPane: (config) => (pane = new FakePane(config, paneOpts)),
    });
    return { worker, pane: () => pane };
  };

  test('polls readiness, then submits the prompt with its nonce exactly once, after ready', async () =>
    withFakeTimers(async () => {
      const dir = tmpRoot();
      const { worker, pane } = wire(dir, {
        readyAfter: 3,
        onSubmit: (text) =>
          writeFileSync(join(dir, 'ours.jsonl'), session('sess-i', userMessage(text), assistantFinal('ok'))),
      });

      const promise = worker.runTurn({ prompt: 'do the thing', cwd: dir });
      await vi.advanceTimersByTimeAsync(5_000);
      await promise;

      expect.soft(pane().submitted).toHaveLength(1);
      expect.soft(pane().events.indexOf('submit')).toBeGreaterThan(pane().events.indexOf('ready:true'));
      expect.soft(pane().submitted[0]).toContain('do the thing');
      expect.soft(pane().submitted[0]).toMatch(/\[duet-turn:[0-9a-f]{16}\]/);
      rmSync(dir, { recursive: true, force: true });
    }));

  test('drives a full turn to a parsed WorkerTurn and tears the pane down once', async () =>
    withFakeTimers(async () => {
      const dir = tmpRoot();
      const { worker, pane } = wire(dir, {
        readyAfter: 1,
        onSubmit: (text) =>
          writeFileSync(
            join(dir, 'ours.jsonl'),
            session(
              'sess-i',
              userMessage(text),
              assistantFinal('the worker did it', {
                usage: { input_tokens: 1000, output_tokens: 50 },
                contextWindow: 200_000,
              }),
            ),
          ),
      });

      const promise = worker.runTurn({ prompt: 'do it', cwd: dir });
      await vi.advanceTimersByTimeAsync(5_000);
      const turn = await promise;

      expect.soft(turn).toEqual({
        text: 'the worker did it',
        sessionId: 'sess-i',
        tokens: { input: 1000, output: 50 },
        context: { usedTokens: 1050, windowTokens: 200_000 },
      });
      expect.soft(pane().events.filter((e) => e === 'kill')).toHaveLength(1);
      rmSync(dir, { recursive: true, force: true });
    }));

  test('a fresh turn announces its id from the transcript BEFORE the turn completes', async () =>
    withFakeTimers(async () => {
      const dir = tmpRoot();
      const announced: string[] = [];
      const { worker, pane } = wire(dir, {
        readyAfter: 0,
        // First only the turn-open + a mid-turn tool step land — id visible, turn open.
        onSubmit: (text) =>
          writeFileSync(join(dir, 'ours.jsonl'), session('sess-live', userMessage(text), toolStep('Read', 'mid-turn'))),
      });

      const promise = worker.runTurn({ prompt: 'do it', cwd: dir, onSessionId: (id) => announced.push(id) });
      await vi.advanceTimersByTimeAsync(5_000); // poll ticks: id located + announced, turn not yet closed
      expect.soft(announced).toEqual(['sess-live']); // announced while still running

      // Now close the turn, reusing the captured body so the nonce matches.
      writeFileSync(join(dir, 'ours.jsonl'), session('sess-live', userMessage(pane().submitted[0]!), assistantFinal('done')));
      await vi.advanceTimersByTimeAsync(5_000);
      const turn = await promise;
      expect.soft(turn.text).toBe('done');
      expect.soft(announced).toEqual(['sess-live']); // exactly once
      rmSync(dir, { recursive: true, force: true });
    }));

  test('a resume turn announces its id immediately, without waiting on the transcript', async () =>
    withFakeTimers(async () => {
      const dir = tmpRoot();
      const announced: string[] = [];
      const { worker } = wire(dir, {
        readyAfter: 1,
        onSubmit: (text) => writeFileSync(join(dir, 'ours.jsonl'), session('sess-resumed', userMessage(text), assistantFinal('done'))),
      });

      const promise = worker.runTurn({ prompt: 'go', cwd: dir, sessionId: 'sess-resumed', onSessionId: (id) => announced.push(id) });
      expect.soft(announced).toEqual(['sess-resumed']); // fired synchronously, before any await/poll
      await vi.advanceTimersByTimeAsync(5_000);
      await promise;
      expect.soft(announced).toEqual(['sess-resumed']); // and not re-announced from the transcript
      rmSync(dir, { recursive: true, force: true });
    }));

  test('a session that never becomes ready rejects at the deadline, pane still killed', async () =>
    withFakeTimers(async () => {
      const dir = tmpRoot();
      const { worker, pane } = wire(dir, { readyAfter: Number.POSITIVE_INFINITY });

      const promise = worker.runTurn({ prompt: 'do it', cwd: dir });
      const assertion = expect(promise).rejects.toThrow(/not ready for input before the per-turn timeout/);
      await vi.advanceTimersByTimeAsync(61_000);
      await assertion;

      expect(pane().killed).toBe(true);
      rmSync(dir, { recursive: true, force: true });
    }));

  test('a located-but-incomplete turn settles as a resumable aborted checkpoint at the deadline, pane still killed (S5)', async () =>
    withFakeTimers(async () => {
      const dir = tmpRoot();
      const { worker, pane } = wire(dir, {
        readyAfter: 0,
        // turn-open + a tool step, but no final assistant — the post-injection stall.
        // The nonce IS correlated (the prompt was injected and accepted), so the
        // deadline now yields a resumable aborted checkpoint (resume, don't re-send)
        // — the interactive accepted-abort split — rather than the old infra reject.
        onSubmit: (text) =>
          writeFileSync(join(dir, 'ours.jsonl'), session('sess-i', userMessage(text), toolStep('Bash', 'running'))),
      });

      const promise = worker.runTurn({ prompt: 'do it', cwd: dir });
      await vi.advanceTimersByTimeAsync(61_000);
      const turn = await promise;

      expect.soft(turn.aborted).toBe(true);
      expect.soft(turn.sessionId).toBe('sess-i'); // the resumable handle, from the correlated transcript
      expect.soft(pane().killed).toBe(true); // the finally still tears the pane down (Finding 4)
      rmSync(dir, { recursive: true, force: true });
    }));

  test('a submit failure still tears the pane down (the finally)', async () =>
    withFakeTimers(async () => {
      const dir = tmpRoot();
      const { worker, pane } = wire(dir, { readyAfter: 0, throwOnSubmit: new Error('tmux paste-buffer failed') });

      const promise = worker.runTurn({ prompt: 'do it', cwd: dir });
      const assertion = expect(promise).rejects.toThrow(/paste-buffer/);
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;

      expect(pane().killed).toBe(true);
      rmSync(dir, { recursive: true, force: true });
    }));

  test('correlates by nonce, not recency — picks the transcript carrying the nonce among decoys', async () =>
    withFakeTimers(async () => {
      const dir = tmpRoot();
      const { worker } = wire(dir, {
        readyAfter: 0,
        onSubmit: (text) => {
          // our turn's transcript carries the nonce...
          writeFileSync(join(dir, 'ours.jsonl'), session('ours-sess', userMessage(text), assistantFinal('right answer')));
          // ...and the concurrent orchestrator session writes a NEWER decoy with no nonce
          writeFileSync(
            join(dir, 'decoy.jsonl'),
            session('decoy-sess', userMessage('an unrelated concurrent turn'), assistantFinal('wrong answer')),
          );
        },
      });

      const promise = worker.runTurn({ prompt: 'do it', cwd: dir });
      await vi.advanceTimersByTimeAsync(5_000);
      const turn = await promise;

      expect.soft(turn.text).toBe('right answer');
      expect.soft(turn.sessionId).toBe('ours-sess');
      rmSync(dir, { recursive: true, force: true });
    }));

  test('no nonce-bearing transcript is never silently substituted — rejects at the deadline', async () =>
    withFakeTimers(async () => {
      const dir = tmpRoot();
      const { worker } = wire(dir, {
        readyAfter: 0,
        onSubmit: () =>
          writeFileSync(join(dir, 'decoy.jsonl'), session('decoy', userMessage('no nonce here'), assistantFinal('decoy answer'))),
      });

      const promise = worker.runTurn({ prompt: 'do it', cwd: dir });
      const assertion = expect(promise).rejects.toThrow(/could not correlate the turn transcript/);
      await vi.advanceTimersByTimeAsync(61_000);
      await assertion;
      rmSync(dir, { recursive: true, force: true });
    }));

  test('a nonce matching more than one transcript throws rather than guessing', async () =>
    withFakeTimers(async () => {
      const dir = tmpRoot();
      const { worker } = wire(dir, {
        readyAfter: 0,
        onSubmit: (text) => {
          writeFileSync(join(dir, 'a.jsonl'), session('a', userMessage(text), assistantFinal('answer a')));
          writeFileSync(join(dir, 'b.jsonl'), session('b', userMessage(text), assistantFinal('answer b')));
        },
      });

      const promise = worker.runTurn({ prompt: 'do it', cwd: dir });
      const assertion = expect(promise).rejects.toThrow(/matched 2 session transcripts/);
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      rmSync(dir, { recursive: true, force: true });
    }));

  test('refuses a read-only turn before spawning anything (implementer-only transport)', async () => {
    let paneBuilt = false;
    const worker = new InteractiveClaudeWorker({
      model: 'claude-opus-4-8',
      timeoutMs: 60_000,
      transcriptRoot: '/nonexistent',
      newPane: (config) => {
        paneBuilt = true;
        return new FakePane(config);
      },
    });

    await expect(worker.runTurn({ prompt: 'review this', readOnly: true, cwd: '/x' })).rejects.toThrow(
      /cannot run a read-only turn/,
    );
    expect(paneBuilt).toBe(false);
  });

  test('correlates a resumed turn by the appended nonce — a pre-existing session file (Finding 2)', async () =>
    withFakeTimers(async () => {
      const dir = tmpRoot();
      const file = join(dir, 'sess-i.jsonl');
      // a prior turn already sits in the resumed session file before this turn runs
      writeFileSync(file, session('sess-i', userTurn('an earlier turn', 'old-nonce'), assistantFinal('earlier answer')));
      const { worker } = wire(dir, {
        readyAfter: 0,
        // this turn APPENDS to the same file — correlation must find it by nonce, not recency
        onSubmit: (text) => appendFileSync(file, session('sess-i', userMessage(text), assistantFinal('resumed answer'))),
      });

      const promise = worker.runTurn({ prompt: 'do it', sessionId: 'sess-i', cwd: dir });
      await vi.advanceTimersByTimeAsync(5_000);
      const turn = await promise;

      expect.soft(turn.text).toBe('resumed answer');
      expect.soft(turn.sessionId).toBe('sess-i');
      rmSync(dir, { recursive: true, force: true });
    }));

  test('finds the transcript in the cwd-scoped project dir (the fast path)', async () =>
    withFakeTimers(async () => {
      const dir = tmpRoot();
      const cwd = '/proj/example';
      const scoped = join(dir, claudeProjectSlug(cwd));
      mkdirSync(scoped, { recursive: true });
      const { worker } = wire(dir, {
        readyAfter: 0,
        onSubmit: (text) =>
          writeFileSync(join(scoped, 'sess.jsonl'), session('scoped-sess', userMessage(text), assistantFinal('scoped answer'))),
      });

      const promise = worker.runTurn({ prompt: 'do it', cwd });
      await vi.advanceTimersByTimeAsync(5_000);
      const turn = await promise;

      expect.soft(turn.text).toBe('scoped answer');
      expect.soft(turn.sessionId).toBe('scoped-sess');
      rmSync(dir, { recursive: true, force: true });
    }));

  test('falls back to the root scan when the scoped slug dir exists but lacks the turn (wrong-slug shape)', async () =>
    withFakeTimers(async () => {
      const dir = tmpRoot();
      const cwd = '/proj/example';
      const scoped = join(dir, claudeProjectSlug(cwd));
      mkdirSync(scoped, { recursive: true });
      // the scoped dir exists but holds only a decoy without our nonce...
      writeFileSync(join(scoped, 'decoy.jsonl'), session('decoy', userMessage('unrelated'), assistantFinal('wrong')));
      const { worker } = wire(dir, {
        readyAfter: 0,
        // ...and the real transcript lands elsewhere under the root (a wrong slug guess)
        onSubmit: (text) =>
          writeFileSync(join(dir, 'real.jsonl'), session('real-sess', userMessage(text), assistantFinal('right answer'))),
      });

      const promise = worker.runTurn({ prompt: 'do it', cwd });
      await vi.advanceTimersByTimeAsync(5_000);
      const turn = await promise;

      expect.soft(turn.text).toBe('right answer');
      expect.soft(turn.sessionId).toBe('real-sess');
      rmSync(dir, { recursive: true, force: true });
    }));
});

describe('claudeProjectSlug', () => {
  test("maps a cwd to Claude Code's project-dir name (known case; Slice 5 confirms the rule)", () => {
    expect(claudeProjectSlug('/Users/qiushi/dev/duet')).toBe('-Users-qiushi-dev-duet');
  });
});

describe('context-window probes (per-provider math, one shape)', () => {
  test('claude: last assistant request usage against modelUsage’s context window', () => {
    const result = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      session_id: 'sess-1',
      modelUsage: { 'claude-fable-5': { contextWindow: 200_000, costUSD: 1 } },
    };
    const stdout = JSON.stringify([
      { type: 'assistant', message: { usage: { input_tokens: 10_000, cache_read_input_tokens: 5_000, output_tokens: 100 } } },
      { type: 'assistant', message: { usage: { input_tokens: 60_000, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 2_000, output_tokens: 500 } } },
      result,
    ]);

    // The LAST request is what fills the window; earlier ones are history.
    expect(parseClaudeTurn(stdout, 'p').context).toEqual({ usedTokens: 82_500, windowTokens: 200_000 });
  });

  test('claude: no assistant usage or no window means no reading, not a guess', () => {
    const result = { type: 'result', subtype: 'success', is_error: false, result: 'x', session_id: 's' };
    expect.soft(parseClaudeTurn(JSON.stringify([result]), 'p').context).toBeUndefined();
    const noWindow = JSON.stringify([
      { type: 'assistant', message: { usage: { input_tokens: 1 } } },
      result,
    ]);
    expect.soft(parseClaudeTurn(noWindow, 'p').context).toBeUndefined();
  });

  test('claude: a trailing zero-usage assistant message (the error echo) never zeroes the reading', () => {
    // The 20260701 wedge: an error-terminated turn's last assistant message is
    // the CLI's error echo with zeroed usage — taking it verbatim reported
    // "context 0%" on a session that died of overflow at 98%. The last REAL
    // request's reading must win.
    const result = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      session_id: 'sess-1',
      modelUsage: { 'claude-opus-4-8[1m]': { contextWindow: 1_000_000 } },
    };
    const stdout = JSON.stringify([
      { type: 'assistant', message: { usage: { input_tokens: 900_000, cache_read_input_tokens: 70_000, output_tokens: 500 } } },
      { type: 'assistant', message: { usage: { input_tokens: 0, output_tokens: 0 } } },
      result,
    ]);
    expect(parseClaudeTurn(stdout, 'p').context).toEqual({ usedTokens: 970_500, windowTokens: 1_000_000 });
  });

  test('claude: only zero-usage assistant messages means no reading at all', () => {
    const result = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'x',
      session_id: 's',
      modelUsage: { 'claude-opus-4-8[1m]': { contextWindow: 1_000_000 } },
    };
    const stdout = JSON.stringify([{ type: 'assistant', message: { usage: { input_tokens: 0, output_tokens: 0 } } }, result]);
    expect(parseClaudeTurn(stdout, 'p').context).toBeUndefined();
  });

  test('claude: an interrupted turn keeps the last honest reading, not the error echo’s zero', () => {
    // The mid-response failure shape from the wedge night: an is_error envelope
    // whose partial work settles as an interrupted checkpoint. Its context must
    // come from the last real request — undefined would also be acceptable, but
    // 0% (the old behavior) actively misled the send-gate.
    const stdout = JSON.stringify([
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'real partial work' }],
          usage: { input_tokens: 950_000, cache_read_input_tokens: 20_000, output_tokens: 400 },
        },
      },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Prompt is too long' }], usage: { input_tokens: 0, output_tokens: 0 } } },
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'Prompt is too long',
        session_id: 'sess-wedge',
        modelUsage: { 'claude-opus-4-8[1m]': { contextWindow: 1_000_000 } },
      },
    ]);
    const turn = parseClaudeTurn(stdout, 'continue the keystone');
    expect.soft(turn.interrupted).toBe(true);
    expect.soft(turn.contextExhausted).toBe(true); // the failure reason WAS the window ceiling
    expect.soft(turn.context).toEqual({ usedTokens: 970_400, windowTokens: 1_000_000 });
  });

  test('claude: a non-overflow interruption is NOT marked context-exhausted', () => {
    const stdout = JSON.stringify([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'real partial work' }], usage: { input_tokens: 50_000, output_tokens: 200 } },
      },
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'Connection closed mid-response',
        session_id: 'sess-drop',
        modelUsage: { 'claude-opus-4-8[1m]': { contextWindow: 1_000_000 } },
      },
    ]);
    const turn = parseClaudeTurn(stdout, 'p');
    expect.soft(turn.interrupted).toBe(true);
    expect.soft(turn.contextExhausted).toBeUndefined(); // a plain drop keeps the continuation recovery
  });

  test('codex: the rollout’s last token_count event wins', () => {
    const tail = [
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 30_000 }, model_context_window: 258_400 } } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 62_228 }, model_context_window: 258_400 } } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message' } }),
    ].join('\n');

    expect(parseRolloutContext(tail)).toEqual({ usedTokens: 62_228, windowTokens: 258_400 });
  });

  test('codex: a cut first line, null info, or no token_count yields nothing', () => {
    expect.soft(parseRolloutContext('{"type":"event_msg","payl')).toBeUndefined();
    expect.soft(parseRolloutContext(JSON.stringify({ payload: { type: 'token_count', info: null } }))).toBeUndefined();
    expect.soft(parseRolloutContext('')).toBeUndefined();
  });
});

describe('ClaudeWorker.runTurn (failure recovery at the execa boundary)', () => {
  // A claude -p failure exits non-zero, so execa throws before parseClaudeTurn
  // sees stdout; runTurn recovers from the captured output. execa is mocked (the
  // true boundary). The behaviors that matter: the signal survives, the dump does
  // not, and a budget cutoff is still a checkpoint — none of these pin the exact
  // message wording, so they survive refactors.
  const worker = () => new ClaudeWorker({ model: 'claude-opus-4-8', maxBudgetUsd: 0.01 });
  const execaExit1 = (stdout: string) =>
    Object.assign(new Error('Command failed with exit code 1'), { stdout });

  test('a budget cutoff (with session) in the thrown error stdout returns the checkpoint turn', async () => {
    mockExeca.mockRejectedValueOnce(execaExit1(budgetStdout('sess-budget')));
    const turn = await worker().runTurn({ prompt: 'do it', cwd: '/x' });
    expect.soft(turn.budgetTruncated).toBe(true);
    expect.soft(turn.sessionId).toBe('sess-budget');
  });

  test('a budget cutoff with no recoverable session propagates BudgetCutoffError (the fallback tier)', async () => {
    mockExeca.mockRejectedValueOnce(execaExit1(budgetStdout(null)));
    await expect(worker().runTurn({ prompt: 'do it', cwd: '/x' })).rejects.toBeInstanceOf(BudgetCutoffError);
  });

  test('a pre-flight CLI-reported failure (no real generation) surfaces the envelope’s reason — not a budget turn, not the multi-KB stdout dump', async () => {
    // A realistic noisy -p stream: a fat init event wrapping the one error result,
    // the error also rendered as the only assistant block (no real work). Any error
    // class lands here the same way — the reason is whatever `result` holds (here a
    // 5xx), matched by structure not text.
    const stdout = JSON.stringify([
      { type: 'system', subtype: 'init', tools: Array(40).fill('SomeNoisyToolName'), slash_commands: Array(40).fill('cmd') },
      { type: 'assistant', uuid: 'msg-id-1', message: { content: [{ type: 'text', text: 'API Error: 500 Internal server error' }] } },
      { type: 'result', subtype: 'success', is_error: true, session_id: 's', result: 'API Error: 500 Internal server error' },
    ]);
    mockExeca.mockRejectedValueOnce(execaExit1(stdout));
    // Throws (pre-flight → resend) — it is NOT returned as a settled checkpoint,
    // because the only assistant content is the error itself (no real generation).
    const err: Error = await worker().runTurn({ prompt: 'do it', cwd: '/x' }).catch((e) => e);
    expect.soft(err).toBeInstanceOf(Error);
    expect.soft(err).not.toBeInstanceOf(BudgetCutoffError);
    expect.soft(err.message).toContain('API Error: 500 Internal server error'); // the signal survives
    expect.soft(err.message).not.toContain('SomeNoisyToolName'); // the init-payload noise is gone
    expect.soft(err.message.length).toBeLessThan(stdout.length / 2); // far smaller than the dump
  });

  test('an unparseable failure (no result event) surfaces the exit code + stderr, not the stdout dump', async () => {
    // stdout is JSON but carries no result event (a crash / auth-at-startup); the
    // real reason is on stderr, separate from the noisy stdout.
    const noisyStdout = JSON.stringify(Array(50).fill({ type: 'system', blob: 'x'.repeat(200) }));
    mockExeca.mockRejectedValueOnce(
      Object.assign(new Error('big raw message — would inline all of stdout'), {
        shortMessage: 'Command failed with exit code 1: claude -p',
        stdout: noisyStdout,
        stderr: 'Invalid API key · Please run /login',
      }),
    );
    const err: Error = await worker().runTurn({ prompt: 'do it', cwd: '/x' }).catch((e) => e);
    expect.soft(err.message).toContain('Please run /login'); // the stderr signal surfaces
    expect.soft(err.message).toContain('exit code 1'); // exit context kept
    expect.soft(err.message).not.toContain('blob'); // the stdout dump is dropped
  });

  test('a spawn failure with no output surfaces a concise error', async () => {
    mockExeca.mockRejectedValueOnce(Object.assign(new Error('spawn claude ENOENT'), { stdout: '' }));
    await expect(worker().runTurn({ prompt: 'do it', cwd: '/x' })).rejects.toThrow('spawn claude ENOENT');
  });

  // Mid-response vs pre-flight. The `-p` stream renders an API error as a trailing
  // assistant `text` block, so the classifier must exclude it (else every failure,
  // pre-flight included, looks like mid-response → a "continue?" on work never
  // started). It keys on real generated content, never the error wording.
  const drop = 'API Error: Connection closed mid-response. The response above may be incomplete.';

  test('a mid-response failure (real partial work before the drop) settles as an interrupted checkpoint, not a throw', async () => {
    const stdout = JSON.stringify([
      { type: 'system', subtype: 'init', tools: ['x'] },
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'planning' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Writing the spec now, starting with the envelope' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: drop }] } }, // the error, as an assistant block
      { type: 'result', subtype: 'success', is_error: true, session_id: 'sess-mid', total_cost_usd: 0.27, result: drop },
    ]);
    mockExeca.mockRejectedValueOnce(execaExit1(stdout));
    const turn = await worker().runTurn({ prompt: 'do it', cwd: '/x' });
    expect.soft(turn.interrupted).toBe(true);
    expect.soft(turn.sessionId).toBe('sess-mid'); // the resumable handle is captured
    expect.soft(turn.text).toContain('Writing the spec now'); // the real partial work
    expect.soft(turn.text).not.toContain('API Error'); // the error-marker block is excluded
  });

  const successStdout = (sessionId: string): string =>
    JSON.stringify([{ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sessionId }]);

  test('a fresh turn mints an id, announces it before spawn, and predeclares it with --session-id', async () => {
    let announced: string | undefined;
    let argv: string[] = [];
    // The CLI echoes back the id we predeclared, so minted == returned == settled.
    mockExeca.mockImplementationOnce((_cmd: string, args: string[]) => {
      argv = args;
      // The id must be in hand at spawn time — onSessionId fired BEFORE this.
      expect.soft(announced).toBe(args[args.indexOf('--session-id') + 1]);
      return Promise.resolve({ stdout: successStdout(args[args.indexOf('--session-id') + 1]!) });
    });
    const turn = await new ClaudeWorker({ model: 'claude-opus-4-8' }).runTurn({
      prompt: 'go',
      cwd: '/x',
      onSessionId: (id) => {
        announced = id;
      },
    });
    expect.soft(announced).toBeTruthy();
    expect.soft(argv).not.toContain('--resume');
    expect.soft(turn.sessionId).toBe(announced); // the round-trip: minted id == settled id
  });

  test('a resume turn announces the resume id immediately and uses --resume (no minting)', async () => {
    let announced: string | undefined;
    let argv: string[] = [];
    mockExeca.mockImplementationOnce((_cmd: string, args: string[]) => {
      argv = args;
      return Promise.resolve({ stdout: successStdout('sess-resumed') });
    });
    await new ClaudeWorker({ model: 'claude-opus-4-8' }).runTurn({
      prompt: 'go',
      cwd: '/x',
      sessionId: 'sess-resumed',
      onSessionId: (id) => {
        announced = id;
      },
    });
    expect.soft(announced).toBe('sess-resumed');
    expect.soft(argv[argv.indexOf('--resume') + 1]).toBe('sess-resumed');
    expect.soft(argv).not.toContain('--session-id');
  });
});

describe('recoverClaudeFailure (S5 — the accepted-abort vs never-accepted split)', () => {
  const turnStartedAt = Date.parse('2026-06-20T12:00:00.000Z');
  const timeoutErr = () => Object.assign(new Error('Command timed out after 90 minutes'), { timedOut: true, stdout: '' });
  const acceptedTail = JSON.stringify({ type: 'assistant', timestamp: new Date(turnStartedAt + 5_000).toISOString() });
  const preStartTail = JSON.stringify({ type: 'assistant', timestamp: new Date(turnStartedAt - 60_000).toISOString() });

  test('a timeout whose transcript shows the prompt accepted ⇒ a resumable aborted checkpoint', () => {
    const turn = recoverClaudeFailure(timeoutErr(), 'do it', {
      sessionId: 'sess-abc',
      turnStartedAt,
      readTail: () => ({ jsonl: acceptedTail }),
    });
    expect.soft(turn.aborted).toBe(true);
    expect.soft(turn.sessionId).toBe('sess-abc');
  });

  test('a WallClockExceededError with an accepted transcript ⇒ aborted checkpoint (the suspend-on-wake path)', () => {
    const turn = recoverClaudeFailure(new WallClockExceededError(90 * 60_000), 'do it', {
      sessionId: 'sess-wc',
      turnStartedAt,
      readTail: () => ({ jsonl: acceptedTail }),
    });
    expect.soft(turn.aborted).toBe(true);
    expect.soft(turn.sessionId).toBe('sess-wc');
  });

  test('a ContextDeadlineExceededError with an accepted transcript ⇒ aborted + context-exhausted checkpoint', () => {
    const turn = recoverClaudeFailure(new ContextDeadlineExceededError(870_000, 850_000), 'do it', {
      sessionId: 'sess-ctx',
      turnStartedAt,
      readTail: () => ({ jsonl: acceptedTail }),
    });
    expect.soft(turn.aborted).toBe(true);
    expect.soft(turn.contextExhausted).toBe(true); // the window ran out, not time — compact-then-resume
    expect.soft(turn.sessionId).toBe('sess-ctx');
  });

  test('a never-accepted context cut throws a message that classifies as context-overflow, never generic infra', () => {
    try {
      recoverClaudeFailure(new ContextDeadlineExceededError(870_000, 850_000), 'do it', {
        sessionId: 's',
        turnStartedAt,
        readTail: () => undefined,
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(classifyError((err as Error).message)).toBe('context-overflow'); // the compaction prescription fires
    }
  });

  test('a timeout with only PRE-start records (resumed session, this turn never accepted) ⇒ throws infra', () => {
    expect(() =>
      recoverClaudeFailure(timeoutErr(), 'do it', { sessionId: 's', turnStartedAt, readTail: () => ({ jsonl: preStartTail }) }),
    ).toThrow();
  });

  test('a timeout with no locatable transcript ⇒ throws infra', () => {
    expect(() =>
      recoverClaudeFailure(timeoutErr(), 'do it', { sessionId: 's', turnStartedAt, readTail: () => undefined }),
    ).toThrow();
  });

  test('a NON-timeout failure never reads as aborted, even with an accepted transcript available', () => {
    const err = Object.assign(new Error('spawn claude ENOENT'), { stdout: '' });
    expect(() =>
      recoverClaudeFailure(err, 'do it', { sessionId: 's', turnStartedAt, readTail: () => ({ jsonl: acceptedTail }) }),
    ).toThrow(/ENOENT/);
  });

  test('a budgetTruncated stdout settles as its own checkpoint even on a timeout error (stdout precedes the abort branch)', () => {
    const err = Object.assign(new Error('exit 1'), { stdout: budgetStdout('sess-b'), timedOut: true });
    const turn = recoverClaudeFailure(err, 'do it', {
      sessionId: 'sess-minted',
      turnStartedAt,
      readTail: () => ({ jsonl: acceptedTail }),
    });
    expect.soft(turn.budgetTruncated).toBe(true);
    expect.soft(turn.aborted).toBeUndefined();
    expect.soft(turn.sessionId).toBe('sess-b'); // from the envelope, not the minted id or the abort branch
  });
});

describe('recoverCodexAbort (S5 — the codex accepted-abort split, no SDK needed)', () => {
  test('a wall-clock abort with thread.started seen this turn ⇒ a resumable aborted checkpoint', () => {
    const turn = recoverCodexAbort(new WallClockExceededError(90 * 60_000), 'thread-123');
    expect.soft(turn.aborted).toBe(true);
    expect.soft(turn.sessionId).toBe('thread-123');
  });

  test('a wall-clock abort BEFORE thread.started (pre-acceptance) ⇒ throws infra', () => {
    expect(() => recoverCodexAbort(new WallClockExceededError(90 * 60_000), undefined)).toThrow(WallClockExceededError);
  });

  test('a non-abort error re-throws unchanged regardless of thread.started', () => {
    const boom = new Error('turn.failed: model exploded');
    expect(() => recoverCodexAbort(boom, 'thread-123')).toThrow(/model exploded/);
  });
});

describe('claudeArgs (the session-flag + budget-cap seams)', () => {
  test('a fresh turn predeclares its id with --session-id (and no --resume)', () => {
    // Predeclaring the id is what lets runTurn announce it BEFORE spawn — the
    // live-activity poll can then find this turn's transcript from its start.
    const args = claudeArgs({ sessionId: 'mint-1', resume: false }, { model: 'claude-opus-4-8' });
    expect.soft(args[args.indexOf('--session-id') + 1]).toBe('mint-1');
    expect.soft(args).not.toContain('--resume');
  });

  test('a resume turn uses --resume (and no --session-id)', () => {
    const args = claudeArgs({ sessionId: 'sess-7', resume: true }, { model: 'claude-opus-4-8' });
    expect.soft(args[args.indexOf('--resume') + 1]).toBe('sess-7');
    expect.soft(args).not.toContain('--session-id');
  });

  test('passes --max-budget-usd when the cap is a number', () => {
    const args = claudeArgs({ sessionId: 's', resume: false }, { model: 'claude-opus-4-8', maxBudgetUsd: 10 });
    expect.soft(args).toContain('--max-budget-usd');
    expect.soft(args[args.indexOf('--max-budget-usd') + 1]).toBe('10');
  });

  test('omits --max-budget-usd entirely when the cap is undefined (budgets off)', () => {
    const args = claudeArgs({ sessionId: 's', resume: false }, { model: 'claude-opus-4-8', maxBudgetUsd: undefined });
    expect(args).not.toContain('--max-budget-usd');
  });

  test('always launches bypassPermissions and never --disallowed-tools — both roles run full-permission', () => {
    // The reviewer hint no longer restricts the headless argv: full permissions
    // for every worker, review-only enforced by the prompt instead — claudeArgs
    // takes no readOnly at all. Fresh and resume builds both bypassPermissions.
    const fresh = claudeArgs({ sessionId: 's', resume: false }, { model: 'claude-opus-4-8' });
    const resumed = claudeArgs({ sessionId: 's', resume: true }, { model: 'claude-opus-4-8' });
    for (const args of [fresh, resumed]) {
      expect.soft(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
      expect.soft(args).not.toContain('--disallowed-tools');
    }
  });
});

describe('codexThreadOptions (the sandbox-deferral seam)', () => {
  test('never sets sandboxMode — codex defers the sandbox to ~/.codex/config.toml', () => {
    // The reviewer hint (a read-only role) must NOT derive an OS sandbox: the
    // old read-only/workspace-write mapping overrode the user's config and broke
    // read-only tooling ($TMPDIR IPC sockets, outbound reads). Omitting it lets
    // the codex CLI fall back to the user's configured posture.
    expect.soft(codexThreadOptions({ cwd: '/repo' }).sandboxMode).toBeUndefined();
    expect.soft(codexThreadOptions({}).sandboxMode).toBeUndefined();
  });

  test('passes the working directory through', () => {
    expect(codexThreadOptions({ cwd: '/repo' }).workingDirectory).toBe('/repo');
  });
});

describe('reconstructCodexTurn (the codex event-stream seam)', () => {
  async function* stream(...events: ThreadEvent[]): AsyncGenerator<ThreadEvent> {
    for (const e of events) yield e;
  }
  const usage = { input_tokens: 100, cached_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 5 };

  test('announces the id on thread.started (first event) and reconstructs the final text + usage', async () => {
    const seen: string[] = [];
    const result = await reconstructCodexTurn(
      stream(
        { type: 'thread.started', thread_id: 'th-live' },
        { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'first' } },
        { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'the final answer' } },
        { type: 'turn.completed', usage },
      ),
      (id) => seen.push(id),
    );
    // The id is announced as soon as the stream opens — not after it drains.
    expect.soft(seen).toEqual(['th-live']);
    expect.soft(result.finalResponse).toBe('the final answer'); // the LAST agent_message wins
    expect.soft(result.usage).toEqual(usage);
  });

  test('a turn.failed throws the error message (matching the SDK run() contract)', async () => {
    await expect(
      reconstructCodexTurn(stream({ type: 'thread.started', thread_id: 'th-x' }, { type: 'turn.failed', error: { message: 'model exploded' } })),
    ).rejects.toThrow('model exploded');
  });

  test('S5: onThreadStarted fires from the stream thread.started with the thread id (the acceptance signal)', async () => {
    const started: string[] = [];
    await reconstructCodexTurn(
      stream(
        { type: 'thread.started', thread_id: 'th-accept' },
        { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'done' } },
        { type: 'turn.completed', usage },
      ),
      undefined,
      (id) => started.push(id),
    );
    // The separate hook fires from the stream event — the proof recoverCodexAbort
    // keys on, distinct from the pre-stream onSessionId for a resumed thread.
    expect(started).toEqual(['th-accept']);
  });
});

describe('createWorkers', () => {
  test('binds each role to its provider with the phase rails applied', () => {
    const workers = createWorkers(DEFAULT_BINDINGS, 'spec', { workerBudgetUsd: 10, timeoutMs: 60_000 });
    expect.soft(workers.implementer.name).toBe('claude');
    expect.soft(workers.reviewer.name).toBe('codex');
  });

  test('a workerBudgetUsd: undefined rail builds a ClaudeWorker (off → the cap is omitted downstream)', () => {
    // The undefined cap is now a legal rail (budgets off); it flows to the
    // ClaudeWorker's config, where claudeArgs leaves --max-budget-usd off the
    // argv (pinned directly by the claudeArgs omission test above).
    const workers = createWorkers(DEFAULT_BINDINGS, 'spec', { workerBudgetUsd: undefined, timeoutMs: 60_000 });
    expect.soft(workers.implementer).toBeInstanceOf(ClaudeWorker);
    expect.soft(workers.implementer.name).toBe('claude');
  });

  test('an interactive claude binding builds the interactive transport; headless stays ClaudeWorker', () => {
    const headless = createWorkers(DEFAULT_BINDINGS, 'spec', { workerBudgetUsd: 10, timeoutMs: 60_000 });
    expect.soft(headless.implementer).toBeInstanceOf(ClaudeWorker);

    const interactive = createWorkers(
      { ...DEFAULT_BINDINGS, implementer: { provider: 'claude', model: 'claude-opus-4-8', transport: 'interactive' } },
      'spec',
      { workerBudgetUsd: 10, timeoutMs: 60_000 },
    );
    expect.soft(interactive.implementer).toBeInstanceOf(InteractiveClaudeWorker);
    expect.soft(interactive.implementer.name).toBe('claude'); // the same WorkerProvider contract name
  });

  test('the implementer builds with its post-handoff model after the handoff gate, the base model before', async () => {
    // The true wiring, exercised through the public interface (createWorkers →
    // runTurn → the execa argv): a bound `impl` model shows up on the --model flag
    // only for a post-handoff phase; a planning phase keeps the base model.
    const bindings: RoleBindings = {
      ...DEFAULT_BINDINGS,
      implementer: {
        provider: 'claude',
        model: 'claude-opus-4-8',
        transport: 'headless',
        impl: { provider: 'claude', model: 'claude-sonnet-5' },
      },
    };
    const modelOnArgv = async (phase: PhaseName): Promise<string> => {
      let argv: string[] = [];
      mockExeca.mockImplementationOnce((_cmd: string, args: string[]) => {
        argv = args;
        return Promise.resolve({
          stdout: JSON.stringify([{ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's' }]),
        });
      });
      await createWorkers(bindings, phase, { workerBudgetUsd: 10, timeoutMs: 60_000 }).implementer.runTurn({ prompt: 'go', cwd: '/x' });
      return argv[argv.indexOf('--model') + 1]!;
    };
    expect.soft(await modelOnArgv('plan')).toBe('claude-opus-4-8'); // planning keeps the smart base
    expect.soft(await modelOnArgv('impl')).toBe('claude-sonnet-5'); // the build switches to the impl model
  });

  test('the consultant provider is built only when bound; an un-enabled run has exactly today’s two', () => {
    const unbound = createWorkers(DEFAULT_BINDINGS, 'spec', { workerBudgetUsd: 10, timeoutMs: 60_000 });
    expect.soft(unbound).not.toHaveProperty('consultant');
    expect.soft(unbound.consultant).toBeUndefined();

    const bound = createWorkers(
      { ...DEFAULT_BINDINGS, consultant: { provider: 'claude', model: 'claude-opus-4-8', transport: 'headless' } },
      'spec',
      { workerBudgetUsd: 10, timeoutMs: 60_000 },
    );
    expect.soft(bound.consultant).toBeInstanceOf(ClaudeWorker);
    expect.soft(bound.consultant?.name).toBe('claude');
  });
});

describe('providerFor (narrow-or-prescribed-error over the optional consultant)', () => {
  test('returns a built provider, and throws a prescribed-recovery error for an unbuilt role', () => {
    const unbound = createWorkers(DEFAULT_BINDINGS, 'spec', { workerBudgetUsd: 10, timeoutMs: 60_000 });
    expect.soft(providerFor(unbound, 'implementer').name).toBe('claude');
    expect.soft(providerFor(unbound, 'reviewer').name).toBe('codex');
    expect.soft(() => providerFor(unbound, 'consultant')).toThrow(/no consultant worker is built/);

    const bound = createWorkers(
      { ...DEFAULT_BINDINGS, consultant: { provider: 'codex' } },
      'spec',
      { workerBudgetUsd: 10, timeoutMs: 60_000 },
    );
    expect.soft(providerFor(bound, 'consultant').name).toBe('codex');
  });
});

describe('the wall-clock backstop is wired into runTurn (S3 — the load-bearing regression guard)', () => {
  // Two reviewers flagged that runWithWallClockDeadline is thoroughly unit-tested
  // but NOTHING proved runTurn actually routes through it at the effective cap —
  // so deleting the wrap or passing a wrong capMs would leave the suite green
  // while silently reintroducing the 7447 machine-sleep regression this branch
  // exists to prevent. These pin the wiring per provider: the turn is aborted at
  // the cap, and NOT one tick before it (which also pins that capMs is the
  // effective per-turn cap, not a shorter default). Real execa/stream are the
  // mocked boundary; fake timers drive Date.now + the deadline's re-check ticks.
  const cap = 90 * 60_000;

  test('claude: runTurn kills the execa child at the effective cap, not before', async () => {
    vi.useFakeTimers();
    try {
      const kill = vi.fn();
      const hanging = Object.assign(new Promise<never>(() => {}), { kill }); // a subprocess that never settles
      mockExeca.mockReturnValueOnce(hanging);
      const promise = new ClaudeWorker({ model: 'claude-opus-4-8' }).runTurn({ prompt: 'build it', cwd: '/x', timeoutMs: cap });
      const rejects = expect(promise).rejects.toThrow(); // no accepted transcript ⇒ recovers to an infra error
      await vi.advanceTimersByTimeAsync(cap - WALL_CLOCK_TICK_MS);
      expect.soft(kill).not.toHaveBeenCalled(); // the cap is honored — not a shorter default
      await vi.advanceTimersByTimeAsync(2 * WALL_CLOCK_TICK_MS);
      expect.soft(kill).toHaveBeenCalledTimes(1); // the wrap fired at the cap, exactly once
      await vi.advanceTimersByTimeAsync(WALL_CLOCK_DRAIN_GRACE_MS); // let the bounded drain settle the turn
      await rejects;
    } finally {
      vi.useRealTimers();
    }
  });

  test('codex: runTurn aborts the runStreamed signal at the effective cap, not before', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      codexRunStreamed.mockImplementation((_prompt: string, opts: { signal: AbortSignal }) => {
        signal = opts.signal;
        return new Promise(() => {}); // hang — never emits thread.started, never resolves
      });
      const promise = new CodexWorker({ timeoutMs: cap }).runTurn({ prompt: 'build it', cwd: '/x' });
      const rejects = expect(promise).rejects.toBeInstanceOf(WallClockExceededError); // never accepted ⇒ re-thrown
      await vi.advanceTimersByTimeAsync(cap - WALL_CLOCK_TICK_MS);
      expect.soft(signal?.aborted).toBe(false); // the deadline has not fired before the cap
      await vi.advanceTimersByTimeAsync(2 * WALL_CLOCK_TICK_MS);
      expect.soft(signal?.aborted).toBe(true); // the wall-clock deadline aborted the stream at the cap
      await vi.advanceTimersByTimeAsync(WALL_CLOCK_DRAIN_GRACE_MS); // let the bounded drain settle the turn
      await rejects;
    } finally {
      vi.useRealTimers();
    }
  });
});

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { COMPACT_CONFIRMATION, ClaudeWorker, claudeArgs, claudeExecaOptions, parseClaudeTurn } from '../src/providers/claude.ts';
import { codexThreadOptions, parseRolloutContext, reconstructCodexTurn } from '../src/providers/codex.ts';
import type { ThreadEvent } from '@openai/codex-sdk';
import { InteractiveClaudeWorker, claudeProjectSlug, parseInteractiveTurn, sessionIdForNonce } from '../src/providers/interactive-claude.ts';
import { createWorkers, providerFor } from '../src/providers/index.ts';
import { BudgetCutoffError } from '../src/providers/types.ts';
import { DEFAULT_BINDINGS } from '../src/config.ts';
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

  test('a located turn that never completes rejects at the deadline, pane still killed (Finding 4)', async () =>
    withFakeTimers(async () => {
      const dir = tmpRoot();
      const { worker, pane } = wire(dir, {
        readyAfter: 0,
        // turn-open + a tool step, but no final assistant — the post-injection stall
        onSubmit: (text) =>
          writeFileSync(join(dir, 'ours.jsonl'), session('sess-i', userMessage(text), toolStep('Bash', 'running'))),
      });

      const promise = worker.runTurn({ prompt: 'do it', cwd: dir });
      const assertion = expect(promise).rejects.toThrow(/did not complete in the transcript/);
      await vi.advanceTimersByTimeAsync(61_000);
      await assertion;

      expect(pane().killed).toBe(true);
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
});

describe('createWorkers', () => {
  test('binds each role to its provider with the phase rails applied', () => {
    const workers = createWorkers(DEFAULT_BINDINGS, { workerBudgetUsd: 10, timeoutMs: 60_000 });
    expect.soft(workers.implementer.name).toBe('claude');
    expect.soft(workers.reviewer.name).toBe('codex');
  });

  test('a workerBudgetUsd: undefined rail builds a ClaudeWorker (off → the cap is omitted downstream)', () => {
    // The undefined cap is now a legal rail (budgets off); it flows to the
    // ClaudeWorker's config, where claudeArgs leaves --max-budget-usd off the
    // argv (pinned directly by the claudeArgs omission test above).
    const workers = createWorkers(DEFAULT_BINDINGS, { workerBudgetUsd: undefined, timeoutMs: 60_000 });
    expect.soft(workers.implementer).toBeInstanceOf(ClaudeWorker);
    expect.soft(workers.implementer.name).toBe('claude');
  });

  test('an interactive claude binding builds the interactive transport; headless stays ClaudeWorker', () => {
    const headless = createWorkers(DEFAULT_BINDINGS, { workerBudgetUsd: 10, timeoutMs: 60_000 });
    expect.soft(headless.implementer).toBeInstanceOf(ClaudeWorker);

    const interactive = createWorkers(
      { ...DEFAULT_BINDINGS, implementer: { provider: 'claude', model: 'claude-opus-4-8', transport: 'interactive' } },
      { workerBudgetUsd: 10, timeoutMs: 60_000 },
    );
    expect.soft(interactive.implementer).toBeInstanceOf(InteractiveClaudeWorker);
    expect.soft(interactive.implementer.name).toBe('claude'); // the same WorkerProvider contract name
  });

  test('the consultant provider is built only when bound; an un-enabled run has exactly today’s two', () => {
    const unbound = createWorkers(DEFAULT_BINDINGS, { workerBudgetUsd: 10, timeoutMs: 60_000 });
    expect.soft(unbound).not.toHaveProperty('consultant');
    expect.soft(unbound.consultant).toBeUndefined();

    const bound = createWorkers(
      { ...DEFAULT_BINDINGS, consultant: { provider: 'claude', model: 'claude-opus-4-8', transport: 'headless' } },
      { workerBudgetUsd: 10, timeoutMs: 60_000 },
    );
    expect.soft(bound.consultant).toBeInstanceOf(ClaudeWorker);
    expect.soft(bound.consultant?.name).toBe('claude');
  });
});

describe('providerFor (narrow-or-prescribed-error over the optional consultant)', () => {
  test('returns a built provider, and throws a prescribed-recovery error for an unbuilt role', () => {
    const unbound = createWorkers(DEFAULT_BINDINGS, { workerBudgetUsd: 10, timeoutMs: 60_000 });
    expect.soft(providerFor(unbound, 'implementer').name).toBe('claude');
    expect.soft(providerFor(unbound, 'reviewer').name).toBe('codex');
    expect.soft(() => providerFor(unbound, 'consultant')).toThrow(/no consultant worker is built/);

    const bound = createWorkers(
      { ...DEFAULT_BINDINGS, consultant: { provider: 'codex' } },
      { workerBudgetUsd: 10, timeoutMs: 60_000 },
    );
    expect.soft(providerFor(bound, 'consultant').name).toBe('codex');
  });
});

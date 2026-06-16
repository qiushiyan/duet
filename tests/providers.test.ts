import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { COMPACT_CONFIRMATION, ClaudeWorker, parseClaudeTurn } from '../src/providers/claude.ts';
import { parseRolloutContext } from '../src/providers/codex.ts';
import { InteractiveClaudeWorker, claudeProjectSlug, parseInteractiveTurn } from '../src/providers/interactive-claude.ts';
import { createWorkers } from '../src/providers/index.ts';
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

  test('a failed turn surfaces the subtype and the partial result', () => {
    const stdout = JSON.stringify([{ ...result, subtype: 'error_max_budget_usd', is_error: true, result: 'ran out' }]);
    expect(() => parseClaudeTurn(stdout, 'prompt')).toThrow('claude worker turn failed (error_max_budget_usd): ran out');
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

describe('createWorkers', () => {
  test('binds each role to its provider with the phase rails applied', () => {
    const workers = createWorkers(DEFAULT_BINDINGS, { workerBudgetUsd: 10, timeoutMs: 60_000 });
    expect.soft(workers.implementer.name).toBe('claude');
    expect.soft(workers.reviewer.name).toBe('codex');
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
});

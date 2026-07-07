import { describe, expect, test, vi } from 'vitest';
import { ClaudeWorker, claudeArgs, claudeExecaOptions, parseClaudeTurn, recoverClaudeFailure } from '../src/voices/providers/claude.ts';
import { ContextDeadlineExceededError, WALL_CLOCK_DRAIN_GRACE_MS, WALL_CLOCK_TICK_MS, WallClockExceededError } from '../src/voices/providers/wall-clock.ts';
import { classifyError } from '../src/voices/health.ts';
import { BudgetCutoffError } from '../src/voices/providers/types.ts';
import { jsonl, plantClaudeTranscript } from './helpers/transcripts.ts';

// execa is the provider's true external boundary (mock allowed there). No test
// in this file spawns the real `claude`, so a file-global mock is safe — it is
// configured only by the ClaudeWorker.runTurn tests below.
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
    // The subtype and the cause must both survive into the error; the sentence
    // around them is not pinned.
    expect.soft(() => parseClaudeTurn(stdout, 'prompt')).toThrow(/error_during_execution/);
    expect.soft(() => parseClaudeTurn(stdout, 'prompt')).toThrow(/crashed/);
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

describe('the context deadline is wired into runTurn (the S3 sibling — the window-fill regression guard)', () => {
  // The sibling of wall-clock.test.ts's S3 wiring guard: runWithContextDeadline
  // is thoroughly unit-tested, but only THIS proves ClaudeWorker.runTurn actually
  // wraps its turn in it — deleting that wrap in claude.ts would leave every
  // other test green while reintroducing the regression class the wrap exists to
  // prevent (a session fills mid-turn and the run wedges on "Prompt is too long"
  // for hours). The sampler seam is the real one: the wrap re-reads this turn's
  // transcript tail from disk each tick (readTranscriptTailForSession under
  // $HOME — the fake home the global setup plants), so the test writes a real
  // transcript rather than injecting a fake sampler the impl doesn't have.
  const capTokens = 850_000;
  const turnStart = new Date('2026-06-20T12:00:00.000Z');
  // One record satisfies both tick-time reads: an assistant record with billed
  // usage (the fill sampler's input) timestamped after the turn start (the
  // accepted-abort proof recoverClaudeFailure demands before it settles a
  // checkpoint instead of throwing infra).
  const assistantAtFill = (totalTokens: number) => ({
    type: 'assistant',
    timestamp: '2026-06-20T12:00:01.000Z',
    message: { content: [{ type: 'text', text: 'grinding on the keystone' }], usage: { input_tokens: totalTokens, output_tokens: 0 } },
  });
  const successStdout = (sessionId: string): string =>
    JSON.stringify([{ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sessionId }]);

  test('a high-fill tail cuts the hung turn at the first sampler tick — the context-exhausted checkpoint, not the wall-clock one', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(turnStart);
      const sessionId = 'sess-ctx-wired-cut';
      plantClaudeTranscript(process.env.HOME!, sessionId, jsonl(assistantAtFill(870_000)));
      const kill = vi.fn();
      const hanging = Object.assign(new Promise<never>(() => {}), { kill }); // a subprocess that never settles on its own
      mockExeca.mockReturnValueOnce(hanging);
      const promise = new ClaudeWorker({ model: 'claude-opus-4-8' }).runTurn({
        prompt: 'build it',
        cwd: '/x',
        sessionId,
        timeoutMs: 90 * 60_000, // the wall-clock cap is FAR away — only the context deadline can cut this early
        contextCapTokens: capTokens,
      });
      // One sampler tick: the planted tail reads 870k ≥ the 850k cap → the wrap
      // kills the child. HARD assert (not soft): with the wrap deleted, nothing
      // cuts until the 90-min wall clock, and awaiting the turn would hang —
      // fail here instead.
      await vi.advanceTimersByTimeAsync(WALL_CLOCK_TICK_MS);
      expect(kill).toHaveBeenCalledTimes(1);
      // The cut drains (the resumable-checkpoint discipline), then recovery reads
      // the same accepted transcript and settles the turn.
      await vi.advanceTimersByTimeAsync(WALL_CLOCK_DRAIN_GRACE_MS);
      const turn = await promise;
      expect.soft(turn.aborted).toBe(true);
      expect.soft(turn.contextExhausted).toBe(true); // the window ran out, not time — compact-then-resume, never a bare resume
      expect.soft(turn.sessionId).toBe(sessionId);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a low-fill tail never cuts: the same ticks pass and the turn completes normally', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(turnStart);
      const sessionId = 'sess-ctx-wired-low';
      plantClaudeTranscript(process.env.HOME!, sessionId, jsonl(assistantAtFill(100_000))); // well under the cap
      const kill = vi.fn();
      let finishChild!: (v: { stdout: string }) => void;
      const child = Object.assign(
        new Promise<{ stdout: string }>((r) => {
          finishChild = r;
        }),
        { kill },
      );
      mockExeca.mockReturnValueOnce(child);
      const promise = new ClaudeWorker({ model: 'claude-opus-4-8' }).runTurn({
        prompt: 'build it',
        cwd: '/x',
        sessionId,
        timeoutMs: 90 * 60_000,
        contextCapTokens: capTokens,
      });
      // Two sampler ticks below the limit — the deadline is armed but must not fire.
      await vi.advanceTimersByTimeAsync(2 * WALL_CLOCK_TICK_MS);
      expect.soft(kill).not.toHaveBeenCalled();
      // The turn then finishes on its own, untouched by the armed deadline.
      finishChild({ stdout: successStdout(sessionId) });
      const turn = await promise;
      expect.soft(turn.text).toBe('ok');
      expect.soft(turn.aborted).toBeUndefined();
      expect.soft(turn.contextExhausted).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
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

  // The S5 seam: scripting a WallClockExceededError models a turn aborted at its
  // wall-clock cap, driving the abort outcome without a real overrun. Higher-level
  // suites can script the same error through the WorkerProvider interface — a
  // FakeWorker already relays a scripted Error as a rejection, no fixture change.
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

describe('claudeArgs (the budget-cap + permission seams)', () => {
  // Only the rows the integration argv paths can't reach live here. The session
  // flags (fresh --session-id / resume --resume) are re-proven byte-for-byte by
  // the ClaudeWorker.runTurn argv asserts above, and the effort + native-argv
  // passthrough by provider-factory.test.ts's createWorkers→runTurn argv assert
  // — so those rows are pinned there, not duplicated here.
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
    // The analyst hint no longer restricts the headless argv: full permissions
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

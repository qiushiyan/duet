import { describe, expect, test, vi } from 'vitest';
import { CodexWorker, codexThreadOptions, parseRolloutContext, reconstructCodexTurn, recoverCodexAbort } from '../src/voices/providers/codex.ts';
import { WallClockExceededError } from '../src/voices/providers/wall-clock.ts';
import type { ThreadEvent } from '@openai/codex-sdk';

// The codex SDK is the codex provider's true external boundary — mocked so the
// CodexWorker test can capture the constructed client and thread options
// without spawning the real codex (the pure codex helpers don't touch the
// client).
const codexRunStreamed = vi.hoisted(() => vi.fn());
const codexConstructedOptions = vi.hoisted((): unknown[] => []);
const codexStartThreadOptions = vi.hoisted(() => vi.fn());
const codexResumeThreadOptions = vi.hoisted(() => vi.fn());
vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    constructor(options?: unknown) {
      codexConstructedOptions.push(options);
    }
    startThread(options?: unknown) {
      codexStartThreadOptions(options);
      return { id: 'codex-thread', runStreamed: codexRunStreamed };
    }
    resumeThread(id: string, options?: unknown) {
      codexResumeThreadOptions(id, options);
      return { id: 'codex-thread', runStreamed: codexRunStreamed };
    }
  },
}));

describe('the watchdog is Claude-only (S2 — never leaked into codex)', () => {
  test('codexThreadOptions carries no API_FORCE_IDLE_TIMEOUT (a Claude API knob)', () => {
    const opts = codexThreadOptions({ cwd: '/repo' });
    expect(JSON.stringify(opts)).not.toContain('API_FORCE_IDLE_TIMEOUT');
  });
});

describe('context-window probes (per-provider math, one shape)', () => {
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

describe('codexThreadOptions (the sandbox-deferral seam)', () => {
  test('never sets sandboxMode — codex defers the sandbox to ~/.codex/config.toml', () => {
    // The analyst hint (a read-only role) must NOT derive an OS sandbox: the
    // old read-only/workspace-write mapping overrode the user's config and broke
    // read-only tooling ($TMPDIR IPC sockets, outbound reads). Omitting it lets
    // the codex CLI fall back to the user's configured posture.
    expect.soft(codexThreadOptions({ cwd: '/repo' }).sandboxMode).toBeUndefined();
    expect.soft(codexThreadOptions({}).sandboxMode).toBeUndefined();
  });

  // The workingDirectory/model/modelReasoningEffort passthrough rows live only in
  // the CodexWorker test below — its startThread assert re-proves the exact
  // thread-options object at the SDK boundary, so pure rows would duplicate it.
  test('CodexWorker builds the SDK client with native config and starts a thread with model/effort', async () => {
    codexConstructedOptions.length = 0;
    codexStartThreadOptions.mockClear();
    codexRunStreamed.mockResolvedValueOnce({
      events: (async function* (): AsyncGenerator<ThreadEvent> {
        yield { type: 'thread.started', thread_id: 'th-1' };
        yield { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'OK' } };
        yield {
          type: 'turn.completed',
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
        };
      })(),
    });

    const worker = new CodexWorker({
      model: 'gpt-5.5',
      effort: 'high',
      nativeConfig: { model_reasoning_summary: 'detailed' },
      timeoutMs: 60_000,
    });
    const turn = await worker.runTurn({ prompt: 'go', cwd: '/repo' });

    expect.soft(turn.text).toBe('OK');
    expect.soft(codexConstructedOptions.at(-1)).toEqual({ config: { model_reasoning_summary: 'detailed' } });
    expect.soft(codexStartThreadOptions).toHaveBeenLastCalledWith({
      workingDirectory: '/repo',
      model: 'gpt-5.5',
      modelReasoningEffort: 'high',
    });
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

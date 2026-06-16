import { describe, expect, test } from 'vitest';
import { COMPACT_CONFIRMATION, parseClaudeTurn } from '../src/providers/claude.ts';
import { parseRolloutContext } from '../src/providers/codex.ts';
import { parseInteractiveTurn } from '../src/providers/interactive-claude.ts';
import { createWorkers } from '../src/providers/index.ts';
import { DEFAULT_BINDINGS } from '../src/config.ts';
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
});

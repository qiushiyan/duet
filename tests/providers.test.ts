import { describe, expect, test } from 'vitest';
import { parseClaudeTurn } from '../src/providers/claude.ts';
import { createWorkers } from '../src/providers/index.ts';
import { DEFAULT_BINDINGS } from '../src/config.ts';

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

describe('createWorkers', () => {
  test('binds each role to its provider with the phase rails applied', () => {
    const workers = createWorkers(DEFAULT_BINDINGS, { workerBudgetUsd: 10, timeoutMs: 60_000 });
    expect.soft(workers.implementer.name).toBe('claude');
    expect.soft(workers.reviewer.name).toBe('codex');
  });
});

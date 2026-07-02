import { describe, expect, test } from 'vitest';
import {
  CONTEXT_CAUTION_PERCENT,
  CONTEXT_EMERGENCY_PERCENT,
  contextBand,
  latestTranscriptUsageTokens,
} from '../src/context-guard.ts';

describe('contextBand — the pressure bands', () => {
  test.for<[number | undefined, string]>([
    [undefined, 'ok'], // no reading → guards stand down, not a fabricated alarm
    [0, 'ok'],
    [CONTEXT_CAUTION_PERCENT - 1, 'ok'],
    [CONTEXT_CAUTION_PERCENT, 'caution'],
    [CONTEXT_EMERGENCY_PERCENT - 1, 'caution'],
    [CONTEXT_EMERGENCY_PERCENT, 'emergency'],
    [100, 'emergency'],
  ])('%s%% → %s', ([percent, band]) => {
    expect(contextBand(percent)).toBe(band);
  });
});

describe('latestTranscriptUsageTokens — the mid-turn fill parse', () => {
  const rec = (o: object): string => JSON.stringify(o);

  test('the last assistant record with real usage wins', () => {
    const jsonl = [
      rec({ type: 'assistant', message: { usage: { input_tokens: 100_000, output_tokens: 50 } } }),
      rec({ type: 'user', message: { content: 'tool result' } }),
      rec({ type: 'assistant', message: { usage: { input_tokens: 800_000, cache_read_input_tokens: 100_000, output_tokens: 400 } } }),
    ].join('\n');
    expect(latestTranscriptUsageTokens(jsonl)).toBe(900_400);
  });

  test('a trailing zero-sum usage (the error echo) is skipped — same honesty rule as the settle extractor', () => {
    const jsonl = [
      rec({ type: 'assistant', message: { usage: { input_tokens: 950_000, output_tokens: 300 } } }),
      rec({ type: 'assistant', message: { usage: { input_tokens: 0, output_tokens: 0 } } }),
    ].join('\n');
    expect(latestTranscriptUsageTokens(jsonl)).toBe(950_300);
  });

  test('a sidechain (subagent) assistant record never speaks for the session', () => {
    // A subagent's usage reflects ITS window, not the session's — reading it
    // would mis-report the fill exactly while a subagent runs. (Empirically
    // absent in 14 days of real transcripts — the spike's census — but the
    // parser matches the validated mainline-only read structurally.)
    const jsonl = [
      rec({ type: 'assistant', message: { usage: { input_tokens: 800_000, output_tokens: 200 } } }),
      rec({ type: 'assistant', isSidechain: true, message: { usage: { input_tokens: 12_000, output_tokens: 50 } } }),
    ].join('\n');
    expect(latestTranscriptUsageTokens(jsonl)).toBe(800_200);
  });

  test('no usage-bearing assistant record means undefined, not zero', () => {
    const jsonl = [
      rec({ type: 'system', subtype: 'init' }),
      rec({ type: 'assistant', message: { content: [{ type: 'text', text: 'no usage field' }] } }),
      'not json at all',
    ].join('\n');
    expect(latestTranscriptUsageTokens(jsonl)).toBeUndefined();
  });
});

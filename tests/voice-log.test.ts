import { describe, expect, test } from 'vitest';
import {
  ASK_HUMAN_HEADER,
  PHASE_CLOSE_HEADER,
  PHASE_OPEN_HEADER,
  WORKER_PROMPT_HEADER,
  WORKER_RESPONSE_HEADER,
  parseVoiceLogBlocks,
} from '../src/run/voice-log.ts';

const stamp = (minute: number): string => `2026-07-07T10:${String(minute).padStart(2, '0')}:00.000Z`;
const entry = (minute: number, header: string, body?: string): string =>
  body === undefined ? `[${stamp(minute)}] ${header}\n` : `[${stamp(minute)}] ${header}\n${body}\n\n`;

describe('voice-log stamped blocks', () => {
  test('parses headers and bodies without the appendVoiceLog separator', () => {
    const log = [
      entry(0, '◀ harness prompt (phase=spec)', 'line 1\nline 2'),
      entry(1, '▶ orchestrator'),
      entry(2, 'ask_human queued', 'Need a decision?\nWith context.'),
    ].join('');

    expect(parseVoiceLogBlocks(log)).toEqual([
      { stamp: stamp(0), header: '◀ harness prompt (phase=spec)', body: 'line 1\nline 2' },
      { stamp: stamp(1), header: '▶ orchestrator' },
      { stamp: stamp(2), header: 'ask_human queued', body: 'Need a decision?\nWith context.' },
    ]);
  });

  test('preserves a body trailing newline while dropping only the log separator', () => {
    const [block] = parseVoiceLogBlocks(entry(0, '▶ response (session s1)', 'body with newline\n'));

    expect(block?.body).toBe('body with newline\n');
  });

  test('exports the protocol marker vocabulary used by stats and replay readers', () => {
    expect.soft(PHASE_OPEN_HEADER.exec('◀ harness prompt (phase=spec)')?.[1]).toBe('spec');
    expect.soft(PHASE_CLOSE_HEADER.exec('advance_phase (spec)')?.[1]).toBe('spec');
    expect.soft(WORKER_PROMPT_HEADER.exec('◀ prompt (tag=review-spec, from orchestrator)')?.[1]).toBe('review-spec');
    expect.soft(WORKER_RESPONSE_HEADER.exec('▶ response (session abc) · context 42%')?.slice(1)).toEqual(['abc', '42']);
    expect.soft(ASK_HUMAN_HEADER.test('ask_human queued')).toBe(true);
  });
});

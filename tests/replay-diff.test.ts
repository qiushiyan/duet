import { describe, expect, test } from 'vitest';
import { diffReplay } from '../src/replay/diff.ts';
import type { CapturedToolEvent } from '../src/replay/host.ts';
import { parseProtocolTrace } from '../src/replay/record.ts';
import type { ScriptedWorkerCall } from '../src/replay/scripted-worker.ts';

const entry = (minute: number, header: string, body?: string): string =>
  body === undefined
    ? `[2026-07-07T10:${String(minute).padStart(2, '0')}:00.000Z] ${header}\n`
    : `[2026-07-07T10:${String(minute).padStart(2, '0')}:00.000Z] ${header}\n${body}\n\n`;

function traceWith(workerLogs: Array<{ voice: string; tag: string; body: string }>, terminalBody = 'done') {
  return parseProtocolTrace({
    orchestratorLog: [entry(0, '◀ harness prompt (phase=design)', 'brief'), entry(50, 'advance_phase (design)', terminalBody)].join(''),
    workerLogs: workerLogs.map((turn, index) => ({
      voice: turn.voice,
      log: [
        entry(index + 1, `◀ prompt (tag=${turn.tag}, from orchestrator)`, turn.body),
        entry(index + 20, `▶ response (session ${turn.voice}-${index + 1})`, `${turn.voice} response`),
      ].join(''),
    })),
  });
}

const send = (duty: readonly string[], tag: string, body: string): CapturedToolEvent => ({ kind: 'send_prompt', duty, tag, body });
const advance = (body = 'done'): CapturedToolEvent => ({ kind: 'terminal', verb: 'advance_phase', body });

describe('diffReplay', () => {
  test('reports body-only changes as adaptation drift on aligned turns', () => {
    const diff = diffReplay({
      original: traceWith([{ voice: 'architect', tag: 'write-design', body: 'write the draft' }]),
      phase: 'design',
      freshEvents: [send(['architect'], 'write-design', 'write the draft carefully'), advance()],
    });

    expect.soft(diff.firstStructuralDivergence).toBeUndefined();
    expect.soft(diff.sends[0]?.structural).toBeUndefined();
    expect.soft(diff.sends[0]?.adaptation).toEqual({
      originalBody: 'write the draft',
      freshBody: 'write the draft carefully',
    });
  });

  test('compares original ordinals phase-locally when the voice was used in a prior phase', () => {
    const original = parseProtocolTrace({
      orchestratorLog: [
        entry(0, '◀ harness prompt (phase=frame)', 'frame brief'),
        entry(5, 'advance_phase (frame)', 'frame done'),
        entry(6, '◀ harness prompt (phase=design)', 'design brief'),
        entry(50, 'advance_phase (design)', 'done'),
      ].join(''),
      workerLogs: [
        {
          voice: 'architect',
          log: [
            entry(1, '◀ prompt (tag=think-holistic, from orchestrator)', 'frame read'),
            entry(2, '▶ response (session architect-frame)', 'frame response'),
            entry(7, '◀ prompt (tag=write-design, from orchestrator)', 'design write'),
            entry(8, '▶ response (session architect-design)', 'design response'),
          ].join(''),
        },
      ],
    });

    const diff = diffReplay({
      original,
      phase: 'design',
      freshEvents: [send(['architect'], 'write-design', 'design write'), advance()],
    });

    expect.soft(diff.firstStructuralDivergence).toBeUndefined();
    expect.soft(diff.sends[0]?.structural).toBeUndefined();
    expect.soft(diff.sends[0]?.original?.ordinalsByDuty).toEqual({ architect: 1 });
    expect.soft(diff.sends[0]?.fresh?.ordinalsByDuty).toEqual({ architect: 1 });
  });

  test('marks the first structural divergence and labels later body drift unanchored', () => {
    const diff = diffReplay({
      original: traceWith([
        { voice: 'architect', tag: 'write-design', body: 'write' },
        { voice: 'analyst', tag: 'review-design', body: 'review' },
      ]),
      phase: 'design',
      freshEvents: [
        send(['architect'], 'review-design', 'write'),
        send(['analyst'], 'review-design', 'review with new wording'),
        advance('fresh terminal after divergence'),
      ],
    });

    expect.soft(diff.firstStructuralDivergence).toBe('send_prompt[0]: snippet tag changed from write-design to review-design');
    expect.soft(diff.unanchoredFromIndex).toBe(0);
    expect.soft(diff.sends[1]).toMatchObject({ unanchored: true });
    expect.soft(diff.sends[1]?.adaptation).toBeUndefined();
    expect.soft(diff.terminal).toMatchObject({ unanchored: true });
    expect.soft(diff.terminal.structural).toBeUndefined();
  });

  test('names single-duty routing changes as worker duty changes', () => {
    const diff = diffReplay({
      original: traceWith([{ voice: 'architect', tag: 'write-design', body: 'write' }]),
      phase: 'design',
      freshEvents: [send(['analyst'], 'write-design', 'write'), advance()],
    });

    expect.soft(diff.firstStructuralDivergence).toBe('send_prompt[0]: worker duty changed from architect to analyst');
  });

  test('treats changed terminal verb and payload as structural drift', () => {
    const diff = diffReplay({
      original: traceWith([], 'ship it'),
      phase: 'design',
      freshEvents: [{ kind: 'terminal', verb: 'ask_human', body: 'Which scope?' }],
    });

    expect.soft(diff.firstStructuralDivergence).toBe('terminal: terminal verb changed from advance_phase to ask_human');
    expect.soft(diff.terminal).toMatchObject({
      original: { verb: 'advance_phase', body: 'ship it' },
      fresh: { verb: 'ask_human', body: 'Which scope?' },
    });
  });

  test('reports fan-out membership changes as structural drift', () => {
    const diff = diffReplay({
      original: parseProtocolTrace({
        orchestratorLog: [entry(0, '◀ harness prompt (phase=design)', 'brief'), entry(50, 'advance_phase (design)', 'done')].join(''),
        workerLogs: [
          {
            voice: 'architect',
            log: [entry(1, '◀ prompt (tag=think-holistic, from orchestrator)', 'same prompt'), entry(20, '▶ response (session a1)', 'a')].join(''),
          },
          {
            voice: 'analyst',
            log: [entry(1, '◀ prompt (tag=think-holistic, from orchestrator)', 'same prompt'), entry(21, '▶ response (session c1)', 'c')].join(''),
          },
        ],
      }),
      phase: 'design',
      freshEvents: [send(['architect'], 'think-holistic', 'same prompt'), advance()],
    });

    expect.soft(diff.firstStructuralDivergence).toBe('send_prompt[0]: fan-out membership changed from architect,analyst to architect');
  });

  test('reports scripted worker exhaustion at the exhausted fresh duty ordinal', () => {
    const calls: ScriptedWorkerCall[] = [
      { voice: 'architect', ordinal: 1, prompt: 'first', exhausted: false },
      { voice: 'architect', ordinal: 2, prompt: 'second', exhausted: true },
    ];
    const diff = diffReplay({
      original: traceWith([{ voice: 'architect', tag: 'write-design', body: 'first' }]),
      phase: 'design',
      freshEvents: [send(['architect'], 'write-design', 'first'), send(['architect'], 'write-design', 'second'), advance()],
      scriptedCalls: calls,
    });

    expect.soft(diff.firstStructuralDivergence).toBe('send_prompt[1]: scripted worker exhausted for this send_prompt');
    expect.soft(diff.sends[1]).toMatchObject({ structural: 'scripted worker exhausted for this send_prompt' });
  });

  test('marks compact-bodied turns so the report can explain ordinal cascades', () => {
    const diff = diffReplay({
      original: traceWith([{ voice: 'analyst', tag: 'compact-inflight', body: '/compact\npreserve review context' }]),
      phase: 'design',
      freshEvents: [send(['analyst'], 'compact-inflight', '/compact\npreserve review context'), advance()],
    });

    expect.soft(diff.sends[0]).toMatchObject({ compactCascade: true });
  });
});

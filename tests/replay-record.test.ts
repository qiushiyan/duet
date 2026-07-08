import { describe, expect, test } from 'vitest';
import { parseProtocolTrace } from '../src/replay/record.ts';
import { entry } from './helpers/replay.ts';

describe('parseProtocolTrace', () => {
  test('extracts phase briefs, worker prompts and responses, terminals, and ordering', () => {
    const trace = parseProtocolTrace({
      orchestratorLog: [
        entry(0, '◀ harness prompt (phase=spec)', 'recorded brief'),
        entry(5, 'advance_phase (spec)', 'ship the design'),
      ].join(''),
      workerLogs: [
        {
          voice: 'architect',
          log: [
            entry(1, '◀ prompt (tag=write-spec, from orchestrator)', 'write prompt'),
            entry(3, '▶ response (session a1) · context 12%', 'wrote it'),
          ].join(''),
        },
        {
          voice: 'analyst',
          log: [
            entry(2, '◀ prompt (tag=review-spec, from orchestrator)', 'review prompt'),
            entry(4, '▶ response (session c1)', 'reviewed it'),
          ].join(''),
        },
      ],
    });

    expect.soft(trace.notes).toEqual([]);
    expect.soft(trace.events.map((event) => event.kind)).toEqual([
      'phase_brief',
      'worker_prompt',
      'worker_prompt',
      'worker_response',
      'worker_response',
      'terminal',
    ]);
    expect.soft(trace.events.map((event) => event.phase)).toEqual(['spec', 'spec', 'spec', 'spec', 'spec', 'spec']);
    expect.soft(trace.workerTurns).toHaveLength(2);
    expect.soft(trace.workerTurns[0]?.prompt).toMatchObject({ voice: 'architect', ordinal: 1, tag: 'write-spec', body: 'write prompt' });
    expect.soft(trace.workerTurns[0]?.terminal).toMatchObject({ kind: 'worker_response', sessionId: 'a1', body: 'wrote it', contextPercent: 12 });
    expect.soft(trace.events.at(-1)).toMatchObject({ kind: 'terminal', verb: 'advance_phase', body: 'ship the design' });
  });

  test('extracts ask_human and delivered steers as protocol events', () => {
    const trace = parseProtocolTrace({
      orchestratorLog: [
        entry(0, '◀ harness prompt (phase=spec)', 'brief'),
        entry(1, 'human steer delivered (staged 2026-07-07T09:59:00.000Z)', 'tighten scope'),
        entry(2, 'ask_human queued', 'Which way?'),
      ].join(''),
      workerLogs: [],
    });

    expect.soft(trace.events[1]).toMatchObject({
      kind: 'steer',
      delivery: 'live',
      stagedAt: '2026-07-07T09:59:00.000Z',
      body: 'tighten scope',
      phase: 'spec',
    });
    expect.soft(trace.events[2]).toMatchObject({ kind: 'terminal', verb: 'ask_human', body: 'Which way?', phase: 'spec' });
  });

  test('marks a near-simultaneous same-body multi-worker prompt as a fan-out', () => {
    const body = 'same neutral read';
    const trace = parseProtocolTrace({
      orchestratorLog: [entry(0, '◀ harness prompt (phase=frame)', 'brief')].join(''),
      workerLogs: [
        { voice: 'architect', log: entry(1, '◀ prompt (tag=think-holistic, from orchestrator)', body) },
        { voice: 'analyst', log: entry(1, '◀ prompt (tag=think-holistic, from orchestrator)', body, 1) },
      ],
    });

    const prompts = trace.events.filter((event) => event.kind === 'worker_prompt');
    expect.soft(prompts.map((event) => event.fanoutId)).toEqual(['fanout-1', 'fanout-1']);
    expect.soft(trace.notes).toContain('fanout fanout-1 inferred by 10ms proximity for tag think-holistic; original log stamps differed');
  });

  test('reports missing logs and unmatched worker turns as notes', () => {
    const trace = parseProtocolTrace({
      workerLogs: [
        { voice: 'architect', log: entry(1, '◀ prompt (tag=write-spec, from orchestrator)', 'no response') },
        { voice: 'analyst' },
      ],
    });

    expect.soft(trace.notes).toContain('missing orchestrator.log');
    expect.soft(trace.notes).toContain('missing analyst.log');
    expect.soft(trace.notes).toContain('architect ordinal 1 has a prompt without a terminal');
    expect.soft(trace.workerTurns[0]).toMatchObject({ voice: 'architect', ordinal: 1 });
  });

  test('captures non-response worker terminals instead of dropping them', () => {
    const trace = parseProtocolTrace({
      orchestratorLog: [entry(0, '◀ harness prompt (phase=spec)', 'brief')].join(''),
      workerLogs: [
        {
          voice: 'analyst',
          log: [
            entry(1, '◀ prompt (tag=review-spec, from orchestrator)', 'review'),
            entry(2, '◼ budget-control stop: cap reached'),
          ].join(''),
        },
      ],
    });

    expect.soft(trace.workerTurns[0]?.terminal).toMatchObject({ kind: 'worker_terminal', status: 'budget', body: 'cap reached' });
  });
});

import { describe, expect, test as plain } from 'vitest';
import { decisionPoints, gradeMatrix } from '../src/surfaces/decision-points.ts';
import { test } from './helpers/fixtures.ts';

const line = (ts: string, header: string) => `[${ts}] ${header}`;
const at = (m: number) => `2026-07-07T10:${String(m).padStart(2, '0')}:00.000Z`;

describe('decisionPoints', () => {
  test('discovers attended, auto-crossed, held-high, and question stops with stable keys', ({ run }) => {
    run.gatesAt = ['frame', 'spec'];
    run.autoApprovals = [{ gate: 'plan', at: at(25) }];
    run.phaseSummaries.frame = { summary: 'direction approved', artifacts: [] };
    run.phaseSummaries.spec = { summary: 'spec packet final', artifacts: ['docs/spec.md'] };
    run.phaseSummaries.plan = { summary: 'plan packet', artifacts: ['docs/plan.md'] };
    run.phaseSummaries.implement = {
      summary: 'ship packet',
      artifacts: ['src/app.ts'],
      humanDecisions: [{ title: 'accept residual risk', severity: 'high' }],
    };

    const log = [
      line(at(0), '◀ harness prompt (phase=frame)'),
      line(at(1), 'advance_phase (frame)'),
      'direction approved',
      '',
      line(at(2), '◀ harness prompt (phase=spec)'),
      line(at(5), 'advance_phase (spec)'),
      'spec packet rejected once',
      '',
      line(at(8), '◀ harness prompt (phase=spec)'),
      line(at(10), 'advance_phase (spec)'),
      'spec packet final',
      '',
      line(at(12), '◀ harness prompt (phase=implement)'),
      line(at(13), 'ask_human queued'),
      'Should the builder preserve the legacy flag?',
      '',
      line(at(14), '◀ harness prompt (phase=implement)'),
      'The human answered your queued question: "yes: keep it". Continue the phase from where you paused, taking their answer into account.',
      '',
      line(at(20), 'advance_phase (implement)'),
      'ship packet',
      '',
    ].join('\n');

    const discovery = decisionPoints(run, log);

    expect.soft(discovery.notes).toEqual([]);
    expect.soft(discovery.points.map((p) => [p.key, p.kind, p.phase, p.polarity])).toEqual([
      ['gate:frame:0', 'gate', 'frame', 'stopped'],
      ['gate:spec:0', 'gate', 'spec', 'stopped'],
      ['question:implement:0', 'question', 'implement', 'stopped'],
      ['gate:implement:0', 'gate', 'implement', 'stopped'],
      ['gate:plan:0', 'gate', 'plan', 'did-not-stop'],
    ]);
    expect.soft(discovery.points.find((p) => p.key === 'gate:frame:0')).toMatchObject({
      disposition: 'attended',
      context: { rejectionCount: 0, summary: 'direction approved' },
    });
    expect.soft(discovery.points.find((p) => p.key === 'gate:spec:0')).toMatchObject({
      disposition: 'attended',
      context: { rejectionCount: 1, summary: 'spec packet final' },
    });
    expect.soft(discovery.points.find((p) => p.key === 'gate:plan:0')).toMatchObject({ disposition: 'auto-crossed' });
    expect.soft(discovery.points.find((p) => p.key === 'gate:implement:0')).toMatchObject({
      disposition: 'held-high',
      context: { humanDecisions: [{ title: 'accept residual risk', severity: 'high' }] },
    });
    expect.soft(discovery.points.find((p) => p.key === 'question:implement:0')).toMatchObject({
      context: { question: 'Should the builder preserve the legacy flag?', answer: 'yes: keep it' },
    });
  });

  test('a held high gate that later advances is still one held-high point, not a second attended point', ({ run }) => {
    run.gatesAt = [];
    run.phaseSummaries.implement = {
      summary: 'ship packet after human tap',
      artifacts: [],
      humanDecisions: [{ title: 'verification failed', severity: 'high' }],
    };
    const log = [line(at(0), '◀ harness prompt (phase=implement)'), line(at(5), 'advance_phase (implement)'), 'ship packet after human tap'].join('\n');

    expect(decisionPoints(run, log).points).toEqual([
      {
        key: 'gate:implement:0',
        kind: 'gate',
        phase: 'implement',
        polarity: 'stopped',
        disposition: 'held-high',
        context: {
          summary: 'ship packet after human tap',
          artifacts: [],
          humanDecisions: [{ title: 'verification failed', severity: 'high' }],
          rejectionCount: 0,
        },
      },
    ]);
  });

  plain('question ordinals are append-only within a phase', () => {
    const state = {
      runId: 'r',
      createdAt: at(0),
      cwd: '/tmp',
      workflow: 'full',
      bindings: { orchestrator: { provider: 'claude', model: 'm', transport: 'headless' }, duties: {} },
      sessions: {},
      phaseStarted: {},
      rounds: {},
      phaseSummaries: {},
      costs: { orchestratorUsd: 0, orchestratorCostPartial: false, claudeWorkersUsd: 0, claudeWorkersCostPartial: false, codexTokens: { input: 0, output: 0 } },
      snippetProposals: [],
    } as Parameters<typeof decisionPoints>[0];
    const first = [line(at(0), '◀ harness prompt (phase=implement)'), line(at(1), 'ask_human queued'), 'First?'].join('\n');
    const second = `${first}\n\n${line(at(2), 'ask_human queued')}\nSecond?`;

    expect.soft(decisionPoints(state, first).points.map((p) => p.key)).toEqual(['question:implement:0']);
    expect.soft(decisionPoints(state, second).points.map((p) => p.key)).toEqual(['question:implement:0', 'question:implement:1']);
  });

  test('missing logs fail soft while state-sourced gate points remain visible', ({ run }) => {
    run.gatesAt = [];
    run.autoApprovals = [{ gate: 'plan', at: at(5) }];
    run.phaseSummaries.plan = { summary: 'plan packet', artifacts: [] };
    run.phaseSummaries.implement = {
      summary: 'held packet',
      artifacts: [],
      humanDecisions: [{ title: 'contract failed', severity: 'high' }],
    };

    const discovery = decisionPoints(run, undefined);

    expect.soft(discovery.points.map((p) => [p.key, 'disposition' in p ? p.disposition : undefined])).toEqual([
      ['gate:plan:0', 'auto-crossed'],
      ['gate:implement:0', 'held-high'],
    ]);
    expect.soft(discovery.notes.join('\n')).toContain('orchestrator log missing');
  });
});

describe('gradeMatrix', () => {
  test('derives confusion-matrix counts from point polarity and verdict, with missed stops as FN', ({ run }) => {
    run.gatesAt = [];
    run.autoApprovals = [{ gate: 'plan', at: at(5) }];
    run.phaseSummaries.plan = { summary: 'plan packet', artifacts: [] };
    const points = decisionPoints(run, [line(at(0), '◀ harness prompt (phase=spec)'), line(at(1), 'advance_phase (spec)')].join('\n')).points;

    expect(
      gradeMatrix(points, [
        { key: 'gate:spec:0', verdict: 'wrong', gradedAt: at(2) },
        { key: 'gate:plan:0', verdict: 'wrong', gradedAt: at(3) },
        { key: 'missed:implement:security', verdict: 'wrong', note: 'missed auth decision', gradedAt: at(4) },
      ]),
    ).toMatchObject({ fp: 1, fn: 2, missed: 1, graded: 3, total: 3 });
  });
});

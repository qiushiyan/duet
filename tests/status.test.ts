import { describe, expect } from 'vitest';
import { describeStop, renderStatus } from '../src/status.ts';
import { test } from './helpers/fixtures.ts';

describe('describeStop (the notification body)', () => {
  test('names the gate that is ready', ({ run }) => {
    run.machineState = 'shipGate';
    expect(describeStop(run, false)).toBe('Ship gate — implementation packet ready');
  });

  test('surfaces the queued question at a flag-wait', ({ run }) => {
    run.machineState = 'implFlagWait';
    run.pendingQuestion = { question: 'run the migration?' };
    expect(describeStop(run, false)).toBe('question queued: run the migration?');
  });

  test('reports completion', ({ run }) => {
    expect(describeStop(run, true)).toBe('run complete — the PR is open');
  });

  test('falls back to the raw state name', ({ run }) => {
    run.machineState = 'specFlagWait';
    expect(describeStop(run, false)).toBe('stopped at specFlagWait');
  });
});

describe('renderStatus', () => {
  test('a gate stop shows the packet, the heading, and the decide-with commands', ({ run }) => {
    run.machineState = 'commitSpecGate';
    run.phaseSummaries.spec = { summary: 'reviewer flagged the data model; fixed', artifacts: ['docs/spec.md'] };
    const out = renderStatus(run);

    expect.soft(out).toContain("━━━ SPEC gate — the orchestrator's summary ━━━");
    expect.soft(out).toContain('reviewer flagged the data model; fixed');
    expect.soft(out).toContain('artifacts: docs/spec.md');
    expect.soft(out).toContain(`duet continue ${run.runId} --approve`);
    expect.soft(out).toContain(`duet continue ${run.runId} --reject "<feedback>"`);
  });

  test('gates with verification stakes carry their hint', ({ run }) => {
    run.machineState = 'shipGate';
    expect(renderStatus(run)).toContain('verify in your environment before deciding');

    run.machineState = 'openPrGate';
    expect(renderStatus(run)).toContain('approving opens the PR');
  });

  test('a queued question takes over the action section', ({ run }) => {
    run.machineState = 'implFlagWait';
    run.pendingQuestion = { question: 'migrate now?', context: 'schema change in slice 3' };
    const out = renderStatus(run);

    expect.soft(out).toContain('QUEUED QUESTION for you:');
    expect.soft(out).toContain('migrate now?');
    expect.soft(out).toContain('context: schema change in slice 3');
    expect.soft(out).toContain(`duet continue ${run.runId} --answer`);
    expect.soft(out).not.toContain('decide with:');
  });

  test('the while-you-were-away section lists auto-crossed gates with packet headlines', ({ run }) => {
    run.machineState = 'shipGate';
    run.gatesAt = ['impl', 'pr'];
    run.autoApprovals = [{ gate: 'directionGate', at: '2026-06-12T03:14:00.000Z' }];
    run.phaseSummaries.frame = { summary: 'Direction: invert the scope\nmore detail', artifacts: [] };
    const out = renderStatus(run);

    expect.soft(out).toContain('while you were away — gates auto-approved (pre-authorized):');
    expect.soft(out).toContain('✓ directionGate  2026-06-12 03:14  Direction: invert the scope');
    expect.soft(out).toContain('gates:    attending impl, pr — other gates pre-authorized');
  });

  test('a completed run shows the final summary and queued snippet proposals', ({ run }) => {
    run.machineState = 'done';
    run.phaseSummaries.open = { summary: 'PR: https://example.com/pr/7', artifacts: [] };
    run.snippetProposals.push({ snippetKey: 'review-spec', proposedBody: 'b', rationale: 'missed X', at: 'now' });
    const out = renderStatus(run);

    expect.soft(out).toContain('run complete — the PR is open.');
    expect.soft(out).toContain('PR: https://example.com/pr/7');
    expect.soft(out).toContain('• review-spec — missed X');
    expect.soft(out).toContain('queued snippet proposals');
  });

  test('shows the live phase driver and the round counters against their caps', ({ run }) => {
    run.machineState = 'specFlagWait';
    run.rounds = { spec: 2, frame: 1 };
    const out = renderStatus(run, { livePid: 4242 });

    expect.soft(out).toContain('phase:    running in the background (pid 4242)');
    expect.soft(out).toContain('frame 1/2');
    expect.soft(out).toContain('spec 2/6');
    expect.soft(out).toContain('plan 0/4');
    expect.soft(out).toContain('impl 0/6');
    expect.soft(out).not.toContain('docs 0');
  });
});

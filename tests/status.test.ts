import { describe, expect } from 'vitest';
import { buildBrief, buildStatusModel, describeStop, renderBrief, renderStatus, steerRefusal } from '../src/status.ts';
import type { RunState } from '../src/run-store.ts';
import type { RunPosition } from '../src/harness/lifecycle.ts';
import { test } from './helpers/fixtures.ts';

const render = (run: RunState, position: RunPosition): string =>
  renderStatus(buildStatusModel(run, position, []));

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

describe('steerRefusal (the steer channel gate)', () => {
  test('a live or crashed phase accepts the steer', () => {
    expect.soft(steerRefusal({ kind: 'running', pid: 4242, phase: 'impl' }, 'r1')).toBeUndefined();
    expect.soft(steerRefusal({ kind: 'crashed', phase: 'impl' }, 'r1')).toBeUndefined();
  });

  test('a gate refuses toward the gate decision', () => {
    const copy = steerRefusal({ kind: 'gate', phase: 'impl' }, 'r1');
    expect.soft(copy).toContain('shipGate');
    expect.soft(copy).toContain('duet continue r1 --approve');
    expect.soft(copy).toContain('--reject');
  });

  test('a flag refuses toward the answer', () => {
    const copy = steerRefusal({ kind: 'flag', phase: 'impl' }, 'r1');
    expect.soft(copy).toContain('queued question');
    expect.soft(copy).toContain('duet continue r1 --answer');
  });

  test('an interactive run points to the interactive orchestrator session, not a staged steer', () => {
    const copy = steerRefusal({ kind: 'interactive', phase: 'spec' }, 'r1');
    expect.soft(copy).toBeDefined(); // not the generic "nothing to steer" fallback
    expect.soft(copy).toContain('interactive orchestrator session');
    expect.soft(copy).toContain('chat');
  });

  test('a finished run says so', () => {
    expect(steerRefusal({ kind: 'done' }, 'r1')).toContain('complete');
  });
});

describe('buildStatusModel (the one derivation both renderers and --json consume)', () => {
  test('discriminates the stop across all five kinds, each carrying its acting command', ({ run }) => {
    run.pendingQuestion = { question: 'migrate?', context: 'slice 3' };
    run.phaseSummaries.spec = { summary: 'spec summary', artifacts: ['docs/spec.md'] };
    run.phaseSummaries.open = { summary: 'PR: https://example.com/pr/7', artifacts: [] };

    const gate = buildStatusModel(run, { kind: 'gate', phase: 'spec' }, []).stop;
    expect.soft(gate).toMatchObject({
      kind: 'gate',
      gate: 'commitSpecGate',
      packet: { summary: 'spec summary', artifacts: ['docs/spec.md'] },
      commands: {
        approve: `duet continue ${run.runId} --approve`,
        reject: `duet continue ${run.runId} --reject "<feedback>"`,
      },
    });

    const flag = buildStatusModel(run, { kind: 'flag', phase: 'impl' }, []).stop;
    expect.soft(flag).toEqual({
      kind: 'flag',
      question: 'migrate?',
      context: 'slice 3',
      command: `duet continue ${run.runId} --answer "<your answer>"`,
    });

    expect.soft(buildStatusModel(run, { kind: 'running', pid: 7, phase: 'impl' }, []).stop).toEqual({
      kind: 'running',
      pid: 7,
      phase: 'impl',
    });

    expect.soft(buildStatusModel(run, { kind: 'crashed', phase: 'impl' }, []).stop).toEqual({
      kind: 'crashed',
      phase: 'impl',
      command: `duet continue ${run.runId}`,
    });

    expect.soft(buildStatusModel(run, { kind: 'done' }, []).stop).toEqual({
      kind: 'done',
      summary: 'PR: https://example.com/pr/7',
    });

    expect.soft(buildStatusModel(run, { kind: 'interactive', phase: 'spec' }, []).stop).toEqual({
      kind: 'interactive',
      phase: 'spec',
    });
  });

  test('the schema promise: a fully-populated model pins its key set (additive-only)', ({ run }) => {
    run.branch = 'feat/x';
    run.specPath = 'docs/spec.md';
    run.machineState = 'shipGate';
    run.gatesAt = ['impl', 'pr'];
    run.autoApprovals = [{ gate: 'directionGate', at: '2026-06-12T03:14:00.000Z' }];
    run.lastActivity = 'send_prompt → reviewer';
    const model = buildStatusModel(run, { kind: 'gate', phase: 'impl' }, [
      { file: 'f.json', text: 'note', stagedAt: 'now' },
    ]);

    expect(Object.keys(model).sort()).toEqual([
      'autoApprovals',
      'branch',
      'context',
      'costs',
      'createdAt',
      'gatesAt',
      'lastActivity',
      'machineState',
      'pendingSteers',
      'rounds',
      'runId',
      'sessions',
      'snippetProposals',
      'specPath',
      'stop',
    ]);
  });

  test('a flag stop surfaces cause/errorClass when set, absent otherwise (additive, #4a)', ({ run }) => {
    run.pendingQuestion = { question: 'down?', cause: 'infra', errorClass: 'network' };
    const infra = buildStatusModel(run, { kind: 'flag', phase: 'impl' }, []).stop;
    if (infra.kind === 'flag') {
      expect.soft(infra.cause).toBe('infra');
      expect.soft(infra.errorClass).toBe('network');
    }
    run.pendingQuestion = { question: 'plain?' };
    const plain = buildStatusModel(run, { kind: 'flag', phase: 'impl' }, []).stop;
    if (plain.kind === 'flag') {
      expect.soft(plain.cause).toBeUndefined();
      expect.soft(plain.errorClass).toBeUndefined();
    }
  });

  test('the gate packet carries humanDecisions only when present (additive)', ({ run }) => {
    run.phaseSummaries.impl = { summary: 's', artifacts: [] };
    const without = buildStatusModel(run, { kind: 'gate', phase: 'impl' }, []).stop;
    if (without.kind === 'gate') expect.soft(without.packet?.humanDecisions).toBeUndefined();

    run.phaseSummaries.impl = { summary: 's', artifacts: [], humanDecisions: [{ title: 't', severity: 'low' }] };
    const withD = buildStatusModel(run, { kind: 'gate', phase: 'impl' }, []).stop;
    if (withD.kind === 'gate') expect.soft(withD.packet?.humanDecisions).toEqual([{ title: 't', severity: 'low' }]);
  });

  test('status --brief is a derived lean projection with a computed headline', ({ run }) => {
    run.machineState = 'shipGate';
    run.phaseSummaries.impl = {
      summary: 'Shipped the queue.\nDetails follow…',
      artifacts: ['src/x.ts'],
      humanDecisions: [{ title: 'keep the flag default-off?', severity: 'high' }],
    };
    const model = buildStatusModel(run, { kind: 'gate', phase: 'impl' }, [{ file: 'f', text: 'note', stagedAt: 't' }]);
    const brief = buildBrief(model);

    expect.soft(brief.stopKind).toBe('gate');
    // headline = the gate packet's first non-empty line — a derived field the
    // full model does NOT expose top-level.
    expect.soft(brief.headline).toBe('Shipped the queue.');
    expect.soft(brief.humanDecisions).toEqual([{ title: 'keep the flag default-off?', severity: 'high' }]);
    expect.soft(brief.pendingSteers).toBe(1);
    expect.soft(brief.nextCommand).toContain('--approve');
    // The lean human render flags the high decision as a hold signal.
    expect.soft(renderBrief(brief)).toContain('hold — a high decision');
  });

  test('the brief of a flag stop has no humanDecisions and a question headline', ({ run }) => {
    run.pendingQuestion = { question: 'run the migration first?' };
    const brief = buildBrief(buildStatusModel(run, { kind: 'flag', phase: 'impl' }, []));
    expect.soft(brief.stopKind).toBe('flag');
    expect.soft(brief.headline).toBe('run the migration first?');
    expect.soft(brief.humanDecisions).toBeUndefined();
    expect.soft(brief.nextCommand).toContain('--answer');
  });

  test('sessions[] surfaces the known voices and is [] on a fresh run', ({ run }) => {
    expect.soft(buildStatusModel(run, { kind: 'running', pid: 1, phase: 'frame' }, []).sessions).toEqual([]);
    run.orchestratorSessionId = 'orch-1';
    run.workerSessions = { reviewer: 'rev-1' };
    expect.soft(buildStatusModel(run, { kind: 'running', pid: 1, phase: 'frame' }, []).sessions).toEqual([
      { role: 'orchestrator', provider: 'claude', sessionId: 'orch-1' },
      { role: 'reviewer', provider: 'codex', sessionId: 'rev-1' },
    ]);
  });

  test('context fill per voice carries the computed percent', ({ run }) => {
    run.contextUsage = {
      orchestrator: { usedTokens: 83_000, windowTokens: 200_000, at: 't1' },
      reviewer: { usedTokens: 62_228, windowTokens: 258_400, at: 't2' },
    };
    const model = buildStatusModel(run, { kind: 'running', pid: 1, phase: 'impl' }, []);

    expect.soft(model.context).toEqual([
      { role: 'orchestrator', usedTokens: 83_000, windowTokens: 200_000, percent: 42, at: 't1' },
      { role: 'reviewer', usedTokens: 62_228, windowTokens: 258_400, percent: 24, at: 't2' },
    ]);
  });

  test('pending steers carry text and provenance, never the file handle', ({ run }) => {
    const model = buildStatusModel(run, { kind: 'running', pid: 1, phase: 'impl' }, [
      { file: 'internal.json', text: 'drop the retry tests', stagedAt: 't1', stagedDuring: 'impl' },
    ]);
    expect(model.pendingSteers).toEqual([{ stagedAt: 't1', stagedDuring: 'impl', text: 'drop the retry tests' }]);
  });

  test('pendingTurns surfaces the interactive in-flight/settled turns, and the text names check_turns', ({ run }) => {
    run.pendingTurns = {
      implementer: { tag: 'write-spec', startedAt: 't1', status: 'running' },
      reviewer: { tag: 'review-spec', startedAt: 't2', status: 'ready' },
    };
    const model = buildStatusModel(run, { kind: 'interactive', phase: 'spec' }, []);
    expect.soft(model.pendingTurns).toEqual([
      { role: 'implementer', tag: 'write-spec', status: 'running', startedAt: 't1' },
      { role: 'reviewer', tag: 'review-spec', status: 'ready', startedAt: 't2' },
    ]);
    const out = renderStatus(model);
    expect.soft(out).toContain('implementer (write-spec): running in the background');
    expect.soft(out).toContain('reviewer (review-spec): ready — collect with check_turns');
  });

  test('pendingTurns is absent when no turn is in flight (additive — omitted, not empty)', ({ run }) => {
    expect(buildStatusModel(run, { kind: 'interactive', phase: 'spec' }, [])).not.toHaveProperty('pendingTurns');
  });

  test('rounds run against their caps; auto-approvals carry packet headlines', ({ run }) => {
    run.rounds = { spec: 2, frame: 1 };
    run.autoApprovals = [{ gate: 'directionGate', at: '2026-06-12T03:14:00.000Z' }];
    run.phaseSummaries.frame = { summary: 'Direction: invert the scope\nmore detail', artifacts: [] };
    const model = buildStatusModel(run, { kind: 'running', pid: 1, phase: 'spec' }, []);

    expect.soft(model.rounds).toContainEqual({ phase: 'spec', used: 2, cap: 6 });
    expect.soft(model.rounds).toContainEqual({ phase: 'frame', used: 1, cap: 2 });
    expect.soft(model.rounds.find((r) => r.phase === 'docs')).toBeUndefined();
    expect.soft(model.autoApprovals[0]?.headline).toBe('Direction: invert the scope');
  });
});

describe('renderStatus', () => {
  test('a gate stop shows the packet, the heading, and the decide-with commands', ({ run }) => {
    run.machineState = 'commitSpecGate';
    run.phaseSummaries.spec = { summary: 'reviewer flagged the data model; fixed', artifacts: ['docs/spec.md'] };
    const out = render(run, { kind: 'gate', phase: 'spec' });

    expect.soft(out).toContain("━━━ SPEC gate — the orchestrator's summary ━━━");
    expect.soft(out).toContain('reviewer flagged the data model; fixed');
    expect.soft(out).toContain('artifacts: docs/spec.md');
    expect.soft(out).toContain(`duet continue ${run.runId} --approve`);
    expect.soft(out).toContain(`duet continue ${run.runId} --reject "<feedback>"`);
  });

  test('gates with verification stakes carry their hint', ({ run }) => {
    run.machineState = 'shipGate';
    expect(render(run, { kind: 'gate', phase: 'impl' })).toContain('verify in your environment before deciding');

    run.machineState = 'openPrGate';
    expect(render(run, { kind: 'gate', phase: 'pr' })).toContain('approving opens the PR');
  });

  test('a queued question takes over the action section', ({ run }) => {
    run.machineState = 'implFlagWait';
    run.pendingQuestion = { question: 'migrate now?', context: 'schema change in slice 3' };
    const out = render(run, { kind: 'flag', phase: 'impl' });

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
    const out = render(run, { kind: 'gate', phase: 'impl' });

    expect.soft(out).toContain('while you were away — gates auto-approved (pre-authorized):');
    expect.soft(out).toContain('✓ directionGate  2026-06-12 03:14  Direction: invert the scope');
    expect.soft(out).toContain('gates:    attending impl, pr — other gates pre-authorized');
  });

  test('a completed run shows the final summary and queued snippet proposals', ({ run }) => {
    run.machineState = 'done';
    run.phaseSummaries.open = { summary: 'PR: https://example.com/pr/7', artifacts: [] };
    run.snippetProposals.push({ snippetKey: 'review-spec', proposedBody: 'b', rationale: 'missed X', at: 'now' });
    const out = render(run, { kind: 'done' });

    expect.soft(out).toContain('run complete — the PR is open.');
    expect.soft(out).toContain('PR: https://example.com/pr/7');
    expect.soft(out).toContain('• review-spec — missed X');
    expect.soft(out).toContain('queued snippet proposals');
  });

  test('shows the live phase driver and the round counters against their caps', ({ run }) => {
    run.machineState = 'specFlagWait';
    run.rounds = { spec: 2, frame: 1 };
    const out = render(run, { kind: 'running', pid: 4242, phase: 'spec' });

    expect.soft(out).toContain('phase:    running in the background (pid 4242)');
    expect.soft(out).toContain('frame 1/2');
    expect.soft(out).toContain('spec 2/6');
    expect.soft(out).toContain('plan 0/4');
    expect.soft(out).toContain('impl 0/6');
    expect.soft(out).not.toContain('docs 0');
  });

  test('the cost line marks claude-worker cost unavailable only when the total is partial', ({ run }) => {
    run.machineState = 'implFlagWait';
    expect.soft(render(run, { kind: 'running', pid: 1, phase: 'impl' })).not.toContain('cost unavailable');

    run.costs.claudeWorkersCostPartial = true;
    expect
      .soft(render(run, { kind: 'running', pid: 1, phase: 'impl' }))
      .toContain('claude workers $0.00 known (+ interactive turns: cost unavailable)');
  });

  test('the cost line marks the orchestrator total unavailable only when interactive-hosted', ({ run }) => {
    run.machineState = 'specLoop';
    expect.soft(render(run, { kind: 'interactive', phase: 'spec' })).not.toContain('subscription quota');

    run.costs.orchestratorCostPartial = true;
    expect
      .soft(render(run, { kind: 'interactive', phase: 'spec' }))
      .toContain('orchestrator $0.00 known (interactive turns on the subscription quota: cost unavailable)');
  });

  test('context fill renders as plain percentages per voice', ({ run }) => {
    run.machineState = 'implFlagWait';
    run.contextUsage = {
      orchestrator: { usedTokens: 83_000, windowTokens: 200_000, at: 't1' },
      implementer: { usedTokens: 134_000, windowTokens: 200_000, at: 't2' },
    };
    const out = render(run, { kind: 'running', pid: 1, phase: 'impl' });
    expect.soft(out).toContain('context:  orchestrator 42% (83k/200k) · implementer 67% (134k/200k)');

    delete run.contextUsage;
    expect.soft(render(run, { kind: 'running', pid: 1, phase: 'impl' })).not.toContain('context:');
  });

  test('staged steers awaiting delivery are listed with their text', ({ run }) => {
    run.machineState = 'implFlagWait';
    const out = renderStatus(
      buildStatusModel(run, { kind: 'running', pid: 1, phase: 'impl' }, [
        { file: 'f.json', text: 'drop the retry tests', stagedAt: '2026-06-12T10:30:00.000Z', stagedDuring: 'impl' },
      ]),
    );

    expect.soft(out).toContain('staged steers awaiting delivery:');
    expect.soft(out).toContain('• 2026-06-12 10:30  drop the retry tests');
  });

  test('a crashed phase names itself and the resume command', ({ run }) => {
    run.machineState = 'planApprovalGate';
    const out = render(run, { kind: 'crashed', phase: 'impl' });

    expect.soft(out).toContain('the impl phase stopped mid-flight');
    expect.soft(out).toContain(`resume with:  duet continue ${run.runId}`);
  });

  test('an interactive stop names the phase the interactive orchestrator session is driving', ({ run }) => {
    run.machineState = 'specLoop';
    const out = render(run, { kind: 'interactive', phase: 'spec' });

    expect.soft(out).toContain('the interactive orchestrator is driving the spec phase');
    expect.soft(out).toContain('interactive orchestrator session');
  });
});

import { describe, expect } from 'vitest';
import { buildBrief, buildStatusModel, describeStop, displayState, formatGatePosture, renderBrief, renderStatus, steerRefusal } from '../src/status.ts';
import type { StopModel } from '../src/status.ts';
import { createRun } from '../src/run-store.ts';
import type { RunState } from '../src/run-store.ts';
import type { RunPosition } from '../src/harness/lifecycle.ts';
import { DEFAULT_BINDINGS } from '../src/config.ts';
import { localStamp } from '../src/timefmt.ts';
import { test } from './helpers/fixtures.ts';

const render = (run: RunState, position: RunPosition): string =>
  renderStatus(buildStatusModel(run, position, []));

describe('formatGatePosture (the single source for the three posture surfaces)', () => {
  test('formats the attended-list branch and the none branch from the injected copy', () => {
    const copy = { label: 'gates:    ', attendedSuffix: 'other gates pre-authorized', noneSuffix: 'all gates pre-authorized' };
    expect(formatGatePosture(['frame', 'spec'], copy)).toBe('gates:    attending frame, spec — other gates pre-authorized');
    expect(formatGatePosture([], copy)).toBe('gates:    attending none — all gates pre-authorized');
  });
  // The function has exactly two branches (attended-list / none), both covered above.
  // Each surface's actual copy — duet status / new / afk — is pinned at its real call
  // site (the renderStatus suite below; the cli.ts new/afk paths), not by re-running
  // this formatter with hand-supplied literals.
});

describe('workflow-neutral status surfaces (RIR)', () => {
  const rirRun = (projectDir: string): RunState =>
    createRun({ cwd: projectDir, bindings: DEFAULT_BINDINGS, workflow: 'rir', framing: 'x' });

  test('describeStop completion claims the PR for both arcs now (rir opens one too)', ({ projectDir }) => {
    const rir = rirRun(projectDir);
    expect.soft(describeStop(rir, true)).toBe('run complete — the PR is open');
    expect.soft(describeStop({ ...rir, workflow: 'full' }, true)).toBe('run complete — the PR is open');
  });

  test('the model carries the workflow and scopes rounds to the RIR arc', ({ projectDir }) => {
    const model = buildStatusModel(rirRun(projectDir), { kind: 'gate', phase: 'implement' }, []);
    expect.soft(model.workflow).toBe('rir');
    expect.soft(model.workflowDisplayName).toBe('Research → Implement → Review');
    // Only RIR phases appear in rounds — no Full phases leak in.
    expect.soft(model.rounds.map((r) => r.phase)).toEqual(['implement']);
  });

  test('the done summary reads the run’s last phase (publish), and the render claims the PR', ({
    projectDir,
  }) => {
    const rir = rirRun(projectDir);
    rir.phaseSummaries.publish = { summary: 'opened the PR', artifacts: [] };
    const model = buildStatusModel(rir, { kind: 'done' }, []);
    expect.soft(model.stop.kind === 'done' && model.stop.summary).toBe('opened the PR');
    const text = renderStatus(model);
    expect.soft(text).toContain('run complete');
    expect.soft(text).toContain('the PR is open'); // rir opens a (real) PR now too
    expect.soft(text).not.toContain('spec:'); // RIR still has no spec phase
    expect.soft(text).toContain('workflow: Research → Implement → Review');
  });

  test('the brief headline reports the open PR on completion', ({ projectDir }) => {
    const brief = buildBrief(buildStatusModel(rirRun(projectDir), { kind: 'done' }, []));
    expect(brief.headline).toBe('run complete — the PR is open');
  });

  test('an empty gatesAt (afk: attend none) renders explicit copy and survives in the JSON model', ({
    projectDir,
  }) => {
    const rir = rirRun(projectDir);
    rir.gatesAt = []; // the afk posture: every gate pre-authorized
    rir.machineState = 'shipGate';
    const model = buildStatusModel(rir, { kind: 'gate', phase: 'implement' }, []);
    // The JSON model MUST keep [] — it is the "attend none" signal, distinct
    // from absent (= attend every gate). A future change must not drop it.
    expect.soft(model.gatesAt).toEqual([]);
    const text = renderStatus(model);
    expect.soft(text).toContain('gates:    attending none — all gates pre-authorized');
    // No empty `attending  — …` join leaks through.
    expect.soft(text).not.toContain('attending  —');
  });
});

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
    run.phaseSummaries.finish = { summary: 'PR: https://example.com/pr/7', artifacts: [] };

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
    run.gatesAt = ['impl', 'finish'];
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
      'workflow',
      'workflowDisplayName',
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

  test('a budget-cause flag carries cause budget with no errorClass (the enum-widening, #3b)', ({ run }) => {
    run.pendingQuestion = { question: 'orchestrator capped?', cause: 'budget' };
    const budget = buildStatusModel(run, { kind: 'flag', phase: 'impl' }, []).stop;
    if (budget.kind === 'flag') {
      expect.soft(budget.cause).toBe('budget');
      expect.soft(budget.errorClass).toBeUndefined(); // budget is not an infra taxonomy class
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

  test('full status renders the structured decisions and names a held high (pre-authorized vs attended) — slice 5', ({
    run,
  }) => {
    run.phaseSummaries.impl = { summary: 'Shipped.', artifacts: [], humanDecisions: [{ title: 'data retention window', severity: 'high' }] };

    // Pre-authorized (impl not in gatesAt): the high is precisely why it stopped.
    run.gatesAt = ['spec'];
    const preAuth = renderStatus(buildStatusModel(run, { kind: 'gate', phase: 'impl' }, []));
    expect.soft(preAuth).toContain('decisions for you:');
    expect.soft(preAuth).toContain('● data retention window'); // the structured decision, in the PRIMARY view
    expect.soft(preAuth).toContain('pre-authorized, but a high decision held it');

    // Attended (impl in gatesAt): the high is the human's call at a live gate.
    run.gatesAt = ['impl'];
    const attended = renderStatus(buildStatusModel(run, { kind: 'gate', phase: 'impl' }, []));
    expect.soft(attended).toContain('a high decision is yours to make');
    expect.soft(attended).not.toContain('pre-authorized, but a high');

    // A low-only packet renders the decision but no high-hold line.
    run.phaseSummaries.impl = { summary: 's', artifacts: [], humanDecisions: [{ title: 'minor', severity: 'low' }] };
    const low = renderStatus(buildStatusModel(run, { kind: 'gate', phase: 'impl' }, []));
    expect.soft(low).toContain('○ minor');
    expect.soft(low).not.toContain('held it for you');
    expect.soft(low).not.toContain('yours to make');
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

    // The lean --brief path surfaces them too (review finding 2): narrowed to
    // role/tag/status (startedAt dropped), with a concise role/status render —
    // so the remote/concierge supervisor sees the turn to collect.
    const brief = buildBrief(model);
    expect.soft(brief.pendingTurns).toEqual([
      { role: 'implementer', tag: 'write-spec', status: 'running' },
      { role: 'reviewer', tag: 'review-spec', status: 'ready' },
    ]);
    expect.soft(renderBrief(brief)).toContain('pending turns: implementer running · reviewer ready');
  });

  test('pendingTurns is absent when no turn is in flight, in both the full model and the brief (additive — omitted, not empty)', ({
    run,
  }) => {
    const model = buildStatusModel(run, { kind: 'interactive', phase: 'spec' }, []);
    expect.soft(model).not.toHaveProperty('pendingTurns');
    expect.soft(buildBrief(model)).not.toHaveProperty('pendingTurns');
  });

  test('a bound consultant is enumerated across sessions[], context, and pendingTurns; the orchestrator is kept', ({
    run,
    consultantRun,
  }) => {
    // sessions[] (worker surface): the consultant appears when bound, never when not.
    run.orchestratorSessionId = 'orch-1';
    run.workerSessions = { reviewer: 'rev-1', consultant: 'stray' }; // unbound: 'stray' must not surface
    expect
      .soft(buildStatusModel(run, { kind: 'running', pid: 1, phase: 'frame' }, []).sessions.map((s) => s.role))
      .toEqual(['orchestrator', 'reviewer']);

    consultantRun.orchestratorSessionId = 'orch-1';
    consultantRun.workerSessions = { consultant: 'c-1' };
    expect
      .soft(buildStatusModel(consultantRun, { kind: 'running', pid: 1, phase: 'frame' }, []).sessions)
      .toContainEqual({ role: 'consultant', provider: 'claude', sessionId: 'c-1' });

    // context (voice surface): keeps the orchestrator AND gains the consultant —
    // a blunt workerRolesFor here would have silently dropped the orchestrator.
    consultantRun.contextUsage = {
      orchestrator: { usedTokens: 83_000, windowTokens: 200_000, at: 't1' },
      consultant: { usedTokens: 50_000, windowTokens: 200_000, at: 't2' },
    };
    const ctxRoles = buildStatusModel(consultantRun, { kind: 'running', pid: 1, phase: 'spec' }, []).context.map((c) => c.role);
    expect.soft(ctxRoles).toContain('orchestrator');
    expect.soft(ctxRoles).toContain('consultant');

    // pendingTurns (worker surface): a dispatched consultant turn is surfaced.
    consultantRun.pendingTurns = { consultant: { tag: 'consultant-spec', startedAt: 't3', status: 'ready' } };
    expect
      .soft(buildStatusModel(consultantRun, { kind: 'interactive', phase: 'spec' }, []).pendingTurns)
      .toContainEqual({ role: 'consultant', tag: 'consultant-spec', status: 'ready', startedAt: 't3' });
  });

  test('rounds run against their caps; auto-approvals carry packet headlines', ({ run }) => {
    run.rounds = { spec: 2, frame: 1 };
    run.autoApprovals = [{ gate: 'directionGate', at: '2026-06-12T03:14:00.000Z' }];
    run.phaseSummaries.frame = { summary: 'Direction: invert the scope\nmore detail', artifacts: [] };
    const model = buildStatusModel(run, { kind: 'running', pid: 1, phase: 'spec' }, []);

    expect.soft(model.rounds).toContainEqual({ phase: 'spec', used: 2, cap: 3 });
    expect.soft(model.rounds).toContainEqual({ phase: 'frame', used: 1, cap: 2 });
    expect.soft(model.rounds.find((r) => r.phase === 'finish')).toBeUndefined();
    expect.soft(model.autoApprovals[0]?.headline).toBe('Direction: invert the scope');
  });
});

describe('renderStatus', () => {
  test('a gate stop shows the packet, the heading, and the decide-with commands', ({ run }) => {
    run.machineState = 'commitSpecGate';
    run.phaseSummaries.spec = { summary: 'reviewer flagged the data model; fixed', artifacts: ['docs/spec.md'] };
    const out = render(run, { kind: 'gate', phase: 'spec' });

    expect.soft(out).toContain('SPEC gate'); // the load-bearing tokens, not the box-drawing decoration
    expect.soft(out).toContain('reviewer flagged the data model; fixed');
    expect.soft(out).toContain('artifacts: docs/spec.md');
    expect.soft(out).toContain(`duet continue ${run.runId} --approve`);
    expect.soft(out).toContain(`duet continue ${run.runId} --reject "<feedback>"`);
  });

  test('gates with verification stakes carry their hint', ({ run }) => {
    run.machineState = 'shipGate';
    expect(render(run, { kind: 'gate', phase: 'impl' })).toContain('verify in your environment before deciding');

    run.machineState = 'openPrGate';
    expect(render(run, { kind: 'gate', phase: 'finish' })).toContain('auto-crosses to done by default');
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

  test('a budget-cause flag names the stop resumable; an infra flag does not', ({ run }) => {
    run.machineState = 'implFlagWait';
    run.pendingQuestion = { question: 'orchestrator capped', cause: 'budget' };
    const budget = render(run, { kind: 'flag', phase: 'impl' });
    expect.soft(budget).toContain('budget-control stop');
    expect.soft(budget).toContain('resumable');

    run.pendingQuestion = { question: 'down?', cause: 'infra', errorClass: 'network' };
    expect.soft(render(run, { kind: 'flag', phase: 'impl' })).not.toContain('budget-control stop');
  });

  test('the while-you-were-away section lists auto-crossed gates with packet headlines', ({ run }) => {
    run.machineState = 'shipGate';
    run.gatesAt = ['impl', 'finish'];
    run.autoApprovals = [{ gate: 'directionGate', at: '2026-06-12T03:14:00.000Z' }];
    run.phaseSummaries.frame = { summary: 'Direction: invert the scope\nmore detail', artifacts: [] };
    const out = render(run, { kind: 'gate', phase: 'impl' });

    expect.soft(out).toContain('while you were away — gates auto-approved (pre-authorized):');
    // The stamp is localized to the human's zone (the stored field stays UTC) —
    // derive the expected local form so the assertion is timezone-robust.
    expect.soft(out).toContain(`✓ directionGate  ${localStamp('2026-06-12T03:14:00.000Z')}  Direction: invert the scope`);
    expect.soft(out).toContain('gates:    attending impl, finish — other gates pre-authorized');
  });

  test('a completed run shows the final summary and queued snippet proposals', ({ run }) => {
    run.machineState = 'done';
    run.phaseSummaries.finish = { summary: 'PR: https://example.com/pr/7', artifacts: [] };
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
    expect.soft(out).toContain('spec 2/3');
    expect.soft(out).toContain('plan 0/3');
    expect.soft(out).toContain('impl 0/3');
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
    expect.soft(out).toContain(`• ${localStamp('2026-06-12T10:30:00.000Z')}  drop the retry tests`);
    // The boundary: human text localizes, but the underlying field (and so
    // `status --json`) keeps raw UTC ISO — a machine consumer never sees local.
    expect.soft(out).not.toContain('2026-06-12T10:30:00.000Z');
    expect.soft(buildStatusModel(run, { kind: 'running', pid: 1, phase: 'impl' }, [{ file: 'f.json', text: 'x', stagedAt: '2026-06-12T10:30:00.000Z' }]).pendingSteers[0]?.stagedAt).toBe('2026-06-12T10:30:00.000Z');
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

describe('displayState — the truthful state label (F5)', () => {
  test('machineState wins when present; otherwise the label derives from the stop kind', () => {
    // machineState present → it wins (preserves headless quiescent labels).
    expect.soft(displayState({ kind: 'interactive', phase: 'spec' }, 'specLoop')).toBe('specLoop');
    // No machineState (the interactive case crossInteractive never mirrored):
    expect.soft(displayState({ kind: 'interactive', phase: 'spec' })).toBe('spec');
    expect.soft(displayState({ kind: 'running', pid: 1, phase: 'impl' })).toBe('impl');
    expect.soft(displayState({ kind: 'crashed', phase: 'plan', command: 'c' })).toBe('plan');
    expect.soft(displayState({ kind: 'gate', phase: 'finish', gate: 'openPrGate', heading: 'h', commands: { approve: 'a', reject: 'r' } } as StopModel)).toBe('openPrGate');
    expect.soft(displayState({ kind: 'flag', question: 'q?', command: 'c' } as StopModel)).toBe('flag');
    expect.soft(displayState({ kind: 'done', summary: 's' } as StopModel)).toBe('done');
  });

  test('an interactive run with no machineState shows its phase, never "(not started)"', ({ projectDir }) => {
    const interactive = createRun({ cwd: projectDir, bindings: DEFAULT_BINDINGS, framing: 'x' });
    interactive.orchestrationHost = 'interactive';
    const out = renderStatus(buildStatusModel(interactive, { kind: 'interactive', phase: 'frame' }, []));
    expect.soft(out).toContain('state:    frame');
    expect.soft(out).not.toContain('(not started)');
  });
});

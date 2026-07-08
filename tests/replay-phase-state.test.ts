import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { createPhaseTools } from '../src/orchestrator/tools.ts';
import { parseProtocolTrace } from '../src/replay/record.ts';
import { rewindPhaseState } from '../src/replay/phase-state.ts';
import { loadRunState, runDirOf, saveRunState } from '../src/run/store.ts';
import { workflowFor } from '../src/run/workflow.ts';
import { FakeWorker } from './helpers/fixtures.ts';
import { entry, test, tool, toolText } from './helpers/replay.ts';

describe('rewindPhaseState', () => {
  test('classifies spec replay state into inherited, phase-produced, downstream, and replay identity buckets', ({
    blueprintConsultantRun,
    replayOutDir,
  }) => {
    blueprintConsultantRun.specPath = 'docs/replay-spec.md';
    blueprintConsultantRun.orchestratorSessionId = 'original-orchestrator';
    blueprintConsultantRun.sessions = {
      'planning.architect': { provider: 'claude', id: 'planning-architect-original' },
      'planning.analyst': { provider: 'codex', id: 'planning-analyst-original' },
      'delivery.builder': { provider: 'claude', id: 'delivery-builder-original' },
      'delivery.critic': { provider: 'codex', id: 'delivery-critic-original' },
      consultant: { provider: 'claude', id: 'consultant-later-original' },
    };
    blueprintConsultantRun.phaseStarted.spec = true;
    blueprintConsultantRun.rounds.spec = 2;
    blueprintConsultantRun.sentSnippets = { spec: { architect: ['write-spec'], analyst: ['review-spec'], consultant: ['consultant-contract'] } };
    blueprintConsultantRun.phaseSummaries = {
      frame: { summary: 'direction', artifacts: [] },
      spec: { summary: 'spec done', artifacts: ['docs/replay-spec.md'] },
      implement: { summary: 'later build', artifacts: [] },
    };
    blueprintConsultantRun.terminalMarker = { phase: 'spec', kind: 'advance' };
    blueprintConsultantRun.pendingQuestion = { question: 'stale?' };
    blueprintConsultantRun.activeTurns = { architect: { tag: 'write-spec', startedAt: 'then' } };
    blueprintConsultantRun.pendingTurns = { analyst: { tag: 'review-spec', startedAt: 'then', status: 'running' } };
    blueprintConsultantRun.contextUsage = { architect: { usedTokens: 900, windowTokens: 1000, at: 'then' } };
    blueprintConsultantRun.acceptanceContractDraft = { sessionId: 'contract-original', authoredAt: 'then' };
    blueprintConsultantRun.acceptanceContract = { path: 'docs/replay-spec.acceptance.md', commit: 'abc', verifiedAt: 'later' };
    blueprintConsultantRun.corpusDir = join(replayOutDir, 'record-sentinel');

    const trace = parseProtocolTrace({
      orchestratorLog: [
        entry(0, '◀ harness prompt (phase=frame)', 'frame brief'),
        entry(1, 'advance_phase (frame)', 'direction'),
        entry(2, '◀ harness prompt (phase=spec)', 'spec draft brief without the final path'),
        entry(9, 'advance_phase (spec)', 'spec done'),
      ].join(''),
      workerLogs: [
        {
          voice: 'architect',
          log: [
            entry(0, '◀ prompt (tag=think-holistic, from orchestrator)', 'frame read'),
            entry(3, '◀ prompt (tag=write-spec, from orchestrator)', 'write it'),
          ].join(''),
        },
        { voice: 'analyst', log: entry(4, '◀ prompt (tag=review-spec, from orchestrator)', 'review it') },
        { voice: 'consultant', log: entry(8, '◀ prompt (tag=consultant-contract, from orchestrator)', 'author contract') },
      ],
    });

    const rewound = rewindPhaseState({
      recordState: blueprintConsultantRun,
      workflow: workflowFor(blueprintConsultantRun),
      phase: 'spec',
      outputDir: replayOutDir,
      trace,
      replayRunId: 'replay-spec',
    });
    const persisted = loadRunState(join(replayOutDir, 'workspace'), 'replay-spec');

    expect.soft(rewound.runDir).toBe(runDirOf(join(replayOutDir, 'workspace'), 'replay-spec'));
    expect.soft(existsSync(join(rewound.runDir, 'workflow.json'))).toBe(true);
    expect.soft(persisted.corpusDir).toBeUndefined();
    expect.soft(persisted.orchestratorSessionId).toBeUndefined();
    expect.soft(persisted.activeTurns).toBeUndefined();
    expect.soft(persisted.pendingTurns).toBeUndefined();
    expect.soft(persisted.contextUsage).toBeUndefined();
    expect.soft(persisted.specPath).toBeUndefined();
    expect.soft(persisted.acceptanceContractDraft).toBeUndefined();
    expect.soft(persisted.acceptanceContract).toBeUndefined();
    expect.soft(persisted.phaseStarted.spec).toBeUndefined();
    expect.soft(persisted.rounds.spec).toBeUndefined();
    expect.soft(persisted.sentSnippets?.spec).toBeUndefined();
    expect.soft(persisted.phaseSummaries.spec).toBeUndefined();
    expect.soft(persisted.phaseSummaries.frame).toEqual({ summary: 'direction', artifacts: [] });
    expect.soft(persisted.sessions).toEqual({});
    expect.soft(persisted.workerDispatched).toBe(true);
    expect.soft(rewound.notes).toContain('cleared acceptanceContractDraft produced by spec');
    expect.soft(rewound.notes).toContain('cleared downstream-produced session delivery.builder');
    expect.soft(rewound.notes).toContain('cleared same-stage session planning.architect produced or overwritten by spec');
  });

  test('a consultant-bound spec replay that skips the consultant is held at advance_phase', async ({
    blueprintConsultantRun,
    replayOutDir,
  }) => {
    blueprintConsultantRun.specPath = 'docs/replay-spec.md';
    blueprintConsultantRun.rounds.spec = 2;
    blueprintConsultantRun.phaseSummaries = { frame: { summary: 'direction', artifacts: [] }, spec: { summary: 'old', artifacts: [] } };
    blueprintConsultantRun.acceptanceContractDraft = { sessionId: 'stale-contract', authoredAt: 'then' };
    const trace = parseProtocolTrace({
      orchestratorLog: [entry(0, '◀ harness prompt (phase=spec)', 'spec draft brief without the final path')].join(''),
      workerLogs: [],
    });
    const { state } = rewindPhaseState({
      recordState: blueprintConsultantRun,
      workflow: workflowFor(blueprintConsultantRun),
      phase: 'spec',
      outputDir: replayOutDir,
      trace,
      replayRunId: 'replay-spec',
    });

    state.rounds.spec = 1;
    saveRunState(state);
    const { tools } = createPhaseTools({
      state,
      phase: 'spec',
      providers: {
        architect: new FakeWorker('claude'),
        analyst: new FakeWorker('codex'),
        consultant: new FakeWorker('claude'),
      },
      log: () => {},
    });

    const advance = tool(tools, 'advance_phase');
    const result = await advance.handler({ summary: 'done', artifacts: ['docs/replay-spec.md'], spec_path: 'docs/replay-spec.md' }, {});

    expect.soft(result.isError).toBe(true);
    expect.soft(toolText(result)).toContain('acceptance contract');
    expect.soft(loadRunState(state.cwd, state.runId).terminalMarker).toBeUndefined();
  });
});

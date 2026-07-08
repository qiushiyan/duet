import { join } from 'node:path';
import { describe, expect } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { runHostedPhase } from '../src/orchestrator/hosts/host-runner.ts';
import type { RunOrchestratorTurn } from '../src/orchestrator/hosts/driver.ts';
import { makeReplayHost } from '../src/replay/host.ts';
import { parseProtocolTrace } from '../src/replay/record.ts';
import { rewindPhaseState } from '../src/replay/phase-state.ts';
import { SCRIPT_EXHAUSTED_TEXT, scriptedWorkersForTrace } from '../src/replay/scripted-worker.ts';
import { loadRunState, saveRunState } from '../src/run/store.ts';
import { workflowFor } from '../src/run/workflow.ts';
import { entry, test } from './helpers/replay.ts';

const success = (): SDKMessage =>
  ({ type: 'result', subtype: 'success', session_id: 'replay-orchestrator-session', total_cost_usd: 0.01 }) as SDKMessage;

describe('scripted replay workers', () => {
  test('serve responses by duty ordinal and exhaust instead of matching prompt bodies', async ({ blueprintRun }) => {
    const trace = parseProtocolTrace({
      orchestratorLog: [entry(0, '◀ harness prompt (phase=spec)', 'brief')].join(''),
      workerLogs: [
        {
          voice: 'analyst',
          log: [
            entry(1, '◀ prompt (tag=review-spec, from orchestrator)', 'original prompt'),
            entry(2, '▶ response (session a1)', 'first response'),
          ].join(''),
        },
      ],
    });
    const scripted = scriptedWorkersForTrace(blueprintRun, trace, 'spec');
    const analyst = scripted.providers.analyst;
    if (!analyst) throw new Error('missing analyst provider');

    await expect(analyst.runTurn({ prompt: 'different fresh prompt' })).resolves.toMatchObject({ text: 'first response' });
    await expect(analyst.runTurn({ prompt: 'extra prompt' })).resolves.toMatchObject({ text: SCRIPT_EXHAUSTED_TEXT });
    expect.soft(scripted.calls).toMatchObject([
      { voice: 'analyst', ordinal: 1, prompt: 'different fresh prompt', exhausted: false },
      { voice: 'analyst', ordinal: 2, prompt: 'extra prompt', exhausted: true },
    ]);
  });
});

describe('makeReplayHost', () => {
  test('serves the recorded brief, captures tool calls, and isolates SDK home', async ({ blueprintRun, replayOutDir }) => {
    const trace = parseProtocolTrace({
      orchestratorLog: [entry(0, '◀ harness prompt (phase=spec)', 'RECORDED BRIEF')].join(''),
      workerLogs: [
        {
          voice: 'analyst',
          log: [
            entry(1, '◀ prompt (tag=review-spec, from orchestrator)', 'original review'),
            entry(2, '▶ response (session analyst-1)', 'review response'),
          ].join(''),
        },
      ],
    });
    const rewound = rewindPhaseState({
      recordState: blueprintRun,
      workflow: workflowFor(blueprintRun),
      phase: 'spec',
      outputDir: replayOutDir,
      trace,
      replayRunId: 'replay-spec',
    });
    const scripted = scriptedWorkersForTrace(rewound.state, trace, 'spec');
    const seen: { prompt?: string; home?: string; claudeConfigDir?: string; claudeHome?: string; resume?: string } = {};
    const runTurn: RunOrchestratorTurn = async function* (ctx) {
      seen.prompt = ctx.prompt;
      seen.home = ctx.options.env?.HOME;
      seen.claudeConfigDir = ctx.options.env?.CLAUDE_CONFIG_DIR;
      seen.claudeHome = ctx.options.env?.CLAUDE_HOME;
      seen.resume = (ctx.options as { resume?: string }).resume;
      const task = ctx.tools.find((tool) => tool.name === 'get_task');
      const send = ctx.tools.find((tool) => tool.name === 'send_prompt');
      const advance = ctx.tools.find((tool) => tool.name === 'advance_phase');
      if (!task || !send || !advance) throw new Error('missing replay tool');
      const taskResult = await task.handler({}, {});
      expect.soft(taskResult.content[0]).toMatchObject({ type: 'text', text: 'RECORDED BRIEF' });
      await send.handler({ duty: 'analyst', tag: 'review-spec', body: 'fresh review body' }, {});
      await advance.handler({ summary: 'fresh summary', artifacts: ['docs/spec.md'], spec_path: 'docs/spec.md' }, {});
      yield success();
    };
    const { host, capture } = makeReplayHost({
      providers: scripted.providers,
      recordedBrief: 'RECORDED BRIEF',
      outputDir: replayOutDir,
      runTurn,
    });

    await expect(runHostedPhase({ cwd: rewound.state.cwd, runId: rewound.state.runId, phase: 'spec' }, host)).resolves.toEqual({
      type: 'phase.advance',
    });

    expect.soft(seen.prompt).toBe('RECORDED BRIEF');
    expect.soft(seen.home).toBe(join(replayOutDir, 'provider-home'));
    expect.soft(seen.claudeConfigDir).toBe(join(replayOutDir, 'provider-home', '.claude'));
    expect.soft(seen.claudeHome).toBe(join(replayOutDir, 'provider-home', '.claude'));
    expect.soft(seen.resume).toBeUndefined();
    expect.soft(capture.events).toEqual([
      { kind: 'send_prompt', duty: ['analyst'], tag: 'review-spec', body: 'fresh review body' },
      { kind: 'terminal', verb: 'advance_phase', body: 'fresh summary' },
    ]);
    expect.soft(loadRunState(rewound.state.cwd, rewound.state.runId).terminalMarker).toEqual({ phase: 'spec', kind: 'advance' });
  });

  test('keeps rail-refused send_prompt attempts out of aligned capture events', async ({ blueprintRun, replayOutDir }) => {
    const trace = parseProtocolTrace({
      orchestratorLog: [entry(0, '◀ harness prompt (phase=spec)', 'RECORDED BRIEF')].join(''),
      workerLogs: [],
    });
    const rewound = rewindPhaseState({
      recordState: blueprintRun,
      workflow: workflowFor(blueprintRun),
      phase: 'spec',
      outputDir: replayOutDir,
      trace,
      replayRunId: 'replay-spec',
    });
    rewound.state.rounds.spec = 99;
    saveRunState(rewound.state);
    const scripted = scriptedWorkersForTrace(rewound.state, trace, 'spec');
    const runTurn: RunOrchestratorTurn = async function* (ctx) {
      const send = ctx.tools.find((tool) => tool.name === 'send_prompt');
      const ask = ctx.tools.find((tool) => tool.name === 'ask_human');
      if (!send || !ask) throw new Error('missing replay tool');
      const refused = await send.handler({ duty: 'analyst', tag: 'review-spec', body: 'review anyway' }, {});
      expect.soft(refused.isError).toBe(true);
      await ask.handler({ question: 'review cap hit' }, {});
      yield success();
    };
    const { host, capture } = makeReplayHost({
      providers: scripted.providers,
      recordedBrief: 'RECORDED BRIEF',
      outputDir: replayOutDir,
      runTurn,
    });

    await expect(runHostedPhase({ cwd: rewound.state.cwd, runId: rewound.state.runId, phase: 'spec' }, host)).resolves.toEqual({
      type: 'phase.flag',
    });

    expect.soft(capture.events).toEqual([{ kind: 'terminal', verb: 'ask_human', body: 'review cap hit' }]);
    expect.soft(capture.refusedSends).toMatchObject([{ duty: ['analyst'], tag: 'review-spec', body: 'review anyway' }]);
    expect.soft(capture.notes[0]).toContain('send_prompt returned a tool error and was excluded from aligned replay sends');
  });
});

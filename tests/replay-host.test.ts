import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { runHostedPhase } from '../src/orchestrator/hosts/host-runner.ts';
import type { RunOrchestratorTurn } from '../src/orchestrator/hosts/driver.ts';
import { makeReplayHost } from '../src/replay/host.ts';
import { parseProtocolTrace } from '../src/replay/record.ts';
import { rewindPhaseState } from '../src/replay/phase-state.ts';
import { SCRIPT_EXHAUSTED_TEXT, scriptedWorkersForTrace } from '../src/replay/scripted-worker.ts';
import { loadRunState } from '../src/run/store.ts';
import { workflowFor } from '../src/run/workflow.ts';
import { test } from './helpers/fixtures.ts';

const stamp = (minute: number): string => `2026-07-07T10:${String(minute).padStart(2, '0')}:00.000Z`;
const entry = (minute: number, header: string, body?: string): string =>
  body === undefined ? `[${stamp(minute)}] ${header}\n` : `[${stamp(minute)}] ${header}\n${body}\n\n`;

const success = (): SDKMessage =>
  ({ type: 'result', subtype: 'success', session_id: 'replay-orchestrator-session', total_cost_usd: 0.01 }) as SDKMessage;

describe('scripted replay workers', () => {
  test('serve responses by duty ordinal and exhaust instead of matching prompt bodies', async ({ blueprintRun }) => {
    const trace = parseProtocolTrace({
      orchestratorLog: [entry(0, '◀ harness prompt (phase=design)', 'brief')].join(''),
      workerLogs: [
        {
          voice: 'analyst',
          log: [
            entry(1, '◀ prompt (tag=review-design, from orchestrator)', 'original prompt'),
            entry(2, '▶ response (session a1)', 'first response'),
          ].join(''),
        },
      ],
    });
    const scripted = scriptedWorkersForTrace(blueprintRun, trace, 'design');
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
  test('serves the recorded brief, captures tool calls, and isolates SDK home', async ({ blueprintRun }) => {
    const outDir = mkdtempSync(join(tmpdir(), 'duet-replay-'));
    try {
      const trace = parseProtocolTrace({
        orchestratorLog: [entry(0, '◀ harness prompt (phase=design)', 'RECORDED BRIEF')].join(''),
        workerLogs: [
          {
            voice: 'analyst',
            log: [
              entry(1, '◀ prompt (tag=review-design, from orchestrator)', 'original review'),
              entry(2, '▶ response (session analyst-1)', 'review response'),
            ].join(''),
          },
        ],
      });
      const rewound = rewindPhaseState({
        recordState: blueprintRun,
        workflow: workflowFor(blueprintRun),
        phase: 'design',
        outputDir: outDir,
        trace,
        replayRunId: 'replay-design',
      });
      const scripted = scriptedWorkersForTrace(rewound.state, trace, 'design');
      const seen: { prompt?: string; home?: string; resume?: string } = {};
      const runTurn: RunOrchestratorTurn = async function* (ctx) {
        seen.prompt = ctx.prompt;
        seen.home = ctx.options.env?.HOME;
        seen.resume = (ctx.options as { resume?: string }).resume;
        const task = ctx.tools.find((tool) => tool.name === 'get_task');
        const send = ctx.tools.find((tool) => tool.name === 'send_prompt');
        const advance = ctx.tools.find((tool) => tool.name === 'advance_phase');
        if (!task || !send || !advance) throw new Error('missing replay tool');
        const taskResult = await task.handler({}, {});
        expect.soft(taskResult.content[0]).toMatchObject({ type: 'text', text: 'RECORDED BRIEF' });
        await send.handler({ duty: 'analyst', tag: 'review-design', body: 'fresh review body' }, {});
        await advance.handler({ summary: 'fresh summary', artifacts: ['docs/design.md'], spec_path: 'docs/design.md' }, {});
        yield success();
      };
      const { host, capture } = makeReplayHost({
        providers: scripted.providers,
        recordedBrief: 'RECORDED BRIEF',
        outputDir: outDir,
        runTurn,
      });

      await expect(runHostedPhase({ cwd: rewound.state.cwd, runId: rewound.state.runId, phase: 'design' }, host)).resolves.toEqual({
        type: 'phase.advance',
      });

      expect.soft(seen.prompt).toBe('RECORDED BRIEF');
      expect.soft(seen.home).toBe(join(outDir, 'provider-home'));
      expect.soft(seen.resume).toBeUndefined();
      expect.soft(capture.events).toEqual([
        { kind: 'send_prompt', duty: ['analyst'], tag: 'review-design', body: 'fresh review body' },
        { kind: 'terminal', verb: 'advance_phase', body: 'fresh summary' },
      ]);
      expect.soft(loadRunState(rewound.state.cwd, rewound.state.runId).terminalMarker).toEqual({ phase: 'design', kind: 'advance' });
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

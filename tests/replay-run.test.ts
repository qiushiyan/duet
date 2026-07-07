import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import type { RunOrchestratorTurn } from '../src/orchestrator/hosts/driver.ts';
import { prepareReplayPhase, runReplayPhase } from '../src/replay/run.ts';
import { loadRunState, runDirOf, saveRunState } from '../src/run/store.ts';
import { workflowFor } from '../src/run/workflow.ts';
import { entry, snapshotTree, test } from './helpers/replay.ts';

const success = (): SDKMessage =>
  ({ type: 'result', subtype: 'success', session_id: 'fresh-replay-session', total_cost_usd: 0.01 }) as SDKMessage;

describe('replay phase kernel', () => {
  test('dry-run preparation parses the record, rewinds isolated state, and notes omitted mid-phase steers without invoking a turn', ({
    blueprintRun,
    replayOutDir,
  }) => {
    const recordDir = runDirOf(blueprintRun.cwd, blueprintRun.runId);
    writeFileSync(
      join(recordDir, 'orchestrator.log'),
      [
        entry(0, '◀ harness prompt (phase=design)', 'RECORDED BRIEF'),
        entry(1, 'human steer delivered (staged 2026-07-07T09:59:00.000Z)', 'tighten scope'),
        entry(9, 'advance_phase (design)', 'old summary'),
      ].join(''),
    );

    const prepared = prepareReplayPhase({
      record: { runDir: recordDir, state: blueprintRun, workflow: workflowFor(blueprintRun) },
      phase: 'design',
      outputDir: replayOutDir,
      replayRunId: 'dry-run-replay',
    });

    expect.soft(prepared.recordedBrief).toBe('RECORDED BRIEF');
    expect.soft(prepared.state.cwd).toBe(join(replayOutDir, 'workspace'));
    expect.soft(loadRunState(prepared.state.cwd, prepared.state.runId).orchestratorSessionId).toBeUndefined();
    expect.soft(prepared.reconstructionNotes).toContain('phase-entry state synthesized from terminal state.json');
    expect
      .soft(prepared.reconstructionNotes)
      .toContain('mid-phase steer staged 2026-07-07T09:59:00.000Z was recorded but not re-injected at its original tool-result boundary');
  });

  test('fake-turn replay writes reports under the output dir and leaves the record unchanged', async ({
    blueprintRun,
    replayOutDir,
    providerStoreSentinel,
  }) => {
    const recordDir = runDirOf(blueprintRun.cwd, blueprintRun.runId);
    blueprintRun.orchestratorSessionId = 'archived-orchestrator-session';
    blueprintRun.rounds.design = 1;
    blueprintRun.phaseSummaries.design = { summary: 'old summary', artifacts: ['docs/design.md'] };
    saveRunState(blueprintRun);
    writeFileSync(
      join(recordDir, 'orchestrator.log'),
      [entry(0, '◀ harness prompt (phase=design)', 'RECORDED BRIEF'), entry(9, 'advance_phase (design)', 'old summary')].join(''),
    );
    writeFileSync(
      join(recordDir, 'analyst.log'),
      [entry(1, '◀ prompt (tag=review-design, from orchestrator)', 'old review body'), entry(2, '▶ response (session analyst-1)', 'recorded review')].join(''),
    );
    const beforeRecord = snapshotTree(recordDir);
    const beforeProviderStore = snapshotTree(providerStoreSentinel);
    const seen: { prompt?: string; home?: string; claudeConfigDir?: string; claudeHome?: string; resume?: string; cwd?: string } = {};
    const runTurn: RunOrchestratorTurn = async function* (ctx) {
      seen.prompt = ctx.prompt;
      seen.home = ctx.options.env?.HOME;
      seen.claudeConfigDir = ctx.options.env?.CLAUDE_CONFIG_DIR;
      seen.claudeHome = ctx.options.env?.CLAUDE_HOME;
      seen.resume = (ctx.options as { resume?: string }).resume;
      seen.cwd = ctx.options.cwd;
      const task = ctx.tools.find((tool) => tool.name === 'get_task');
      const snippets = ctx.tools.find((tool) => tool.name === 'list_snippets');
      const send = ctx.tools.find((tool) => tool.name === 'send_prompt');
      const advance = ctx.tools.find((tool) => tool.name === 'advance_phase');
      if (!task || !snippets || !send || !advance) throw new Error('missing replay tool');
      await expect(task.handler({}, {})).resolves.toMatchObject({ content: [{ type: 'text', text: 'RECORDED BRIEF' }] });
      await snippets.handler({}, {});
      await send.handler({ duty: 'analyst', tag: 'review-design', body: 'fresh review body' }, {});
      await advance.handler({ summary: 'fresh summary', artifacts: ['docs/design.md'], spec_path: 'docs/design.md' }, {});
      yield success();
    };

    const result = await runReplayPhase({
      record: { runDir: recordDir, state: blueprintRun, workflow: workflowFor(blueprintRun) },
      phase: 'design',
      outputDir: replayOutDir,
      replayRunId: 'fake-replay',
      runTurn,
    });

    expect.soft(snapshotTree(recordDir)).toEqual(beforeRecord);
    expect.soft(snapshotTree(providerStoreSentinel)).toEqual(beforeProviderStore);
    expect.soft(seen.prompt).toBe('RECORDED BRIEF');
    expect.soft(seen.cwd).toBe(join(replayOutDir, 'workspace'));
    expect.soft(seen.home).toBe(join(replayOutDir, 'provider-home'));
    expect.soft(seen.claudeConfigDir).toBe(join(replayOutDir, 'provider-home', '.claude'));
    expect.soft(seen.claudeHome).toBe(join(replayOutDir, 'provider-home', '.claude'));
    expect.soft(seen.resume).toBeUndefined();
    expect.soft(result.outcome).toEqual({ type: 'phase.advance' });
    expect.soft(existsSync(result.textReportPath)).toBe(true);
    expect.soft(existsSync(result.jsonReportPath)).toBe(true);
    expect
      .soft(readFileSync(result.textReportPath, 'utf8'))
      .toContain('raw historical list_snippets tool output is not recorded; replay serves the current snippet library if list_snippets is called');
    expect.soft(result.report.freshRuns[0]?.diff.sends[0]?.adaptation).toMatchObject({
      originalBody: 'old review body',
      freshBody: 'fresh review body',
    });
    expect.soft(loadRunState(join(replayOutDir, 'workspace'), 'fake-replay').orchestratorSessionId).toBe('fresh-replay-session');
  });
});

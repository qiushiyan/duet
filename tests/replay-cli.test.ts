import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { runReplayPhaseCli } from '../scripts/corpus/replay-phase.ts';
import type { RunOrchestratorTurn } from '../src/orchestrator/hosts/driver.ts';
import { runDirOf } from '../src/run/store.ts';
import { workflowFor } from '../src/run/workflow.ts';
import { test } from './helpers/fixtures.ts';

const stamp = (minute: number): string => `2026-07-07T10:${String(minute).padStart(2, '0')}:00.000Z`;
const entry = (minute: number, header: string, body?: string): string =>
  body === undefined ? `[${stamp(minute)}] ${header}\n` : `[${stamp(minute)}] ${header}\n${body}\n\n`;

describe('scripts/corpus/replay-phase', () => {
  test('without --yes, prints the live-token gate and does not invoke the orchestrator turn', async ({ blueprintRun }) => {
    const outDir = mkdtempSync(join(tmpdir(), 'duet-replay-'));
    try {
      const recordDir = runDirOf(blueprintRun.cwd, blueprintRun.runId);
      const lines: string[] = [];
      let invoked = false;
      const runTurn: RunOrchestratorTurn = async function* () {
        invoked = true;
        throw new Error('should not run');
      };

      const result = await runReplayPhaseCli(
        ['--record', blueprintRun.runId, '--phase', 'design', '--out', outDir, '--json'],
        {
          runTurn,
          stdout: (line) => lines.push(line),
          loadRecords: () => ({
            records: [{ runDir: recordDir, state: blueprintRun, workflow: workflowFor(blueprintRun), source: 'corpus' }],
            skippedUnloadable: 0,
            skippedForeign: 0,
            source: 'corpus',
          }),
        },
      );

      expect.soft(result).toEqual({ gated: true });
      expect.soft(invoked).toBe(false);
      expect.soft(lines).toContain(`record: ${blueprintRun.runId}`);
      expect.soft(lines).toContain('phase: design');
      expect.soft(lines).toContain(`output: ${outDir}`);
      expect.soft(lines.join('\n')).toContain('fresh live orchestrator SDK session');
      expect.soft(lines.join('\n')).toContain('--yes');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('dry-run parses and rewinds without invoking the orchestrator turn', async ({ blueprintRun }) => {
    const outDir = mkdtempSync(join(tmpdir(), 'duet-replay-'));
    try {
      const recordDir = runDirOf(blueprintRun.cwd, blueprintRun.runId);
      writeFileSync(
        join(recordDir, 'orchestrator.log'),
        [
          entry(0, '◀ harness prompt (phase=design)', 'RECORDED BRIEF'),
          entry(1, 'human steer delivered (staged 2026-07-07T09:59:00.000Z)', 'tighten scope'),
        ].join(''),
      );
      const lines: string[] = [];
      let invoked = false;
      const runTurn: RunOrchestratorTurn = async function* () {
        invoked = true;
        throw new Error('should not run');
      };

      const result = await runReplayPhaseCli(
        ['--record', blueprintRun.runId, '--phase', 'design', '--out', outDir, '--dry-run', '--json'],
        {
          runTurn,
          stdout: (line) => lines.push(line),
          loadRecords: () => ({
            records: [{ runDir: recordDir, state: blueprintRun, workflow: workflowFor(blueprintRun), source: 'corpus' }],
            skippedUnloadable: 0,
            skippedForeign: 0,
            source: 'corpus',
          }),
        },
      );

      const parsed = JSON.parse(lines.join('\n'));
      expect.soft(result).toEqual({ dryRun: true });
      expect.soft(invoked).toBe(false);
      expect.soft(parsed.dryRun).toBe(true);
      expect.soft(parsed.replayRunDir).toContain(outDir);
      expect.soft(parsed.reconstructionNotes).toContain('phase-entry state synthesized from terminal state.json');
      expect
        .soft(parsed.reconstructionNotes)
        .toContain('mid-phase steer staged 2026-07-07T09:59:00.000Z was recorded but not re-injected at its original tool-result boundary');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

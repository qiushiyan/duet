import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { gradeCommand } from '../src/surfaces/grade.ts';
import { appendVoiceLog, loadRunState, runDirOf, saveRunState } from '../src/run/store.ts';
import { test } from './helpers/fixtures.ts';

function seedQuestionRun(run: Parameters<typeof saveRunState>[0]): void {
  run.gatesAt = ['spec'];
  run.phaseSummaries.spec = { summary: 'spec packet', artifacts: [] };
  saveRunState(run);
  appendVoiceLog(run, 'orchestrator', '◀ harness prompt (phase=spec)', 'brief');
  appendVoiceLog(run, 'orchestrator', 'ask_human queued', 'Should this stop?');
  appendVoiceLog(run, 'orchestrator', 'advance_phase (spec)', 'spec packet');
}

describe('gradeCommand', () => {
  test('lists decision points as JSON without recording grades', async ({ projectDir, run }) => {
    seedQuestionRun(run);

    const result = await gradeCommand(projectDir, run.runId, { list: true, json: true }, { isTTY: false });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = JSON.parse(result.output) as { points: Array<{ key: string }>; grades: unknown[] };
    expect.soft(body.points.map((p) => p.key)).toEqual(['question:spec:0', 'gate:spec:0']);
    expect.soft(body.grades).toEqual([]);
    expect.soft(loadRunState(projectDir, run.runId).grades).toBeUndefined();
  });

  test('records non-TTY set, note with colons, and idempotent missed-stop updates', async ({ projectDir, run }) => {
    seedQuestionRun(run);

    const first = await gradeCommand(
      projectDir,
      run.runId,
      {
        set: ['question:spec:0=right'],
        note: ['question:spec:0=kept: colon context'],
        missed: ['implement:auth=should have stopped: auth scope'],
      },
      { isTTY: false, now: () => new Date('2026-07-07T11:00:00.000Z') },
    );
    expect(first.ok).toBe(true);

    const second = await gradeCommand(
      projectDir,
      run.runId,
      {
        set: ['question:spec:0=wrong'],
        missed: ['implement:auth=revised missed stop', 'implement:docs=docs should have stopped'],
      },
      { isTTY: false, now: () => new Date('2026-07-07T11:05:00.000Z') },
    );
    expect(second.ok).toBe(true);

    const grades = loadRunState(projectDir, run.runId).grades ?? [];
    expect.soft(grades).toHaveLength(3);
    expect.soft(grades.find((g) => g.key === 'question:spec:0')).toMatchObject({
      verdict: 'wrong',
      note: 'kept: colon context',
    });
    expect.soft(grades.find((g) => g.key === 'missed:implement:auth')).toMatchObject({
      verdict: 'wrong',
      note: 'revised missed stop',
    });
    expect.soft(grades.find((g) => g.key === 'missed:implement:docs')).toMatchObject({
      verdict: 'wrong',
      note: 'docs should have stopped',
    });
  });

  test('refuses writes while a live driver owns the run, but --list remains read-only', async ({ projectDir, run, onTestFinished }) => {
    seedQuestionRun(run);
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    onTestFinished(() => {
      child.kill();
    });
    writeFileSync(join(runDirOf(projectDir, run.runId), 'driver.pid'), `${child.pid}\n`);

    const write = await gradeCommand(projectDir, run.runId, { set: ['question:spec:0=right'] }, { isTTY: false });
    const list = await gradeCommand(projectDir, run.runId, { list: true }, { isTTY: false });

    expect.soft(write.ok).toBe(false);
    if (!write.ok) expect.soft(write.error).toContain('actively running');
    expect.soft(list.ok).toBe(true);
    expect.soft(loadRunState(projectDir, run.runId).grades).toBeUndefined();
  });

  test('writing the first grade adds the ledger without disturbing unrelated state', async ({ projectDir, run }) => {
    seedQuestionRun(run);
    const before = JSON.parse(readFileSync(join(runDirOf(projectDir, run.runId), 'state.json'), 'utf8')) as { grades?: unknown; phaseSummaries: unknown };

    await gradeCommand(projectDir, run.runId, { set: ['gate:spec:0=right'] }, { isTTY: false });

    const after = JSON.parse(readFileSync(join(runDirOf(projectDir, run.runId), 'state.json'), 'utf8')) as { grades?: unknown[]; phaseSummaries: unknown };
    expect.soft(before.grades).toBeUndefined();
    expect.soft(after.grades).toHaveLength(1);
    expect.soft(after.phaseSummaries).toEqual(before.phaseSummaries);
  });
});

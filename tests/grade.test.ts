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

/** A run carrying a stopped gate, an auto-crossed gate, and a held-high gate. */
function seedMixedRun(run: Parameters<typeof saveRunState>[0]): void {
  run.gatesAt = ['spec'];
  run.autoApprovals = [{ gate: 'plan', at: '2026-07-07T10:05:00.000Z' }];
  run.phaseSummaries.spec = { summary: 'spec approved', artifacts: ['docs/spec.md'] };
  run.phaseSummaries.plan = { summary: 'plan packet', artifacts: [] };
  run.phaseSummaries.implement = {
    summary: 'ship packet',
    artifacts: ['src/app.ts'],
    humanDecisions: [{ title: 'accept residual auth risk', severity: 'high' }],
  };
  saveRunState(run);
  appendVoiceLog(run, 'orchestrator', '◀ harness prompt (phase=spec)', 'brief');
  appendVoiceLog(run, 'orchestrator', 'advance_phase (spec)', 'spec approved');
  appendVoiceLog(run, 'orchestrator', '◀ harness prompt (phase=implement)', 'brief');
  appendVoiceLog(run, 'orchestrator', 'advance_phase (implement)', 'ship packet');
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

  test('the interactive walkthrough presents each point’s context and polarity-aware question before the verdict', async ({ projectDir, run }) => {
    seedMixedRun(run);
    const prompts: string[] = [];
    // right for the stopped points, right for the auto-cross, no notes.
    const answers = ['right', '', 'right', '', 'right', ''];
    let i = 0;
    const io = {
      isTTY: true,
      ask: async (p: string) => {
        prompts.push(p);
        return answers[i++] ?? '';
      },
      now: () => new Date('2026-07-07T12:00:00.000Z'),
    };

    const result = await gradeCommand(projectDir, run.runId, {}, io);
    expect(result.ok).toBe(true);

    const shown = prompts.join('\n');
    // Context rides the prompt, so a point is judgeable without --list --json:
    // a held gate's hold finding and the packet summary both appear inline.
    // (Classification itself is decision-points.test.ts's to prove.)
    expect.soft(shown).toContain('accept residual auth risk');
    expect.soft(shown).toContain('spec approved');
    // The verdict question is phrased by polarity (design §"The walkthrough").
    expect.soft(shown).toMatch(/stopping here/);
    expect.soft(shown).toMatch(/have stopped you/);

    // One verdict question per seeded point (spec stop, plan auto-cross, implement hold)…
    const verdictPrompts = prompts.filter((p) => /stopping here|have stopped you/.test(p));
    expect.soft(verdictPrompts).toHaveLength(3);
    // …and each answered verdict lands in the ledger under a stable structural key.
    const grades = loadRunState(projectDir, run.runId).grades ?? [];
    expect.soft(grades).toHaveLength(3);
    expect.soft(grades.find((g) => g.key === 'gate:spec:0')).toMatchObject({ verdict: 'right' });
  });

  test('a missing orchestrator log surfaces its coverage note on the write path, not only on --list', async ({ projectDir, run }) => {
    run.gatesAt = [];
    run.autoApprovals = [{ gate: 'plan', at: '2026-07-07T10:05:00.000Z' }];
    run.phaseSummaries.plan = { summary: 'plan packet', artifacts: [] };
    saveRunState(run);
    // No orchestrator.log written — discovery degrades to state-sourced points + a note.

    const result = await gradeCommand(projectDir, run.runId, { set: ['gate:plan:0=right'] }, { isTTY: false });

    expect.soft(result.ok).toBe(true);
    if (result.ok) expect.soft(result.output).toContain('orchestrator log missing');
    expect.soft(loadRunState(projectDir, run.runId).grades).toHaveLength(1);
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

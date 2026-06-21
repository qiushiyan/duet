import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import type { Snapshot } from 'xstate';
import { DEFAULT_BINDINGS } from '../src/config.ts';
import {
  consumeHumanInput,
  createRun,
  gateAttended,
  listPendingSteers,
  listRuns,
  loadMachineSnapshot,
  loadRunState,
  markSteersDelivered,
  runDirOf,
  saveMachineSnapshot,
  saveRunState,
  stageHumanInput,
  stageSteer,
  workflowOf,
} from '../src/run-store.ts';
import { test } from './helpers/fixtures.ts';

describe('run creation', () => {
  test('a created run round-trips through load', ({ projectDir, run }) => {
    const loaded = loadRunState(projectDir, run.runId);
    expect(loaded).toEqual(run);
  });

  test('the run dir is self-contained: state, framing archive, notes', ({ projectDir, run }) => {
    const dir = runDirOf(projectDir, run.runId);
    expect.soft(existsSync(join(dir, 'state.json'))).toBe(true);
    expect.soft(readFileSync(join(dir, 'framing.md'), 'utf8')).toBe('test framing');
    expect.soft(readFileSync(join(dir, 'notes.md'), 'utf8')).toContain('run created');
  });

  test('the framing archive prefers the verbatim file over the stripped body', ({ projectDir }) => {
    const run = createRun({
      cwd: projectDir,
      bindings: DEFAULT_BINDINGS,
      framing: 'body only',
      framingRaw: '---\ngates_at: frame\n---\n\nbody only',
    });
    const archived = readFileSync(join(runDirOf(projectDir, run.runId), 'framing.md'), 'utf8');
    expect(archived).toContain('gates_at: frame');
  });

  test('.duet self-ignores without touching the project gitignore', ({ projectDir, run }) => {
    expect(run.cwd).toBe(projectDir); // the run fixture created .duet here
    expect(readFileSync(join(projectDir, '.duet', '.gitignore'), 'utf8')).toBe('*\n');
    expect(existsSync(join(projectDir, '.gitignore'))).toBe(false);
  });

  test('loading an unknown run names the path and the likely mistake', ({ projectDir }) => {
    expect(() => loadRunState(projectDir, 'nope')).toThrow(/is nope a run of this project/);
  });
});

describe('persistence', () => {
  test('saves leave no temp debris behind (atomic write)', ({ projectDir, run }) => {
    run.lastActivity = 'something';
    saveRunState(run);
    const files = readdirSync(runDirOf(projectDir, run.runId));
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(loadRunState(projectDir, run.runId).lastActivity).toBe('something');
  });

  test('machine snapshots round-trip', ({ run }) => {
    const snapshot: Snapshot<unknown> = { status: 'active', output: undefined, error: undefined };
    expect(loadMachineSnapshot(run)).toBeUndefined();
    saveMachineSnapshot(run, snapshot);
    expect(loadMachineSnapshot(run)).toEqual(snapshot);
  });
});

describe('the human-input handshake', () => {
  test('staged input survives a process boundary and is consumed exactly once', ({ projectDir, run }) => {
    stageHumanInput(run, { kind: 'feedback', text: 'tighten the scope' });

    // The driver runs in another process: it loads its own copy.
    const driverCopy = loadRunState(projectDir, run.runId);
    expect(consumeHumanInput(driverCopy)).toEqual({ kind: 'feedback', text: 'tighten the scope' });

    // A crashed-and-retried invocation must not replay the input.
    const retryCopy = loadRunState(projectDir, run.runId);
    expect(consumeHumanInput(retryCopy)).toBeUndefined();
  });

  test('consuming an answer clears the question it answers', ({ projectDir, run }) => {
    run.pendingQuestion = { question: 'which migration?' };
    stageHumanInput(run, { kind: 'answer', text: 'the latest one' });

    const driverCopy = loadRunState(projectDir, run.runId);
    consumeHumanInput(driverCopy);
    expect(driverCopy.pendingQuestion).toBeUndefined();
    expect(loadRunState(projectDir, run.runId).pendingQuestion).toBeUndefined();
  });

  test('consuming feedback leaves an unrelated pending question in place', ({ projectDir, run }) => {
    run.pendingQuestion = { question: 'still open' };
    stageHumanInput(run, { kind: 'feedback', text: 'gate feedback' });

    const driverCopy = loadRunState(projectDir, run.runId);
    consumeHumanInput(driverCopy);
    expect(driverCopy.pendingQuestion).toEqual({ question: 'still open' });
  });
});

describe('the steer store', () => {
  test('staging creates one file per steer, listed in staging order with verbatim text', ({ run }) => {
    stageSteer(run, 'drop the retry tests', 'impl');
    stageSteer(run, 'and keep the fixture name');

    const pending = listPendingSteers(run);
    expect(pending).toHaveLength(2);
    expect.soft(pending[0]?.text).toBe('drop the retry tests');
    expect.soft(pending[0]?.stagedDuring).toBe('impl');
    expect.soft(pending[0]?.stagedAt).toBeTruthy();
    expect.soft(pending[1]?.text).toBe('and keep the fixture name');
    expect.soft(pending[1]?.stagedDuring).toBeUndefined();
  });

  test('a second process copy staging concurrently appends without clobbering (file-per-steer)', ({
    projectDir,
    run,
  }) => {
    stageSteer(run, 'from the driver-side copy');
    const cliCopy = loadRunState(projectDir, run.runId);
    stageSteer(cliCopy, 'from the CLI');

    expect(listPendingSteers(run).map((s) => s.text)).toEqual(['from the driver-side copy', 'from the CLI']);
  });

  test('marking delivered removes steers from the pending list but keeps the files (audit trail)', ({
    projectDir,
    run,
  }) => {
    const steer = stageSteer(run, 'one note');
    markSteersDelivered(run, [steer]);

    expect.soft(listPendingSteers(run)).toEqual([]);
    const delivered = join(runDirOf(projectDir, run.runId), 'steers', 'delivered', steer.file);
    expect.soft(readFileSync(delivered, 'utf8')).toContain('one note');
  });

  test('marking an already-delivered steer is a no-op (a parallel drain won the race)', ({ run }) => {
    const steer = stageSteer(run, 'raced note');
    markSteersDelivered(run, [steer]);
    expect(() => markSteersDelivered(run, [steer])).not.toThrow();
  });

  test('staging lands in the orchestrator voice log', ({ projectDir, run }) => {
    stageSteer(run, 'drop the retry tests', 'impl');
    const log = readFileSync(join(runDirOf(projectDir, run.runId), 'orchestrator.log'), 'utf8');
    expect.soft(log).toContain('human steer staged (during impl)');
    expect.soft(log).toContain('drop the retry tests');
  });
});

describe('gate attendance', () => {
  test('absent gates_at means every gate is attended', ({ run }) => {
    expect(gateAttended(run, 'frame')).toBe(true);
    expect(gateAttended(run, 'impl')).toBe(true);
  });

  test('listed phases are attended, unlisted are pre-authorized, pr is unconditional', ({ run }) => {
    run.gatesAt = ['frame', 'spec', 'pr'];
    expect.soft(gateAttended(run, 'frame')).toBe(true);
    expect.soft(gateAttended(run, 'plan')).toBe(false);
    expect.soft(gateAttended(run, 'impl')).toBe(false);
    expect.soft(gateAttended(run, 'pr')).toBe(true);

    run.gatesAt = ['frame'];
    expect(gateAttended(run, 'pr')).toBe(true);
  });

  test('pr stays force-attended through forceAttend even when gates_at excludes it', ({ run }) => {
    // The pr unconditional above now flows through WORKFLOWS.full.forceAttend,
    // not a hardcoded phase check — a gates_at that omits pr still attends it.
    run.gatesAt = ['frame', 'spec'];
    expect(gateAttended(run, 'pr')).toBe(true);
  });
});

describe('workflow identity', () => {
  test('a created run defaults to the full workflow', ({ run }) => {
    expect(workflowOf(run)).toBe('full');
  });

  test('a state with no workflow field (pre-feature) resolves to full', ({ run }) => {
    delete run.workflow;
    expect(workflowOf(run)).toBe('full');
  });

  test('createRun persists an explicit workflow', ({ projectDir }) => {
    const created = createRun({ cwd: projectDir, bindings: DEFAULT_BINDINGS, workflow: 'full', framing: 'f' });
    expect(created.workflow).toBe('full');
    expect(loadRunState(projectDir, created.runId).workflow).toBe('full');
  });
});

describe('run listing', () => {
  test('lists newest first and skips non-run directories', ({ projectDir, run }) => {
    mkdirSync(join(projectDir, '.duet', 'runs', 'junk'));
    writeFileSync(join(projectDir, '.duet', 'runs', 'junk-file'), 'not a dir');

    const newer = createRun({ cwd: projectDir, bindings: DEFAULT_BINDINGS });
    newer.createdAt = new Date(Date.now() + 60_000).toISOString();
    saveRunState(newer);

    expect(listRuns(projectDir).map((r) => r.runId)).toEqual([newer.runId, run.runId]);
  });
});

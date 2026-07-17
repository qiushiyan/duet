import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { reconcileRecord, transcriptArchiveDir } from '../src/run/corpus.ts';
import { createRun, loadRunState, runDirOf } from '../src/run/store.ts';
import { defaultBindingsFor } from '../src/voices/bindings.ts';
import { test as base } from './helpers/fixtures.ts';

/**
 * The corpus contract under test is FAIL-SOFT (docs/corpus-runbook.md): a
 * corpus write must never affect a run, and absent config is byte-for-byte
 * off. The corpus root is a real second tmpdir — the archive lives outside
 * the project it mirrors.
 */
const test = base.extend<{ corpusRoot: string }>({
  corpusRoot: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'greenflag-corpus-'));
    await use(dir);
    rmSync(dir, { recursive: true, force: true });
  },
});

describe('reconcileRecord — the quiescence re-sync', () => {
  test('mirrors the run dir\'s CURRENT included files; excludes scratch and strays; preserves the transcript archive', ({ projectDir, corpusRoot }) => {
    const run = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full'), framing: 'original framing', corpusRoot });
    const runDir = runDirOf(projectDir, run.runId);
    // Drift the local dir past what append-through mirrored at creation —
    // direct fs writes, so nothing below reaches the record before the sweep.
    writeFileSync(join(runDir, 'framing.md'), 'edited after creation');
    writeFileSync(join(runDir, 'driver.log'), 'driver line\n');
    run.lastActivity = 'drifted';
    writeFileSync(join(runDir, 'state.json'), JSON.stringify(run, null, 2));
    writeFileSync(join(runDir, 'stray.txt'), 'not an included artifact');
    writeFileSync(join(runDir, 'scratch', 'wip.md'), 'live mechanics');
    // The transcript archive is owned by the voices layer; the sweep must keep it.
    writeFileSync(join(transcriptArchiveDir(run)!, 'builder.s1.jsonl.gz'), 'gz bytes');

    reconcileRecord(run);

    expect.soft(readFileSync(join(run.corpusDir!, 'framing.md'), 'utf8')).toBe('edited after creation');
    expect.soft(readFileSync(join(run.corpusDir!, 'driver.log'), 'utf8')).toBe('driver line\n');
    expect.soft(JSON.parse(readFileSync(join(run.corpusDir!, 'state.json'), 'utf8')).lastActivity).toBe('drifted');
    expect.soft(existsSync(join(run.corpusDir!, 'stray.txt'))).toBe(false); // not an included artifact
    expect.soft(existsSync(join(run.corpusDir!, 'scratch'))).toBe(false); // live mechanics stay local
    expect.soft(readFileSync(join(run.corpusDir!, 'transcripts', 'builder.s1.jsonl.gz'), 'utf8')).toBe('gz bytes');
  });

  test('replaces the record\'s steers with the live run\'s — a consumed steer does not linger — without touching the live steers', ({ projectDir, corpusRoot }) => {
    const run = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full'), corpusRoot });
    const localSteers = join(runDirOf(projectDir, run.runId), 'steers');
    mkdirSync(localSteers, { recursive: true });
    writeFileSync(join(localSteers, 'a.md'), 'steer a');
    writeFileSync(join(localSteers, 'b.md'), 'steer b');
    reconcileRecord(run);
    expect.soft(readdirSync(join(run.corpusDir!, 'steers')).sort()).toEqual(['a.md', 'b.md']);

    // a.md is consumed locally; the record grows a stale file of its own.
    rmSync(join(localSteers, 'a.md'));
    writeFileSync(join(run.corpusDir!, 'steers', 'stale.md'), 'only in the record');
    reconcileRecord(run);

    expect.soft(readdirSync(join(run.corpusDir!, 'steers'))).toEqual(['b.md']); // replaced, not merged
    // The destructive step is record-side only: the live run's steers are untouched.
    expect.soft(readdirSync(localSteers)).toEqual(['b.md']);
    expect.soft(readFileSync(join(localSteers, 'b.md'), 'utf8')).toBe('steer b');
  });

  test('fail-soft: a corpusDir pointing at a plain FILE neither throws nor corrupts the run dir', ({ projectDir, corpusRoot }) => {
    const run = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full'), framing: 'kept', corpusRoot });
    const localSteers = join(runDirOf(projectDir, run.runId), 'steers');
    mkdirSync(localSteers, { recursive: true });
    writeFileSync(join(localSteers, 'a.md'), 'steer a');
    const blocker = join(corpusRoot, 'blocker');
    writeFileSync(blocker, 'a file, not a dir');
    run.corpusDir = blocker; // the record path is unusable — mkdir fails portably

    expect(() => reconcileRecord(run)).not.toThrow();

    expect.soft(readFileSync(blocker, 'utf8')).toBe('a file, not a dir'); // not clobbered into a record
    // The run dir is intact and still loads — the local dir stays the working truth.
    expect.soft(readFileSync(join(localSteers, 'a.md'), 'utf8')).toBe('steer a');
    expect.soft(readFileSync(join(runDirOf(projectDir, run.runId), 'framing.md'), 'utf8')).toBe('kept');
    expect.soft(loadRunState(projectDir, run.runId).runId).toBe(run.runId);
  });

  test('no corpusDir on state — a no-op: nothing thrown, nothing created', ({ projectDir, corpusRoot }) => {
    const run = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full') });
    expect(run.corpusDir).toBeUndefined();
    const before = readdirSync(runDirOf(projectDir, run.runId)).sort();

    expect(() => reconcileRecord(run)).not.toThrow();

    expect.soft(readdirSync(runDirOf(projectDir, run.runId)).sort()).toEqual(before); // run dir untouched
    expect.soft(readdirSync(corpusRoot)).toEqual([]); // absent config is byte-for-byte off
  });
});

describe('transcriptArchiveDir — the record\'s transcript slot', () => {
  test('returns <record>/transcripts, created on demand and stable across calls', ({ projectDir, corpusRoot }) => {
    const run = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full'), corpusRoot });
    expect(existsSync(join(run.corpusDir!, 'transcripts'))).toBe(false); // not pre-created

    const dir = transcriptArchiveDir(run);
    expect.soft(dir).toBe(join(run.corpusDir!, 'transcripts'));
    expect.soft(existsSync(dir!)).toBe(true);
    expect.soft(transcriptArchiveDir(run)).toBe(dir); // capture-adjacent derivation never moves
  });

  test('returns undefined without a corpusDir, and fail-soft undefined when the record cannot be created', ({ projectDir, corpusRoot }) => {
    const run = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full') });
    expect.soft(transcriptArchiveDir(run)).toBeUndefined();

    const blocker = join(corpusRoot, 'blocker');
    writeFileSync(blocker, 'a file, not a dir');
    run.corpusDir = blocker;
    expect.soft(transcriptArchiveDir(run)).toBeUndefined(); // never a throw into the capture path
    expect.soft(readFileSync(blocker, 'utf8')).toBe('a file, not a dir');
  });
});

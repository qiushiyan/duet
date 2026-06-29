import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { loadRunState, runDirOf } from '../src/run-store.ts';
import { listPendingSteers, markSteersDelivered, stageSteer } from '../src/steer-store.ts';
import { test } from './helpers/fixtures.ts';

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
    // The audit contract is the human's verbatim text plus the provenance phase —
    // not the exact log sentence, which is free to reword.
    expect.soft(log).toContain('drop the retry tests');
    expect.soft(log).toMatch(/impl/);
  });
});

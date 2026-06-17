import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect } from 'vitest';
import { aliveDriverPid, driveToQuiescence, killDriver, probeRunPosition } from '../src/harness/lifecycle.ts';
import type { DriverOutput } from '../src/harness/driver.ts';
import { loadRunState, markAbandoned, purgeRun, runDirOf, saveRunState } from '../src/run-store.ts';
import { locateSessionTranscripts } from '../src/sessions.ts';
import { buildStatusModel, renderStatus, steerRefusal } from '../src/status.ts';
import { test } from './helpers/fixtures.ts';
import { scriptedMachine } from './helpers/scripted-machine.ts';

/**
 * `duet abandon` — stop a run for good. Two separable effects: kill the live
 * driver (always), and (with --purge) delete the run dir and the providers'
 * session transcripts. The marker keeps a deliberate stop from reading as a
 * crash, and abandonment stays reversible (the transcripts are kept).
 */

const advanced: DriverOutput = { outcome: 'advanced' };
const quiet = async () => {};

/** A throwaway $HOME with the providers' transcript dirs laid out. */
function fakeHome(): string {
  return mkdtempSync(join(tmpdir(), 'duet-home-'));
}
function writeClaudeTranscript(home: string, projectDir: string, sessionId: string): string {
  const dir = join(home, '.claude', 'projects', projectDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, '{"type":"summary"}\n');
  return path;
}
function writeCodexRollout(home: string, sessionId: string): string {
  const dir = join(home, '.codex', 'sessions', '2026', '06', '17');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-06-17T09-00-00-${sessionId}.jsonl`);
  writeFileSync(path, '{"type":"session_meta"}\n');
  return path;
}

const homes: string[] = [];
afterEach(() => {
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});
function home(): string {
  const h = fakeHome();
  homes.push(h);
  return h;
}

describe('locateSessionTranscripts', () => {
  test('finds a claude session by its exact id, ignoring others', () => {
    const h = home();
    const wanted = writeClaudeTranscript(h, '-Users-me-proj', 'abc-123');
    writeClaudeTranscript(h, '-Users-me-proj', 'other-999');
    expect.soft(locateSessionTranscripts('claude', 'abc-123', h)).toEqual([wanted]);
    expect.soft(locateSessionTranscripts('claude', 'missing', h)).toEqual([]);
  });

  test('finds a codex rollout by its id suffix, ignoring others', () => {
    const h = home();
    const wanted = writeCodexRollout(h, 'rev-555');
    writeCodexRollout(h, 'rev-777');
    expect.soft(locateSessionTranscripts('codex', 'rev-555', h)).toEqual([wanted]);
    expect.soft(locateSessionTranscripts('codex', 'nope', h)).toEqual([]);
  });

  test('a missing provider root is empty, not an error', () => {
    expect(locateSessionTranscripts('claude', 'x', join(tmpdir(), 'does-not-exist-xyz'))).toEqual([]);
  });
});

describe('markAbandoned + probeRunPosition', () => {
  test('a deliberate abandon reads as abandoned, never as a crash', ({ projectDir, run }) => {
    markAbandoned(run);
    expect.soft(loadRunState(projectDir, run.runId).abandoned?.at).toBeTruthy();
    expect.soft(probeRunPosition(loadRunState(projectDir, run.runId))).toEqual({ kind: 'abandoned' });
  });

  test('the marker wins over a parked gate snapshot, and clearing it revives the underlying stop', async ({
    projectDir,
    run,
  }) => {
    // Park the run at the direction gate, then abandon it.
    await driveToQuiescence(run, undefined, { machine: scriptedMachine([advanced]).machine, notify: quiet });
    const parked = loadRunState(projectDir, run.runId);
    expect.soft(probeRunPosition(parked)).toEqual({ kind: 'gate', phase: 'frame' });

    markAbandoned(parked);
    expect.soft(probeRunPosition(loadRunState(projectDir, run.runId))).toEqual({ kind: 'abandoned' });

    // Reviving (what `duet continue` does) clears the marker — the parked gate
    // re-derives from the snapshot that was kept all along.
    const revived = loadRunState(projectDir, run.runId);
    delete revived.abandoned;
    saveRunState(revived);
    expect.soft(probeRunPosition(loadRunState(projectDir, run.runId))).toEqual({ kind: 'gate', phase: 'frame' });
  });
});

describe('killDriver', () => {
  test('stops a live driver and reports its pid', async ({ projectDir, run, onTestFinished }) => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    onTestFinished(() => {
      child.kill();
    });
    writeFileSync(join(runDirOf(projectDir, run.runId), 'driver.pid'), `${child.pid}\n`);

    const killed = await killDriver(loadRunState(projectDir, run.runId), { graceMs: 3000, pollMs: 20 });
    expect.soft(killed).toBe(child.pid);
    expect.soft(aliveDriverPid(loadRunState(projectDir, run.runId))).toBeUndefined();
  });

  test('is a no-op when no driver is running', async ({ run }) => {
    expect(await killDriver(run)).toBeUndefined();
  });
});

describe('purgeRun', () => {
  test('removes the run dir and every bound session transcript, leaving unrelated ones', ({ projectDir, run }) => {
    const h = home();
    // Default bindings: orchestrator + implementer on claude, reviewer on codex.
    const orch = writeClaudeTranscript(h, '-proj', 'orch-1');
    const impl = writeClaudeTranscript(h, '-proj', 'impl-2');
    const rev = writeCodexRollout(h, 'rev-3');
    const bystanderClaude = writeClaudeTranscript(h, '-proj', 'someone-else');
    const bystanderCodex = writeCodexRollout(h, 'unrelated');

    run.orchestratorSessionId = 'orch-1';
    run.workerSessions = { implementer: 'impl-2', reviewer: 'rev-3' };
    saveRunState(run);

    const result = purgeRun(loadRunState(projectDir, run.runId), h);

    expect.soft(result.runDir).toBe(runDirOf(projectDir, run.runId));
    expect.soft(new Set(result.transcripts)).toEqual(new Set([orch, impl, rev]));
    expect.soft(existsSync(runDirOf(projectDir, run.runId))).toBe(false);
    for (const gone of [orch, impl, rev]) expect.soft(existsSync(gone)).toBe(false);
    for (const kept of [bystanderClaude, bystanderCodex]) expect.soft(existsSync(kept)).toBe(true);
  });

  test('a run with no sessions yet still removes its dir, reporting no transcripts', ({ projectDir, run }) => {
    const result = purgeRun(loadRunState(projectDir, run.runId), home());
    expect.soft(result.transcripts).toEqual([]);
    expect.soft(existsSync(runDirOf(projectDir, run.runId))).toBe(false);
  });
});

describe('status at an abandoned / done stop', () => {
  const render = (run: Parameters<typeof buildStatusModel>[0]) =>
    renderStatus(buildStatusModel(run, { kind: 'abandoned' }, []));

  test('the abandoned stop model carries the revive and purge commands', ({ run }) => {
    run.abandoned = { at: '2026-06-17T09:00:00.000Z' };
    const model = buildStatusModel(run, { kind: 'abandoned' }, []);
    expect.soft(model.stop).toMatchObject({
      kind: 'abandoned',
      at: '2026-06-17T09:00:00.000Z',
      revive: `duet continue ${run.runId}`,
      purge: `duet abandon ${run.runId} --purge`,
    });
    const text = render(run);
    expect.soft(text).toContain('abandoned');
    expect.soft(text).toContain(`duet continue ${run.runId}`);
    expect.soft(text).toContain(`duet abandon ${run.runId} --purge`);
  });

  test('steering an abandoned run is refused toward revive/new', ({ run }) => {
    const copy = steerRefusal({ kind: 'abandoned' }, run.runId);
    expect.soft(copy).toContain('abandoned');
    expect.soft(copy).toContain(`duet continue ${run.runId}`);
  });

  test('a done run points at GitHub merge and the purge cleanup', ({ run }) => {
    const text = renderStatus(buildStatusModel(run, { kind: 'done' }, []));
    expect.soft(text).toContain('merge the PR on GitHub');
    expect.soft(text).toContain(`duet abandon ${run.runId} --purge`);
  });
});

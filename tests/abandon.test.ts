import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect } from 'vitest';
import { driveToQuiescence, killDriver } from '../src/surfaces/lifecycle.ts';
import { aliveDriverPid, probeRunPosition } from '../src/run/position.ts';
import type { PhaseEvent } from '../src/run/phase-events.ts';
import { loadRunState, markAbandoned, runDirOf, saveRunState } from '../src/run/store.ts';
import { captureRunTranscripts, purgeRun } from '../src/voices/sessions.ts';
import { locateSessionTranscripts } from '../src/voices/sessions.ts';
import { test } from './helpers/fixtures.ts';
import { scriptedMachine } from './helpers/scripted-machine.ts';

/**
 * `greenflag abandon` — stop a run for good. Two separable effects: kill the live
 * driver (always), and (with --purge) delete the run dir and the providers'
 * session transcripts. The marker keeps a deliberate stop from reading as a
 * crash, and abandonment stays reversible (the transcripts are kept).
 */

const advanced: PhaseEvent = { type: 'phase.advance' };
const quiet = async () => {};

/** A throwaway $HOME with the providers' transcript dirs laid out. */
function fakeHome(): string {
  return mkdtempSync(join(tmpdir(), 'greenflag-home-'));
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

    // Reviving (what `greenflag continue` does) clears the marker — the parked gate
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

  test('escalates to SIGKILL when the driver traps SIGTERM past the grace', async ({ projectDir, run, onTestFinished }) => {
    // A driver that ignores the polite signal and lingers — only the
    // uncatchable escalation ends it. "armed" on stdout proves the trap is
    // installed before killDriver signals (else the default SIGTERM action
    // would win the race and the test would pass without escalating).
    const child = spawn(
      process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); console.log("armed"); setInterval(() => {}, 1000)'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    onTestFinished(() => {
      child.kill('SIGKILL');
    });
    await new Promise((resolve) => child.stdout!.once('data', resolve));
    writeFileSync(join(runDirOf(projectDir, run.runId), 'driver.pid'), `${child.pid}\n`);
    const exitSignal = new Promise((resolve) => child.once('exit', (_code, signal) => resolve(signal)));

    const killed = await killDriver(loadRunState(projectDir, run.runId), { graceMs: 300, pollMs: 50 });

    expect.soft(killed).toBe(child.pid);
    expect.soft(await exitSignal).toBe('SIGKILL'); // SIGTERM was trapped; the escalation ended it
    expect.soft(aliveDriverPid(loadRunState(projectDir, run.runId))).toBeUndefined();
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
    run.sessions = { 'planning.architect': { provider: 'claude', id: 'impl-2' }, 'planning.analyst': { provider: 'codex', id: 'rev-3' } };
    saveRunState(run);

    const result = purgeRun(loadRunState(projectDir, run.runId), h);

    expect.soft(result.runDir).toBe(runDirOf(projectDir, run.runId));
    expect.soft(new Set(result.transcripts)).toEqual(new Set([orch, impl, rev]));
    expect.soft(existsSync(runDirOf(projectDir, run.runId))).toBe(false);
    for (const gone of [orch, impl, rev]) expect.soft(existsSync(gone)).toBe(false);
    for (const kept of [bystanderClaude, bystanderCodex]) expect.soft(existsSync(kept)).toBe(true);
  });

  test('captures tracked transcripts into the corpus before deleting them, gzip-only', ({ projectDir, run }) => {
    const h = home();
    const corpusDir = join(projectDir, 'corpus', run.runId);
    const orch = writeClaudeTranscript(h, '-proj', 'orch-1');
    const impl = writeClaudeTranscript(h, '-proj', 'impl-2');
    run.corpusDir = corpusDir;
    run.orchestratorSessionId = 'orch-1';
    run.sessions = { 'planning.architect': { provider: 'claude', id: 'impl-2' } };
    saveRunState(run);

    const result = purgeRun(loadRunState(projectDir, run.runId), h);
    const transcriptDir = join(corpusDir, 'transcripts');
    const files = readdirSync(transcriptDir).sort();

    expect.soft(new Set(result.transcripts)).toEqual(new Set([orch, impl]));
    expect.soft(files).toEqual(['orchestrator.orch-1.jsonl.gz', 'planning.architect.impl-2.jsonl.gz']);
    expect.soft(files.every((f) => f.endsWith('.jsonl.gz'))).toBe(true);
    expect.soft(gunzipSync(readFileSync(join(transcriptDir, 'orchestrator.orch-1.jsonl.gz'))).toString('utf8')).toContain('summary');
    expect.soft(existsSync(orch)).toBe(false);
    expect.soft(existsSync(impl)).toBe(false);
    expect.soft(readdirSync(transcriptDir).some((f) => f.endsWith('.jsonl'))).toBe(false);
  });

  test('captures transcripts even when workflow.json is corrupt (capture is workflow-independent)', ({ projectDir, run }) => {
    const h = home();
    const corpusDir = join(projectDir, 'corpus', run.runId);
    writeClaudeTranscript(h, '-proj', 'orch-1');
    run.corpusDir = corpusDir;
    run.orchestratorSessionId = 'orch-1';
    saveRunState(run);

    // Load while valid, then corrupt the frozen workflow on disk — the window
    // where the old resolveSessions→workflowFor path threw and lost the
    // transcript un-archived while purge still deleted it.
    const loaded = loadRunState(projectDir, run.runId);
    writeFileSync(join(runDirOf(projectDir, run.runId), 'workflow.json'), 'not json');

    const captured = captureRunTranscripts(loaded, h);
    expect.soft(captured).toEqual([join(corpusDir, 'transcripts', 'orchestrator.orch-1.jsonl.gz')]);
    expect.soft(existsSync(join(corpusDir, 'transcripts', 'orchestrator.orch-1.jsonl.gz'))).toBe(true);
  });

  test('transcript capture is silent and skipped when the corpus is off', ({ projectDir, run }) => {
    const h = home();
    writeClaudeTranscript(h, '-proj', 'orch-1');
    run.orchestratorSessionId = 'orch-1';
    saveRunState(run);

    expect(captureRunTranscripts(loadRunState(projectDir, run.runId), h)).toEqual([]);
    expect(existsSync(join(runDirOf(projectDir, run.runId), 'transcripts'))).toBe(false);
  });

  test('a run with no sessions yet still removes its dir, reporting no transcripts', ({ projectDir, run }) => {
    const result = purgeRun(loadRunState(projectDir, run.runId), home());
    expect.soft(result.transcripts).toEqual([]);
    expect.soft(existsSync(runDirOf(projectDir, run.runId))).toBe(false);
  });

  test('a bound consultant: purge removes the LATEST tracked transcript, leaving prior checkpoint ones', ({
    projectDir,
    consultantRun,
  }) => {
    const h = home();
    const latest = writeClaudeTranscript(h, '-proj', 'consult-latest');
    // An earlier checkpoint's session — state tracks only the latest id, so this
    // was never recorded, and purge (exact-id match, no directory sweep) leaves it.
    const prior = writeClaudeTranscript(h, '-proj', 'consult-prior');
    consultantRun.sessions = { consultant: { provider: 'claude', id: 'consult-latest' } };
    saveRunState(consultantRun);

    const result = purgeRun(loadRunState(projectDir, consultantRun.runId), h);
    expect.soft(result.transcripts).toContain(latest);
    expect.soft(existsSync(latest)).toBe(false);
    expect.soft(result.transcripts).not.toContain(prior);
    expect.soft(existsSync(prior)).toBe(true); // the prior checkpoint transcript survives, by design
  });
});

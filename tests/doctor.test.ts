import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { buildDoctorModel, renderDoctor } from '../src/surfaces/doctor.ts';
import type { DoctorModel, VoiceHealthRow } from '../src/surfaces/doctor.ts';
import { runDirOf, saveRunState } from '../src/run/store.ts';
import { test } from './helpers/fixtures.ts';
import { localStamp } from '../src/view/timefmt.ts';
import { claudeApiError, claudeUserToolResult, jsonl, plantClaudeTranscript, plantCodexRollout } from './helpers/transcripts.ts';

const NOW = Date.parse('2026-06-20T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const SEC = 1_000;
const MIN = 60_000;
const okFetch = async () => ({ status: 200 });

/** Mark a live (or dead) driver by writing the pid file the lifecycle reads. */
function setDriver(run: { cwd: string; runId: string }, pid: number): void {
  writeFileSync(join(runDirOf(run.cwd, run.runId), 'driver.pid'), `${pid}\n`);
}
const DEAD_PID = 2 ** 22; // far above any real pid → process.kill(pid, 0) throws ESRCH

const rowOf = (model: DoctorModel, voice: string): VoiceHealthRow => model.voices.find((r) => r.voice === voice)!;

describe('buildDoctorModel — per-voice verdicts', () => {
  test('a parked run with no in-flight turns reads all idle, with resolved paths', async ({ run, projectDir }) => {
    const home = join(projectDir, 'home');
    run.orchestratorSessionId = 'orch-1';
    run.sessions = { 'planning.architect': { provider: 'claude', id: 'impl-1' }, 'planning.analyst': { provider: 'codex', id: 'rev-1' } };
    saveRunState(run);
    plantClaudeTranscript(home, 'orch-1', jsonl(claudeUserToolResult({ ts: ago(20 * MIN) })));
    plantClaudeTranscript(home, 'impl-1', jsonl(claudeUserToolResult({ ts: ago(20 * MIN) })));
    plantCodexRollout(home, 'rev-1', jsonl({ type: 'event_msg', timestamp: ago(20 * MIN), payload: { type: 'agent_message', message: 'done' } }));

    const model = await buildDoctorModel(run, { now: NOW, home, fetch: okFetch });
    // Every stage's duties get a row — the not-yet-started delivery pair reads idle too.
    expect.soft(model.voices.map((r) => r.verdict)).toEqual(['idle', 'idle', 'idle', 'idle', 'idle']);
    expect.soft(rowOf(model, 'analyst').provider).toBe('codex'); // exact map, no heuristic
    expect.soft(rowOf(model, 'architect').sessionPath).toContain('impl-1.jsonl');
  });

  test('a bound consultant gets its own health row; the orchestrator is never dropped', async ({ consultantRun, projectDir }) => {
    const home = join(projectDir, 'home');
    consultantRun.orchestratorSessionId = 'orch-1';
    consultantRun.sessions = { consultant: { provider: 'claude', id: 'consult-1' } };
    saveRunState(consultantRun);
    plantClaudeTranscript(home, 'orch-1', jsonl(claudeUserToolResult({ ts: ago(20 * MIN) })));
    plantClaudeTranscript(home, 'consult-1', jsonl(claudeUserToolResult({ ts: ago(20 * MIN) })));

    const model = await buildDoctorModel(consultantRun, { now: NOW, home, fetch: okFetch });
    const roles = model.voices.map((r) => r.voice);
    expect.soft(roles).toContain('orchestrator'); // voicesFor keeps it
    expect.soft(roles).toContain('consultant');
    expect.soft(rowOf(model, 'consultant').provider).toBe('claude'); // its exact bound provider
    expect.soft(rowOf(model, 'consultant').sessionPath).toContain('consult-1.jsonl');
  });

  test('an unbound run shows the orchestrator plus every stage’s duties, in run order', async ({ run, projectDir }) => {
    const home = join(projectDir, 'home');
    const model = await buildDoctorModel(run, { now: NOW, home, fetch: okFetch });
    expect.soft(model.voices.map((r) => r.voice)).toEqual(['orchestrator', 'architect', 'analyst', 'builder', 'critic']);
  });

  test('an in-flight worker (activeTurns + live driver) reads working', async ({ run, projectDir }) => {
    const home = join(projectDir, 'home');
    run.sessions = { 'planning.architect': { provider: 'claude', id: 'impl-1' } };
    run.activeTurns = { architect: { tag: 'start-plan', startedAt: ago(30 * SEC) } };
    saveRunState(run);
    setDriver(run, process.pid); // a live driver (this test process)
    plantClaudeTranscript(home, 'impl-1', jsonl(claudeUserToolResult({ ts: ago(8 * SEC) })));

    const model = await buildDoctorModel(run, { now: NOW, home, fetch: okFetch });
    expect.soft(rowOf(model, 'architect').inFlight).toBe(true);
    expect.soft(rowOf(model, 'architect').verdict).toBe('working');
  });

  test('stale activeTurns under a DEAD driver is reconciled to idle, never long-inference', async ({ run, projectDir }) => {
    const home = join(projectDir, 'home');
    run.sessions = { 'planning.architect': { provider: 'claude', id: 'impl-1' } };
    // A turn the hint says started 40m ago — but the driver that would clear it is dead.
    run.activeTurns = { architect: { tag: 'start-plan', startedAt: ago(40 * MIN) } };
    saveRunState(run);
    setDriver(run, DEAD_PID);
    plantClaudeTranscript(home, 'impl-1', jsonl(claudeUserToolResult({ ts: ago(40 * MIN) })));

    const model = await buildDoctorModel(run, { now: NOW, home, fetch: okFetch });
    expect.soft(rowOf(model, 'architect').inFlight).toBe(false);
    expect.soft(rowOf(model, 'architect').verdict).toBe('idle'); // NOT silent/stuck
  });

  test('the interactive orchestrator (phase mid-flight) reads working from its own transcript', async ({ interactiveRun, projectDir }) => {
    const home = join(projectDir, 'home');
    interactiveRun.orchestratorSessionId = 'orch-1';
    saveRunState(interactiveRun);
    plantClaudeTranscript(home, 'orch-1', jsonl(claudeUserToolResult({ ts: ago(8 * SEC) })));

    const model = await buildDoctorModel(interactiveRun, { now: NOW, home, fetch: okFetch });
    expect.soft(rowOf(model, 'orchestrator').inFlight).toBe(true);
    expect.soft(rowOf(model, 'orchestrator').verdict).toBe('working');
  });

  test('a voice with no session yet is idle with no path', async ({ run, projectDir }) => {
    const home = join(projectDir, 'home');
    run.sessions = { 'planning.architect': { provider: 'claude', id: 'impl-1' } }; // analyst + orchestrator absent
    saveRunState(run);
    plantClaudeTranscript(home, 'impl-1', jsonl(claudeUserToolResult({ ts: ago(MIN) })));

    const model = await buildDoctorModel(run, { now: NOW, home, fetch: okFetch });
    const rev = rowOf(model, 'analyst');
    expect.soft(rev.verdict).toBe('idle');
    expect.soft(rev.sessionPath).toBeUndefined();
  });

  test('a recent terminal error with no later activity reads crashed and lists the error', async ({ run, projectDir }) => {
    const home = join(projectDir, 'home');
    run.sessions = { 'planning.architect': { provider: 'claude', id: 'impl-1' } };
    saveRunState(run);
    plantClaudeTranscript(home, 'impl-1', jsonl(claudeApiError('API Error: 500 Internal server error', { ts: ago(30 * SEC) })));

    const model = await buildDoctorModel(run, { now: NOW, home, fetch: okFetch });
    expect.soft(rowOf(model, 'architect').verdict).toBe('crashed');
    expect.soft(rowOf(model, 'architect').recentErrors[0]?.errorClass).toBe('server');
  });
});

describe('buildDoctorModel — connectivity (best-effort, never load-bearing)', () => {
  test('a 200 is reachable, a 403 is auth-rejected, a throw is down — and the model always returns', async ({ run }) => {
    saveRunState(run);
    const reach = await buildDoctorModel(run, { now: NOW, fetch: async () => ({ status: 200 }) });
    expect.soft(reach.connectivity).toEqual({ target: 'api.anthropic.com', status: 'reachable' });

    const auth = await buildDoctorModel(run, { now: NOW, fetch: async () => ({ status: 403 }) });
    expect.soft(auth.connectivity).toEqual({ target: 'api.anthropic.com', status: 'reachable-but-auth-rejected' });

    const down = await buildDoctorModel(run, { now: NOW, fetch: async () => { throw new Error('ENOTFOUND'); } });
    expect.soft(down.connectivity).toEqual({ target: 'api.anthropic.com', status: 'down' });
    expect.soft(down.voices).toHaveLength(5); // probe failure never sinks the model
  });
});

describe('renderDoctor', () => {
  test('shows one line per voice with its verdict and the connectivity probe', async ({ run, projectDir }) => {
    const home = join(projectDir, 'home');
    run.sessions = { 'planning.architect': { provider: 'claude', id: 'impl-1' } };
    saveRunState(run);
    plantClaudeTranscript(home, 'impl-1', jsonl(claudeUserToolResult({ ts: ago(MIN) })));
    const text = renderDoctor(await buildDoctorModel(run, { now: NOW, home, fetch: okFetch }));

    expect.soft(text).toContain('orchestrator');
    expect.soft(text).toContain('architect');
    expect.soft(text).toContain('analyst');
    expect.soft(text).toContain('network:');
    expect.soft(text).toMatch(/idle|working|crashed|retrying|long-inference|silent\/stuck/);
  });

  test('an error row localizes its timestamp (the stored transcript ts stays UTC)', async ({ run, projectDir }) => {
    const home = join(projectDir, 'home');
    const errTs = '2026-06-20T11:59:30.000Z';
    run.sessions = { 'planning.architect': { provider: 'claude', id: 'impl-1' } };
    saveRunState(run);
    plantClaudeTranscript(home, 'impl-1', jsonl(claudeApiError('API Error: 500 Internal server error', { ts: errTs })));
    const text = renderDoctor(await buildDoctorModel(run, { now: NOW, home, fetch: okFetch }));

    expect.soft(text).toContain(`⛔ ${localStamp(errTs)}`); // local, not the raw UTC slice
    expect.soft(text).not.toContain(errTs);
  });
});

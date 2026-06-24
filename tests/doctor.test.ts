import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { buildDoctorModel, renderDoctor } from '../src/doctor.ts';
import type { DoctorModel, RoleHealthRow } from '../src/doctor.ts';
import { runDirOf, saveRunState } from '../src/run-store.ts';
import { test } from './helpers/fixtures.ts';
import { localStamp } from '../src/timefmt.ts';
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

const rowOf = (model: DoctorModel, role: string): RoleHealthRow => model.roles.find((r) => r.role === role)!;

describe('buildDoctorModel — per-role verdicts', () => {
  test('a parked run with no in-flight turns reads all idle, with resolved paths', async ({ run, projectDir }) => {
    const home = join(projectDir, 'home');
    run.orchestratorSessionId = 'orch-1';
    run.workerSessions = { implementer: 'impl-1', reviewer: 'rev-1' };
    saveRunState(run);
    plantClaudeTranscript(home, 'orch-1', jsonl(claudeUserToolResult({ ts: ago(20 * MIN) })));
    plantClaudeTranscript(home, 'impl-1', jsonl(claudeUserToolResult({ ts: ago(20 * MIN) })));
    plantCodexRollout(home, 'rev-1', jsonl({ type: 'event_msg', timestamp: ago(20 * MIN), payload: { type: 'agent_message', message: 'done' } }));

    const model = await buildDoctorModel(run, { now: NOW, home, fetch: okFetch });
    expect.soft(model.roles.map((r) => r.verdict)).toEqual(['idle', 'idle', 'idle']);
    expect.soft(rowOf(model, 'reviewer').provider).toBe('codex'); // exact map, no heuristic
    expect.soft(rowOf(model, 'implementer').sessionPath).toContain('impl-1.jsonl');
  });

  test('a bound consultant gets its own health row; the orchestrator is never dropped', async ({ consultantRun, projectDir }) => {
    const home = join(projectDir, 'home');
    consultantRun.orchestratorSessionId = 'orch-1';
    consultantRun.workerSessions = { consultant: 'consult-1' };
    saveRunState(consultantRun);
    plantClaudeTranscript(home, 'orch-1', jsonl(claudeUserToolResult({ ts: ago(20 * MIN) })));
    plantClaudeTranscript(home, 'consult-1', jsonl(claudeUserToolResult({ ts: ago(20 * MIN) })));

    const model = await buildDoctorModel(consultantRun, { now: NOW, home, fetch: okFetch });
    const roles = model.roles.map((r) => r.role);
    expect.soft(roles).toContain('orchestrator'); // voicesFor keeps it
    expect.soft(roles).toContain('consultant');
    expect.soft(rowOf(model, 'consultant').provider).toBe('claude'); // its exact bound provider
    expect.soft(rowOf(model, 'consultant').sessionPath).toContain('consult-1.jsonl');
  });

  test('an unbound run has exactly today’s three voices (byte-for-byte)', async ({ run, projectDir }) => {
    const home = join(projectDir, 'home');
    const model = await buildDoctorModel(run, { now: NOW, home, fetch: okFetch });
    expect.soft(model.roles.map((r) => r.role)).toEqual(['orchestrator', 'implementer', 'reviewer']);
  });

  test('an in-flight worker (activeTurns + live driver) reads working', async ({ run, projectDir }) => {
    const home = join(projectDir, 'home');
    run.workerSessions = { implementer: 'impl-1' };
    run.activeTurns = { implementer: { tag: 'start-plan', startedAt: ago(30 * SEC) } };
    saveRunState(run);
    setDriver(run, process.pid); // a live driver (this test process)
    plantClaudeTranscript(home, 'impl-1', jsonl(claudeUserToolResult({ ts: ago(8 * SEC) })));

    const model = await buildDoctorModel(run, { now: NOW, home, fetch: okFetch });
    expect.soft(rowOf(model, 'implementer').inFlight).toBe(true);
    expect.soft(rowOf(model, 'implementer').verdict).toBe('working');
  });

  test('stale activeTurns under a DEAD driver is reconciled to idle, never long-inference', async ({ run, projectDir }) => {
    const home = join(projectDir, 'home');
    run.workerSessions = { implementer: 'impl-1' };
    // A turn the hint says started 40m ago — but the driver that would clear it is dead.
    run.activeTurns = { implementer: { tag: 'start-plan', startedAt: ago(40 * MIN) } };
    saveRunState(run);
    setDriver(run, DEAD_PID);
    plantClaudeTranscript(home, 'impl-1', jsonl(claudeUserToolResult({ ts: ago(40 * MIN) })));

    const model = await buildDoctorModel(run, { now: NOW, home, fetch: okFetch });
    expect.soft(rowOf(model, 'implementer').inFlight).toBe(false);
    expect.soft(rowOf(model, 'implementer').verdict).toBe('idle'); // NOT silent/stuck
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

  test('a role with no session yet is idle with no path', async ({ run, projectDir }) => {
    const home = join(projectDir, 'home');
    run.workerSessions = { implementer: 'impl-1' }; // reviewer + orchestrator absent
    saveRunState(run);
    plantClaudeTranscript(home, 'impl-1', jsonl(claudeUserToolResult({ ts: ago(MIN) })));

    const model = await buildDoctorModel(run, { now: NOW, home, fetch: okFetch });
    const rev = rowOf(model, 'reviewer');
    expect.soft(rev.verdict).toBe('idle');
    expect.soft(rev.sessionPath).toBeUndefined();
  });

  test('a recent terminal error with no later activity reads crashed and lists the error', async ({ run, projectDir }) => {
    const home = join(projectDir, 'home');
    run.workerSessions = { implementer: 'impl-1' };
    saveRunState(run);
    plantClaudeTranscript(home, 'impl-1', jsonl(claudeApiError('API Error: 500 Internal server error', { ts: ago(30 * SEC) })));

    const model = await buildDoctorModel(run, { now: NOW, home, fetch: okFetch });
    expect.soft(rowOf(model, 'implementer').verdict).toBe('crashed');
    expect.soft(rowOf(model, 'implementer').recentErrors[0]?.errorClass).toBe('server');
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
    expect.soft(down.roles).toHaveLength(3); // probe failure never sinks the model
  });
});

describe('renderDoctor', () => {
  test('shows one line per role with its verdict and the connectivity probe', async ({ run, projectDir }) => {
    const home = join(projectDir, 'home');
    run.workerSessions = { implementer: 'impl-1' };
    saveRunState(run);
    plantClaudeTranscript(home, 'impl-1', jsonl(claudeUserToolResult({ ts: ago(MIN) })));
    const text = renderDoctor(await buildDoctorModel(run, { now: NOW, home, fetch: okFetch }));

    expect.soft(text).toContain('orchestrator');
    expect.soft(text).toContain('implementer');
    expect.soft(text).toContain('reviewer');
    expect.soft(text).toContain('network:');
    expect.soft(text).toMatch(/idle|working|crashed|retrying|long-inference|silent\/stuck/);
  });

  test('an error row localizes its timestamp (the stored transcript ts stays UTC)', async ({ run, projectDir }) => {
    const home = join(projectDir, 'home');
    const errTs = '2026-06-20T11:59:30.000Z';
    run.workerSessions = { implementer: 'impl-1' };
    saveRunState(run);
    plantClaudeTranscript(home, 'impl-1', jsonl(claudeApiError('API Error: 500 Internal server error', { ts: errTs })));
    const text = renderDoctor(await buildDoctorModel(run, { now: NOW, home, fetch: okFetch }));

    expect.soft(text).toContain(`⛔ ${localStamp(errTs)}`); // local, not the raw UTC slice
    expect.soft(text).not.toContain(errTs);
  });
});

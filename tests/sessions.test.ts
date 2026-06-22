import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { readRoleTranscriptTail, readTranscriptTailAtPath, resolveSessions } from '../src/sessions.ts';
import { test } from './helpers/fixtures.ts';
import { claudeUserToolResult, jsonl, plantClaudeTranscript } from './helpers/transcripts.ts';

const TS = '2026-06-20T00:00:00.000Z';

describe('resolveSessions — the cheap exact session map (no fs)', () => {
  test('orchestrator + both workers map to their provider and id', ({ run }) => {
    run.orchestratorSessionId = 'orch-1';
    run.workerSessions = { implementer: 'impl-1', reviewer: 'rev-1' };
    expect(resolveSessions(run)).toEqual([
      { role: 'orchestrator', provider: 'claude', sessionId: 'orch-1' },
      { role: 'implementer', provider: 'claude', sessionId: 'impl-1' },
      { role: 'reviewer', provider: 'codex', sessionId: 'rev-1' },
    ]);
  });

  test('a role with no session id yet is OMITTED, never a null-id entry', ({ run }) => {
    run.orchestratorSessionId = 'orch-1';
    run.workerSessions = { implementer: 'impl-1' }; // reviewer not started
    const roles = resolveSessions(run).map((s) => s.role);
    expect.soft(roles).toEqual(['orchestrator', 'implementer']);
    expect.soft(resolveSessions(run).every((s) => s.sessionId)).toBe(true);
  });

  test('a fresh run with no sessions resolves to []', ({ run }) => {
    expect(resolveSessions(run)).toEqual([]);
  });

  test('a bound consultant resolves alongside the base workers; an unbound run never includes it', ({
    run,
    consultantRun,
  }) => {
    consultantRun.orchestratorSessionId = 'orch-1';
    consultantRun.workerSessions = { implementer: 'impl-1', reviewer: 'rev-1', consultant: 'c-1' };
    expect.soft(resolveSessions(consultantRun)).toEqual([
      { role: 'orchestrator', provider: 'claude', sessionId: 'orch-1' },
      { role: 'implementer', provider: 'claude', sessionId: 'impl-1' },
      { role: 'reviewer', provider: 'codex', sessionId: 'rev-1' },
      { role: 'consultant', provider: 'claude', sessionId: 'c-1' },
    ]);
    // Unbound: even a stray tracked consultant id is not enumerated — the role
    // isn't bound, so workerRolesFor doesn't reach it.
    run.workerSessions = { implementer: 'impl-1', consultant: 'stray' };
    expect.soft(resolveSessions(run).map((s) => s.role)).toEqual(['implementer']);
  });
});

describe('readRoleTranscriptTail — the fs tail wrapper', () => {
  test('a small transcript is read from offset 0, first record intact, with a path', ({ run, projectDir }) => {
    const home = join(projectDir, 'home');
    run.workerSessions = { implementer: 'impl-1' };
    const content = jsonl(claudeUserToolResult({ ts: TS }), claudeUserToolResult({ ts: TS }));
    const path = plantClaudeTranscript(home, 'impl-1', content);

    const tail = readRoleTranscriptTail(run, 'implementer', { home });
    expect.soft(tail?.schema).toBe('claude');
    expect.soft(tail?.path).toBe(path);
    // No discard on a sub-maxBytes file: the very first record survives byte-for-byte.
    expect.soft(tail?.jsonl).toBe(content);
  });

  test('a transcript larger than maxBytes returns <= maxBytes with the partial first line discarded', ({ run, projectDir }) => {
    const home = join(projectDir, 'home');
    const maxBytes = 64 * 1024;
    run.workerSessions = { implementer: 'impl-1' };
    // A huge leading record (the read seeks into it), then small intact records.
    const big = JSON.stringify({ type: 'assistant', timestamp: TS, pad: 'x'.repeat(200_000), message: { content: [] } });
    const survivor = JSON.stringify({ type: 'user', timestamp: TS, message: { content: [{ type: 'tool_result', content: 'first-survivor' }] } });
    const content = [big, survivor, survivor].join('\n');
    plantClaudeTranscript(home, 'impl-1', content);

    const tail = readRoleTranscriptTail(run, 'implementer', { home, maxBytes });
    expect.soft(Buffer.byteLength(tail?.jsonl ?? '', 'utf8')).toBeLessThanOrEqual(maxBytes);
    // The partial fragment of `big` is gone; the first parsed record is intact JSON.
    const firstLine = (tail?.jsonl ?? '').split('\n').find((l) => l.trim());
    expect.soft(() => JSON.parse(firstLine ?? '')).not.toThrow();
    expect.soft(JSON.parse(firstLine ?? '')).toMatchObject({ type: 'user' });
    expect.soft(tail?.jsonl.includes('first-survivor')).toBe(true);
  });

  test('on multiple located paths, the newest by mtime wins', ({ run, projectDir }) => {
    const home = join(projectDir, 'home');
    run.workerSessions = { implementer: 'shared-id' };
    plantClaudeTranscript(home, 'shared-id', jsonl(claudeUserToolResult({ ts: TS })), { slug: 'proj-old', mtime: 1_000_000_000_000 });
    const newerPath = plantClaudeTranscript(
      home,
      'shared-id',
      jsonl({ type: 'user', timestamp: TS, message: { content: [{ type: 'tool_result', content: 'newest' }] } }),
      { slug: 'proj-new', mtime: 2_000_000_000_000 },
    );
    const tail = readRoleTranscriptTail(run, 'implementer', { home });
    expect.soft(tail?.path).toBe(newerPath);
    expect.soft(tail?.jsonl.includes('newest')).toBe(true);
  });

  test('a role with no locatable transcript returns undefined', ({ run, projectDir }) => {
    const home = join(projectDir, 'home');
    run.workerSessions = { implementer: 'ghost' }; // session id with no file on disk
    expect.soft(readRoleTranscriptTail(run, 'implementer', { home })).toBeUndefined();
    // A role with no session id at all is also undefined.
    expect.soft(readRoleTranscriptTail(run, 'reviewer', { home })).toBeUndefined();
  });
});

describe('readTranscriptTailAtPath — the locate-free reader (the 30s activity poll)', () => {
  test('reads the tail at an already-located path, no directory scan', ({ run, projectDir }) => {
    const home = join(projectDir, 'home');
    run.workerSessions = { implementer: 'impl-1' };
    const path = plantClaudeTranscript(home, 'impl-1', jsonl(claudeUserToolResult({ ts: TS })));
    const tail = readTranscriptTailAtPath(path, 'claude');
    expect.soft(tail?.path).toBe(path);
    expect.soft(tail?.schema).toBe('claude');
    expect.soft(tail?.jsonl.includes('tool_result')).toBe(true);
  });

  test('a vanished path returns undefined (so the caller re-locates)', () => {
    expect(readTranscriptTailAtPath('/no/such/transcript.jsonl', 'codex')).toBeUndefined();
  });
});

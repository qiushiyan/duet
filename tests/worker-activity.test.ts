import { describe, expect, test } from 'vitest';
import { activityLine, latestActivity } from '../src/worker-activity.ts';
import type { WorkerActivity } from '../src/worker-activity.ts';
import { claudeAssistantText, claudeToolUse, codexExecCommand, jsonl } from './helpers/transcripts.ts';

/**
 * The pure activity parser — the testable seam, in the spirit of
 * `parseClaudeTurn` / `parseRolloutContext` / `probeRole`: provider-shaped JSONL
 * tails in, a normalized `WorkerActivity` out. Fixtures are real record shapes
 * (helpers/transcripts.ts), so a CLI format drift surfaces here.
 */

describe('latestActivity — claude (structured tool_use)', () => {
  test('a Read surfaces the file path', () => {
    const tail = jsonl(claudeToolUse([{ name: 'Read', input: { file_path: '/repo/src/foo.ts' }, id: 'toolu_a' }]));
    expect(latestActivity(tail, 'claude')).toEqual({ id: 'toolu_a', kind: 'read', path: '/repo/src/foo.ts' });
  });

  test.for<[string]>([['Write'], ['Edit'], ['MultiEdit'], ['NotebookEdit']])(
    'a %s is a write with the path (never its contents)',
    ([name]) => {
      const tail = jsonl(claudeToolUse([{ name, input: { file_path: '/repo/x.ts', content: 'SECRET BODY' }, id: 'toolu_w' }]));
      expect(latestActivity(tail, 'claude')).toEqual({ id: 'toolu_w', kind: 'write', path: '/repo/x.ts' });
    },
  );

  test('the newest qualifying tool_use wins across records and blocks', () => {
    const tail = jsonl(
      claudeToolUse([{ name: 'Read', input: { file_path: '/repo/old.ts' }, id: 'toolu_old' }], { ts: '2026-06-20T00:00:00.000Z' }),
      claudeToolUse(
        [
          { name: 'Read', input: { file_path: '/repo/mid.ts' }, id: 'toolu_mid' },
          { name: 'Edit', input: { file_path: '/repo/new.ts' }, id: 'toolu_new' },
        ],
        { ts: '2026-06-20T00:01:00.000Z' },
      ),
    );
    expect(latestActivity(tail, 'claude')).toEqual({ id: 'toolu_new', kind: 'write', path: '/repo/new.ts' });
  });

  test('a search/command after a read is skipped — the last real read still shows', () => {
    const tail = jsonl(
      claudeToolUse([{ name: 'Read', input: { file_path: '/repo/foo.ts' }, id: 'toolu_read' }]),
      claudeToolUse([{ name: 'Grep', input: { pattern: 'x' }, id: 'toolu_grep' }]),
      claudeToolUse([{ name: 'Bash', input: { command: 'pnpm test' }, id: 'toolu_bash' }]),
    );
    expect(latestActivity(tail, 'claude')).toEqual({ id: 'toolu_read', kind: 'read', path: '/repo/foo.ts' });
  });

  test('no qualifying tool_use → undefined (text-only / search-only tail)', () => {
    expect(latestActivity(jsonl(claudeAssistantText('thinking out loud')), 'claude')).toBeUndefined();
    expect(latestActivity(jsonl(claudeToolUse([{ name: 'Glob', input: { pattern: '**/*.ts' } }])), 'claude')).toBeUndefined();
  });
});

describe('latestActivity — codex (shell-command reads)', () => {
  test.for<[string, string]>([
    ["sed -n '1,260p' CLAUDE.md", 'CLAUDE.md'],
    ['cat src/foo.ts', 'src/foo.ts'],
    ['head -n 50 docs/automation-design.md', 'docs/automation-design.md'],
    ['tail -f src/x.ts', 'src/x.ts'],
    ['/usr/bin/sed -n 1,10p a.ts', 'a.ts'],
  ])('a single-file read command surfaces the path: %s', ([cmd, path]) => {
    expect(latestActivity(jsonl(codexExecCommand(cmd, { callId: 'call_r' })), 'codex')).toEqual({
      id: 'call_r',
      kind: 'read',
      path,
    });
  });

  test.for<[string]>([
    ['rg "appendVoiceLog" src'], // a search — not a single-file read
    ['ls -la src'],
    ["sed -n '1,5p' a.ts | grep foo"], // a pipeline — too ambiguous
    ['cat a.ts > b.ts'], // a redirect
  ])('a search/pipeline/redirect falls back to the raw command, never a guessed path: %s', ([cmd]) => {
    const act = latestActivity(jsonl(codexExecCommand(cmd, { callId: 'call_x' })), 'codex');
    expect(act?.kind).toBe('run');
    expect((act as Extract<WorkerActivity, { kind: 'run' }>).label).toContain(cmd.split(' ')[0]!);
  });

  test('a long command label is truncated', () => {
    const long = `rg ${'x'.repeat(200)}`;
    const act = latestActivity(jsonl(codexExecCommand(long, { callId: 'call_l' })), 'codex');
    expect((act as Extract<WorkerActivity, { kind: 'run' }>).label.length).toBeLessThanOrEqual(80);
    expect((act as Extract<WorkerActivity, { kind: 'run' }>).label.endsWith('…')).toBe(true);
  });

  test('newest function_call wins', () => {
    const tail = jsonl(
      codexExecCommand('cat old.ts', { callId: 'call_old', ts: '2026-06-20T00:00:00.000Z' }),
      codexExecCommand('cat new.ts', { callId: 'call_new', ts: '2026-06-20T00:01:00.000Z' }),
    );
    expect(latestActivity(tail, 'codex')).toEqual({ id: 'call_new', kind: 'read', path: 'new.ts' });
  });
});

describe('latestActivity — fail-soft parsing', () => {
  test('blank / half-written / foreign lines are skipped, not thrown on', () => {
    const tail = ['', 'not json', '{ "partial":', JSON.stringify(claudeToolUse([{ name: 'Read', input: { file_path: '/r/x.ts' }, id: 'toolu_z' }]))].join(
      '\n',
    );
    expect(latestActivity(tail, 'claude')).toEqual({ id: 'toolu_z', kind: 'read', path: '/r/x.ts' });
  });

  test('an empty tail → undefined', () => {
    expect(latestActivity('', 'claude')).toBeUndefined();
    expect(latestActivity('', 'codex')).toBeUndefined();
  });
});

describe('activityLine — the one voice-log line shape', () => {
  test.for<[WorkerActivity, string]>([
    [{ id: '1', kind: 'read', path: 'src/foo.ts' }, '⋯ reading src/foo.ts'],
    [{ id: '2', kind: 'write', path: 'src/foo.ts' }, '⋯ editing src/foo.ts'],
    [{ id: '3', kind: 'run', label: 'rg foo src' }, '⋯ running rg foo src'],
  ])('renders %o', ([activity, line]) => {
    expect(activityLine(activity)).toBe(line);
  });
});

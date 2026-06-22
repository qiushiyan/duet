import { describe, expect, test } from 'vitest';
import { activityLine, latestActivity } from '../src/worker-activity.ts';
import type { WorkerActivity } from '../src/worker-activity.ts';
import { claudeAssistantText, claudeToolUse, codexApplyPatch, codexExecCommand, jsonl, patchBody } from './helpers/transcripts.ts';

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

describe('latestActivity — codex reads (single-file shell commands only)', () => {
  test.for<[string, string]>([
    ["sed -n '1,260p' CLAUDE.md", 'CLAUDE.md'],
    ["sed '1,5p' a.ts", 'a.ts'],
    ['cat src/foo.ts', 'src/foo.ts'],
    ['cat -- src/foo.ts', 'src/foo.ts'], // end-of-options marker
    ['head -n 50 docs/x.md', 'docs/x.md'], // separate numeric value of -n
    ['head -n50 docs/x.md', 'docs/x.md'], // attached value
    ['head -50 docs/x.md', 'docs/x.md'], // legacy -N
    ['tail -f src/x.ts', 'src/x.ts'],
    ['cat "my file.ts"', 'my file.ts'], // quoted path with a space
    ['/usr/bin/sed -n 1,10p a.ts', 'a.ts'], // absolute command path
  ])('a confident single-file read surfaces the path: %s', ([cmd, path]) => {
    expect(latestActivity(jsonl(codexExecCommand(cmd, { callId: 'call_r' })), 'codex')).toEqual({ id: 'call_r', kind: 'read', path });
  });

  test.for<[string]>([
    ['cat a.ts b.ts'], // multi-file — must not look single-file
    ["sed -n '1,5p' a.ts b.ts"],
    ['head -n 50 a.ts b.ts'],
    ['rg "appendVoiceLog" src'], // a search — not a read command, and the args are out of scope
    ['ls -la src'],
    ['pnpm test'],
    ["sed -n '1,5p' a.ts | grep foo"], // a pipeline
    ['cat a.ts > b.ts'], // a redirect
  ])('an ambiguous/multi-file/non-read command surfaces NO line (never a guessed or raw-command path): %s', ([cmd]) => {
    expect(latestActivity(jsonl(codexExecCommand(cmd, { callId: 'call_x' })), 'codex')).toBeUndefined();
  });

  test('a search after a read is skipped — the last confident read still shows', () => {
    const tail = jsonl(
      codexExecCommand('cat foo.ts', { callId: 'call_read', ts: '2026-06-20T00:00:00.000Z' }),
      codexExecCommand('rg pattern src', { callId: 'call_search', ts: '2026-06-20T00:01:00.000Z' }),
    );
    expect(latestActivity(tail, 'codex')).toEqual({ id: 'call_read', kind: 'read', path: 'foo.ts' });
  });

  test('newest read wins', () => {
    const tail = jsonl(
      codexExecCommand('cat old.ts', { callId: 'call_old', ts: '2026-06-20T00:00:00.000Z' }),
      codexExecCommand('cat new.ts', { callId: 'call_new', ts: '2026-06-20T00:01:00.000Z' }),
    );
    expect(latestActivity(tail, 'codex')).toEqual({ id: 'call_new', kind: 'read', path: 'new.ts' });
  });
});

describe('latestActivity — codex writes (apply_patch, header-only)', () => {
  test.for<[string, 'Add' | 'Update' | 'Delete']>([
    ['src/x.ts', 'Update'],
    ['src/new.ts', 'Add'],
    ['src/gone.ts', 'Delete'],
  ])('an apply_patch surfaces the file header path (%s, %s), never a hunk', ([path, kind]) => {
    const tail = jsonl(codexApplyPatch(patchBody({ path, kind }), { callId: 'call_w' }));
    expect(latestActivity(tail, 'codex')).toEqual({ id: 'call_w', kind: 'write', path });
  });

  test('a multi-file patch surfaces the first file header', () => {
    const tail = jsonl(codexApplyPatch(patchBody({ path: 'a.ts' }, { path: 'b.ts', kind: 'Add' }), { callId: 'call_m' }));
    expect(latestActivity(tail, 'codex')).toEqual({ id: 'call_m', kind: 'write', path: 'a.ts' });
  });

  test('a write after a read is the current action', () => {
    const tail = jsonl(
      codexExecCommand('cat foo.ts', { callId: 'call_read', ts: '2026-06-20T00:00:00.000Z' }),
      codexApplyPatch(patchBody({ path: 'src/x.ts' }), { callId: 'call_write', ts: '2026-06-20T00:01:00.000Z' }),
    );
    expect(latestActivity(tail, 'codex')).toEqual({ id: 'call_write', kind: 'write', path: 'src/x.ts' });
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
  ])('renders %o', ([activity, line]) => {
    expect(activityLine(activity)).toBe(line);
  });
});

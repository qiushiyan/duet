import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, vi } from 'vitest';
import { program, stageContinueText } from '../src/cli.ts';
import { loadRunState, saveRunState } from '../src/run-store.ts';
import { test } from './helpers/fixtures.ts';

/**
 * The write path for a gate/flag decision (#6): non-TTY-safe (never opens an
 * editor a headless caller can't drive) and quoting-safe (file/stdin forms so
 * apostrophes, em-dashes, and newlines reach the orchestrator verbatim).
 * stageContinueText is driven directly on a `run` fixture; what it staged is
 * read back via loadRunState. fail() routes through program.error, so
 * exitOverride turns the abort paths into catchable throws.
 */
beforeAll(() => {
  program.exitOverride();
});

const staged = (run: { cwd: string; runId: string }) => loadRunState(run.cwd, run.runId).pendingMessage;

describe('stageContinueText — non-TTY safety', () => {
  test('a bare --approve off a TTY stages no rider and never opens an editor', async ({ projectDir, run }) => {
    const marker = join(projectDir, 'editor-ran.marker');
    vi.stubEnv('VISUAL', '');
    vi.stubEnv('EDITOR', `sh -c 'touch ${marker}'`);
    await stageContinueText(run, { approve: true }, { isTTY: false });
    // No rider staged — a true no-rider approval, the run advances plain.
    expect.soft(staged(run)).toBeUndefined();
  });

  test('a bare --reject off a TTY fails fast, naming the inline / file / stdin forms', async ({ run }) => {
    await expect(stageContinueText(run, { reject: true }, { isTTY: false })).rejects.toThrow(
      /non-interactive.*--reject-file/s,
    );
    expect(staged(run)).toBeUndefined();
  });

  test('a bare --answer off a TTY fails fast, naming the inline / file / stdin forms', async ({ run }) => {
    await expect(stageContinueText(run, { answer: true }, { isTTY: false })).rejects.toThrow(
      /non-interactive.*--answer-file/s,
    );
    expect(staged(run)).toBeUndefined();
  });

  test('a bare --approve on a TTY still opens the editor (the human flow is unchanged)', async ({ projectDir, run }) => {
    const editor = join(projectDir, 'editor.sh');
    writeFileSync(editor, '#!/bin/sh\nprintf "ship it, but rename the flag\\n" >> "$1"\n', { mode: 0o755 });
    vi.stubEnv('VISUAL', '');
    vi.stubEnv('EDITOR', editor);
    await stageContinueText(run, { approve: true }, { isTTY: true });
    expect(staged(run)).toEqual({ kind: 'approval', text: 'ship it, but rename the flag' });
  });
});

describe('stageContinueText — file and stdin forms relay verbatim', () => {
  test('--reject-file relays apostrophes, em-dashes, and newlines byte-for-byte', async ({ projectDir, run }) => {
    const verbatim = "it's wrong — the contract leaks\nsplit it across two slices";
    const path = join(projectDir, 'feedback.md');
    writeFileSync(path, verbatim);
    await stageContinueText(run, { rejectFile: path }, { isTTY: false });
    expect(staged(run)).toEqual({ kind: 'feedback', text: verbatim });
  });

  test('--answer-file relays the answer verbatim', async ({ projectDir, run }) => {
    const verbatim = 'use the codex reviewer — it already has the rollout context';
    const path = join(projectDir, 'answer.md');
    writeFileSync(path, verbatim);
    await stageContinueText(run, { answerFile: path }, { isTTY: false });
    expect(staged(run)).toEqual({ kind: 'answer', text: verbatim });
  });

  test('--reject-file - reads stdin verbatim (the injected reader)', async ({ run }) => {
    const piped = "don't — the heuristic match is exactly what we removed";
    await stageContinueText(run, { rejectFile: '-' }, { isTTY: false, readStdin: async () => piped });
    expect(staged(run)).toEqual({ kind: 'feedback', text: piped });
  });

  test('an empty reject file aborts (empty feedback is meaningless)', async ({ projectDir, run }) => {
    const path = join(projectDir, 'empty.md');
    writeFileSync(path, '   \n');
    await expect(stageContinueText(run, { rejectFile: path }, { isTTY: false })).rejects.toThrow(/aborted/);
    expect(staged(run)).toBeUndefined();
  });

  test('an empty answer file aborts', async ({ projectDir, run }) => {
    const path = join(projectDir, 'empty.md');
    writeFileSync(path, '');
    await expect(stageContinueText(run, { answerFile: path }, { isTTY: false })).rejects.toThrow(/aborted/);
    expect(staged(run)).toBeUndefined();
  });

  test('mixing an inline flag with its file form fails fast (one source per intent)', async ({ run }) => {
    await expect.soft(stageContinueText(run, { reject: 'x', rejectFile: '/tmp/f' }, { isTTY: false })).rejects.toThrow(/not both/);
    await expect.soft(stageContinueText(run, { answer: 'x', answerFile: '/tmp/f' }, { isTTY: false })).rejects.toThrow(/not both/);
    expect(staged(run)).toBeUndefined();
  });
});

describe('duet steer — non-TTY fail-fast (command level)', () => {
  test('a bare steer off a TTY fails fast naming the inline form', async ({ run, projectDir }) => {
    // Drive the real command: a fresh run probes to a crashed position, so steer
    // reaches resolveHumanText, which off a TTY (vitest is non-interactive)
    // returns the sentinel instead of opening an editor — the command must fail.
    const cwd = process.cwd();
    process.chdir(projectDir);
    try {
      // Bare steer (no positionals): `steer [text] [runId]` — passing a runId
      // would land as the note text, so target the fixture run via latestRun.
      expect.soft(run.runId).toBeTruthy();
      await expect(program.parseAsync(['node', 'duet', 'steer'])).rejects.toThrow(
        /non-interactive shell — pass it inline/,
      );
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('takeover — resolving an interrupted (orphaned) turn', () => {
  test('a no-session orphan is dropped, re-opening the role — no spawn, no fail', async ({ projectDir, run }) => {
    const cwd = process.cwd();
    process.chdir(projectDir);
    try {
      // An orphan with no captured session id (its turn died before settle).
      run.pendingTurns = { reviewer: { tag: 'review-spec', startedAt: 't', status: 'running' } };
      saveRunState(run);
      await program.parseAsync(['node', 'duet', 'takeover', 'reviewer', run.runId]);
      // The orphan is cleared (role re-opened); no provider was spawned, no fail.
      expect(loadRunState(projectDir, run.runId).pendingTurns?.reviewer).toBeUndefined();
    } finally {
      process.chdir(cwd);
    }
  });

  test('no session and no orphan still fails (unregressed "no session yet")', async ({ projectDir, run }) => {
    const cwd = process.cwd();
    process.chdir(projectDir);
    try {
      await expect(program.parseAsync(['node', 'duet', 'takeover', 'reviewer', run.runId])).rejects.toThrow(
        /no session yet/,
      );
    } finally {
      process.chdir(cwd);
    }
  });
});

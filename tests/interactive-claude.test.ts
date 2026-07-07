import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { COMPACT_CONFIRMATION } from '../src/voices/providers/claude.ts';
import { InteractiveClaudeWorker, claudeProjectSlug, parseInteractiveTurn, sessionIdForNonce } from '../src/voices/providers/interactive-claude.ts';
import { claudePaneLaunchCommand } from '../src/voices/providers/pane.ts';
import { FakePane } from './helpers/fake-pane.ts';
import {
  assistantFinal,
  compactBoundary,
  session,
  toolStep,
  userMessage,
  userTurn,
} from './helpers/interactive-transcript.ts';

describe('claudePaneLaunchCommand (S2 — the forced watchdog on the interactive launch)', () => {
  test('carries API_FORCE_IDLE_TIMEOUT=1 as a command-level env prefix, keeping the flags', () => {
    const cmd = claudePaneLaunchCommand({ model: 'claude-opus-4-8' });
    // The env assignment leads the command so sh sets it for THIS claude only
    // (not inherited from the tmux server env).
    expect.soft(cmd[0]).toBe('API_FORCE_IDLE_TIMEOUT=1');
    expect.soft(cmd[1]).toBe('claude');
    expect.soft(cmd).toContain('--model');
    expect.soft(cmd).toContain('claude-opus-4-8');
    expect.soft(cmd).toContain('--permission-mode');
    expect.soft(cmd).toContain('bypassPermissions');
  });

  test('resumes a session id when present, still carrying the watchdog prefix', () => {
    const cmd = claudePaneLaunchCommand({ model: 'm', sessionId: 'sess-9' });
    expect.soft(cmd[0]).toBe('API_FORCE_IDLE_TIMEOUT=1');
    expect.soft(cmd).toContain('--resume');
    expect.soft(cmd).toContain('sess-9');
  });

  test('carries effort and appends native argv after duet-owned launch flags', () => {
    const cmd = claudePaneLaunchCommand({ model: 'm', effort: 'xhigh', nativeArgs: ['--append-system-prompt', 'extra'] });
    expect.soft(cmd[cmd.indexOf('--effort') + 1]).toBe('xhigh');
    expect.soft(cmd.slice(-2)).toEqual(['--append-system-prompt', 'extra']);
  });
});

describe('parseInteractiveTurn (the interactive-transcript boundary)', () => {
  test('extracts the final assistant text and session id for a plain turn', () => {
    const tail = session('sess-i', userTurn('do the thing', 'nonce-1'), assistantFinal('the worker did it'));
    expect(parseInteractiveTurn(tail, { nonce: 'nonce-1' })).toEqual({
      text: 'the worker did it',
      sessionId: 'sess-i',
    });
  });

  test('a tool-using turn returns the final assistant text, not intermediate narration', () => {
    const tail = session(
      'sess-i',
      userTurn('edit the file', 'nonce-1'),
      toolStep('Edit', 'file written'),
      assistantFinal('done — the edit is in'),
    );
    expect(parseInteractiveTurn(tail, { nonce: 'nonce-1' })?.text).toBe('done — the edit is in');
  });

  test('tokens and context come from the final assistant message.usage (the claudeContextUsage reuse)', () => {
    const tail = session(
      'sess-i',
      userTurn('analyze', 'nonce-1'),
      assistantFinal('analysis', {
        usage: { input_tokens: 60_000, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 2_000, output_tokens: 500 },
        contextWindow: 200_000,
      }),
    );
    const turn = parseInteractiveTurn(tail, { nonce: 'nonce-1' });
    expect.soft(turn?.tokens).toEqual({ input: 60_000, output: 500 });
    expect.soft(turn?.context).toEqual({ usedTokens: 82_500, windowTokens: 200_000 });
  });

  test('an incomplete turn (no final assistant yet) returns undefined', () => {
    const tail = session('sess-i', userTurn('start', 'nonce-1'), toolStep('Bash', 'still running'));
    expect(parseInteractiveTurn(tail, { nonce: 'nonce-1' })).toBeUndefined();
  });

  test('a /compact turn returns the synthetic confirmation and the unchanged session id', () => {
    const tail = session('sess-i', userTurn('/compact keep the plan decisions', 'nonce-1'), compactBoundary());
    expect(parseInteractiveTurn(tail, { nonce: 'nonce-1' })).toEqual({
      text: COMPACT_CONFIRMATION,
      sessionId: 'sess-i',
    });
  });

  test('a cut or partial trailing JSONL line is tolerated', () => {
    const tail =
      session('sess-i', userTurn('do it', 'nonce-1'), assistantFinal('done')) + '{"type":"assistant","mess';
    expect(parseInteractiveTurn(tail, { nonce: 'nonce-1' })?.text).toBe('done');
  });

  test('nonce isolation: only the turn whose user record carries the asked nonce is returned', () => {
    const tail = session(
      'sess-i',
      userTurn('first task', 'nonce-1'),
      assistantFinal('first answer'),
      userMessage('an unrelated user message with no nonce'),
      userTurn('second task', 'nonce-2'),
      assistantFinal('second answer'),
    );
    expect.soft(parseInteractiveTurn(tail, { nonce: 'nonce-2' })?.text).toBe('second answer');
    expect.soft(parseInteractiveTurn(tail, { nonce: 'nonce-1' })?.text).toBe('first answer');
  });
});

describe('sessionIdForNonce (the interactive early-id extractor)', () => {
  test('reads the id from the nonce-bearing record before any turn-close', () => {
    // Only the turn-open + a mid-turn tool step — no final assistant yet. The id
    // is still extractable, which is the whole point (announce mid-turn).
    const tail = session('sess-live', userTurn('do the thing', 'nonce-1'), toolStep('Read', 'still reading'));
    expect(sessionIdForNonce(tail, 'nonce-1')).toBe('sess-live');
  });

  test('is undefined until the nonce-bearing record is visible', () => {
    const tail = session('sess-live', userMessage('an unrelated message'));
    expect(sessionIdForNonce(tail, 'nonce-1')).toBeUndefined();
  });
});

describe('InteractiveClaudeWorker (driving over FakePane + a tmpdir, no live auth)', () => {
  const withFakeTimers = async (fn: () => Promise<void>): Promise<void> => {
    vi.useFakeTimers();
    try {
      await fn();
    } finally {
      vi.useRealTimers();
    }
  };
  const tmpRoot = (): string => mkdtempSync(join(tmpdir(), 'duet-iclaude-'));

  /** Wire a worker over a tmpdir root and a captured FakePane (spawn-per-turn → one pane). */
  const wire = (
    dir: string,
    paneOpts: ConstructorParameters<typeof FakePane>[1] & {},
    workerOpts: { timeoutMs?: number } = {},
  ): { worker: InteractiveClaudeWorker; pane: () => FakePane } => {
    let pane!: FakePane;
    const worker = new InteractiveClaudeWorker({
      model: 'claude-opus-4-8',
      timeoutMs: workerOpts.timeoutMs ?? 60_000,
      transcriptRoot: dir,
      newPane: (config) => (pane = new FakePane(config, paneOpts)),
    });
    return { worker, pane: () => pane };
  };

  test('polls readiness, then submits the prompt with its nonce exactly once, after ready', async () =>
    withFakeTimers(async () => {
      const dir = tmpRoot();
      const { worker, pane } = wire(dir, {
        readyAfter: 3,
        onSubmit: (text) =>
          writeFileSync(join(dir, 'ours.jsonl'), session('sess-i', userMessage(text), assistantFinal('ok'))),
      });

      const promise = worker.runTurn({ prompt: 'do the thing', cwd: dir });
      await vi.advanceTimersByTimeAsync(5_000);
      await promise;

      expect.soft(pane().submitted).toHaveLength(1);
      expect.soft(pane().events.indexOf('submit')).toBeGreaterThan(pane().events.indexOf('ready:true'));
      expect.soft(pane().submitted[0]).toContain('do the thing');
      expect.soft(pane().submitted[0]).toMatch(/\[duet-turn:[0-9a-f]{16}\]/);
      rmSync(dir, { recursive: true, force: true });
    }));

  test('drives a full turn to a parsed WorkerTurn and tears the pane down once', async () =>
    withFakeTimers(async () => {
      const dir = tmpRoot();
      const { worker, pane } = wire(dir, {
        readyAfter: 1,
        onSubmit: (text) =>
          writeFileSync(
            join(dir, 'ours.jsonl'),
            session(
              'sess-i',
              userMessage(text),
              assistantFinal('the worker did it', {
                usage: { input_tokens: 1000, output_tokens: 50 },
                contextWindow: 200_000,
              }),
            ),
          ),
      });

      const promise = worker.runTurn({ prompt: 'do it', cwd: dir });
      await vi.advanceTimersByTimeAsync(5_000);
      const turn = await promise;

      expect.soft(turn).toEqual({
        text: 'the worker did it',
        sessionId: 'sess-i',
        tokens: { input: 1000, output: 50 },
        context: { usedTokens: 1050, windowTokens: 200_000 },
      });
      expect.soft(pane().events.filter((e) => e === 'kill')).toHaveLength(1);
      rmSync(dir, { recursive: true, force: true });
    }));

  test('a fresh turn announces its id from the transcript BEFORE the turn completes', async () =>
    withFakeTimers(async () => {
      const dir = tmpRoot();
      const announced: string[] = [];
      const { worker, pane } = wire(dir, {
        readyAfter: 0,
        // First only the turn-open + a mid-turn tool step land — id visible, turn open.
        onSubmit: (text) =>
          writeFileSync(join(dir, 'ours.jsonl'), session('sess-live', userMessage(text), toolStep('Read', 'mid-turn'))),
      });

      const promise = worker.runTurn({ prompt: 'do it', cwd: dir, onSessionId: (id) => announced.push(id) });
      await vi.advanceTimersByTimeAsync(5_000); // poll ticks: id located + announced, turn not yet closed
      expect.soft(announced).toEqual(['sess-live']); // announced while still running

      // Now close the turn, reusing the captured body so the nonce matches.
      writeFileSync(join(dir, 'ours.jsonl'), session('sess-live', userMessage(pane().submitted[0]!), assistantFinal('done')));
      await vi.advanceTimersByTimeAsync(5_000);
      const turn = await promise;
      expect.soft(turn.text).toBe('done');
      expect.soft(announced).toEqual(['sess-live']); // exactly once
      rmSync(dir, { recursive: true, force: true });
    }));

  test('a resume turn announces its id immediately, without waiting on the transcript', async () =>
    withFakeTimers(async () => {
      const dir = tmpRoot();
      const announced: string[] = [];
      const { worker } = wire(dir, {
        readyAfter: 1,
        onSubmit: (text) => writeFileSync(join(dir, 'ours.jsonl'), session('sess-resumed', userMessage(text), assistantFinal('done'))),
      });

      const promise = worker.runTurn({ prompt: 'go', cwd: dir, sessionId: 'sess-resumed', onSessionId: (id) => announced.push(id) });
      expect.soft(announced).toEqual(['sess-resumed']); // fired synchronously, before any await/poll
      await vi.advanceTimersByTimeAsync(5_000);
      await promise;
      expect.soft(announced).toEqual(['sess-resumed']); // and not re-announced from the transcript
      rmSync(dir, { recursive: true, force: true });
    }));

  test('a session that never becomes ready rejects at the deadline, pane still killed', async () =>
    withFakeTimers(async () => {
      const dir = tmpRoot();
      const { worker, pane } = wire(dir, { readyAfter: Number.POSITIVE_INFINITY });

      const promise = worker.runTurn({ prompt: 'do it', cwd: dir });
      const assertion = expect(promise).rejects.toThrow(/not ready for input before the per-turn timeout/);
      await vi.advanceTimersByTimeAsync(61_000);
      await assertion;

      expect(pane().killed).toBe(true);
      rmSync(dir, { recursive: true, force: true });
    }));

  test('a located-but-incomplete turn settles as a resumable aborted checkpoint at the deadline, pane still killed (S5)', async () =>
    withFakeTimers(async () => {
      const dir = tmpRoot();
      const { worker, pane } = wire(dir, {
        readyAfter: 0,
        // turn-open + a tool step, but no final assistant — the post-injection stall.
        // The nonce IS correlated (the prompt was injected and accepted), so the
        // deadline now yields a resumable aborted checkpoint (resume, don't re-send)
        // — the interactive accepted-abort split — rather than the old infra reject.
        onSubmit: (text) =>
          writeFileSync(join(dir, 'ours.jsonl'), session('sess-i', userMessage(text), toolStep('Bash', 'running'))),
      });

      const promise = worker.runTurn({ prompt: 'do it', cwd: dir });
      await vi.advanceTimersByTimeAsync(61_000);
      const turn = await promise;

      expect.soft(turn.aborted).toBe(true);
      expect.soft(turn.sessionId).toBe('sess-i'); // the resumable handle, from the correlated transcript
      expect.soft(pane().killed).toBe(true); // the finally still tears the pane down (Finding 4)
      rmSync(dir, { recursive: true, force: true });
    }));

  test('a submit failure still tears the pane down (the finally)', async () =>
    withFakeTimers(async () => {
      const dir = tmpRoot();
      const { worker, pane } = wire(dir, { readyAfter: 0, throwOnSubmit: new Error('tmux paste-buffer failed') });

      const promise = worker.runTurn({ prompt: 'do it', cwd: dir });
      const assertion = expect(promise).rejects.toThrow(/paste-buffer/);
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;

      expect(pane().killed).toBe(true);
      rmSync(dir, { recursive: true, force: true });
    }));

  test('correlates by nonce, not recency — picks the transcript carrying the nonce among decoys', async () =>
    withFakeTimers(async () => {
      const dir = tmpRoot();
      const { worker } = wire(dir, {
        readyAfter: 0,
        onSubmit: (text) => {
          // our turn's transcript carries the nonce...
          writeFileSync(join(dir, 'ours.jsonl'), session('ours-sess', userMessage(text), assistantFinal('right answer')));
          // ...and the concurrent orchestrator session writes a NEWER decoy with no nonce
          writeFileSync(
            join(dir, 'decoy.jsonl'),
            session('decoy-sess', userMessage('an unrelated concurrent turn'), assistantFinal('wrong answer')),
          );
        },
      });

      const promise = worker.runTurn({ prompt: 'do it', cwd: dir });
      await vi.advanceTimersByTimeAsync(5_000);
      const turn = await promise;

      expect.soft(turn.text).toBe('right answer');
      expect.soft(turn.sessionId).toBe('ours-sess');
      rmSync(dir, { recursive: true, force: true });
    }));

  test('no nonce-bearing transcript is never silently substituted — rejects at the deadline', async () =>
    withFakeTimers(async () => {
      const dir = tmpRoot();
      const { worker } = wire(dir, {
        readyAfter: 0,
        onSubmit: () =>
          writeFileSync(join(dir, 'decoy.jsonl'), session('decoy', userMessage('no nonce here'), assistantFinal('decoy answer'))),
      });

      const promise = worker.runTurn({ prompt: 'do it', cwd: dir });
      const assertion = expect(promise).rejects.toThrow(/could not correlate the turn transcript/);
      await vi.advanceTimersByTimeAsync(61_000);
      await assertion;
      rmSync(dir, { recursive: true, force: true });
    }));

  test('a nonce matching more than one transcript throws rather than guessing', async () =>
    withFakeTimers(async () => {
      const dir = tmpRoot();
      const { worker } = wire(dir, {
        readyAfter: 0,
        onSubmit: (text) => {
          writeFileSync(join(dir, 'a.jsonl'), session('a', userMessage(text), assistantFinal('answer a')));
          writeFileSync(join(dir, 'b.jsonl'), session('b', userMessage(text), assistantFinal('answer b')));
        },
      });

      const promise = worker.runTurn({ prompt: 'do it', cwd: dir });
      const assertion = expect(promise).rejects.toThrow(/matched 2 session transcripts/);
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      rmSync(dir, { recursive: true, force: true });
    }));

  test('refuses a read-only turn before spawning anything (architect-only transport)', async () => {
    let paneBuilt = false;
    const worker = new InteractiveClaudeWorker({
      model: 'claude-opus-4-8',
      timeoutMs: 60_000,
      transcriptRoot: '/nonexistent',
      newPane: (config) => {
        paneBuilt = true;
        return new FakePane(config);
      },
    });

    await expect(worker.runTurn({ prompt: 'review this', readOnly: true, cwd: '/x' })).rejects.toThrow(
      /cannot run a read-only turn/,
    );
    expect(paneBuilt).toBe(false);
  });

  test('correlates a resumed turn by the appended nonce — a pre-existing session file (Finding 2)', async () =>
    withFakeTimers(async () => {
      const dir = tmpRoot();
      const file = join(dir, 'sess-i.jsonl');
      // a prior turn already sits in the resumed session file before this turn runs
      writeFileSync(file, session('sess-i', userTurn('an earlier turn', 'old-nonce'), assistantFinal('earlier answer')));
      const { worker } = wire(dir, {
        readyAfter: 0,
        // this turn APPENDS to the same file — correlation must find it by nonce, not recency
        onSubmit: (text) => appendFileSync(file, session('sess-i', userMessage(text), assistantFinal('resumed answer'))),
      });

      const promise = worker.runTurn({ prompt: 'do it', sessionId: 'sess-i', cwd: dir });
      await vi.advanceTimersByTimeAsync(5_000);
      const turn = await promise;

      expect.soft(turn.text).toBe('resumed answer');
      expect.soft(turn.sessionId).toBe('sess-i');
      rmSync(dir, { recursive: true, force: true });
    }));

  test('finds the transcript in the cwd-scoped project dir (the fast path)', async () =>
    withFakeTimers(async () => {
      const dir = tmpRoot();
      const cwd = '/proj/example';
      const scoped = join(dir, claudeProjectSlug(cwd));
      mkdirSync(scoped, { recursive: true });
      const { worker } = wire(dir, {
        readyAfter: 0,
        onSubmit: (text) =>
          writeFileSync(join(scoped, 'sess.jsonl'), session('scoped-sess', userMessage(text), assistantFinal('scoped answer'))),
      });

      const promise = worker.runTurn({ prompt: 'do it', cwd });
      await vi.advanceTimersByTimeAsync(5_000);
      const turn = await promise;

      expect.soft(turn.text).toBe('scoped answer');
      expect.soft(turn.sessionId).toBe('scoped-sess');
      rmSync(dir, { recursive: true, force: true });
    }));

  test('falls back to the root scan when the scoped slug dir exists but lacks the turn (wrong-slug shape)', async () =>
    withFakeTimers(async () => {
      const dir = tmpRoot();
      const cwd = '/proj/example';
      const scoped = join(dir, claudeProjectSlug(cwd));
      mkdirSync(scoped, { recursive: true });
      // the scoped dir exists but holds only a decoy without our nonce...
      writeFileSync(join(scoped, 'decoy.jsonl'), session('decoy', userMessage('unrelated'), assistantFinal('wrong')));
      const { worker } = wire(dir, {
        readyAfter: 0,
        // ...and the real transcript lands elsewhere under the root (a wrong slug guess)
        onSubmit: (text) =>
          writeFileSync(join(dir, 'real.jsonl'), session('real-sess', userMessage(text), assistantFinal('right answer'))),
      });

      const promise = worker.runTurn({ prompt: 'do it', cwd });
      await vi.advanceTimersByTimeAsync(5_000);
      const turn = await promise;

      expect.soft(turn.text).toBe('right answer');
      expect.soft(turn.sessionId).toBe('real-sess');
      rmSync(dir, { recursive: true, force: true });
    }));
});

describe('claudeProjectSlug', () => {
  test("maps a cwd to Claude Code's project-dir name (known case; Slice 5 confirms the rule)", () => {
    expect(claudeProjectSlug('/Users/qiushi/dev/duet')).toBe('-Users-qiushi-dev-duet');
  });
});

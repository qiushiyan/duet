import { closeSync, openSync, readSync, readdirSync, fstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Codex, type ThreadEvent, type ThreadOptions, type Usage } from '@openai/codex-sdk';
import type { ContextUsage, RunTurnOptions, WorkerProvider, WorkerTurn } from './types.ts';
import { WallClockExceededError, runWithWallClockDeadline } from './wall-clock.ts';

/**
 * Codex worker provider, via `@openai/codex-sdk` (a thin spawn-the-CLI
 * wrapper, pinned to the same release as the bundled CLI). Rollouts land in
 * `~/.codex/sessions/`, so the session stays manually resumable with
 * `codex exec resume <id>` (augmentation principle).
 *
 * Deliberately no model key AND no sandbox flag: the user's own
 * `~/.codex/config.toml` governs model, reasoning effort, AND the sandbox /
 * approval posture (docs/automation-design.md §"Roles are decoupled from
 * providers"). See `codexThreadOptions` for why duet imposes no `--sandbox`.
 */

/**
 * Context fill from a codex rollout tail: the last `token_count` event
 * carries `last_token_usage` (the most recent request — its total IS what
 * sits in the context window; `input_tokens` already includes the cached
 * subset, verified against live rollouts where total = input + output
 * exactly) and `model_context_window`. Exported as the testable parsing seam.
 */
export function parseRolloutContext(jsonlTail: string): ContextUsage | undefined {
  const lines = jsonlTail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"token_count"')) continue;
    try {
      const event = JSON.parse(line) as {
        payload?: {
          type?: string;
          info?: { last_token_usage?: { total_tokens?: number }; model_context_window?: number } | null;
        };
      };
      const info = event.payload?.type === 'token_count' ? event.payload.info : undefined;
      if (info?.last_token_usage?.total_tokens !== undefined && info.model_context_window) {
        return { usedTokens: info.last_token_usage.total_tokens, windowTokens: info.model_context_window };
      }
    } catch {
      // A cut or foreign line — keep scanning backwards.
    }
  }
  return undefined;
}

const SESSIONS_ROOT = join(homedir(), '.codex', 'sessions');
const TAIL_BYTES = 64 * 1024;

/**
 * The thread options for a codex turn, extracted as a pure builder (mirroring
 * claudeArgs) so the sandbox posture is verifiable by test.
 *
 * It deliberately sets NO `sandboxMode`: the `@openai/codex-sdk` appends
 * `--sandbox <mode>` to the CLI argv only when `sandboxMode` is truthy, so
 * omitting it lets the user's `~/.codex/config.toml` (or active profile)
 * govern the sandbox + approval posture — the same way duet already defers
 * the model and reasoning effort to that file.
 *
 * This reversed a derived `opts.readOnly ? 'read-only' : 'workspace-write'`
 * mapping (2026-06-22). That override conflated "this role must not mutate the
 * repo" with "this role may touch nothing locally": codex `read-only` is a
 * Seatbelt profile that denies ALL filesystem writes and network, so it killed
 * the read-only reviewer's own evidence tooling (a tsx/Node tool's `$TMPDIR`
 * IPC socket dies with `listen EPERM`; outbound reads are blocked) AND it
 * overrode the user's config. The reviewer's review-only behavior is a
 * prompt-level convention now (the review-* snippets ask for critique, not
 * edits), not an OS sandbox — `opts.readOnly` no longer shapes the launch.
 */
export function codexThreadOptions(opts: { cwd?: string }): ThreadOptions {
  return { ...(opts.cwd !== undefined ? { workingDirectory: opts.cwd } : {}) };
}

/**
 * Drain a codex event stream into the turn's final text + usage, announcing the
 * session id on the first `thread.started` event (the earliest a FRESH thread
 * knows it). This is exactly the reduction the SDK's own non-streaming `run()`
 * performs over the same events — lifted out so duet can observe the id mid-turn
 * (run() surfaces it only after the whole turn resolves) and can be tested
 * against a synthetic event stream, the parseClaudeTurn-style provider seam. A
 * `turn.failed` throws its message, matching run()'s own behavior.
 */
export async function reconstructCodexTurn(
  events: AsyncIterable<ThreadEvent>,
  onSessionId?: (id: string) => void,
  onThreadStarted?: (threadId: string) => void,
): Promise<{ finalResponse: string; usage: Usage | null }> {
  let finalResponse = '';
  let usage: Usage | null = null;
  for await (const event of events) {
    if (event.type === 'thread.started') {
      onSessionId?.(event.thread_id);
      // The acceptance signal, distinct from onSessionId: this fires ONLY from
      // the stream's thread.started, so it proves THIS turn's prompt was accepted
      // — onSessionId also fires pre-stream for a resumed thread (a heartbeat /
      // session-location signal), which is not proof the new prompt was accepted.
      onThreadStarted?.(event.thread_id);
    } else if (event.type === 'item.completed') {
      if (event.item.type === 'agent_message') finalResponse = event.item.text;
    } else if (event.type === 'turn.completed') {
      usage = event.usage;
    } else if (event.type === 'turn.failed') {
      throw new Error(event.error.message);
    }
  }
  return { finalResponse, usage };
}

/**
 * Recover a codex turn that threw out of its wall-clock-bounded stream. A
 * WallClockExceededError whose turn actually started (thread.started seen this
 * turn ⇒ `startedThreadId` set) is a resumable aborted CHECKPOINT — resume with
 * `codex exec resume <id>`, don't re-send. Anything else (the abort fired before
 * thread.started — a pre-flight failure — or a non-abort error) propagates as
 * infra (retry verbatim). The pure decision seam, so the accepted/never-accepted
 * split is testable without the real SDK stream (mirrors recoverClaudeFailure).
 */
export function recoverCodexAbort(err: unknown, startedThreadId: string | undefined): WorkerTurn {
  if (err instanceof WallClockExceededError && startedThreadId !== undefined) {
    return { text: '', sessionId: startedThreadId, aborted: true };
  }
  throw err instanceof Error ? err : new Error(String(err));
}

export class CodexWorker implements WorkerProvider {
  readonly name = 'codex' as const;
  private readonly codex = new Codex();
  private readonly timeoutMs: number;
  /** Rollout path per session — the recursive name scan runs once per session, not per turn. */
  private readonly rolloutPaths = new Map<string, string>();

  constructor(config?: { timeoutMs?: number }) {
    this.timeoutMs = config?.timeoutMs ?? 15 * 60_000;
  }

  async runTurn(opts: RunTurnOptions): Promise<WorkerTurn> {
    const threadOptions = codexThreadOptions(opts);
    const thread = opts.sessionId
      ? this.codex.resumeThread(opts.sessionId, threadOptions)
      : this.codex.startThread(threadOptions);
    // A resume already knows its id (resumeThread seeds it), so announce it now;
    // a fresh thread learns its id on the first stream event, where
    // reconstructCodexTurn announces it. Either way the live-activity poll has
    // this turn's id at/near its start — not only after it settles.
    if (opts.sessionId) opts.onSessionId?.(opts.sessionId);

    // runStreamed (not run): draining the events ourselves is what lets us see
    // thread.started — and the session id — mid-turn. run() exposes the id only
    // after it resolves, which is the blindness this whole change removes.
    // Effective cap: a per-turn override wins over the construction value (which
    // already carries codex's 15-min default) — two-tier, no extra floor here.
    const effectiveTimeoutMs = opts.timeoutMs ?? this.timeoutMs;
    // Own the AbortController so the wall-clock backstop drives the abort.
    // AbortSignal.timeout is MONOTONIC — a suspend freezes it, so a suspended
    // codex turn would never hit the abort S5's honest accepted-abort recovery
    // depends on. The wall-clock helper re-checks real time and aborts on wake.
    const controller = new AbortController();
    // Set ONLY by the stream's thread.started (not onSessionId) — the honest
    // proof THIS turn's prompt was accepted, which recoverCodexAbort keys on.
    let startedThreadId: string | undefined;
    let finalResponse: string;
    let usage: Usage | null;
    try {
      ({ finalResponse, usage } = await runWithWallClockDeadline({
        run: (async () => {
          const { events } = await thread.runStreamed(opts.prompt, { signal: controller.signal });
          return reconstructCodexTurn(events, opts.onSessionId, (id) => {
            startedThreadId = id;
          });
        })(),
        abort: () => controller.abort(),
        capMs: effectiveTimeoutMs,
      }));
    } catch (err) {
      // A wall-clock abort after thread.started is a resumable aborted checkpoint;
      // anything else (pre-acceptance abort, or a non-abort failure) re-throws.
      return recoverCodexAbort(err, startedThreadId);
    }

    const sessionId = thread.id;
    if (!sessionId) throw new Error('codex worker turn completed without a thread id');
    const context = this.contextUsage(sessionId);
    return {
      text: finalResponse,
      sessionId,
      tokens: usage
        ? {
            // input_tokens already includes the cached subset (rollout
            // arithmetic: total = input + output) — adding cached_input_tokens
            // would double-count it.
            input: usage.input_tokens,
            output: usage.output_tokens,
          }
        : undefined,
      ...(context ? { context } : {}),
    };
  }

  /**
   * Best-effort, fail-soft: locate the session's rollout under
   * `~/.codex/sessions/<y>/<m>/<d>/rollout-<ts>-<id>.jsonl` and read its
   * tail for the last token_count event. Any failure means "no context
   * reading", never a failed turn.
   */
  private contextUsage(sessionId: string): ContextUsage | undefined {
    try {
      let path = this.rolloutPaths.get(sessionId);
      if (!path) {
        const match = readdirSync(SESSIONS_ROOT, { recursive: true })
          .map(String)
          .find((p) => p.endsWith(`-${sessionId}.jsonl`));
        if (!match) return undefined;
        path = join(SESSIONS_ROOT, match);
        this.rolloutPaths.set(sessionId, path);
      }
      const fd = openSync(path, 'r');
      try {
        const size = fstatSync(fd).size;
        const length = Math.min(size, TAIL_BYTES);
        const buffer = Buffer.alloc(length);
        readSync(fd, buffer, 0, length, size - length);
        return parseRolloutContext(buffer.toString('utf8'));
      } finally {
        closeSync(fd);
      }
    } catch {
      return undefined;
    }
  }
}

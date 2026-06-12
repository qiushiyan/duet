import { closeSync, openSync, readSync, readdirSync, fstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Codex } from '@openai/codex-sdk';
import type { ContextUsage, RunTurnOptions, WorkerProvider, WorkerTurn } from './types.ts';

/**
 * Codex worker provider, via `@openai/codex-sdk` (a thin spawn-the-CLI
 * wrapper, pinned to the same release as the bundled CLI). Rollouts land in
 * `~/.codex/sessions/`, so the session stays manually resumable with
 * `codex exec resume <id>` (augmentation principle).
 *
 * Deliberately no model key: the user's own `~/.codex/config.toml` governs
 * model and reasoning effort (docs/automation-design.md §"Roles are
 * decoupled from providers").
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
    const threadOptions = {
      sandboxMode: opts.readOnly ? ('read-only' as const) : ('workspace-write' as const),
      workingDirectory: opts.cwd,
    };
    const thread = opts.sessionId
      ? this.codex.resumeThread(opts.sessionId, threadOptions)
      : this.codex.startThread(threadOptions);

    const turn = await thread.run(opts.prompt, { signal: AbortSignal.timeout(this.timeoutMs) });

    const sessionId = thread.id;
    if (!sessionId) throw new Error('codex worker turn completed without a thread id');
    const context = this.contextUsage(sessionId);
    return {
      text: turn.finalResponse,
      sessionId,
      tokens: turn.usage
        ? {
            // input_tokens already includes the cached subset (rollout
            // arithmetic: total = input + output) — adding cached_input_tokens
            // would double-count it.
            input: turn.usage.input_tokens,
            output: turn.usage.output_tokens,
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

import { Codex } from '@openai/codex-sdk';
import type { RunTurnOptions, WorkerProvider, WorkerTurn } from './types.ts';

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
export class CodexWorker implements WorkerProvider {
  readonly name = 'codex' as const;
  private readonly codex = new Codex();
  private readonly timeoutMs: number;

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
    return {
      text: turn.finalResponse,
      sessionId,
      tokens: turn.usage
        ? {
            input: turn.usage.input_tokens + turn.usage.cached_input_tokens,
            output: turn.usage.output_tokens,
          }
        : undefined,
    };
  }
}

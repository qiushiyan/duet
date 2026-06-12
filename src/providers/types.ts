/**
 * Role–provider decoupling (docs/automation-design.md §"Roles are decoupled
 * from providers"): a role is a capability contract; a provider is an
 * implementation that can serve one or more roles. Exactly two providers
 * exist — `claude` and `codex`. A third provider means forking the code.
 */

/** The two worker roles the orchestrator routes between. */
export type WorkerRole = 'implementer' | 'reviewer';

/**
 * What currently fills a session's context window, captured at a turn
 * boundary. One shape over provider-specific math: claude counts the last
 * request's input + cache reads + cache creation + output against the
 * model's window (the same formula Claude Code's own statusline uses);
 * codex reads its rollout's last token_count event
 * (last_token_usage.total_tokens against model_context_window).
 */
export interface ContextUsage {
  usedTokens: number;
  windowTokens: number;
}

/** One completed worker turn. */
export interface WorkerTurn {
  /** The worker's final message text. */
  text: string;
  /** Provider-native session id — resumable manually (augmentation principle). */
  sessionId: string;
  /** USD cost of the turn, when the provider reports it (claude does; codex reports tokens only). */
  costUsd?: number;
  /** Token usage, when the provider reports it. */
  tokens?: { input: number; output: number };
  /** Context-window fill after this turn, when the provider can tell (best-effort, never load-bearing). */
  context?: ContextUsage;
}

export interface RunTurnOptions {
  prompt: string;
  /** Resume an existing session; omit to start a new one. */
  sessionId?: string;
  /** Worker may not write or execute. Maps to `-s read-only` (codex) / restricted tools (claude). */
  readOnly?: boolean;
  cwd?: string;
}

/** A provider serving a worker role (implementer or reviewer). */
export interface WorkerProvider {
  readonly name: 'claude' | 'codex';
  runTurn(opts: RunTurnOptions): Promise<WorkerTurn>;
}

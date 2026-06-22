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
  /**
   * The turn was cut short by the worker's budget cap, but a recoverable result
   * arrived (a session id is present, so this is a settleable WorkerTurn). A
   * resumable CHECKPOINT — committed work is on disk, the session resumes for
   * the remainder — never an infra failure. The session-less cutoff is the
   * distinct `BudgetCutoffError` (no WorkerTurn, since sessionId is required).
   */
  budgetTruncated?: true;
}

/**
 * A budget cutoff with NO recoverable result — the fallback tier. A typed error
 * (NOT a WorkerTurn, whose `sessionId` is required and which `settleTurn` writes
 * unconditionally), so the harness distinguishes a budget-control stop from
 * generic infra and never routes it to the retry/auto-retry/errorClass path:
 * the worker ran and committed work may be on disk, but no session id was
 * recovered to settle or resume from. Lives here (provider-agnostic types), not
 * in the claude adapter, so the harness can `instanceof`-check it without
 * value-importing a concrete provider.
 */
export class BudgetCutoffError extends Error {
  readonly kind = 'budget' as const;
  constructor(message: string) {
    super(message);
    this.name = 'BudgetCutoffError';
  }
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

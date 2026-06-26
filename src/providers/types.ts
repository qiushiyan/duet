/**
 * Role–provider decoupling (docs/automation-design.md §"Roles are decoupled
 * from providers"): a role is a capability contract; a provider is an
 * implementation that can serve one or more roles. Exactly two providers
 * exist — `claude` and `codex`. A third provider means forking the code.
 */

/**
 * The worker roles the orchestrator routes between. `implementer` and
 * `reviewer` are the always-present base; `consultant` is the optional second
 * reviewer — an independent cross-family voice, bound only when configured.
 */
export type WorkerRole = 'implementer' | 'reviewer' | 'consultant';

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
  /**
   * The turn was cut short by a connection drop AFTER the worker generated real
   * partial work (a "mid-response" failure), and the session is resumable. Like
   * `budgetTruncated`, a settled CHECKPOINT — the partial work + session are
   * captured, so the orchestrator resumes with a short continuation rather than
   * re-sending the original prompt. Distinguished from a "pre-flight" failure (no
   * generation, nothing to resume → an infra error) by the presence of real
   * generated content, never by the error wording.
   */
  interrupted?: true;
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
  /**
   * Marks the read-only reviewer role. A role-intent HINT, not an OS guarantee
   * (2026-06-22): the headless providers run full-permission — codex defers to
   * `~/.codex/config.toml` (no `--sandbox`), claude uses `bypassPermissions` —
   * and the reviewer's review-only behavior rests on the review-* snippets, not
   * a sandbox. The interactive claude transport is the lone consumer that still
   * acts on it: being implementer-only, it refuses a read-only (reviewer) turn.
   */
  readOnly?: boolean;
  cwd?: string;
  /**
   * Fired with this turn's provider session id as EARLY as the provider knows
   * it — before spawn (claude: a freshly minted id, or the resume id) or on the
   * first stream event (codex: `thread.started`). The harness stages it onto the
   * active-turn hint so the live-activity poll can locate this turn's transcript
   * from at/near its start, rather than only after it settles (the symptom this
   * callback removes: a worker's FIRST turn — and every ephemeral consultant turn
   * — was blind, because the only locate key was the settled `workerSessions` id).
   * Best-effort telemetry: an adapter that never fires it simply leaves the turn
   * silent, exactly as before.
   */
  onSessionId?: (id: string) => void;
}

/** A provider serving a worker role (implementer, reviewer, or consultant). */
export interface WorkerProvider {
  readonly name: 'claude' | 'codex';
  runTurn(opts: RunTurnOptions): Promise<WorkerTurn>;
}

/**
 * The run's built worker providers: the always-present base pair plus the
 * optional consultant, built only when a consultant is bound. Required-base
 * over a closed `Record<WorkerRole, …>` keeps the unbound run's map byte-for-byte
 * today's; the optional consultant is why dynamic access goes through
 * `providerFor` (src/providers/index.ts), never `providers[role]` directly
 * (indexing this by a `WorkerRole` variable yields `WorkerProvider | undefined`).
 */
export type WorkerProviders = Record<'implementer' | 'reviewer', WorkerProvider> & {
  consultant?: WorkerProvider;
};

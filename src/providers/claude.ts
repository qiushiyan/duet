import { execa } from 'execa';
import { z } from 'zod';
import { BudgetCutoffError } from './types.ts';
import type { RunTurnOptions, WorkerProvider, WorkerTurn } from './types.ts';

/**
 * What a successful `/compact` turn returns in place of an empty result: the
 * CLI emits only a compact-boundary event, so the provider substitutes a named
 * confirmation rather than hand the orchestrator a blank response. Shared by
 * both claude transports — the headless path (below) and the interactive
 * transport (interactive-claude.ts) must return the IDENTICAL string, because
 * the impl phase's first act is a `/compact` turn and the orchestrator keys on
 * this exact text.
 */
export const COMPACT_CONFIRMATION =
  '(session compacted — context was reset per the instructions; the conversation continues from the summary)';

/**
 * Claude worker provider: spawns `claude -p --output-format json`, which
 * returns a `{result, session_id, total_cost_usd}` envelope and appends to
 * the standard `~/.claude/projects/` transcript (resumable manually).
 *
 * The claude provider is configured per-model — choosing the Anthropic model
 * per role is a knob the user actually turns.
 */

const resultEnvelope = z.looseObject({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().optional(),
  session_id: z.string(),
  total_cost_usd: z.number().optional(),
  usage: z.looseObject({ input_tokens: z.number().optional(), output_tokens: z.number().optional() }).optional(),
  modelUsage: z
    .record(z.string(), z.looseObject({ contextWindow: z.number().optional() }))
    .optional(),
});

/**
 * A budget-cutoff result element, parsed LOOSELY — `session_id` is OPTIONAL here
 * (it is required on `resultEnvelope`). A budget cutoff is a checkpoint, not a
 * failure, so it must be recognized BEFORE the strict parse that would Zod-throw
 * on a session-less cutoff and misread it as infra. Empirically (claude 2.1.185)
 * the cutoff carries a session id + total_cost_usd + modelUsage but NO `result`
 * field; the partial text lives in the preceding assistant element.
 */
const budgetCutoffEnvelope = z.looseObject({
  type: z.literal('result'),
  subtype: z.literal('error_max_budget_usd'),
  session_id: z.string().optional(),
  total_cost_usd: z.number().optional(),
  modelUsage: z.record(z.string(), z.looseObject({ contextWindow: z.number().optional() })).optional(),
});

/** Per-request usage on an assistant message — the context-window arithmetic's input. */
const assistantUsage = z.looseObject({
  input_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
});

/**
 * Context fill from a claude session's message stream: the LAST assistant
 * message's request usage (everything the request carried: fresh input,
 * cache reads, cache writes, output) against the model's context window
 * from the result's modelUsage. Either side missing → undefined, honestly.
 */
export function claudeContextUsage(
  candidates: unknown[],
  modelUsage: Record<string, { contextWindow?: number }> | undefined,
): { usedTokens: number; windowTokens: number } | undefined {
  let last: z.infer<typeof assistantUsage> | undefined;
  for (const m of candidates) {
    if (typeof m !== 'object' || m === null) continue;
    const message = (m as { type?: unknown; message?: { usage?: unknown } });
    if (message.type !== 'assistant' || !message.message?.usage) continue;
    const parsed = assistantUsage.safeParse(message.message.usage);
    if (parsed.success) last = parsed.data;
  }
  const windowTokens = Math.max(0, ...Object.values(modelUsage ?? {}).map((m) => m.contextWindow ?? 0));
  if (!last || windowTokens === 0) return undefined;
  const usedTokens =
    (last.input_tokens ?? 0) +
    (last.cache_read_input_tokens ?? 0) +
    (last.cache_creation_input_tokens ?? 0) +
    (last.output_tokens ?? 0);
  return { usedTokens, windowTokens };
}

/**
 * The last assistant message's text, joined across its text blocks. Used for a
 * budget cutoff's best-effort partial text — the budget `result` element carries
 * no `result` field, so what the worker produced before the cap lives in the
 * assistant element(s). Undefined when there is no assistant text to recover.
 */
function lastAssistantText(candidates: unknown[]): string | undefined {
  let text: string | undefined;
  for (const m of candidates) {
    if (typeof m !== 'object' || m === null) continue;
    const msg = m as { type?: unknown; message?: { content?: unknown } };
    if (msg.type !== 'assistant' || !Array.isArray(msg.message?.content)) continue;
    const parts = msg.message.content
      .filter(
        (b): b is { type: 'text'; text: string } =>
          typeof b === 'object' &&
          b !== null &&
          (b as { type?: unknown }).type === 'text' &&
          typeof (b as { text?: unknown }).text === 'string',
      )
      .map((b) => b.text);
    if (parts.length > 0) text = parts.join('');
  }
  return text;
}

/**
 * The real partial text a worker generated before a mid-response failure — the
 * assistant text blocks across the stream, EXCLUDING the element whose text is
 * the error itself (the `-p` stream renders an API error as a trailing assistant
 * `text` block, so a naive "last assistant text" would mistake every failure —
 * pre-flight included — for a mid-response one). The error element is identified
 * structurally, by its text equalling the result envelope's own `result` string
 * (a same-response comparison, robust to any rewording), never a hardcoded
 * message. Empty when nothing real was generated (a pre-flight failure).
 */
export function partialBeforeError(candidates: unknown[], errorText: string): string {
  const err = errorText.trim();
  const parts: string[] = [];
  for (const m of candidates) {
    if (typeof m !== 'object' || m === null) continue;
    const msg = m as { type?: unknown; message?: { content?: unknown } };
    if (msg.type !== 'assistant' || !Array.isArray(msg.message?.content)) continue;
    for (const b of msg.message.content) {
      if (typeof b !== 'object' || b === null || (b as { type?: unknown }).type !== 'text') continue;
      const t = (b as { text?: unknown }).text;
      if (typeof t === 'string' && t.trim() && t.trim() !== err) parts.push(t);
    }
  }
  return parts.join('');
}

/**
 * The `claude -p` envelope reported a failed turn — `message` is the CLI's own
 * reason (an API / auth / network error — whatever the `result` field held). A
 * distinct type, not matched by wording, so recoverClaudeFailure can propagate
 * this clean reason while routing genuinely unparseable output down the
 * exit-code/stderr path instead.
 */
export class ClaudeTurnFailedError extends Error {}

/**
 * Parse one `--output-format json` invocation's stdout into a WorkerTurn.
 * Current CLI versions emit an array of all session messages (older versions
 * emitted the result object alone); the envelope is the element with
 * type === 'result'. Exported as the provider's testable parsing seam.
 */
export function parseClaudeTurn(stdout: string, prompt: string): WorkerTurn {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`claude worker stdout was not JSON (${stdout.length} bytes) — did the CLI version change its output format?`);
  }
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  const raw = candidates.find((m) => typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'result');
  if (!raw) {
    throw new Error(`claude worker output contained no result message (${stdout.length} bytes)`);
  }
  // A budget cutoff is a checkpoint, not a failure — recognize it BEFORE the
  // strict envelope parse (which requires session_id and would Zod-throw on a
  // session-less cutoff, misreading it as infra). With a session id it settles
  // as a budgetTruncated WorkerTurn; without one it is the BudgetCutoffError
  // fallback (no settleable turn). Never the infra/retry path either way.
  if ((raw as { subtype?: unknown }).subtype === 'error_max_budget_usd') {
    const budget = budgetCutoffEnvelope.safeParse(raw);
    const sessionId = budget.success ? budget.data.session_id : undefined;
    if (sessionId === undefined) {
      throw new BudgetCutoffError(
        'the worker reached its budget cap with no recoverable session id — committed work may be on disk (check git); resume manually once a session id is available, or raise the budget',
      );
    }
    const text = lastAssistantText(candidates) ?? '';
    const context = claudeContextUsage(candidates, budget.success ? budget.data.modelUsage : undefined);
    return {
      text,
      sessionId,
      budgetTruncated: true,
      ...(budget.success && budget.data.total_cost_usd !== undefined ? { costUsd: budget.data.total_cost_usd } : {}),
      ...(context ? { context } : {}),
    };
  }
  const envelope = resultEnvelope.parse(raw);
  if (envelope.is_error || envelope.subtype !== 'success') {
    // Mid-response vs pre-flight. If the worker generated real partial work
    // before the failure (assistant text distinct from the error message) and
    // the session is resumable, this is a settleable CHECKPOINT — capture the
    // partial + session so the orchestrator can resume with a continuation,
    // rather than discarding recoverable work. Requiring POSITIVE evidence of
    // generation biases the close call toward pre-flight (resend), so a pre-flight
    // failure is never misread as "continue".
    const partial = partialBeforeError(candidates, envelope.result ?? '');
    if (partial.trim()) {
      const context = claudeContextUsage(candidates, envelope.modelUsage);
      return {
        text: partial,
        sessionId: envelope.session_id,
        interrupted: true,
        ...(envelope.total_cost_usd !== undefined ? { costUsd: envelope.total_cost_usd } : {}),
        ...(context ? { context } : {}),
      };
    }
    throw new ClaudeTurnFailedError(`claude worker turn failed (${envelope.subtype}): ${envelope.result ?? ''}`);
  }
  // A /compact turn succeeds with an empty result (the CLI emits only a
  // compact_boundary event) — name what happened so the orchestrator isn't
  // handed a blank response.
  const text =
    !envelope.result && prompt.trimStart().startsWith('/compact')
      ? COMPACT_CONFIRMATION
      : (envelope.result ?? '');
  const context = claudeContextUsage(candidates, envelope.modelUsage);
  return {
    text,
    sessionId: envelope.session_id,
    ...(envelope.total_cost_usd !== undefined ? { costUsd: envelope.total_cost_usd } : {}),
    ...(envelope.usage?.input_tokens !== undefined
      ? { tokens: { input: envelope.usage.input_tokens, output: envelope.usage.output_tokens ?? 0 } }
      : {}),
    ...(context ? { context } : {}),
  };
}

/**
 * A concise infra-error string from an execa failure that produced no parseable
 * `-p` envelope — a spawn failure (ENOENT), a timeout, or a crash that wrote no
 * JSON. execa's `shortMessage` is "Command failed with exit code N: <argv>" (the
 * prompt rides stdin, so it is never in the argv) and `stderr` is separate —
 * together the signal, without the stdout dump that bloats `.message`. The stderr
 * tail is bounded so even a noisy crash stays small.
 */
export function conciseExecaError(err: unknown): string {
  const e = err as { shortMessage?: unknown; message?: unknown; stderr?: unknown };
  const base = typeof e.shortMessage === 'string' ? e.shortMessage : typeof e.message === 'string' ? e.message : String(err);
  const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
  const tail = stderr ? ` — ${stderr.length > 500 ? `…${stderr.slice(-500)}` : stderr}` : '';
  return `${base}${tail}`;
}

/**
 * Recover from a failed `claude -p` invocation. A budget cutoff is a checkpoint
 * (return the settled WorkerTurn, or propagate the session-less BudgetCutoffError);
 * anything else throws a CONCISE infra error. When stdout carried a `-p` result
 * envelope, parseClaudeTurn's message is the CLI's own failure reason — an API /
 * auth / network error, *whatever* the envelope's `result` field holds, so no
 * error class is matched by wording — and that is the signal: we propagate it
 * rather than execa's raw `.message`, which inlines the entire multi-KB stdout
 * stream (the init payload, every message event, their ids). With no parseable
 * envelope the signal is the exit code + stderr, via conciseExecaError. Exported
 * as the provider's testable failure seam.
 */
export function recoverClaudeFailure(err: unknown, prompt: string): WorkerTurn {
  if (err instanceof BudgetCutoffError) throw err;
  const stdout = (err as { stdout?: unknown }).stdout;
  if (typeof stdout === 'string' && stdout.length > 0) {
    try {
      const turn = parseClaudeTurn(stdout, prompt);
      // A settled checkpoint — a budget cutoff or a mid-response interruption —
      // is recoverable work, not a failure: return it so the session is captured.
      if (turn.budgetTruncated || turn.interrupted) return turn;
      // A success envelope on a non-zero exit is contradictory and rare — prefer
      // the concise exit/stderr error below over trusting it.
    } catch (parseErr) {
      if (parseErr instanceof BudgetCutoffError) throw parseErr;
      // The -p envelope reported a failure (an API/auth/network error — whatever
      // the result field held): that reason is the signal, so propagate it rather
      // than execa's raw stdout dump. Genuinely unparseable output (no result
      // event, not JSON) falls through to the exit-code/stderr path below, which
      // carries more than a bare "not JSON" would.
      if (parseErr instanceof ClaudeTurnFailedError) throw parseErr;
    }
  }
  throw new Error(conciseExecaError(err));
}

/**
 * The execa options for a `claude -p` turn, extracted as a pure builder so the
 * one named-but-unverified-by-test risk can be pinned: execa's `cleanup`
 * (default `true`) kills the worker child when this parent process exits, so a
 * killed or superseded `_mcp` host takes its in-flight worker down with it —
 * the orphan/reconnect safety the async interactive host leans on. Setting it
 * `false` would silently break that, so the tripwire test asserts this builder
 * never does. Left ABSENT here (execa's default `true` stands) — the live
 * SIGTERM-the-parent confirmation is the human's verify-phase run. On timeout
 * execa sends SIGTERM, then SIGKILL after forceKillAfterDelay.
 */
export interface ClaudeExecaOptions {
  cwd: string | undefined;
  input: string;
  timeout: number;
  forceKillAfterDelay: number;
  cleanup?: boolean;
}

export function claudeExecaOptions(opts: { cwd?: string; prompt: string }, config: { timeoutMs?: number }): ClaudeExecaOptions {
  return {
    cwd: opts.cwd,
    input: opts.prompt,
    timeout: config.timeoutMs ?? 15 * 60_000,
    forceKillAfterDelay: 10_000,
  };
}

/**
 * The `claude -p` argv for a turn, extracted as a pure builder (mirroring
 * claudeExecaOptions) so the budget-cap behavior is verifiable by test:
 * `--max-budget-usd` is on the argv only when the cap is a number, and left off
 * entirely when it is undefined (budgets off). The arg order matches the live
 * call exactly — runTurn delegates here.
 */
export function claudeArgs(
  opts: { sessionId?: string; readOnly?: boolean },
  config: { model: string; maxBudgetUsd?: number },
): string[] {
  const args = ['-p', '--output-format', 'json', '--model', config.model];
  if (opts.sessionId) args.push('--resume', opts.sessionId);
  if (config.maxBudgetUsd !== undefined) {
    args.push('--max-budget-usd', String(config.maxBudgetUsd));
  }
  // Both workers launch with full permissions — headless -p mode has no
  // permission prompt, and duet deliberately does not make its coding agents
  // more restricted than the user's own manual workflow (the user's posture for
  // their own repos: 2026-06-11 for the implementer, extended to the reviewer
  // 2026-06-22, superseding the per-role read-only/bypass split). The reviewer's
  // review-only behavior is a prompt-level convention (the review-* snippets ask
  // for critique, not edits), so opts.readOnly no longer gates the argv.
  // bypassPermissions still honors explicit deny rules and the CLI refuses to
  // run as root.
  args.push('--permission-mode', 'bypassPermissions');
  return args;
}

export class ClaudeWorker implements WorkerProvider {
  readonly name = 'claude' as const;

  private readonly config: {
    model: string;
    /** Per-invocation cost ceiling — day-one rail; headless usage draws from a metered subscription credit pool. */
    maxBudgetUsd?: number;
    timeoutMs?: number;
  };

  constructor(config: { model: string; maxBudgetUsd?: number; timeoutMs?: number }) {
    this.config = config;
  }

  async runTurn(opts: RunTurnOptions): Promise<WorkerTurn> {
    // Prompt goes through stdin (argv has length limits; snippet bodies wrapping
    // whole artifacts can be long). The argv comes from the pinned claudeArgs
    // builder; execa options (incl. the load-bearing `cleanup` default) come
    // from the pinned claudeExecaOptions builder.
    const args = claudeArgs(opts, this.config);
    try {
      const { stdout } = await execa('claude', args, claudeExecaOptions(opts, this.config));
      return parseClaudeTurn(stdout, opts.prompt);
    } catch (err) {
      // A budget cutoff exits non-zero, so execa throws BEFORE parseClaudeTurn
      // sees stdout. recoverClaudeFailure re-parses the captured stdout: a
      // budget-truncated turn is a checkpoint (returned); a session-less cutoff
      // is a BudgetCutoffError (propagated); a CLI-reported failure surfaces the
      // envelope's own reason; anything unparseable becomes a concise exit/stderr
      // error — never execa's raw multi-KB stdout dump.
      return recoverClaudeFailure(err, opts.prompt);
    }
  }
}

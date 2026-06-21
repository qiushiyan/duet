import { execa } from 'execa';
import { z } from 'zod';
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
  const envelope = resultEnvelope.parse(raw);
  if (envelope.is_error || envelope.subtype !== 'success') {
    throw new Error(`claude worker turn failed (${envelope.subtype}): ${envelope.result ?? ''}`);
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
    const args = ['-p', '--output-format', 'json', '--model', this.config.model];
    if (opts.sessionId) args.push('--resume', opts.sessionId);
    if (this.config.maxBudgetUsd !== undefined) {
      args.push('--max-budget-usd', String(this.config.maxBudgetUsd));
    }
    if (opts.readOnly) {
      args.push('--disallowed-tools', 'Write,Edit,NotebookEdit,Bash,Task');
    }

    if (!opts.readOnly) {
      // The implementer edits, commits, and runs project commands (tests,
      // typecheck, builds) with nobody at the keyboard — headless -p mode has
      // no permission prompt. bypassPermissions is the user's deliberate
      // posture for their own repos (2026-06-11 decision); the CLI still
      // honors explicit deny rules and refuses to run as root.
      args.push('--permission-mode', 'bypassPermissions');
    }

    // Prompt goes through stdin (argv has length limits; snippet bodies wrapping
    // whole artifacts can be long). execa options (incl. the load-bearing
    // `cleanup` default) come from the pinned claudeExecaOptions builder.
    const { stdout } = await execa('claude', args, claudeExecaOptions(opts, this.config));

    return parseClaudeTurn(stdout, opts.prompt);
  }
}

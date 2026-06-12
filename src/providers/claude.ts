import { execa } from 'execa';
import { z } from 'zod';
import type { RunTurnOptions, WorkerProvider, WorkerTurn } from './types.ts';

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
});

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
      ? '(session compacted — context was reset per the instructions; the conversation continues from the summary)'
      : (envelope.result ?? '');
  return {
    text,
    sessionId: envelope.session_id,
    ...(envelope.total_cost_usd !== undefined ? { costUsd: envelope.total_cost_usd } : {}),
    ...(envelope.usage?.input_tokens !== undefined
      ? { tokens: { input: envelope.usage.input_tokens, output: envelope.usage.output_tokens ?? 0 } }
      : {}),
  };
}

export class ClaudeWorker implements WorkerProvider {
  readonly name = 'claude' as const;

  private readonly config: {
    model: string;
    /** Per-invocation cost ceiling — day-one rail per Q11 economics. */
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
    // whole artifacts can be long). On timeout execa sends SIGTERM, then
    // SIGKILL after the grace period — the proc.kill() sandcastle forgot.
    const { stdout } = await execa('claude', args, {
      cwd: opts.cwd,
      input: opts.prompt,
      timeout: this.config.timeoutMs ?? 15 * 60_000,
      forceKillAfterDelay: 10_000,
    });

    return parseClaudeTurn(stdout, opts.prompt);
  }
}

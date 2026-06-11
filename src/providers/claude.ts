import { execa } from 'execa';
import type { RunTurnOptions, WorkerProvider, WorkerTurn } from './types.ts';

/**
 * Claude worker provider: spawns `claude -p --output-format json`, which
 * returns a `{result, session_id, total_cost_usd}` envelope and appends to
 * the standard `~/.claude/projects/` transcript (resumable manually).
 *
 * The claude provider is configured per-model — choosing the Anthropic model
 * per role is a knob the user actually turns.
 */
export class ClaudeWorker implements WorkerProvider {
  readonly name = 'claude' as const;

  private readonly config: {
    model: string;
    /** Per-invocation cost ceiling — day-one rail per Q11 economics. */
    maxBudgetUsd?: number;
  };

  constructor(config: { model: string; maxBudgetUsd?: number }) {
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

    // Prompt goes through stdin (argv has length limits; snippet bodies wrapping
    // whole artifacts can be long).
    const { stdout } = await execa('claude', args, {
      cwd: opts.cwd,
      input: opts.prompt,
      timeout: 15 * 60_000,
    });

    // `--output-format json` emits an array of all session messages on
    // current CLI versions (older versions emitted the result object alone);
    // the result envelope is the element with type === 'result'.
    const parsed: unknown = JSON.parse(stdout);
    const envelope = (Array.isArray(parsed)
      ? parsed.find((m: { type?: string }) => m.type === 'result')
      : parsed) as
      | {
          type: string;
          subtype: string;
          is_error: boolean;
          result?: string;
          session_id: string;
          total_cost_usd?: number;
          usage?: { input_tokens?: number; output_tokens?: number };
        }
      | undefined;
    if (!envelope) {
      throw new Error(`claude worker output contained no result message (${stdout.length} bytes)`);
    }
    if (envelope.is_error || envelope.subtype !== 'success') {
      throw new Error(`claude worker turn failed (${envelope.subtype}): ${envelope.result ?? ''}`);
    }
    return {
      text: envelope.result ?? '',
      sessionId: envelope.session_id,
      costUsd: envelope.total_cost_usd,
      tokens:
        envelope.usage?.input_tokens !== undefined
          ? { input: envelope.usage.input_tokens, output: envelope.usage.output_tokens ?? 0 }
          : undefined,
    };
  }
}

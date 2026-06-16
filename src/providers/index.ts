import { DEFAULT_CLAUDE_MODEL } from '../config.ts';
import type { RoleBindings } from '../config.ts';
import { ClaudeWorker } from './claude.ts';
import { CodexWorker } from './codex.ts';
import { InteractiveClaudeWorker } from './interactive-claude.ts';
import type { WorkerProvider, WorkerRole } from './types.ts';

/**
 * Build the two worker providers from the run's role bindings and the
 * phase's rails. The claude provider takes the per-role model and the
 * per-turn budget cap; the codex provider deliberately takes neither
 * (~/.codex/config.toml governs the model, and codex has no budget flag).
 *
 * A claude binding with `transport: "interactive"` selects the interactive
 * transport (subscription-billed) instead of headless `claude -p`; it takes the
 * model and the deadline but no budget cap — the flat quota has no per-turn
 * dollar ceiling to pass.
 */
export function createWorkers(
  bindings: RoleBindings,
  rails: { workerBudgetUsd: number; timeoutMs: number },
): Record<WorkerRole, WorkerProvider> {
  const forRole = (role: WorkerRole): WorkerProvider => {
    const binding = bindings[role];
    if (binding.provider !== 'claude') return new CodexWorker({ timeoutMs: rails.timeoutMs });
    const model = binding.model ?? DEFAULT_CLAUDE_MODEL[role];
    if (binding.transport === 'interactive') {
      return new InteractiveClaudeWorker({ model, timeoutMs: rails.timeoutMs });
    }
    return new ClaudeWorker({ model, maxBudgetUsd: rails.workerBudgetUsd, timeoutMs: rails.timeoutMs });
  };
  return { implementer: forRole('implementer'), reviewer: forRole('reviewer') };
}

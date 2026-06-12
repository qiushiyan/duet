import { DEFAULT_CLAUDE_MODEL } from '../config.ts';
import type { RoleBindings } from '../config.ts';
import { ClaudeWorker } from './claude.ts';
import { CodexWorker } from './codex.ts';
import type { WorkerProvider, WorkerRole } from './types.ts';

/**
 * Build the two worker providers from the run's role bindings and the
 * phase's rails. The claude provider takes the per-role model and the
 * per-turn budget cap; the codex provider deliberately takes neither
 * (~/.codex/config.toml governs the model, and codex has no budget flag).
 */
export function createWorkers(
  bindings: RoleBindings,
  rails: { workerBudgetUsd: number; timeoutMs: number },
): Record<WorkerRole, WorkerProvider> {
  const forRole = (role: WorkerRole): WorkerProvider =>
    bindings[role].provider === 'claude'
      ? new ClaudeWorker({
          model: bindings[role].model ?? DEFAULT_CLAUDE_MODEL[role],
          maxBudgetUsd: rails.workerBudgetUsd,
          timeoutMs: rails.timeoutMs,
        })
      : new CodexWorker({ timeoutMs: rails.timeoutMs });
  return { implementer: forRole('implementer'), reviewer: forRole('reviewer') };
}

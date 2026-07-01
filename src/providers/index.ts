import { DEFAULT_CLAUDE_MODEL, bindingFor, implementerModelFor } from '../config.ts';
import type { RoleBindings } from '../config.ts';
import type { PhaseName, WorkflowName } from '../phases.ts';
import { ClaudeWorker } from './claude.ts';
import { CodexWorker } from './codex.ts';
import { InteractiveClaudeWorker } from './interactive-claude.ts';
import type { WorkerProvider, WorkerProviders, WorkerRole } from './types.ts';

/**
 * Build the worker providers from the run's role bindings and the phase's
 * rails. The always-present base (implementer, reviewer) is built every run;
 * the consultant is built ONLY when its binding is present, so an un-enabled run
 * constructs exactly today's two providers. The claude provider takes the
 * per-role model and the per-turn budget cap; the codex provider deliberately
 * takes neither (~/.codex/config.toml governs the model, and codex has no budget
 * flag).
 *
 * A claude binding with `transport: "interactive"` selects the interactive
 * transport (subscription-billed) instead of headless `claude -p`; it takes the
 * model and the deadline but no budget cap — the flat quota has no per-turn
 * dollar ceiling to pass.
 *
 * The IMPLEMENTER is the one role with a phase-scoped model: `implementerModelFor`
 * resolves its base model through planning and the optional `impl` model after the
 * handoff gate, so the same run can plan on a smart model and build on a cheaper
 * one. Every other claude role runs one model across all phases — hence the
 * `workflow`+`phase` parameters (the handoff boundary is arc-specific, and this is
 * already the per-phase construction site for budget/timeout).
 */
export function createWorkers(
  bindings: RoleBindings,
  workflow: WorkflowName,
  phase: PhaseName,
  rails: { workerBudgetUsd: number | undefined; timeoutMs: number },
): WorkerProviders {
  const forRole = (role: WorkerRole): WorkerProvider => {
    const binding = bindingFor(bindings, role);
    if (binding.provider !== 'claude') return new CodexWorker({ timeoutMs: rails.timeoutMs });
    const model = role === 'implementer' ? implementerModelFor(bindings, workflow, phase) : binding.model ?? DEFAULT_CLAUDE_MODEL[role];
    if (binding.transport === 'interactive') {
      return new InteractiveClaudeWorker({ model, timeoutMs: rails.timeoutMs });
    }
    return new ClaudeWorker({ model, maxBudgetUsd: rails.workerBudgetUsd, timeoutMs: rails.timeoutMs });
  };
  return {
    implementer: forRole('implementer'),
    reviewer: forRole('reviewer'),
    ...(bindings.consultant ? { consultant: forRole('consultant') } : {}),
  };
}

/**
 * Narrow a dynamic worker-provider index into a built provider, or throw a
 * prescribed-recovery error. `WorkerProviders` carries an OPTIONAL consultant,
 * so indexing by a `WorkerRole` variable yields `WorkerProvider | undefined`
 * under `noUncheckedIndexedAccess` — every consuming site routes through here.
 * The send_prompt enum gates the consultant role to bound runs, so the throw is
 * defensive: reaching it means a consultant turn was routed on an un-enabled run.
 */
export function providerFor(providers: WorkerProviders, role: WorkerRole): WorkerProvider {
  const provider = providers[role];
  if (!provider) {
    throw new Error(
      `no ${role} worker is built for this run — send_prompt advertises a role only when it is bound, so the orchestrator should not have routed to an unbound consultant.`,
    );
  }
  return provider;
}

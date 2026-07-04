import { DEFAULT_CLAUDE_MODEL, effectiveBindingFor } from '../config.ts';
import type { VoiceBindings } from '../config.ts';
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
 * Every worker's binding is PHASE-EFFECTIVE: `effectiveBindingFor` looks it up
 * in the frozen manifest by the phase's stage + duty — a provider switch
 * across the stage boundary included — so the same run can plan on one
 * binding and build on another. It resolves BEFORE the provider branch, which
 * is what makes the codex-vs-claude construction fall out per phase — hence
 * the `workflow`+`phase` parameters (the stage split is workflow-specific,
 * and this is already the per-phase construction site for budget/timeout).
 */
export function createWorkers(
  bindings: VoiceBindings,
  workflow: WorkflowName,
  phase: PhaseName,
  rails: { workerBudgetUsd: number | undefined; timeoutMs: number },
): WorkerProviders {
  const forRole = (role: WorkerRole): WorkerProvider => {
    const binding = effectiveBindingFor(bindings, role, workflow, phase);
    if (binding.provider !== 'claude') return new CodexWorker({ timeoutMs: rails.timeoutMs });
    const model = binding.model ?? DEFAULT_CLAUDE_MODEL;
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

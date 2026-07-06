import { DEFAULT_CLAUDE_MODEL, voiceBindingFor } from '../bindings.ts';
import type { VoiceBindings } from '../bindings.ts';
import { dutiesOf, stageOf } from '../../registry/workflows.ts';
import type { PhaseName, WorkflowRef } from '../../registry/workflows.ts';
import { ClaudeWorker } from './claude.ts';
import { CodexWorker } from './codex.ts';
import { InteractiveClaudeWorker } from './interactive-claude.ts';
import type { VoiceAddress, WorkerProvider, WorkerProviders } from './types.ts';

/**
 * Build the phase's worker providers from the frozen bindings and the phase's
 * rails — the stage's two duty voices, plus the consultant ONLY when its
 * binding is present. The claude provider takes the per-voice model and the per-turn budget cap; the codex provider deliberately
 * takes neither (~/.codex/config.toml governs the model, and codex has no budget
 * flag).
 *
 * A claude binding with `transport: "interactive"` selects the interactive
 * transport (subscription-billed) instead of headless `claude -p`; it takes the
 * model and the deadline but no budget cap — the flat quota has no per-turn
 * dollar ceiling to pass.
 *
 * Each duty's binding is a frozen-manifest lookup (`voiceBindingFor`) — a
 * provider switch across the stage boundary included — so the same run plans
 * on one binding and builds on another. The lookup resolves BEFORE the
 * provider branch, which is what makes the codex-vs-claude construction fall
 * out per phase.
 */
export function createWorkers(
  bindings: VoiceBindings,
  workflow: WorkflowRef,
  phase: PhaseName,
  rails: { workerBudgetUsd: number | undefined; timeoutMs: number },
): WorkerProviders {
  const forAddress = (address: VoiceAddress): WorkerProvider => {
    const binding = voiceBindingFor(bindings, address);
    if (binding.provider !== 'claude') return new CodexWorker({ timeoutMs: rails.timeoutMs });
    const model = binding.model ?? DEFAULT_CLAUDE_MODEL;
    if (binding.transport === 'interactive') {
      return new InteractiveClaudeWorker({ model, timeoutMs: rails.timeoutMs });
    }
    return new ClaudeWorker({ model, maxBudgetUsd: rails.workerBudgetUsd, timeoutMs: rails.timeoutMs });
  };
  const [maker, checker] = dutiesOf(workflow, stageOf(workflow, phase));
  return {
    [maker]: forAddress(maker),
    [checker]: forAddress(checker),
    ...(bindings.consultant ? { consultant: forAddress('consultant') } : {}),
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
export function providerFor(providers: WorkerProviders, address: VoiceAddress): WorkerProvider {
  const provider = providers[address];
  if (!provider) {
    throw new Error(
      `no ${address} worker is built for this phase — send_prompt advertises an address only when it is live here, so the orchestrator should not have routed to ${address}.`,
    );
  }
  return provider;
}

import { DEFAULT_CLAUDE_MODEL, dutyBindingFor, formatBinding } from './bindings.ts';
import type { BindAddress, Binding, VoiceBindings } from './bindings.ts';
import { conciseExecaError } from './providers/claude.ts';
import { createWorkerForBinding } from './providers/index.ts';
import type { WorkerProvider } from './providers/types.ts';
import { stagesOf } from '../registry/workflows.ts';
import type { Duty, WorkflowRef } from '../registry/workflows.ts';

/**
 * The create-time binding preflight. For every binding carrying a knob only the
 * provider can validate — an explicit model, or a native-arg passthrough — it
 * runs one throwaway worker turn at `greenflag new` and decides: abort run creation
 * (the provider rejected the configuration), or warn and proceed. The point is
 * to surface a mistyped model/flag while the human is present, never mid-build.
 *
 * greenflag stays a conduit for native args: it never parses or judges their content
 * (that was the deleted `--strict-config` re-serializer) — the provider judges
 * them, just early, and `preflightDisposition` reads only the provider's own
 * verdict.
 */

const PREFLIGHT_PROMPT = 'Reply with the single word OK.';
const PREFLIGHT_TIMEOUT_MS = 120_000;

export type BindingPreflightOutcome =
  | { status: 'ok'; warnings: string[] }
  | { status: 'warning'; warnings: string[] }
  | { status: 'abort'; message: string };

export interface PreflightAddressResult {
  status: 'ok' | 'warning';
  binding: Binding;
  messages: string[];
}

export interface PreflightReport {
  byAddress: Partial<Record<BindAddress, PreflightAddressResult>>;
}

export class PreflightFailedError extends Error {
  readonly binding: Binding;
  readonly addresses: BindAddress[];

  constructor(addresses: BindAddress[], binding: Binding, message: string) {
    super(`preflight failed for ${addresses.map((a) => `${a}=${formatBinding(binding)}`).join(', ')}:\n${message}`);
    this.name = 'PreflightFailedError';
    this.binding = binding;
    this.addresses = addresses;
  }
}

export interface PreflightDeps {
  createWorker?: (binding: Binding) => WorkerProvider;
}

/**
 * How a failed probe disposes: ABORT run creation, or WARN and proceed.
 *
 * ABORT requires a POSITIVE signal that the provider rejected THIS invocation's
 * own configuration — a mistyped native flag or an unusable model — a
 * deterministic failure the real run would hit every time. Everything else
 * WARNS: a transient/environmental failure (network, a per-turn timeout, TLS, a
 * missing tmux) must never block a good `greenflag new`, and an unrecognized failure
 * degrades safely to "surfaces at first use" rather than a false abort. A missed
 * bad-model phrasing is the tolerable direction (it fails cleanly at first use);
 * a false abort of a healthy run is not.
 *
 * This is deliberately NOT `classifyError`: that taxonomy is tuned for scanning
 * terminal API errors in transcripts and buckets most preflight-shaped failures
 * (timeouts, spawn errors) as `unknown`, so keying abort on it would both block
 * good runs on a hiccup AND warn-through a bad model whose NAME contains a
 * taxonomy token (e.g. `429`).
 */
export function preflightDisposition(errorText: string): 'abort' | 'warn' {
  // A rejected argument (the native-passthrough footgun): both CLIs' parsers say
  // so unambiguously. Codex's own passthrough is `-c` config (a bad key is
  // silently ignored, never a flag error), so in practice this guards claude_args.
  const rejectedArg = /\bunknown option\b|\bunexpected argument\b|\bunrecognized (?:option|argument)\b/i;
  // An unusable model, across both providers' phrasings. Deliberately no bare
  // HTTP code — a model NAME containing 400/404/429 must not self-trigger.
  const badModel =
    /issue with the selected model|model_not_found|no such model|(?:unknown|invalid|unsupported) model|model[^.\n]{0,40}(?:not found|does(?:n't| not) exist|not (?:available|supported)|unavailable)/i;
  return rejectedArg.test(errorText) || badModel.test(errorText) ? 'abort' : 'warn';
}

export async function preflightBinding(
  binding: Binding,
  cwd: string,
  deps: PreflightDeps = {},
): Promise<BindingPreflightOutcome> {
  const makeWorker =
    deps.createWorker ??
    ((b: Binding) =>
      createWorkerForBinding(b, { workerBudgetUsd: undefined, timeoutMs: PREFLIGHT_TIMEOUT_MS }, { forceHeadless: true }));

  try {
    const turn = await makeWorker(binding).runTurn({ prompt: PREFLIGHT_PROMPT, cwd, timeoutMs: PREFLIGHT_TIMEOUT_MS });
    const warnings = turn.warnings ?? [];
    return warnings.length > 0 ? { status: 'warning', warnings } : { status: 'ok', warnings: [] };
  } catch (err) {
    const message = conciseExecaError(err);
    if (preflightDisposition(message) === 'abort') return { status: 'abort', message };
    return {
      status: 'warning',
      warnings: [`could not preflight ${formatBinding(binding)} — ${message}; it will validate at first use`],
    };
  }
}

export async function preflightRunBindings(
  bindings: VoiceBindings,
  workflow: WorkflowRef,
  cwd: string,
  deps: PreflightDeps = {},
): Promise<PreflightReport> {
  const byAddress: Partial<Record<BindAddress, PreflightAddressResult>> = {};
  for (const candidate of preflightCandidates(bindings, workflow)) {
    const result = await preflightBinding(candidate.binding, cwd, deps);
    if (result.status === 'abort') throw new PreflightFailedError(candidate.addresses, candidate.binding, result.message);
    for (const address of candidate.addresses) {
      byAddress[address] = {
        status: result.status,
        binding: candidate.binding,
        messages: result.warnings,
      };
    }
  }
  return { byAddress };
}

export function bindingNeedsPreflight(binding: Binding): boolean {
  return hasNative(binding) || hasProviderExplicitModel(binding);
}

export function preflightCandidates(
  bindings: VoiceBindings,
  workflow: WorkflowRef,
): Array<{ binding: Binding; addresses: BindAddress[] }> {
  const grouped = new Map<string, { binding: Binding; addresses: BindAddress[] }>();
  const push = (address: BindAddress, binding: Binding): void => {
    if (!bindingNeedsPreflight(binding)) return;
    const key = stableStringify(binding);
    const existing = grouped.get(key);
    if (existing) existing.addresses.push(address);
    else grouped.set(key, { binding, addresses: [address] });
  };

  const duties = stagesOf(workflow).flatMap((stage) => [stage.duties.maker, stage.duties.checker] as Duty[]);
  for (const duty of duties) push(duty, dutyBindingFor(bindings, duty));
  if (bindings.consultant) push('consultant', bindings.consultant);
  return [...grouped.values()];
}

export function preflightMarker(result: PreflightAddressResult | undefined): string {
  if (!result) return '';
  if (result.status === 'ok') return ' ✓ preflighted';
  return ` ⚠ ${result.messages.join('; ')}`;
}

function hasNative(binding: Binding): boolean {
  return binding.native?.claudeArgs !== undefined || binding.native?.codexConfig !== undefined;
}

/** An explicit, provider-validatable model: any codex model, or a non-default claude one. */
function hasProviderExplicitModel(binding: Binding): boolean {
  if (binding.provider === 'codex') return binding.model !== undefined;
  return binding.model !== undefined && binding.model !== DEFAULT_CLAUDE_MODEL;
}

/** A deterministic key over a binding's fields, for deduping identical candidates. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

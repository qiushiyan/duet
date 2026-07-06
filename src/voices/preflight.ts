import { execa } from 'execa';
import { DEFAULT_CLAUDE_MODEL, dutyBindingFor, formatBinding } from './bindings.ts';
import type { BindAddress, Binding, VoiceBindings } from './bindings.ts';
import { classifyError } from './health.ts';
import type { ErrorClass } from './health.ts';
import { createWorkerForBinding } from './providers/index.ts';
import type { WorkerProvider } from './providers/types.ts';
import { stagesOf } from '../registry/workflows.ts';
import type { Duty, WorkflowRef } from '../registry/workflows.ts';

const PREFLIGHT_PROMPT = 'Reply with the single word OK.';
const PREFLIGHT_TIMEOUT_MS = 120_000;

export type BindingPreflightOutcome =
  | { status: 'ok'; warnings: string[] }
  | { status: 'warning'; errorClass?: ErrorClass; warnings: string[] }
  | { status: 'abort'; errorClass: 'unknown'; message: string };

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
  strictConfigProbe?: (binding: Binding, cwd: string) => Promise<string[]>;
}

export async function preflightBinding(
  binding: Binding,
  cwd: string,
  deps: PreflightDeps = {},
): Promise<BindingPreflightOutcome> {
  const makeWorker =
    deps.createWorker ??
    ((b: Binding) => createWorkerForBinding(b, { workerBudgetUsd: undefined, timeoutMs: PREFLIGHT_TIMEOUT_MS }));
  const strictConfigProbe = deps.strictConfigProbe ?? codexStrictConfigAdvisory;

  let warnings: string[] = [];
  try {
    const turn = await makeWorker(binding).runTurn({ prompt: PREFLIGHT_PROMPT, cwd, timeoutMs: PREFLIGHT_TIMEOUT_MS });
    warnings = [...warnings, ...(turn.warnings ?? [])];
  } catch (err) {
    const message = conciseError(err);
    const errorClass = classifyError(message);
    if (errorClass === 'unknown') return { status: 'abort', errorClass, message };
    return {
      status: 'warning',
      errorClass,
      warnings: [`could not preflight ${formatBinding(binding)} (${errorClass}) — ${message}; it will validate at first use`],
    };
  }

  if (binding.provider === 'codex' && binding.native?.codexConfig !== undefined) {
    try {
      warnings = [...warnings, ...(await strictConfigProbe(binding, cwd))];
    } catch (err) {
      warnings = [...warnings, `codex --strict-config advisory for ${formatBinding(binding)}: ${conciseError(err)}`];
    }
  }

  return warnings.length > 0 ? { status: 'warning', warnings } : { status: 'ok', warnings: [] };
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

async function codexStrictConfigAdvisory(binding: Binding, cwd: string): Promise<string[]> {
  try {
    const args = [
      'exec',
      '--json',
      '--ephemeral',
      '--strict-config',
      '--cd',
      cwd,
      ...(binding.model !== undefined ? ['--model', binding.model] : []),
      ...(binding.effort !== undefined ? ['--config', `model_reasoning_effort="${binding.effort}"`] : []),
    ];
    for (const override of serializeConfigOverrides(binding.native?.codexConfig ?? {})) {
      args.push('--config', override);
    }
    args.push(PREFLIGHT_PROMPT);
    await execa('codex', args, { cwd, timeout: PREFLIGHT_TIMEOUT_MS });
    return [];
  } catch (err) {
    return [`codex --strict-config advisory for ${formatBinding(binding)}: ${conciseError(err)}`];
  }
}

function hasNative(binding: Binding): boolean {
  return binding.native?.claudeArgs !== undefined || binding.native?.codexConfig !== undefined;
}

function hasProviderExplicitModel(binding: Binding): boolean {
  if (binding.provider === 'codex') return binding.model !== undefined;
  return binding.model !== undefined && binding.model !== DEFAULT_CLAUDE_MODEL;
}

function conciseError(err: unknown): string {
  const e = err as { shortMessage?: unknown; message?: unknown; stderr?: unknown; stdout?: unknown };
  const base = typeof e.shortMessage === 'string' ? e.shortMessage : typeof e.message === 'string' ? e.message : String(err);
  const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
  const stdout = typeof e.stdout === 'string' ? e.stdout.trim() : '';
  const detail = stderr || stdout;
  const tail = detail ? ` — ${detail.length > 500 ? `…${detail.slice(-500)}` : detail}` : '';
  return `${base}${tail}`;
}

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

function serializeConfigOverrides(config: Record<string, unknown>): string[] {
  const out: string[] = [];
  flattenConfig(config, '', out);
  return out;
}

function flattenConfig(value: unknown, prefix: string, out: string[]): void {
  if (!isPlainObject(value)) {
    if (prefix) out.push(`${prefix}=${toTomlValue(value, prefix)}`);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(child)) flattenConfig(child, path, out);
    else out.push(`${path}=${toTomlValue(child, path)}`);
  }
}

function toTomlValue(value: unknown, path: string): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Codex config override at ${path} must be a finite number`);
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map((item, index) => toTomlValue(item, `${path}[${index}]`)).join(', ')}]`;
  if (isPlainObject(value)) {
    const parts = Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => `${formatTomlKey(key)} = ${toTomlValue(child, `${path}.${key}`)}`);
    return `{${parts.join(', ')}}`;
  }
  throw new Error(`Unsupported Codex config override value at ${path}: ${value === null ? 'null' : typeof value}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

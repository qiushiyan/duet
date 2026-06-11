import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';

/**
 * Role bindings — the one config duet ships (docs/automation-design.md
 * §"Roles are decoupled from providers"). Scoped to role→provider/model
 * bindings and nothing else; project knowledge never goes here. If a key
 * that isn't a role binding is about to land in this file, that's the
 * design failing.
 */

export type Role = 'orchestrator' | 'implementer' | 'reviewer';

export interface RoleBinding {
  provider: 'claude' | 'codex';
  /** Anthropic model ID. Only meaningful for the claude provider; the codex
   * provider deliberately has no model key (~/.codex/config.toml governs). */
  model?: string;
}

export type RoleBindings = Record<Role, RoleBinding>;

/**
 * Per-role claude-model defaults (the user's call, 2026-06-11): the
 * implementer rides the most capable model — it writes the specs, plans,
 * and code — while the orchestrator's process judgments sit well within
 * Opus. Fable 5 prices at ~2× Opus and its tokenizer counts ~30% more
 * tokens, so the spend concentrates where the artifacts are made.
 */
export const DEFAULT_CLAUDE_MODEL: Record<Role, string> = {
  orchestrator: 'claude-opus-4-8',
  implementer: 'claude-fable-5',
  reviewer: 'claude-opus-4-8',
};

/** Shipped default: matches the user's manual setup and the observed sessions. */
export const DEFAULT_BINDINGS: RoleBindings = {
  orchestrator: { provider: 'claude', model: DEFAULT_CLAUDE_MODEL.orchestrator },
  implementer: { provider: 'claude', model: DEFAULT_CLAUDE_MODEL.implementer },
  reviewer: { provider: 'codex' },
};

export const CONFIG_PATH = join(homedir(), '.config', 'duet', 'config.toml');

function parseBinding(role: Role, raw: unknown): RoleBinding {
  if (typeof raw !== 'object' || raw === null) throw new Error(`config: [roles.${role}] must be a table`);
  const table = raw as Record<string, unknown>;
  const provider = table['provider'];
  if (provider !== 'claude' && provider !== 'codex') {
    throw new Error(`config: [roles.${role}].provider must be "claude" or "codex", got ${JSON.stringify(provider)}`);
  }
  const model = table['model'];
  if (model !== undefined && typeof model !== 'string') {
    throw new Error(`config: [roles.${role}].model must be a string`);
  }
  if (provider === 'codex' && model !== undefined) {
    throw new Error(
      `config: [roles.${role}] sets a model for the codex provider — codex has no model key by design; configure the model in ~/.codex/config.toml instead`,
    );
  }
  if (provider === 'claude' && model === undefined) {
    return { provider, model: DEFAULT_CLAUDE_MODEL[role] };
  }
  return model === undefined ? { provider } : { provider, model };
}

/** Parse a `--<role> provider[:model]` CLI override, e.g. "claude:claude-opus-4-6" or "codex". */
export function parseRoleOverride(role: Role, spec: string): RoleBinding {
  const [provider, ...rest] = spec.split(':');
  const model = rest.length > 0 ? rest.join(':') : undefined;
  return parseBinding(role, model === undefined ? { provider } : { provider, model });
}

export function loadRoleBindings(overrides?: Partial<Record<Role, string>>): RoleBindings {
  const bindings: RoleBindings = { ...DEFAULT_BINDINGS };

  if (existsSync(CONFIG_PATH)) {
    const config = parse(readFileSync(CONFIG_PATH, 'utf8'));
    const roles = (config as Record<string, unknown>)['roles'];
    if (typeof roles === 'object' && roles !== null) {
      for (const role of ['orchestrator', 'implementer', 'reviewer'] as const) {
        const raw = (roles as Record<string, unknown>)[role];
        if (raw !== undefined) bindings[role] = parseBinding(role, raw);
      }
    }
  }

  for (const role of ['orchestrator', 'implementer', 'reviewer'] as const) {
    const spec = overrides?.[role];
    if (spec) bindings[role] = parseRoleOverride(role, spec);
  }

  // The orchestrator's capability contract (custom harness tools, cooperative
  // pause/resume) is only implemented by the claude provider in v1. The codex
  // path is designed but unbuilt — docs/open-questions.md Q17.
  if (bindings.orchestrator.provider !== 'claude') {
    throw new Error(
      'the orchestrator role requires the claude provider in v1 (codex-as-orchestrator is designed but unbuilt — see docs/open-questions.md Q17)',
    );
  }

  return bindings;
}

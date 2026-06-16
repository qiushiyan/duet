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
  /**
   * How duet talks to a claude worker: "headless" (default) is `claude -p`,
   * which draws the metered Agent-SDK credit pool; "interactive" drives the
   * interactive `claude` TUI so the work bills the flat subscription quota.
   * Config-file only (the `--<role>` grammar can't express it). Meaningless
   * for codex (rejected there) — codex already bills the subscription.
   */
  transport?: 'headless' | 'interactive';
}

export type RoleBindings = Record<Role, RoleBinding>;

/**
 * A CLI `--<role> provider[:model]` override. Deliberately has NO transport
 * field: the override grammar cannot express transport, so a model-only
 * override must never manufacture a `transport:"headless"` that overwrites a
 * configured `interactive`. The merge in loadRoleBindings carries a configured
 * claude transport forward instead. Keeping this type separate from RoleBinding
 * (whose parseBinding DOES default the transport) is what makes that clobber
 * unrepresentable rather than merely avoided.
 */
export interface RoleOverride {
  provider: 'claude' | 'codex';
  model?: string;
}

/**
 * Per-role claude-model defaults: Opus 4.8 across the board (updated
 * 2026-06-15 from the earlier Fable-5 implementer default). A more capable
 * or costlier model — e.g. Fable 5, which prices at ~2× Opus — can be bound
 * to any single role per run via the config file or a `--<role>` flag when
 * an artifact-heavy feature warrants it; the shipped default keeps every
 * claude role on Opus 4.8.
 */
export const DEFAULT_CLAUDE_MODEL: Record<Role, string> = {
  orchestrator: 'claude-opus-4-8',
  implementer: 'claude-opus-4-8',
  reviewer: 'claude-opus-4-8',
};

/** Shipped default when no config file is present (claude roles on Opus 4.8, reviewer on codex). */
export const DEFAULT_BINDINGS: RoleBindings = {
  orchestrator: { provider: 'claude', model: DEFAULT_CLAUDE_MODEL.orchestrator, transport: 'headless' },
  implementer: { provider: 'claude', model: DEFAULT_CLAUDE_MODEL.implementer, transport: 'headless' },
  reviewer: { provider: 'codex' },
};

export const CONFIG_PATH = join(homedir(), '.config', 'duet', 'config.toml');

/**
 * Validate the provider + model of a binding spec — the part shared by config
 * tables and CLI overrides. Defaults a claude binding's model per role and
 * rejects a model on codex; deliberately says NOTHING about transport, which is
 * a config-only concern parseBinding layers on top (so an override can never
 * inherit a transport default through this path).
 */
function parseProviderModel(role: Role, table: Record<string, unknown>): RoleOverride {
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

function parseBinding(role: Role, raw: unknown): RoleBinding {
  if (typeof raw !== 'object' || raw === null) throw new Error(`config: [roles.${role}] must be a table`);
  const table = raw as Record<string, unknown>;
  const base = parseProviderModel(role, table);
  const transport = table['transport'];
  if (transport !== undefined) {
    if (base.provider === 'codex') {
      throw new Error(
        `config: [roles.${role}] sets a transport for the codex provider — transport is a claude-only knob (codex already bills the subscription); remove it`,
      );
    }
    if (transport !== 'headless' && transport !== 'interactive') {
      throw new Error(
        `config: [roles.${role}].transport must be "headless" or "interactive", got ${JSON.stringify(transport)}`,
      );
    }
  }
  // Claude bindings always carry a transport (default headless, alongside the
  // model default); codex bindings never do.
  return base.provider === 'claude'
    ? { ...base, transport: (transport as 'headless' | 'interactive' | undefined) ?? 'headless' }
    : base;
}

/**
 * Parse a `--<role> provider[:model]` CLI override, e.g. "claude:claude-opus-4-6"
 * or "codex". Returns a RoleOverride (no transport) — the grammar can't express
 * transport, and the merge in loadRoleBindings owns the effective transport.
 */
export function parseRoleOverride(role: Role, spec: string): RoleOverride {
  const [provider, ...rest] = spec.split(':');
  const model = rest.length > 0 ? rest.join(':') : undefined;
  return parseProviderModel(role, model === undefined ? { provider } : { provider, model });
}

export function loadRoleBindings(
  overrides?: Partial<Record<Role, string>>,
  configPath: string = CONFIG_PATH,
): RoleBindings {
  const bindings: RoleBindings = { ...DEFAULT_BINDINGS };

  if (existsSync(configPath)) {
    const config = parse(readFileSync(configPath, 'utf8'));
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
    if (!spec) continue;
    const override = parseRoleOverride(role, spec);
    const prev = bindings[role];
    // Compute the effective transport in the merge — the override can't express
    // it. Carry a configured claude transport forward when the override keeps
    // the provider claude; default headless only when the override changes the
    // provider (nothing to carry) or no prior claude transport existed. This is
    // the billing footgun the RoleOverride/RoleBinding split prevents: a
    // model-only override must not silently flip a subscription-billed run back
    // to metered headless.
    if (override.provider === 'claude') {
      const carried = prev.provider === 'claude' ? prev.transport : undefined;
      bindings[role] = { ...override, transport: carried ?? 'headless' };
    } else {
      bindings[role] = override;
    }
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

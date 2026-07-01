import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { isPostHandoffPhase } from './phases.ts';
import type { PhaseName } from './phases.ts';

/**
 * Run config — the one config duet ships (docs/automation-design.md
 * §"Roles are decoupled from providers"). Scoped to role→provider/model
 * bindings AND account/billing posture (transport, budget) — and nothing else;
 * project knowledge never goes here. If a key that isn't a role binding or
 * billing posture is about to land in this file, that's the design failing.
 */

/**
 * The REQUIRED role set: every run binds all three. It keys `DEFAULT_BINDINGS`,
 * the total config loops, and `RoleBindings`' required half — so widening the
 * worker roles never forces a persisted-state change for an unbound run.
 */
export type Role = 'orchestrator' | 'implementer' | 'reviewer';

/**
 * The roles a `[roles.*]` table or a `--<role>` flag may bind: the required base
 * plus the optional `consultant`. Distinct from `Role` precisely so the optional
 * consultant lives outside the required set — present-only, never persisted by
 * default.
 */
export type BindableRole = Role | 'consultant';

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
  /**
   * The IMPLEMENTER's post-handoff model override (present-only, implementer-only):
   * the claude model the implementer switches to for phases strictly after the
   * workflow's handoff gate (the AFK build + finishing tail), typically a
   * cheaper/faster model than the base that plans. A `RoleOverride`, not a
   * `RoleBinding`, precisely because it carries no transport — the post-handoff
   * turn keeps the base implementer's transport. Claude-only and same-provider in
   * v1 (a non-claude provider is grammar-reserved but rejected at the config
   * boundary); validated once in loadRunConfig so `implementerModelFor` can trust
   * it. ABSENT ⇒ byte-for-byte today: the implementer runs its base model in every
   * phase. Only ever set on `bindings.implementer`.
   */
  impl?: RoleOverride;
}

/**
 * Required base plus an optional consultant. An *absent* consultant makes a
 * run's persisted `bindings` byte-for-byte today's — strictly stronger than
 * growing a closed `Record<BindableRole, RoleBinding>`, which would change every
 * state file. Dynamic `bindings[role]` (a `WorkerRole`/`Voice` variable) yields
 * `RoleBinding | undefined` under `noUncheckedIndexedAccess`, so such sites go
 * through `bindingFor`, never a bare index.
 */
export type RoleBindings = Record<Role, RoleBinding> & { consultant?: RoleBinding };

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
export const DEFAULT_CLAUDE_MODEL: Record<BindableRole, string> = {
  orchestrator: 'claude-opus-4-8',
  implementer: 'claude-opus-4-8',
  reviewer: 'claude-opus-4-8',
  // The consultant's no-model default. A PARSE-TIME default (read only when a
  // consultant binding is being parsed) — never written into DEFAULT_BINDINGS,
  // so an unbound run's persisted state is untouched. Opus only as a default;
  // the cross-family binding is fully configurable and that is the point.
  consultant: 'claude-opus-4-8',
};

/**
 * The Anthropic model the IMPLEMENTER runs on at `phase` — the one place the
 * per-phase model split resolves, and the opt-in resolver the design mirrors on
 * `budgetFor`/`gateAttended` (pure, absent-knob ⇒ identity). Pre-/at-handoff
 * phases (the planning arc: frame, spec, plan) run the base binding's model;
 * phases strictly after the handoff gate (the AFK build + finishing tail — full's
 * {impl, finish}, rir's {implement, publish}) run the optional `impl` override's
 * model when one is bound. Absent `impl` ⇒ the base model for every phase,
 * byte-for-byte today.
 *
 * Returns a model STRING, never a provider switch: `impl` is validated at the
 * config boundary (loadRunConfig) to be claude-only, so the swap only ever changes
 * the model — the base binding's provider/transport still build the worker. A
 * codex implementer has no model and never reaches here (createWorkers' codex
 * branch skips it); the base-model fallback keeps the function total regardless.
 */
export function implementerModelFor(bindings: RoleBindings, phase: PhaseName): string {
  const binding = bindings.implementer;
  const base = binding.model ?? DEFAULT_CLAUDE_MODEL.implementer;
  if (binding.provider === 'claude' && binding.impl && isPostHandoffPhase(phase)) {
    return binding.impl.model ?? DEFAULT_CLAUDE_MODEL.implementer;
  }
  return base;
}

/** Shipped default when no config file is present (claude roles on Opus 4.8, reviewer on codex). */
export const DEFAULT_BINDINGS: RoleBindings = {
  orchestrator: { provider: 'claude', model: DEFAULT_CLAUDE_MODEL.orchestrator, transport: 'headless' },
  implementer: { provider: 'claude', model: DEFAULT_CLAUDE_MODEL.implementer, transport: 'headless' },
  reviewer: { provider: 'codex' },
};

export const CONFIG_PATH = join(homedir(), '.config', 'duet', 'config.toml');

/**
 * Narrow a dynamic role index into a present binding, or throw a
 * prescribed-recovery error. The binding-map twin of `providerFor`
 * (src/providers/index.ts): `RoleBindings` carries an OPTIONAL consultant, so
 * indexing `bindings[role]` by a dynamic `WorkerRole`/`Voice`/`BindableRole`
 * yields `RoleBinding | undefined` under `noUncheckedIndexedAccess` — every such
 * site routes through here, never a bare index. The three required base roles
 * always resolve; only an unbound consultant can throw.
 */
export function bindingFor(bindings: RoleBindings, role: BindableRole): RoleBinding {
  const binding = bindings[role];
  if (!binding) {
    throw new Error(
      `no binding for role "${role}" on this run — a consultant is bound only when --consultant or [roles.consultant] is set, so the enumerating surface should not have reached an unbound role here.`,
    );
  }
  return binding;
}

/**
 * Validate the provider + model of a binding spec — the part shared by config
 * tables and CLI overrides. Defaults a claude binding's model per role and
 * rejects a model on codex; deliberately says NOTHING about transport, which is
 * a config-only concern parseBinding layers on top (so an override can never
 * inherit a transport default through this path).
 */
function parseProviderModel(role: BindableRole, table: Record<string, unknown>): RoleOverride {
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

function parseBinding(role: BindableRole, raw: unknown): RoleBinding {
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
    // The interactive transport always drives a read-write/bypass session, so in
    // the spike it serves the implementer only — a read-only interactive reviewer
    // is a production item (spec §"Path to production"). Reject it loudly here so
    // a misconfiguration can never silently grant a read-only role write access.
    if (transport === 'interactive' && role !== 'implementer') {
      throw new Error(
        `config: [roles.${role}].transport = "interactive" — the interactive transport is implementer-only in the spike (it runs read-write/bypass; a read-only interactive reviewer is a production item). Only [roles.implementer] may set it.`,
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
export function parseRoleOverride(role: BindableRole, spec: string): RoleOverride {
  const [provider, ...rest] = spec.split(':');
  const model = rest.length > 0 ? rest.join(':') : undefined;
  return parseProviderModel(role, model === undefined ? { provider } : { provider, model });
}

/**
 * Parse the opt-in budget knob — account/billing posture, the same family as
 * `transport`. Accepts the config-file value (a TOML number or string) and the
 * `--budget` flag string. Returns the resolved per-turn cost multiplier, or
 * `undefined` when OFF — never `0`: the whole plan keys "disabled" off an absent
 * budget (budgetFor returns undefined caps), and a `0` would read as a real
 * zero-dollar cap that cuts every turn instantly.
 *
 *   "off"      → undefined (unbounded — the flat-quota maintainer's posture)
 *   "default"  → 1 (today's per-phase profile, unchanged)
 *   <positive> → that multiplier, scaling the profile (e.g. 0.5, 2)
 */
export function parseBudget(value: unknown): number | undefined {
  if (value === 'off') return undefined;
  if (value === 'default') return 1;
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `budget must be "off", "default", or a positive multiplier (e.g. 0.5, 2), got ${JSON.stringify(value)}`,
    );
  }
  return n;
}

/**
 * Load a run's config: the role bindings AND the resolved per-turn budget. The
 * single config entry point — `loadRoleBindings` is a bindings-only wrapper over
 * it (so existing callers stay unchanged). Budget precedence: the `--budget`
 * flag (`budgetOverride`) wins over the config `budget` key, which wins over the
 * absent default (off). An absent result means OFF (budgetFor reads undefined
 * caps); it is never `0`.
 */
export function loadRunConfig(
  opts: {
    roleOverrides?: Partial<Record<BindableRole, string>>;
    budgetOverride?: string;
    noConsultant?: boolean;
    /** The framing `consultant: on|off` toggle — flips a config-bound consultant for one run (the --consultant/--no-consultant flags win over it). */
    consultantToggle?: 'on' | 'off';
  } = {},
  configPath: string = CONFIG_PATH,
): { bindings: RoleBindings; budget?: number } {
  const bindings: RoleBindings = { ...DEFAULT_BINDINGS };
  let configBudget: number | undefined;

  if (existsSync(configPath)) {
    const config = parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const roles = config['roles'];
    if (typeof roles === 'object' && roles !== null) {
      for (const role of ['orchestrator', 'implementer', 'reviewer'] as const) {
        const raw = (roles as Record<string, unknown>)[role];
        if (raw !== undefined) bindings[role] = parseBinding(role, raw);
      }
      // The consultant is the optional binding: parsed only when present, never
      // defaulted in — so an unbound run keeps today's byte-for-byte bindings.
      const rawConsultant = (roles as Record<string, unknown>)['consultant'];
      if (rawConsultant !== undefined) bindings.consultant = parseBinding('consultant', rawConsultant);
    }
    if (config['budget'] !== undefined) configBudget = parseBudget(config['budget']);
  }

  for (const role of ['orchestrator', 'implementer', 'reviewer'] as const) {
    const spec = opts.roleOverrides?.[role];
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

  // The consultant override: `--no-consultant` removes a config-bound consultant
  // for one run (it wins, so the disable is unambiguous); else `--consultant
  // provider[:model]` binds/replaces it. A fresh binding has no prior transport
  // to carry, and the override grammar can't express `interactive` (rejected
  // anyway — the consultant is read-only by policy), so a claude consultant is
  // always headless.
  // A consultant binding from a spec: a claude consultant is always headless (it's
  // read-only by policy and the override grammar can't express interactive); a
  // non-claude spec carries its own. Shared by the explicit --consultant binding
  // and the frontmatter toggle-on default, so the two can't materialize divergently.
  const consultantBinding = (spec: string): RoleBinding => {
    const override = parseRoleOverride('consultant', spec);
    return override.provider === 'claude' ? { ...override, transport: 'headless' } : override;
  };
  if (opts.noConsultant) {
    delete bindings.consultant;
  } else {
    const consultantSpec = opts.roleOverrides?.consultant;
    if (consultantSpec) {
      // An explicit --consultant binding wins over the frontmatter toggle.
      bindings.consultant = consultantBinding(consultantSpec);
    } else if (opts.consultantToggle === 'off') {
      // The framing toggled it off — disable a config-bound consultant for this run.
      delete bindings.consultant;
    } else if (opts.consultantToggle === 'on' && !bindings.consultant) {
      // The framing toggled it on with none config-bound — enable the default
      // claude consultant (a different family from the codex reviewer is the point;
      // pick a specific model with --consultant / [roles.consultant] instead).
      bindings.consultant = consultantBinding('claude');
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

  // Flag overrides config; config overrides the off default. parseBudget("off")
  // is undefined, so an explicit `--budget off` overrides a config budget to off.
  const budget = opts.budgetOverride !== undefined ? parseBudget(opts.budgetOverride) : configBudget;
  return { bindings, ...(budget !== undefined ? { budget } : {}) };
}

/** Bindings-only view of loadRunConfig — the compatibility wrapper existing callers use. */
export function loadRoleBindings(
  overrides?: Partial<Record<Role, string>>,
  configPath: string = CONFIG_PATH,
): RoleBindings {
  return loadRunConfig({ roleOverrides: overrides }, configPath).bindings;
}

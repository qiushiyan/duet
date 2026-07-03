import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { isPostHandoffPhase } from './phases.ts';
import type { PhaseName, WorkflowName } from './phases.ts';

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
   * The role's post-handoff BUILD override (present-only, worker roles only):
   * the binding this worker switches to for phases strictly after the
   * workflow's handoff gate (the AFK build + finishing tail). A provider
   * switch is allowed — relay's criss-cross plans on claude and builds on
   * codex for the implementer, the inverse for the reviewer. A `RoleOverride`,
   * not a `RoleBinding`, precisely because it carries no transport — a claude
   * override runs headless (the interactive-transport combination is rejected
   * at the config boundary). Written as `build` in the config table; `impl`
   * is accepted as an alias on the implementer (the pre-generalization
   * spelling) and parses into this same field. ABSENT ⇒ byte-for-byte today:
   * the role runs its base binding in every phase.
   */
  build?: RoleOverride;
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
 * The BINDING a worker role runs on at `phase` — the one resolver answering
 * "who runs this turn" (T4; it replaces the model-only `implementerModelFor`),
 * and the opt-in resolver the design mirrors on `budgetFor`/`gateAttended`
 * (pure, absent-knob ⇒ identity). Pre-/at-handoff phases run the base
 * binding; phases strictly after the handoff gate (the AFK build + finishing
 * tail) run the role's optional `build` override when one is bound — a full
 * REPLACEMENT binding (provider switch allowed), never a mutation of the
 * base. Absent `build` ⇒ the base binding for every phase, byte-for-byte.
 *
 * The returned binding is trustworthy by the config boundary's guards
 * (loadRunConfig): a build override never rides an interactive-transport
 * base, and the orchestrator can't carry one — so no downstream site
 * re-checks. `createWorkers` consumes this BEFORE its provider branch, which
 * is what makes the codex-vs-claude construction fall out per phase.
 */
export function effectiveBindingFor(bindings: RoleBindings, role: BindableRole, workflow: WorkflowName, phase: PhaseName): RoleBinding {
  const base = bindingFor(bindings, role);
  const override = base.build;
  if (!override || !isPostHandoffPhase(workflow, phase)) return base;
  return override.provider === 'claude'
    ? { provider: 'claude', model: override.model ?? DEFAULT_CLAUDE_MODEL[role], transport: 'headless' }
    : { provider: 'codex' };
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

/**
 * The config-file `build` field (`[roles.<worker>].build = "provider[:model]"`),
 * or its `impl` alias on the implementer (the pre-generalization spelling), or
 * undefined when absent. Worker-roles-only — the orchestrator never switches
 * mid-run — and the alias is implementer-only, so a stray `impl` on another
 * role still rejects by name. This is the config-file half of the one boundary
 * that makes `binding.build` trustworthy downstream; the flag half and the
 * cross-source transport guard live in loadRunConfig.
 */
function parseBuildField(role: BindableRole, table: Record<string, unknown>): RoleOverride | undefined {
  const rawBuild = table['build'];
  const rawImpl = table['impl'];
  if (rawImpl !== undefined && role !== 'implementer') {
    throw new Error(
      `config: [roles.${role}].impl is implementer-only (it is the legacy alias of "build") — spell the post-handoff override [roles.${role}].build`,
    );
  }
  if (rawBuild !== undefined && rawImpl !== undefined) {
    throw new Error(
      `config: [roles.implementer] sets both "build" and its alias "impl" — keep one (they are the same knob)`,
    );
  }
  const raw = rawBuild ?? rawImpl;
  if (raw === undefined) return undefined;
  const key = rawBuild !== undefined ? 'build' : 'impl';
  if (role === 'orchestrator') {
    throw new Error(
      `config: [roles.orchestrator].${key} — the post-handoff build override is a worker knob; the orchestrator runs one binding across the whole arc`,
    );
  }
  if (typeof raw !== 'string') {
    throw new Error(`config: [roles.${role}].${key} must be a "provider[:model]" string, got ${JSON.stringify(raw)}`);
  }
  return parseRoleOverride(role, raw);
}

function parseBinding(role: BindableRole, raw: unknown): RoleBinding {
  if (typeof raw !== 'object' || raw === null) throw new Error(`config: [roles.${role}] must be a table`);
  const table = raw as Record<string, unknown>;
  const base = parseProviderModel(role, table);
  const build = parseBuildField(role, table);
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
  // model default); codex bindings never do. The build override rides either
  // base provider — the switch is the point (relay's reviewer is codex-based
  // with a claude build override).
  return base.provider === 'claude'
    ? { ...base, transport: (transport as 'headless' | 'interactive' | undefined) ?? 'headless', ...(build ? { build } : {}) }
    : { ...base, ...(build ? { build } : {}) };
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
 * Parse a build-override spec — the `--impl-model` flag or a
 * `[roles.<worker>].build` value, the same `provider[:model]` grammar as
 * parseRoleOverride. A provider switch is a supported value now (the
 * generalization relay rides): `codex` hands the post-handoff phases to
 * codex, `claude:model` swaps the claude model. The one parse boundary for
 * the build knob; the cross-source guards (interactive transport) live in
 * loadRunConfig.
 */
export function parseImplOverride(spec: string): RoleOverride {
  if (spec.trim() === '') {
    throw new Error(
      'the build override is empty — set it to a "provider[:model]" spec (e.g. "codex", "claude:claude-sonnet-5"), or omit it to keep the base binding in every phase',
    );
  }
  return parseRoleOverride('implementer', spec);
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
    /** The `--impl-model provider[:model]` flag — the implementer's post-handoff model, winning over a config `[roles.implementer].impl`. */
    implModelOverride?: string;
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
    // Carry a configured post-handoff `build` forward on either branch: the
    // `--<role>` grammar can't express it, so a base override must not silently
    // discard the role's build-phase binding — and unlike transport (claude-only),
    // the build override rides either base provider.
    if (override.provider === 'claude') {
      const carried = prev.provider === 'claude' ? prev.transport : undefined;
      bindings[role] = { ...override, transport: carried ?? 'headless', ...(prev.build ? { build: prev.build } : {}) };
    } else {
      bindings[role] = { ...override, ...(prev.build ? { build: prev.build } : {}) };
    }
  }

  // The implementer's post-handoff build override: the `--impl-model` flag wins
  // over a configured `[roles.implementer].build`, applied AFTER the role
  // overrides so the guard below sees the final implementer transport.
  if (opts.implModelOverride !== undefined) {
    // REPLACE the implementer object, never mutate it: when no config table and no
    // `--impl` override supplied one, `bindings.implementer` is still the SHARED
    // `DEFAULT_BINDINGS.implementer` reference (`bindings` is only a shallow copy of
    // DEFAULT_BINDINGS above), so `bindings.implementer.build = …` would write the
    // build override onto the process-global default and leak it into every later
    // default-binding load — breaking the absent-knob invariant. A fresh object
    // leaves the default pristine (the same replace-don't-mutate discipline the
    // transport merge above already follows).
    bindings.implementer = { ...bindings.implementer, build: parseImplOverride(opts.implModelOverride) };
  }
  // The cross-source transport guard, per worker role: a build override never
  // rides an interactive-transport base — the interactive pane launches with one
  // binding, and a swap-on-resume there is unverified. Checked after both
  // sources so a config `build` plus a `--implementer` transport carry, or a
  // `--impl-model` on an interactive base, both reject rather than reach a worker.
  for (const role of ['implementer', 'reviewer', 'consultant'] as const) {
    const binding = bindings[role];
    if (binding?.build && binding.transport === 'interactive') {
      throw new Error(
        `the ${role}'s build override is unsupported with the interactive transport in v1 — the interactive pane launches with one binding and a swap-on-resume is unverified there; use a headless ${role} for the post-handoff split`,
      );
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

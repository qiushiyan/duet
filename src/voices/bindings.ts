import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parse } from 'smol-toml';
import { DUTIES, continuityEdgeFor, stageOfDuty, stageOfDutyLane, stagesOf } from '../registry/workflows.ts';
import type { Duty, WorkflowRef } from '../registry/workflows.ts';

/**
 * Voice bindings — the one config duet ships (docs/automation-design.md
 * §"Roles are decoupled from providers"; the duty-keyed shape is the domain
 * remodel, docs/specs/2026-07-04-domain-remodel.md). Scoped to voice→provider/
 * model bindings AND account/billing posture (transport, budget) — and nothing
 * else; project knowledge never goes here. If a key that isn't a binding or
 * billing posture is about to land in this file, that's the design failing.
 *
 * A binding attaches to an ADDRESS: one of the five duties (per (stage, duty) —
 * relay's criss-cross is just four duty bindings), or the two run-long voices
 * (orchestrator, consultant). The run manifest resolves each address
 * independently through flags > framing > config > shipped defaults
 * (`resolveRunConfig`), and the result freezes on the run at creation.
 */

export type Provider = 'claude' | 'codex';

export type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface BindingNative {
  claudeArgs?: string[];
  codexConfig?: Record<string, unknown>;
}

/** Which provider (and model/transport, for claude) a voice runs on. */
export interface Binding {
  provider: Provider;
  /** Provider-native model override. Absent codex model defers to ~/.codex/config.toml. */
  model?: string;
  /** Normalized reasoning-effort intent, validated per provider at manifest freeze. */
  effort?: Effort;
  /** Provider-native config-only passthrough. Shape is routed, contents are provider-owned. */
  native?: BindingNative;
  /**
   * How duet talks to a claude worker: "headless" (default) is `claude -p`,
   * which draws the metered Agent-SDK credit pool; "interactive" drives the
   * interactive `claude` TUI so the work bills the flat subscription quota.
   * Config-file only (the `--bind` grammar can't express it). Meaningless for
   * codex (rejected there) — codex already bills the subscription.
   */
  transport?: 'headless' | 'interactive';
}

/** The addresses a binding can attach to: the duty vocabulary plus the run-long voices. */
export type BindAddress = Duty | 'orchestrator' | 'consultant';

/**
 * A run's frozen bindings, per voice. `duties` carries EXACTLY the run's
 * workflow's four duties (a binding for a duty the workflow lacks is an
 * illegal state, rejected at the freeze); dynamic access goes through
 * `dutyBindingFor`, never a bare index (`noUncheckedIndexedAccess`). An
 * absent `consultant` is the default-off state — nothing reads it unless
 * present.
 */
export interface VoiceBindings {
  orchestrator: Binding;
  consultant?: Binding;
  duties: Partial<Record<Duty, Binding>>;
}

/**
 * The shipped claude-model default, one constant for every address (Opus 4.8
 * across the board since 2026-06-15). A costlier model — e.g. Fable 5 at ~2×
 * Opus — binds to any single address per run via `--bind` or the config file
 * when an artifact-heavy feature warrants it.
 */
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-8';

export const CONFIG_PATH = join(homedir(), '.config', 'duet', 'config.toml');

const PROVIDER_CAPS: Record<
  Provider,
  {
    model: 'default' | 'defer';
    effort: readonly Effort[];
    transport: boolean;
    native: 'claudeArgs' | 'codexConfig';
  }
> = {
  claude: {
    model: 'default',
    effort: ['low', 'medium', 'high', 'xhigh', 'max'],
    transport: true,
    native: 'claudeArgs',
  },
  codex: {
    model: 'defer',
    effort: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    transport: false,
    native: 'codexConfig',
  },
};

/**
 * The shipped default binding per address, built FRESH per call (never a
 * shared object — a frozen manifest must own its values outright, so an
 * accidental in-place write can't leak across runs). Maker lanes and the
 * run-long claude voices ride claude/Opus headless; the checker lanes ride
 * codex — the cross-family review is the shipped posture.
 */
export function defaultBindingFor(address: BindAddress): Binding {
  switch (address) {
    case 'orchestrator':
    case 'consultant':
    case 'architect':
    case 'builder':
      return { provider: 'claude', model: DEFAULT_CLAUDE_MODEL, transport: 'headless' };
    case 'analyst':
    case 'critic':
    case 'judge':
      return { provider: 'codex' };
  }
}

// Derived from the registry's closed vocabulary, never a hand list — a duty
// added there is bindable here the same commit, instead of compiling fine
// while `--bind <newduty>=…` silently rejects it.
const BIND_ADDRESSES: readonly BindAddress[] = [...DUTIES, 'orchestrator', 'consultant'];

/**
 * Parse a bind address — the `<duty>` of `--bind <duty>=…` or the `<key>` of a
 * framing `bind.<key>:`. Duties alone name their stage (globally stage-unique,
 * enforced by validateRegistry), so the bare form is total; the explicit
 * `<stage>.<duty>` long form is RESERVED for a future workflow that collides
 * duty names — documented, rejected with a pointer at the bare spelling.
 */
export function parseBindAddress(raw: string): BindAddress {
  const name = raw.trim();
  if ((BIND_ADDRESSES as readonly string[]).includes(name)) return name as BindAddress;
  if (name.includes('.')) {
    const bare = name.slice(name.indexOf('.') + 1);
    if ((BIND_ADDRESSES as readonly string[]).includes(bare)) {
      throw new Error(
        `bind address "${name}": the explicit stage.duty form is reserved and not yet accepted — duty names are globally stage-unique, so spell it bare: "${bare}"`,
      );
    }
  }
  throw new Error(
    `bind address "${name}" is not bindable — use a duty (${DUTIES.join(', ')}) or a run-long voice (orchestrator, consultant)`,
  );
}

/**
 * Parse a `provider[:model][@effort]` binding spec — THE one binding grammar, shared by
 * `--bind` values, framing `bind.*` values, and the config tables' field pair.
 * Deliberately says nothing about transport (config-file only; the merge in
 * `resolveRunConfig` carries a configured claude transport forward so a
 * model-only override can never silently flip a subscription-billed voice back
 * to metered headless).
 */
export function parseBindingSpec(address: BindAddress, spec: string): Binding {
  if (spec.trim() === '') {
    throw new Error(`the ${address} binding is empty — set it to "provider[:model][@effort]" (e.g. "codex", "claude:claude-sonnet-5"), or omit it for the default`);
  }
  const { body, effort } = splitEffortSuffix(address, spec.trim());
  const [provider, ...rest] = body.split(':');
  const model = rest.length > 0 ? rest.join(':') : undefined;
  return parseProviderModel(address, {
    provider,
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  });
}

function splitEffortSuffix(address: BindAddress, spec: string): { body: string; effort?: string } {
  const at = spec.lastIndexOf('@');
  if (at === -1) return { body: spec };
  const effort = spec.slice(at + 1);
  if (!effort) throw new Error(`config: the ${address} binding has an empty @effort suffix`);
  const body = spec.slice(0, at);
  if (!body) throw new Error(`config: the ${address} binding is missing a provider before @${effort}`);
  if (body.includes('@')) {
    throw new Error(`config: the ${address} binding uses "@" inside the provider/model spec — "@" is reserved for the @effort suffix`);
  }
  return { body, effort };
}

/**
 * The model default resolved per provider: claude falls back to
 * DEFAULT_CLAUDE_MODEL, codex leaves it absent (~/.codex/config.toml governs).
 * Applied once, at resolution (parseBindingTable and resolveAddress) — NEVER in
 * the spec parser — so an omitted model stays distinguishable from an explicit
 * one and can carry forward from a same-provider config binding before this
 * fallback fills it.
 */
function defaultedModel(provider: Provider, model: string | undefined): string | undefined {
  return model ?? (PROVIDER_CAPS[provider].model === 'default' ? DEFAULT_CLAUDE_MODEL : undefined);
}

/**
 * Validate the provider + duet-owned knobs — shared by the spec grammar and the
 * config tables. Returns exactly what the user supplied (no model default): the
 * claude fallback is applied later, at resolution, so an omitted model can carry
 * forward. Rejects an empty model string (a stray trailing ":").
 */
function parseProviderModel(address: BindAddress, table: Record<string, unknown>): Binding {
  const provider = table['provider'];
  if (provider !== 'claude' && provider !== 'codex') {
    throw new Error(`config: the ${address} binding's provider must be "claude" or "codex", got ${JSON.stringify(provider)}`);
  }
  const caps = PROVIDER_CAPS[provider];
  const model = table['model'];
  if (model !== undefined && typeof model !== 'string') {
    throw new Error(`config: the ${address} binding's model must be a string`);
  }
  if (typeof model === 'string' && model.trim() === '') {
    throw new Error(`config: the ${address} binding has an empty model — drop the trailing ":" or name a model (e.g. "${provider}:<model>")`);
  }
  const effort = table['effort'];
  if (effort !== undefined && typeof effort !== 'string') {
    throw new Error(`config: the ${address} binding's effort must be a string`);
  }
  if (effort !== undefined && !(caps.effort as readonly string[]).includes(effort)) {
    throw new Error(
      `config: the ${address} binding's ${provider} effort must be one of ${caps.effort.join(', ')} — got ${JSON.stringify(effort)}`,
    );
  }
  return {
    provider,
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort: effort as Effort }),
  };
}

/** A config-table binding: provider/model plus the config-only transport knob. */
function parseBindingTable(address: BindAddress, raw: unknown, tableName: string): Binding {
  if (typeof raw !== 'object' || raw === null) throw new Error(`config: [${tableName}] must be a table`);
  const table = raw as Record<string, unknown>;
  for (const dead of ['build', 'impl']) {
    if (table[dead] !== undefined) {
      throw new Error(
        `config: [${tableName}].${dead} — the post-handoff build override is retired; bind the delivery duty directly instead (e.g. [duties.builder] provider = "codex")`,
      );
    }
  }
  const base = parseProviderModel(address, table);
  const caps = PROVIDER_CAPS[base.provider];
  const transport = table['transport'];
  if (transport !== undefined) {
    if (!caps.transport) {
      throw new Error(
        `config: [${tableName}] sets a transport for the codex provider — transport is a claude-only knob (codex already bills the subscription); remove it`,
      );
    }
    if (transport !== 'headless' && transport !== 'interactive') {
      throw new Error(`config: [${tableName}].transport must be "headless" or "interactive", got ${JSON.stringify(transport)}`);
    }
    // The interactive transport always drives a read-write/bypass session, so
    // it serves the maker duties only — a read-only interactive checker is a
    // production item (interactive-transport spec §"Path to production").
    // Reject loudly so a misconfiguration can never silently grant a read-only
    // voice write access. The rule IS the lane, read from the registry (never
    // duty-name literals): the run-long voices are not duties, so they narrow
    // out first and stay rejected.
    const makerDuty = address !== 'orchestrator' && address !== 'consultant' && stageOfDutyLane(address) === 'maker';
    if (transport === 'interactive' && !makerDuty) {
      const makers = DUTIES.filter((d) => stageOfDutyLane(d) === 'maker');
      throw new Error(
        `config: [${tableName}].transport = "interactive" — the interactive transport serves the maker duties only in the spike (it runs read-write/bypass; a read-only interactive checker is a production item). Bind it on ${makers.map((d) => `[duties.${d}]`).join(' or ')}.`,
      );
    }
  }
  const claudeArgs = table['claude_args'];
  const codexConfig = table['codex_config'];
  let native: BindingNative | undefined;
  if (claudeArgs !== undefined) {
    if (caps.native !== 'claudeArgs') {
      throw new Error(`config: [${tableName}] sets claude_args for the codex provider — claude_args is a claude-only native passthrough; remove it`);
    }
    if (!Array.isArray(claudeArgs) || !claudeArgs.every((v) => typeof v === 'string')) {
      throw new Error(`config: [${tableName}].claude_args must be an array of strings`);
    }
    native = { ...(native ?? {}), claudeArgs: [...claudeArgs] };
  }
  if (codexConfig !== undefined) {
    if (caps.native !== 'codexConfig') {
      throw new Error(`config: [${tableName}] sets codex_config for the claude provider — codex_config is a codex-only native passthrough; remove it`);
    }
    if (typeof codexConfig !== 'object' || codexConfig === null || Array.isArray(codexConfig)) {
      throw new Error(`config: [${tableName}].codex_config must be a table`);
    }
    // Copy the parsed table so the frozen manifest owns its native config
    // outright (a later in-place mutation can't leak across the run), matching
    // the [...claudeArgs] copy above.
    native = { ...(native ?? {}), codexConfig: structuredClone(codexConfig) as Record<string, unknown> };
  }
  // Resolve fully: apply the claude model default (a config binding is complete),
  // add the transport (claude always carries one; codex never does), attach native.
  const model = defaultedModel(base.provider, base.model);
  return {
    provider: base.provider,
    ...(model !== undefined ? { model } : {}),
    ...(base.effort !== undefined ? { effort: base.effort } : {}),
    ...(base.provider === 'claude' ? { transport: (transport as 'headless' | 'interactive' | undefined) ?? 'headless' } : {}),
    ...(native ? { native } : {}),
  };
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

function expandConfigPath(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function parseCorpusRoot(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) throw new Error('config: [corpus] must be a table');
  const dir = (raw as Record<string, unknown>)['dir'];
  if (typeof dir !== 'string' || dir.trim() === '') {
    throw new Error('config: [corpus].dir must be a non-empty string path');
  }
  const expanded = expandConfigPath(dir.trim());
  // A central archive shared across projects must resolve to one place — a
  // relative dir would bind to whatever cwd read it (the project at `duet new`,
  // the duet repo when a script runs), silently fragmenting the archive.
  if (!isAbsolute(expanded)) {
    throw new Error(
      `config: [corpus].dir must be an absolute path or start with ~ (it names a central archive shared across projects), got ${JSON.stringify(dir)}`,
    );
  }
  return expanded;
}

/** The account-level config file: per-address binding tables + the budget/corpus keys. */
function loadConfigFile(configPath: string): { byAddress: Partial<Record<BindAddress, Binding>>; budget?: number; corpusRoot?: string } {
  const byAddress: Partial<Record<BindAddress, Binding>> = {};
  if (!existsSync(configPath)) return { byAddress };
  const config = parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  if (config['roles'] !== undefined) {
    throw new Error(
      `config: the [roles.*] tables are retired — bindings are duty-keyed now: top-level [orchestrator] and [consultant] tables plus [duties.<duty>] tables (${DUTIES.join(', ')})`,
    );
  }
  for (const voice of ['orchestrator', 'consultant'] as const) {
    if (config[voice] !== undefined) byAddress[voice] = parseBindingTable(voice, config[voice], voice);
  }
  const duties = config['duties'];
  if (duties !== undefined) {
    if (typeof duties !== 'object' || duties === null) throw new Error('config: [duties] must be a table of per-duty tables, e.g. [duties.builder]');
    for (const [key, raw] of Object.entries(duties as Record<string, unknown>)) {
      const address = parseBindAddress(key);
      if (address === 'orchestrator' || address === 'consultant') {
        throw new Error(`config: [duties.${key}] — ${key} is a run-long voice, not a duty; bind it as a top-level [${key}] table`);
      }
      byAddress[address] = parseBindingTable(address, raw, `duties.${key}`);
    }
  }
  const budget = config['budget'] !== undefined ? parseBudget(config['budget']) : undefined;
  const corpusRoot = config['corpus'] !== undefined ? parseCorpusRoot(config['corpus']) : undefined;
  return { byAddress, ...(budget !== undefined ? { budget } : {}), ...(corpusRoot !== undefined ? { corpusRoot } : {}) };
}

export function resolveConfiguredCorpusRoot(configPath: string = CONFIG_PATH): string | undefined {
  return loadConfigFile(configPath).corpusRoot;
}

/**
 * Narrow a dynamic duty index into a present binding, or throw a
 * prescribed-recovery error. The frozen manifest carries exactly the run's
 * workflow's duties, so only a foreign duty (a caller bug) can throw.
 */
export function dutyBindingFor(bindings: VoiceBindings, duty: Duty): Binding {
  const binding = bindings.duties[duty];
  if (!binding) {
    throw new Error(
      `no binding for duty "${duty}" on this run — the frozen manifest binds exactly the run's workflow's duties (${Object.keys(bindings.duties).join(', ')}), so the caller reached a duty this workflow doesn't have.`,
    );
  }
  return binding;
}

/**
 * Whether a continuity edge between two frozen bindings can actually carry a
 * session: same provider, and (for claude) the same transport — a provider
 * switch has no transcript to resume, and an interactive↔headless swap-on-
 * resume is unverified. The one compatibility rule the freeze-time degrade and
 * the session walk both read.
 */
export function sessionCompatible(a: Binding, b: Binding): boolean {
  if (a.provider !== b.provider) return false;
  if (a.provider === 'claude' && (a.transport ?? 'headless') !== (b.transport ?? 'headless')) return false;
  return true;
}

/** A continuity edge degraded to fresh at manifest freeze — echoed and noted, never silent. */
export interface DegradedEdge {
  into: Duty;
  from: Duty;
  /** Human-readable why, e.g. "claude → codex" or "interactive → headless". */
  reason: string;
}

/**
 * The registry edges these frozen bindings DEGRADE to fresh — a legitimate
 * configuration (plan-on-claude / build-on-codex on full is expressible and
 * kept), so never an error; never silent either (`duet new` echoes it, the
 * run notes it). Pure: derivable from the frozen state anywhere, so the
 * decision is one source with no persisted copy.
 */
export function degradedEdgesFor(bindings: VoiceBindings, workflow: WorkflowRef): DegradedEdge[] {
  const out: DegradedEdge[] = [];
  for (const stage of stagesOf(workflow)) {
    for (const duty of [stage.duties.maker, stage.duties.checker]) {
      const from = continuityEdgeFor(workflow, duty);
      if (!from) continue;
      const a = dutyBindingFor(bindings, from);
      const b = dutyBindingFor(bindings, duty);
      if (sessionCompatible(a, b)) continue;
      const reason =
        a.provider !== b.provider
          ? `${a.provider} → ${b.provider}`
          : `${a.transport ?? 'headless'} → ${b.transport ?? 'headless'}`;
      out.push({ into: duty, from, reason });
    }
  }
  return out;
}

/**
 * THE binding resolver for a turn — "who runs this" as a frozen-manifest
 * lookup by address; no band logic, no phase parameter (a duty names its own
 * stage). The one resolver worker construction, session identity, the
 * context-pressure scope, stats, and takeover all read.
 */
export function voiceBindingFor(bindings: VoiceBindings, voice: 'orchestrator' | Duty | 'consultant'): Binding {
  if (voice === 'orchestrator') return bindings.orchestrator;
  if (voice === 'consultant') {
    if (!bindings.consultant) {
      throw new Error(
        'no consultant is bound on this run — a consultant is bound only when --bind consultant=…, a framing bind.consultant/consultant: on, or a config [consultant] table sets one, so the enumerating surface should not have reached it here.',
      );
    }
    return bindings.consultant;
  }
  return dutyBindingFor(bindings, voice);
}

/** Every bound (address, binding) pair — the enumeration for echoes and provider scans. */
export function allBindings(bindings: VoiceBindings): Array<{ address: BindAddress; binding: Binding }> {
  return [
    { address: 'orchestrator' as const, binding: bindings.orchestrator },
    ...(Object.entries(bindings.duties) as Array<[Duty, Binding]>).map(([address, binding]) => ({ address, binding })),
    ...(bindings.consultant ? [{ address: 'consultant' as const, binding: bindings.consultant }] : []),
  ];
}

/**
 * Resolve a run's config into its frozen manifest half: the voice bindings
 * (per-key precedence flags > framing > config > shipped defaults), the
 * degraded continuity edges, and the budget. The ONE config entry point — the
 * old four parsers (role tables, role flags, build fields, the impl alias)
 * collapse into the one spec grammar above.
 *
 * Per-KEY precedence: each address resolves independently — a framing that
 * binds only the judge leaves the builder on config/defaults. A flag or
 * framing spec (which cannot express transport) landing on a claude provider
 * carries a configured claude transport forward; a provider switch drops it.
 *
 * The consultant's on/off axis composes with its binding: `--no-consultant`
 * beats everything; a framing `consultant: off` beats a framing/config
 * binding; `bind.consultant` alone implies bound; toggle + bind in ONE source
 * is a rejected contradiction (callers reject it at their parse boundary —
 * the framing parser and the CLI both do).
 */
export function resolveRunConfig(
  opts: {
    workflow: WorkflowRef;
    /** `--bind <address>=<spec>` values, keyed by parsed address (the flags tier). */
    flagBinds?: Partial<Record<BindAddress, string>>;
    /** Framing `bind.<address>:` values (the framing tier). */
    framingBinds?: Partial<Record<BindAddress, string>>;
    /** `--no-consultant` — wins over every other consultant source. */
    noConsultant?: boolean;
    /** The framing `consultant: on|off` toggle (flags win over it). */
    consultantToggle?: 'on' | 'off';
    budgetOverride?: string;
  },
  configPath: string = CONFIG_PATH,
): { bindings: VoiceBindings; degradedEdges: DegradedEdge[]; budget?: number; corpusRoot?: string } {
  const { byAddress: configBinds, budget: configBudget, corpusRoot } = loadConfigFile(configPath);
  if (opts.noConsultant && opts.flagBinds?.consultant !== undefined) {
    throw new Error('--no-consultant and --bind consultant=… contradict each other — drop one');
  }

  // One address through the tiers, per KEY. A spec overrides only the keys it
  // names: the knobs it cannot express (transport, native — config-only) and any
  // it omits (`:model`, `@effort`) carry forward from a same-provider config
  // binding, so a model-only or effort-only override never silently drops a
  // sibling knob. A provider switch shares nothing (a configured model/effort/
  // native may be illegal for the new provider). The claude model default is
  // applied last, at resolution, so an omitted model carries before it fills.
  const resolveAddress = (address: BindAddress): Binding => {
    const spec = opts.flagBinds?.[address] ?? opts.framingBinds?.[address];
    const configured = configBinds[address];
    if (spec === undefined) return configured ?? defaultBindingFor(address);
    const parsed = parseBindingSpec(address, spec);
    const base = parsed.provider === configured?.provider ? configured : undefined;
    const model = defaultedModel(parsed.provider, parsed.model ?? base?.model);
    const effort = parsed.effort ?? base?.effort;
    return {
      provider: parsed.provider,
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(base?.native ? { native: base.native } : {}),
      ...(parsed.provider === 'claude' ? { transport: base?.transport ?? 'headless' } : {}),
    };
  };

  const duties: Partial<Record<Duty, Binding>> = {};
  const runDuties = stagesOf(opts.workflow).flatMap((s) => [s.duties.maker, s.duties.checker]);
  for (const source of [opts.flagBinds, opts.framingBinds] as const) {
    for (const key of Object.keys(source ?? {})) {
      const address = key as BindAddress;
      if (address !== 'orchestrator' && address !== 'consultant' && !runDuties.includes(address as Duty)) {
        throw new Error(
          `bind.${address}: the "${opts.workflow}" workflow has no ${address} duty (its duties: ${runDuties.join(', ')}) — a binding for a duty the workflow lacks is rejected rather than silently ignored`,
        );
      }
    }
  }
  for (const duty of runDuties) duties[duty] = resolveAddress(duty);

  const orchestrator = resolveAddress('orchestrator');
  // The orchestrator's capability contract (custom harness tools, cooperative
  // pause/resume) is only implemented by the claude provider in v1. The codex
  // path is designed but unbuilt — docs/open-questions.md Q17.
  if (orchestrator.provider !== 'claude') {
    throw new Error(
      'the orchestrator requires the claude provider in v1 (codex-as-orchestrator is designed but unbuilt — see docs/open-questions.md Q17)',
    );
  }

  // The consultant: presence first (per-tier; a toggle+bind contradiction in
  // ONE source is rejected at that source's parse boundary, so here the tiers
  // just rank — and a framing `off` still beats a framing bind defensively),
  // then the binding through the same tiers.
  const consultantBound = (() => {
    if (opts.noConsultant) return false;
    if (opts.flagBinds?.consultant !== undefined) return true;
    if (opts.consultantToggle === 'off') return false;
    if (opts.consultantToggle === 'on') return true;
    if (opts.framingBinds?.consultant !== undefined) return true;
    return configBinds.consultant !== undefined;
  })();
  const consultant = consultantBound ? resolveAddress('consultant') : undefined;

  const bindings: VoiceBindings = { orchestrator, duties, ...(consultant ? { consultant } : {}) };
  const budget = opts.budgetOverride !== undefined ? parseBudget(opts.budgetOverride) : configBudget;
  return {
    bindings,
    degradedEdges: degradedEdgesFor(bindings, opts.workflow),
    ...(budget !== undefined ? { budget } : {}),
    ...(corpusRoot !== undefined ? { corpusRoot } : {}),
  };
}

/** Format a binding for echoes and status: `provider[:model][@effort][ (interactive)]`. */
export function formatBinding(binding: Binding): string {
  const model = binding.model ? `:${binding.model}` : '';
  const effort = binding.effort ? `@${binding.effort}` : '';
  const transport = binding.transport === 'interactive' ? ' (interactive)' : '';
  return `${binding.provider}${model}${effort}${transport}`;
}

/** The shipped default manifest for a workflow — the no-config, no-flag freeze. */
export function defaultBindingsFor(workflow: WorkflowRef): VoiceBindings {
  const duties: Partial<Record<Duty, Binding>> = {};
  for (const stage of stagesOf(workflow)) {
    for (const duty of [stage.duties.maker, stage.duties.checker]) duties[duty] = defaultBindingFor(duty);
  }
  return { orchestrator: defaultBindingFor('orchestrator'), duties };
}

// Re-exported for the surfaces that name a duty's stage without reaching into
// the registry module themselves (the CLI's --bind grammar help).
export { stageOfDuty };
export type { Duty };

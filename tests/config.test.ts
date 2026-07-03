import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import {
  DEFAULT_BINDINGS,
  effectiveBindingFor,
  loadRoleBindings,
  loadRunConfig,
  parseBudget,
  parseRoleOverride,
} from '../src/config.ts';
import type { RoleBindings } from '../src/config.ts';
import { test } from './helpers/fixtures.ts';

const configIn = (dir: string, toml: string): string => {
  const path = join(dir, 'config.toml');
  writeFileSync(path, toml);
  return path;
};

describe('role bindings', () => {
  test('absent config file yields the shipped defaults', ({ projectDir }) => {
    expect(loadRoleBindings(undefined, join(projectDir, 'missing.toml'))).toEqual(DEFAULT_BINDINGS);
  });

  test('the config file binds roles; claude roles default their model when omitted', ({ projectDir }) => {
    const path = configIn(
      projectDir,
      `[roles.implementer]\nprovider = "claude"\n\n[roles.reviewer]\nprovider = "claude"\nmodel = "claude-opus-4-6"`,
    );
    const bindings = loadRoleBindings(undefined, path);
    expect.soft(bindings.implementer).toEqual({ provider: 'claude', model: 'claude-opus-4-8', transport: 'headless' });
    expect.soft(bindings.reviewer).toEqual({ provider: 'claude', model: 'claude-opus-4-6', transport: 'headless' });
    expect.soft(bindings.orchestrator).toEqual(DEFAULT_BINDINGS.orchestrator);
  });

  test('a model on a codex binding is refused — ~/.codex/config.toml governs', ({ projectDir }) => {
    const path = configIn(projectDir, `[roles.reviewer]\nprovider = "codex"\nmodel = "gpt-5.5"`);
    expect(() => loadRoleBindings(undefined, path)).toThrow(/codex has no model key by design/);
  });

  test('an unknown provider is refused by name', ({ projectDir }) => {
    const path = configIn(projectDir, `[roles.reviewer]\nprovider = "gemini"`);
    expect(() => loadRoleBindings(undefined, path)).toThrow(/provider must be "claude" or "codex"/);
  });

  test('CLI overrides win over the config file', ({ projectDir }) => {
    const path = configIn(projectDir, `[roles.implementer]\nprovider = "claude"\nmodel = "claude-opus-4-6"`);
    const bindings = loadRoleBindings({ implementer: 'claude:claude-fable-5', reviewer: 'codex' }, path);
    expect.soft(bindings.implementer).toEqual({ provider: 'claude', model: 'claude-fable-5', transport: 'headless' });
    expect.soft(bindings.reviewer).toEqual({ provider: 'codex' });
  });

  test('orchestrator-on-codex is refused in v1 (codex-as-orchestrator is designed but unbuilt)', ({ projectDir }) => {
    expect(() => loadRoleBindings({ orchestrator: 'codex' }, join(projectDir, 'missing.toml'))).toThrow(
      /orchestrator role requires the claude provider in v1/,
    );
  });
});

describe('the transport knob (the subscription-billing opt-in)', () => {
  test('an interactive transport parses on a claude binding', ({ projectDir }) => {
    const path = configIn(projectDir, `[roles.implementer]\nprovider = "claude"\ntransport = "interactive"`);
    expect(loadRoleBindings(undefined, path).implementer).toEqual({
      provider: 'claude',
      model: 'claude-opus-4-8',
      transport: 'interactive',
    });
  });

  test('a claude binding with no transport defaults to headless', ({ projectDir }) => {
    const path = configIn(projectDir, `[roles.implementer]\nprovider = "claude"`);
    expect(loadRoleBindings(undefined, path).implementer.transport).toBe('headless');
  });

  test('a transport on a codex binding is refused — codex already bills the subscription', ({ projectDir }) => {
    const path = configIn(projectDir, `[roles.reviewer]\nprovider = "codex"\ntransport = "interactive"`);
    expect(() => loadRoleBindings(undefined, path)).toThrow(/transport for the codex provider/);
  });

  test('an invalid transport value is refused by name', ({ projectDir }) => {
    const path = configIn(projectDir, `[roles.implementer]\nprovider = "claude"\ntransport = "tmux"`);
    expect(() => loadRoleBindings(undefined, path)).toThrow(/transport must be "headless" or "interactive"/);
  });

  test('an interactive transport is refused on a non-implementer role (implementer-only scope)', ({ projectDir }) => {
    const reviewer = configIn(projectDir, `[roles.reviewer]\nprovider = "claude"\ntransport = "interactive"`);
    expect.soft(() => loadRoleBindings(undefined, reviewer)).toThrow(/implementer-only/);
    const orchestrator = configIn(projectDir, `[roles.orchestrator]\nprovider = "claude"\ntransport = "interactive"`);
    expect.soft(() => loadRoleBindings(undefined, orchestrator)).toThrow(/implementer-only/);
  });

  test('a headless transport stays allowed on any claude role — only interactive is implementer-scoped', ({
    projectDir,
  }) => {
    const path = configIn(projectDir, `[roles.reviewer]\nprovider = "claude"\ntransport = "headless"`);
    expect(loadRoleBindings(undefined, path).reviewer).toEqual({ provider: 'claude', model: 'claude-opus-4-8', transport: 'headless' });
  });
});

describe('override-merge preserves a configured interactive transport (the billing footgun)', () => {
  const interactiveImpl = (dir: string): string =>
    configIn(dir, `[roles.implementer]\nprovider = "claude"\ntransport = "interactive"`);

  test('a model-only override keeps the configured interactive transport', ({ projectDir }) => {
    const bindings = loadRoleBindings({ implementer: 'claude:claude-fable-5' }, interactiveImpl(projectDir));
    expect(bindings.implementer).toEqual({ provider: 'claude', model: 'claude-fable-5', transport: 'interactive' });
  });

  test('a bare model-less override (claude) still keeps interactive — no injected headless default', ({
    projectDir,
  }) => {
    const bindings = loadRoleBindings({ implementer: 'claude' }, interactiveImpl(projectDir));
    expect(bindings.implementer).toEqual({ provider: 'claude', model: 'claude-opus-4-8', transport: 'interactive' });
  });

  test('switching the provider to codex drops the transport', ({ projectDir }) => {
    const bindings = loadRoleBindings({ implementer: 'codex' }, interactiveImpl(projectDir));
    expect(bindings.implementer).toEqual({ provider: 'codex' });
  });

  test('a claude override with no configured transport stays headless', ({ projectDir }) => {
    const path = configIn(projectDir, `[roles.implementer]\nprovider = "claude"`);
    const bindings = loadRoleBindings({ implementer: 'claude:claude-fable-5' }, path);
    expect(bindings.implementer.transport).toBe('headless');
  });

  test('switching the provider up from codex to claude defaults headless (nothing to carry)', ({ projectDir }) => {
    const path = configIn(projectDir, `[roles.implementer]\nprovider = "codex"`);
    expect.soft(loadRoleBindings({ implementer: 'claude' }, path).implementer).toEqual({
      provider: 'claude',
      model: 'claude-opus-4-8',
      transport: 'headless',
    });
    expect
      .soft(loadRoleBindings({ implementer: 'claude:claude-fable-5' }, path).implementer.transport)
      .toBe('headless');
  });
});

describe('parseRoleOverride', () => {
  test('parses provider and optional model, defaulting claude models per role — never a transport', () => {
    expect.soft(parseRoleOverride('implementer', 'claude')).toEqual({ provider: 'claude', model: 'claude-opus-4-8' });
    expect.soft(parseRoleOverride('implementer', 'claude:claude-opus-4-6')).toEqual({
      provider: 'claude',
      model: 'claude-opus-4-6',
    });
    expect.soft(parseRoleOverride('reviewer', 'codex')).toEqual({ provider: 'codex' });
  });
});

describe('effectiveBindingFor — the per-phase binding resolver (T4)', () => {
  const withBuild = (build?: { provider: 'claude' | 'codex'; model?: string }): RoleBindings => ({
    ...DEFAULT_BINDINGS,
    implementer: { provider: 'claude', model: 'claude-opus-4-8', transport: 'headless', ...(build ? { build } : {}) },
  });

  test('no build override ⇒ the base binding in every phase (byte-for-byte today)', () => {
    const bindings = withBuild();
    for (const phase of ['frame', 'spec', 'plan', 'implement', 'finish'] as const) {
      expect.soft(effectiveBindingFor(bindings, 'implementer', 'full', phase)).toBe(bindings.implementer);
    }
  });

  test('with a claude build override: base binding through planning, override model after the handoff gate', () => {
    const bindings = withBuild({ provider: 'claude', model: 'claude-sonnet-5' });
    // planning (through the plan handoff gate) keeps the smart base binding
    expect.soft(effectiveBindingFor(bindings, 'implementer', 'full', 'frame')).toBe(bindings.implementer);
    expect.soft(effectiveBindingFor(bindings, 'implementer', 'full', 'plan')).toBe(bindings.implementer);
    // the build + finishing tail switch to the override — a REPLACEMENT binding, headless
    const built = effectiveBindingFor(bindings, 'implementer', 'full', 'implement');
    expect.soft(built).toEqual({ provider: 'claude', model: 'claude-sonnet-5', transport: 'headless' });
    expect.soft(effectiveBindingFor(bindings, 'implementer', 'full', 'finish')).toEqual(built);
    // and the base object is untouched (replace, never mutate)
    expect.soft(bindings.implementer.model).toBe('claude-opus-4-8');
  });

  test('a codex build override switches the PROVIDER post-handoff (relay: plan on claude, build on codex)', () => {
    const bindings = withBuild({ provider: 'codex' });
    expect.soft(effectiveBindingFor(bindings, 'implementer', 'full', 'plan')).toBe(bindings.implementer);
    expect.soft(effectiveBindingFor(bindings, 'implementer', 'full', 'implement')).toEqual({ provider: 'codex' });
  });

  test('a claude build override on a codex base — the reviewer half of the criss-cross', () => {
    const bindings: RoleBindings = {
      ...DEFAULT_BINDINGS,
      reviewer: { provider: 'codex', build: { provider: 'claude', model: 'claude-fable-5' } },
    };
    expect.soft(effectiveBindingFor(bindings, 'reviewer', 'design', 'design')).toBe(bindings.reviewer);
    expect.soft(effectiveBindingFor(bindings, 'reviewer', 'design', 'implement')).toEqual({
      provider: 'claude',
      model: 'claude-fable-5',
      transport: 'headless',
    });
  });

  test('rir: research keeps base; implement and finish take the override', () => {
    const bindings = withBuild({ provider: 'claude', model: 'claude-sonnet-5' });
    expect.soft(effectiveBindingFor(bindings, 'implementer', 'rir', 'research')).toBe(bindings.implementer);
    expect.soft(effectiveBindingFor(bindings, 'implementer', 'rir', 'implement').model).toBe('claude-sonnet-5');
    expect.soft(effectiveBindingFor(bindings, 'implementer', 'rir', 'finish').model).toBe('claude-sonnet-5');
  });

  test('a model-less claude override defaults the role claude model', () => {
    const bindings = withBuild({ provider: 'claude' });
    expect.soft(effectiveBindingFor(bindings, 'implementer', 'full', 'implement').model).toBe('claude-opus-4-8');
  });
});

describe('the build knob (post-handoff binding override)', () => {
  test('[roles.implementer].build parses onto the binding as a RoleOverride; impl is its alias', ({ projectDir }) => {
    const viaBuild = loadRunConfig({}, configIn(projectDir, `[roles.implementer]\nprovider = "claude"\nbuild = "claude:claude-sonnet-5"`)).bindings;
    const viaImpl = loadRunConfig({}, configIn(projectDir, `[roles.implementer]\nprovider = "claude"\nimpl = "claude:claude-sonnet-5"`)).bindings;
    const expected = {
      provider: 'claude',
      model: 'claude-opus-4-8',
      transport: 'headless',
      build: { provider: 'claude', model: 'claude-sonnet-5' },
    };
    expect.soft(viaBuild.implementer).toEqual(expected);
    expect.soft(viaImpl.implementer).toEqual(expected); // the alias parses into the same field
  });

  test('both build and its impl alias on one table is refused (one knob, one spelling)', ({ projectDir }) => {
    const path = configIn(projectDir, `[roles.implementer]\nprovider = "claude"\nbuild = "codex"\nimpl = "codex"`);
    expect(() => loadRoleBindings(undefined, path)).toThrow(/both "build" and its alias "impl"/);
  });

  test('a provider switch is a supported value — codex build on a claude base, and the inverse on the reviewer', ({
    projectDir,
  }) => {
    const cross = loadRunConfig(
      {},
      configIn(
        projectDir,
        `[roles.implementer]\nprovider = "claude"\nbuild = "codex"\n[roles.reviewer]\nprovider = "codex"\nbuild = "claude:claude-fable-5"`,
      ),
    ).bindings;
    expect.soft(cross.implementer.build).toEqual({ provider: 'codex' });
    expect.soft(cross.reviewer).toEqual({ provider: 'codex', build: { provider: 'claude', model: 'claude-fable-5' } });
  });

  test('--impl-model attaches the override; it wins over a configured build', ({ projectDir }) => {
    const path = configIn(projectDir, `[roles.implementer]\nprovider = "claude"\nbuild = "claude:claude-sonnet-5"`);
    const bindings = loadRunConfig({ implModelOverride: 'claude:claude-haiku-4-5-20251001' }, path).bindings;
    expect(bindings.implementer.build).toEqual({ provider: 'claude', model: 'claude-haiku-4-5-20251001' });
  });

  test('a base override carries a configured build forward — on either provider branch', ({ projectDir }) => {
    const path = configIn(projectDir, `[roles.implementer]\nprovider = "claude"\nbuild = "claude:claude-sonnet-5"`);
    // Changing only the base model must NOT discard the build-phase binding.
    const modelOnly = loadRoleBindings({ implementer: 'claude:claude-opus-4-6' }, path);
    expect.soft(modelOnly.implementer.model).toBe('claude-opus-4-6');
    expect.soft(modelOnly.implementer.build).toEqual({ provider: 'claude', model: 'claude-sonnet-5' });
    // A provider switch carries it too — the build override rides either base.
    const codexBase = loadRoleBindings({ implementer: 'codex' }, path);
    expect.soft(codexBase.implementer).toEqual({ provider: 'codex', build: { provider: 'claude', model: 'claude-sonnet-5' } });
  });

  test('build on the orchestrator is refused — the orchestrator runs one binding across the arc', ({ projectDir }) => {
    const path = configIn(projectDir, `[roles.orchestrator]\nprovider = "claude"\nbuild = "claude:claude-sonnet-5"`);
    expect(() => loadRoleBindings(undefined, path)).toThrow(/worker knob/);
  });

  test('the impl alias on a non-implementer role is refused by name — spell it build', ({ projectDir }) => {
    const path = configIn(projectDir, `[roles.reviewer]\nprovider = "claude"\nimpl = "claude:claude-sonnet-5"`);
    expect(() => loadRoleBindings(undefined, path)).toThrow(/impl is implementer-only/);
  });

  test('build with the interactive transport is refused in v1 (swap-on-resume unverified there)', ({
    projectDir,
  }) => {
    const path = configIn(
      projectDir,
      `[roles.implementer]\nprovider = "claude"\ntransport = "interactive"\nbuild = "claude:claude-sonnet-5"`,
    );
    expect(() => loadRoleBindings(undefined, path)).toThrow(/interactive transport/);
  });

  test('absent knob ⇒ no build field on any binding (byte-for-byte today)', ({ projectDir }) => {
    const bindings = loadRunConfig({}, join(projectDir, 'missing.toml')).bindings;
    expect(bindings.implementer).not.toHaveProperty('build');
  });

  test('--impl-model on a default binding never mutates the shared DEFAULT_BINDINGS (absent-knob invariant)', ({
    projectDir,
  }) => {
    const missing = join(projectDir, 'missing.toml');
    // A flag load with NO config table — the implementer is the shared default object.
    const withFlag = loadRunConfig({ implModelOverride: 'claude:claude-sonnet-5' }, missing).bindings;
    expect.soft(withFlag.implementer.build).toEqual({ provider: 'claude', model: 'claude-sonnet-5' });
    // A later plain load must return the pristine default — no leaked build.
    const plain = loadRunConfig({}, missing).bindings;
    expect.soft(plain.implementer).not.toHaveProperty('build');
    // And the module-global default itself is untouched (the direct proof).
    expect.soft(DEFAULT_BINDINGS.implementer).not.toHaveProperty('build');
  });

  test('an empty --impl-model spec is rejected with a clear message, not silently dropped', ({ projectDir }) => {
    expect(() => loadRunConfig({ implModelOverride: '' }, join(projectDir, 'missing.toml'))).toThrow(/build override is empty/);
  });
});

describe('parseBudget — the opt-in budget knob', () => {
  test('"off" resolves to undefined (disabled, never a 0 cap)', () => {
    expect(parseBudget('off')).toBeUndefined();
  });

  test('"default" resolves to multiplier 1 (today\'s per-phase profile)', () => {
    expect(parseBudget('default')).toBe(1);
  });

  test('a positive scalar — string (the flag) or number (TOML) — is the multiplier', () => {
    expect.soft(parseBudget('2')).toBe(2);
    expect.soft(parseBudget(2)).toBe(2);
    expect.soft(parseBudget('0.5')).toBe(0.5);
  });

  test('zero, negative, and garbage are refused with an actionable message', () => {
    expect.soft(() => parseBudget('0')).toThrow(/positive multiplier/);
    expect.soft(() => parseBudget(0)).toThrow(/positive multiplier/);
    expect.soft(() => parseBudget(-1)).toThrow(/positive multiplier/);
    expect.soft(() => parseBudget('lots')).toThrow(/must be "off", "default", or a positive multiplier/);
  });
});

describe('the consultant binding (optional, present-only)', () => {
  test('default-off is byte-for-byte: no consultant key, bindings equal the shipped defaults', ({ projectDir }) => {
    const bindings = loadRunConfig({}, join(projectDir, 'missing.toml')).bindings;
    expect.soft(bindings).not.toHaveProperty('consultant');
    expect.soft(bindings).toEqual(DEFAULT_BINDINGS);
  });

  test('[roles.consultant] binds the named provider; an omitted model defaults to claude-opus-4-8', ({ projectDir }) => {
    const named = configIn(projectDir, `[roles.consultant]\nprovider = "claude"\nmodel = "claude-opus-4-6"`);
    expect.soft(loadRunConfig({}, named).bindings.consultant).toEqual({
      provider: 'claude',
      model: 'claude-opus-4-6',
      transport: 'headless',
    });
    const bare = configIn(projectDir, `[roles.consultant]\nprovider = "claude"`);
    expect.soft(loadRunConfig({}, bare).bindings.consultant).toEqual({
      provider: 'claude',
      model: 'claude-opus-4-8', // the no-model default
      transport: 'headless',
    });
  });

  test('--consultant binds the named provider/model verbatim; enabled-without-model defaults claude-opus-4-8', ({
    projectDir,
  }) => {
    const missing = join(projectDir, 'missing.toml');
    expect.soft(loadRunConfig({ roleOverrides: { consultant: 'claude:claude-opus-4-6' } }, missing).bindings.consultant).toEqual({
      provider: 'claude',
      model: 'claude-opus-4-6',
      transport: 'headless',
    });
    expect.soft(loadRunConfig({ roleOverrides: { consultant: 'claude' } }, missing).bindings.consultant).toEqual({
      provider: 'claude',
      model: 'claude-opus-4-8',
      transport: 'headless',
    });
    // A codex consultant carries no model and no transport, like any codex binding.
    expect.soft(loadRunConfig({ roleOverrides: { consultant: 'codex' } }, missing).bindings.consultant).toEqual({
      provider: 'codex',
    });
  });

  test('--no-consultant removes a config-bound consultant for the run (and wins over --consultant)', ({ projectDir }) => {
    const path = configIn(projectDir, `[roles.consultant]\nprovider = "claude"`);
    // The disable yields an absent binding — back to byte-for-byte defaults.
    expect.soft(loadRunConfig({ noConsultant: true }, path).bindings.consultant).toBeUndefined();
    expect.soft(loadRunConfig({ noConsultant: true }, path).bindings).toEqual(DEFAULT_BINDINGS);
    // Mutually exclusive intent: the disable wins over a same-run --consultant.
    expect
      .soft(loadRunConfig({ noConsultant: true, roleOverrides: { consultant: 'claude' } }, path).bindings.consultant)
      .toBeUndefined();
  });

  test('the framing consultant: on|off toggle flips a binding for the run; the flags win over it', ({ projectDir }) => {
    const missing = join(projectDir, 'missing.toml');
    const bound = configIn(projectDir, `[roles.consultant]\nprovider = "codex"`);
    // off disables a config-bound consultant for this run.
    expect.soft(loadRunConfig({ consultantToggle: 'off' }, bound).bindings.consultant).toBeUndefined();
    // on enables the default claude consultant when none is config-bound (it can't bind a model — that's config's job).
    expect.soft(loadRunConfig({ consultantToggle: 'on' }, missing).bindings.consultant).toEqual({
      provider: 'claude',
      model: 'claude-opus-4-8',
      transport: 'headless',
    });
    // on leaves a config-bound consultant exactly as configured — it un-suppresses, never rebinds.
    expect.soft(loadRunConfig({ consultantToggle: 'on' }, bound).bindings.consultant).toEqual({ provider: 'codex' });
    // The flags win: --no-consultant beats `on`; an explicit --consultant binding beats `off`.
    expect.soft(loadRunConfig({ noConsultant: true, consultantToggle: 'on' }, bound).bindings.consultant).toBeUndefined();
    expect
      .soft(loadRunConfig({ roleOverrides: { consultant: 'claude' }, consultantToggle: 'off' }, missing).bindings.consultant)
      .toEqual({ provider: 'claude', model: 'claude-opus-4-8', transport: 'headless' });
  });

  test('[roles.consultant].transport = "interactive" is rejected — the consultant is read-only', ({ projectDir }) => {
    const path = configIn(projectDir, `[roles.consultant]\nprovider = "claude"\ntransport = "interactive"`);
    expect.soft(() => loadRunConfig({}, path)).toThrow(/implementer-only/);
    expect.soft(() => loadRunConfig({}, path)).toThrow(/read-only/);
  });
});

describe('loadRunConfig — bindings + the resolved budget', () => {
  test('absent config and no override ⇒ budget off (absent), shipped bindings', ({ projectDir }) => {
    const cfg = loadRunConfig({}, join(projectDir, 'missing.toml'));
    expect.soft(cfg.budget).toBeUndefined();
    expect.soft(cfg.bindings).toEqual(DEFAULT_BINDINGS);
  });

  test('a config budget key is read when no flag overrides it', ({ projectDir }) => {
    const path = configIn(projectDir, `budget = 2`);
    expect(loadRunConfig({}, path).budget).toBe(2);
  });

  test('the flag budgetOverride wins over a config budget', ({ projectDir }) => {
    const path = configIn(projectDir, `budget = 2`);
    expect(loadRunConfig({ budgetOverride: 'default' }, path).budget).toBe(1);
  });

  test('--budget off overrides a config budget down to off (absent)', ({ projectDir }) => {
    const path = configIn(projectDir, `budget = 2`);
    expect(loadRunConfig({ budgetOverride: 'off' }, path).budget).toBeUndefined();
  });

  test('loadRoleBindings is the bindings-only wrapper (parity, budget ignored)', ({ projectDir }) => {
    const path = configIn(projectDir, `budget = 2\n[roles.implementer]\nprovider = "claude"`);
    expect(loadRoleBindings(undefined, path)).toEqual(loadRunConfig({}, path).bindings);
  });
});

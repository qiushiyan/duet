import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import {
  DEFAULT_BINDINGS,
  implementerModelFor,
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

describe('implementerModelFor — the per-phase implementer model resolver', () => {
  const withImpl = (impl?: { provider: 'claude' | 'codex'; model?: string }): RoleBindings => ({
    ...DEFAULT_BINDINGS,
    implementer: { provider: 'claude', model: 'claude-opus-4-8', transport: 'headless', ...(impl ? { impl } : {}) },
  });

  test('no impl override ⇒ the base model in every phase (byte-for-byte today)', () => {
    const bindings = withImpl();
    for (const phase of ['frame', 'spec', 'plan', 'implement', 'finish'] as const) {
      expect.soft(implementerModelFor(bindings, 'full', phase)).toBe('claude-opus-4-8');
    }
  });

  test('with an impl override: base model through planning, impl model after the handoff gate', () => {
    const bindings = withImpl({ provider: 'claude', model: 'claude-sonnet-5' });
    // planning (through the plan handoff gate) keeps the smart base model
    expect.soft(implementerModelFor(bindings, 'full', 'frame')).toBe('claude-opus-4-8');
    expect.soft(implementerModelFor(bindings, 'full', 'spec')).toBe('claude-opus-4-8');
    expect.soft(implementerModelFor(bindings, 'full', 'plan')).toBe('claude-opus-4-8');
    // the build + finishing tail switch to the cheaper impl model
    expect.soft(implementerModelFor(bindings, 'full', 'implement')).toBe('claude-sonnet-5');
    expect.soft(implementerModelFor(bindings, 'full', 'finish')).toBe('claude-sonnet-5');
  });

  test('rir: research keeps base; implement and publish take the impl model', () => {
    const bindings = withImpl({ provider: 'claude', model: 'claude-sonnet-5' });
    expect.soft(implementerModelFor(bindings, 'rir', 'research')).toBe('claude-opus-4-8');
    expect.soft(implementerModelFor(bindings, 'rir', 'implement')).toBe('claude-sonnet-5');
    expect.soft(implementerModelFor(bindings, 'rir', 'finish')).toBe('claude-sonnet-5');
  });

  test('an impl override with no explicit model defaults the implementer claude model', () => {
    const bindings = withImpl({ provider: 'claude' });
    expect.soft(implementerModelFor(bindings, 'full', 'plan')).toBe('claude-opus-4-8');
    expect.soft(implementerModelFor(bindings, 'full', 'implement')).toBe('claude-opus-4-8'); // defaulted, a harmless no-op split
  });

  test('a codex implementer resolves to the base fallback (never reached by createWorkers, but total)', () => {
    const bindings: RoleBindings = { ...DEFAULT_BINDINGS, implementer: { provider: 'codex' } };
    expect.soft(implementerModelFor(bindings, 'full', 'implement')).toBe('claude-opus-4-8');
  });
});

describe('the impl-model knob (post-handoff implementer model)', () => {
  const implModel = (dir: string, model = 'claude-sonnet-5'): RoleBindings =>
    loadRunConfig({}, configIn(dir, `[roles.implementer]\nprovider = "claude"\nimpl = "claude:${model}"`)).bindings;

  test('[roles.implementer].impl parses onto the implementer binding as a RoleOverride', ({ projectDir }) => {
    expect(implModel(projectDir).implementer).toEqual({
      provider: 'claude',
      model: 'claude-opus-4-8',
      transport: 'headless',
      impl: { provider: 'claude', model: 'claude-sonnet-5' },
    });
  });

  test('--impl-model attaches the override; it wins over a configured impl', ({ projectDir }) => {
    const path = configIn(projectDir, `[roles.implementer]\nprovider = "claude"\nimpl = "claude:claude-sonnet-5"`);
    const bindings = loadRunConfig({ implModelOverride: 'claude:claude-haiku-4-5-20251001' }, path).bindings;
    expect(bindings.implementer.impl).toEqual({ provider: 'claude', model: 'claude-haiku-4-5-20251001' });
  });

  test('a --impl base override carries a configured impl forward (the load-bearing merge)', ({ projectDir }) => {
    const path = configIn(projectDir, `[roles.implementer]\nprovider = "claude"\nimpl = "claude:claude-sonnet-5"`);
    // Changing only the base model must NOT discard the build-phase model.
    const bindings = loadRoleBindings({ implementer: 'claude:claude-opus-4-6' }, path);
    expect.soft(bindings.implementer.model).toBe('claude-opus-4-6');
    expect.soft(bindings.implementer.impl).toEqual({ provider: 'claude', model: 'claude-sonnet-5' });
  });

  test('switching the implementer to codex drops the configured impl (mirrors transport)', ({ projectDir }) => {
    const path = configIn(projectDir, `[roles.implementer]\nprovider = "claude"\nimpl = "claude:claude-sonnet-5"`);
    expect(loadRoleBindings({ implementer: 'codex' }, path).implementer).toEqual({ provider: 'codex' });
  });

  test('impl on a codex implementer is refused — the swap is claude-only, same-provider', ({ projectDir }) => {
    const path = configIn(projectDir, `[roles.implementer]\nprovider = "codex"\nimpl = "claude:claude-sonnet-5"`);
    expect(() => loadRoleBindings(undefined, path)).toThrow(/needs a claude implementer/);
  });

  test('--impl-model on a codex-configured implementer is refused at the cross-source guard', ({ projectDir }) => {
    const path = configIn(projectDir, `[roles.implementer]\nprovider = "codex"`);
    expect(() => loadRunConfig({ implModelOverride: 'claude:claude-sonnet-5' }, path)).toThrow(
      /claude-only knob, but the implementer is bound to codex/,
    );
  });

  test('impl on a non-implementer role is refused — it is implementer-only', ({ projectDir }) => {
    const path = configIn(projectDir, `[roles.reviewer]\nprovider = "claude"\nimpl = "claude:claude-sonnet-5"`);
    expect(() => loadRoleBindings(undefined, path)).toThrow(/impl is implementer-only/);
  });

  test('a reserved (non-claude) impl provider is refused with the reserved message — bare and with a model', ({
    projectDir,
  }) => {
    const bare = configIn(projectDir, `[roles.implementer]\nprovider = "claude"\nimpl = "codex"`);
    expect.soft(() => loadRoleBindings(undefined, bare)).toThrow(/reserved/);
    const withModel = configIn(projectDir, `[roles.implementer]\nprovider = "claude"\nimpl = "codex:gpt-5"`);
    expect.soft(() => loadRoleBindings(undefined, withModel)).toThrow(/reserved/);
    // The flag path shares the same reserved guard.
    expect.soft(() => loadRunConfig({ implModelOverride: 'codex' }, join(projectDir, 'missing.toml'))).toThrow(/reserved/);
  });

  test('impl with the interactive transport is refused in v1 (model-swap-on-resume unverified there)', ({
    projectDir,
  }) => {
    const path = configIn(
      projectDir,
      `[roles.implementer]\nprovider = "claude"\ntransport = "interactive"\nimpl = "claude:claude-sonnet-5"`,
    );
    expect(() => loadRoleBindings(undefined, path)).toThrow(/interactive transport/);
  });

  test('absent knob ⇒ no impl field on any binding (byte-for-byte today)', ({ projectDir }) => {
    const bindings = loadRunConfig({}, join(projectDir, 'missing.toml')).bindings;
    expect(bindings.implementer).not.toHaveProperty('implement');
  });

  test('--impl-model on a default binding never mutates the shared DEFAULT_BINDINGS (absent-knob invariant)', ({
    projectDir,
  }) => {
    const missing = join(projectDir, 'missing.toml');
    // A flag load with NO config table — the implementer is the shared default object.
    const withFlag = loadRunConfig({ implModelOverride: 'claude:claude-sonnet-5' }, missing).bindings;
    expect.soft(withFlag.implementer.impl).toEqual({ provider: 'claude', model: 'claude-sonnet-5' });
    // A later plain load must return the pristine default — no leaked impl.
    const plain = loadRunConfig({}, missing).bindings;
    expect.soft(plain.implementer).not.toHaveProperty('implement');
    // And the module-global default itself is untouched (the direct proof).
    expect.soft(DEFAULT_BINDINGS.implementer).not.toHaveProperty('implement');
  });

  test('an empty --impl-model spec is rejected with a clear message, not silently dropped', ({ projectDir }) => {
    expect(() => loadRunConfig({ implModelOverride: '' }, join(projectDir, 'missing.toml'))).toThrow(/impl model is empty/);
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

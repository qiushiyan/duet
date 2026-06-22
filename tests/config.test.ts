import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { DEFAULT_BINDINGS, loadRoleBindings, loadRunConfig, parseBudget, parseRoleOverride } from '../src/config.ts';
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

  test('orchestrator-on-codex is refused in v1 (Q17 is designed but unbuilt)', ({ projectDir }) => {
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

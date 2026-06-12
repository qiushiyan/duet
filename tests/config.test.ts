import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { DEFAULT_BINDINGS, loadRoleBindings, parseRoleOverride } from '../src/config.ts';
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
    expect.soft(bindings.implementer).toEqual({ provider: 'claude', model: 'claude-fable-5' });
    expect.soft(bindings.reviewer).toEqual({ provider: 'claude', model: 'claude-opus-4-6' });
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
    expect.soft(bindings.implementer).toEqual({ provider: 'claude', model: 'claude-fable-5' });
    expect.soft(bindings.reviewer).toEqual({ provider: 'codex' });
  });

  test('orchestrator-on-codex is refused in v1 (Q17 is designed but unbuilt)', ({ projectDir }) => {
    expect(() => loadRoleBindings({ orchestrator: 'codex' }, join(projectDir, 'missing.toml'))).toThrow(
      /orchestrator role requires the claude provider in v1/,
    );
  });
});

describe('parseRoleOverride', () => {
  test('parses provider and optional model, defaulting claude models per role', () => {
    expect.soft(parseRoleOverride('implementer', 'claude')).toEqual({ provider: 'claude', model: 'claude-fable-5' });
    expect.soft(parseRoleOverride('implementer', 'claude:claude-opus-4-6')).toEqual({
      provider: 'claude',
      model: 'claude-opus-4-6',
    });
    expect.soft(parseRoleOverride('reviewer', 'codex')).toEqual({ provider: 'codex' });
  });
});

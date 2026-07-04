import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import {
  defaultBindingsFor,
  degradedEdgesFor,
  dutyBindingFor,
  formatBinding,
  parseBindAddress,
  parseBindingSpec,
  parseBudget,
  resolveRunConfig,
  sessionCompatible,
} from '../src/config.ts';
import type { VoiceBindings } from '../src/config.ts';
import { test } from './helpers/fixtures.ts';

/**
 * The manifest's binding half — the one spec grammar, the per-key precedence
 * (flags > framing > config > shipped defaults), the freeze-time continuity
 * degrade, and the rejection guards at the load boundary. Everything here goes
 * through the public resolveRunConfig/parse* surface; the config FILE is
 * exercised by writing a real TOML into a tmp dir (the configPath seam).
 */

function configIn(dir: string, content: string): string {
  const path = join(dir, 'config.toml');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, content);
  return path;
}

const missing = (dir: string) => join(dir, 'missing.toml');

describe('parseBindAddress — the --bind / bind.* key grammar', () => {
  test('every duty and run-long voice parses', () => {
    for (const a of ['architect', 'analyst', 'builder', 'critic', 'judge', 'orchestrator', 'consultant'] as const) {
      expect.soft(parseBindAddress(a)).toBe(a);
    }
  });

  test('an unknown address rejects naming the vocabulary', () => {
    expect(() => parseBindAddress('implementer')).toThrow(/not bindable — use a duty/);
  });

  test('the stage.duty long form is reserved: rejected with a pointer at the bare spelling', () => {
    expect(() => parseBindAddress('delivery.builder')).toThrow(/reserved[\s\S]*spell it bare: "builder"/);
  });
});

describe('parseBindingSpec — the one provider[:model] grammar', () => {
  test('a bare claude spec defaults the model; claude:model keeps it', () => {
    expect.soft(parseBindingSpec('builder', 'claude')).toEqual({ provider: 'claude', model: 'claude-opus-4-8' });
    expect.soft(parseBindingSpec('builder', 'claude:claude-fable-5')).toEqual({ provider: 'claude', model: 'claude-fable-5' });
  });

  test('codex takes no model — a model rejects with the config pointer', () => {
    expect.soft(parseBindingSpec('critic', 'codex')).toEqual({ provider: 'codex' });
    expect.soft(() => parseBindingSpec('critic', 'codex:gpt-6')).toThrow(/codex has no model key by design/);
  });

  test('an empty or unknown-provider spec rejects', () => {
    expect.soft(() => parseBindingSpec('builder', '')).toThrow(/binding is empty/);
    expect.soft(() => parseBindingSpec('builder', 'gemini')).toThrow(/provider must be "claude" or "codex"/);
  });
});

describe('the shipped defaults', () => {
  test('a missing config freezes the shipped posture: claude maker lane, codex checker lane, no consultant', ({ projectDir }) => {
    const { bindings, degradedEdges } = resolveRunConfig({ workflow: 'full' }, missing(projectDir));
    expect.soft(bindings).toEqual(defaultBindingsFor('full'));
    expect.soft(dutyBindingFor(bindings, 'architect')).toEqual({ provider: 'claude', model: 'claude-opus-4-8', transport: 'headless' });
    expect.soft(dutyBindingFor(bindings, 'builder')).toEqual({ provider: 'claude', model: 'claude-opus-4-8', transport: 'headless' });
    expect.soft(dutyBindingFor(bindings, 'analyst')).toEqual({ provider: 'codex' });
    expect.soft(dutyBindingFor(bindings, 'critic')).toEqual({ provider: 'codex' });
    expect.soft(bindings.consultant).toBeUndefined();
    // The default lanes are session-compatible, so nothing degrades.
    expect.soft(degradedEdges).toEqual([]);
  });

  test('the frozen duties are exactly the workflow’s four — relay carries a judge, never a critic', ({ projectDir }) => {
    const { bindings } = resolveRunConfig({ workflow: 'relay' }, missing(projectDir));
    expect.soft(Object.keys(bindings.duties).sort()).toEqual(['analyst', 'architect', 'builder', 'judge']);
    expect.soft(() => dutyBindingFor(bindings, 'critic')).toThrow(/no binding for duty "critic"/);
  });

  test('defaultBindingsFor hands out fresh objects — mutating one freeze never leaks into the next', () => {
    const a = defaultBindingsFor('full');
    dutyBindingFor(a, 'builder').model = 'mutated';
    expect(dutyBindingFor(defaultBindingsFor('full'), 'builder').model).toBe('claude-opus-4-8');
  });
});

describe('the config file — top-level [orchestrator]/[consultant] + [duties.*] tables', () => {
  test('a [duties.<duty>] table binds that duty; unbound duties keep defaults', ({ projectDir }) => {
    const path = configIn(projectDir, '[duties.builder]\nprovider = "codex"');
    const { bindings } = resolveRunConfig({ workflow: 'full' }, path);
    expect.soft(dutyBindingFor(bindings, 'builder')).toEqual({ provider: 'codex' });
    expect.soft(dutyBindingFor(bindings, 'architect')).toEqual({ provider: 'claude', model: 'claude-opus-4-8', transport: 'headless' });
  });

  test('a [consultant] table binds the consultant for every run', ({ projectDir }) => {
    const path = configIn(projectDir, '[consultant]\nprovider = "claude"\nmodel = "claude-fable-5"');
    const { bindings } = resolveRunConfig({ workflow: 'full' }, path);
    expect(bindings.consultant).toEqual({ provider: 'claude', model: 'claude-fable-5', transport: 'headless' });
  });

  test('the retired [roles.*] grammar rejects with a pointer at the duty tables', ({ projectDir }) => {
    const path = configIn(projectDir, '[roles.implementer]\nprovider = "claude"');
    expect(() => resolveRunConfig({ workflow: 'full' }, path)).toThrow(/\[roles\.\*\] tables are retired/);
  });

  test('the retired build/impl override keys reject with the direct-binding pointer', ({ projectDir }) => {
    const viaBuild = configIn(join(projectDir, 'a'), '[duties.architect]\nprovider = "claude"\nbuild = "codex"');
    expect.soft(() => resolveRunConfig({ workflow: 'full' }, viaBuild)).toThrow(/build override is retired/);
    const viaImpl = configIn(join(projectDir, 'b'), '[duties.builder]\nprovider = "claude"\nimpl = "codex"');
    expect.soft(() => resolveRunConfig({ workflow: 'full' }, viaImpl)).toThrow(/build override is retired/);
  });

  test('a duty spelled inside [duties] must be a duty; run-long voices point at their top-level table', ({ projectDir }) => {
    const path = configIn(projectDir, '[duties.orchestrator]\nprovider = "claude"');
    expect(() => resolveRunConfig({ workflow: 'full' }, path)).toThrow(/run-long voice, not a duty/);
  });

  test('transport is claude-only, valid-valued, and interactive is maker-only', ({ projectDir }) => {
    const onCodex = configIn(join(projectDir, 'a'), '[duties.critic]\nprovider = "codex"\ntransport = "headless"');
    expect.soft(() => resolveRunConfig({ workflow: 'full' }, onCodex)).toThrow(/transport is a claude-only knob/);
    const badValue = configIn(join(projectDir, 'b'), '[duties.builder]\nprovider = "claude"\ntransport = "carrier-pigeon"');
    expect.soft(() => resolveRunConfig({ workflow: 'full' }, badValue)).toThrow(/must be "headless" or "interactive"/);
    const onChecker = configIn(join(projectDir, 'c'), '[duties.analyst]\nprovider = "claude"\ntransport = "interactive"');
    expect.soft(() => resolveRunConfig({ workflow: 'full' }, onChecker)).toThrow(/maker duties only/);
    const onConsultant = configIn(join(projectDir, 'd'), '[consultant]\nprovider = "claude"\ntransport = "interactive"');
    expect.soft(() => resolveRunConfig({ workflow: 'full' }, onConsultant)).toThrow(/maker duties only/);
    const ok = configIn(join(projectDir, 'e'), '[duties.builder]\nprovider = "claude"\ntransport = "interactive"');
    expect.soft(dutyBindingFor(resolveRunConfig({ workflow: 'full' }, ok).bindings, 'builder').transport).toBe('interactive');
  });

  test('the orchestrator requires claude in v1 — from any tier', ({ projectDir }) => {
    const viaConfig = configIn(projectDir, '[orchestrator]\nprovider = "codex"');
    expect.soft(() => resolveRunConfig({ workflow: 'full' }, viaConfig)).toThrow(/orchestrator requires the claude provider/);
    expect.soft(() => resolveRunConfig({ workflow: 'full', flagBinds: { orchestrator: 'codex' } }, missing(projectDir))).toThrow(
      /orchestrator requires the claude provider/,
    );
  });
});

describe('per-key precedence — flags > framing > config > defaults', () => {
  test('each address resolves independently through the tiers', ({ projectDir }) => {
    const path = configIn(projectDir, '[duties.builder]\nprovider = "claude"\nmodel = "config-model"');
    const { bindings } = resolveRunConfig(
      {
        workflow: 'relay',
        flagBinds: { builder: 'claude:flag-model' },
        framingBinds: { builder: 'claude:framing-model', judge: 'claude:claude-fable-5' },
      },
      path,
    );
    // builder: the flag wins over framing and config; judge: framing wins over
    // the codex default; analyst/architect: untouched defaults.
    expect.soft(dutyBindingFor(bindings, 'builder').model).toBe('flag-model');
    expect.soft(dutyBindingFor(bindings, 'judge')).toEqual({ provider: 'claude', model: 'claude-fable-5', transport: 'headless' });
    expect.soft(dutyBindingFor(bindings, 'analyst')).toEqual({ provider: 'codex' });
  });

  test('a spec override keeps a configured claude transport (the billing footgun); a provider switch drops it', ({ projectDir }) => {
    const path = configIn(projectDir, '[duties.builder]\nprovider = "claude"\ntransport = "interactive"');
    // Model-only override: the subscription-billed transport carries forward.
    const carried = resolveRunConfig({ workflow: 'full', flagBinds: { builder: 'claude:claude-sonnet-5' } }, path);
    expect.soft(dutyBindingFor(carried.bindings, 'builder')).toEqual({ provider: 'claude', model: 'claude-sonnet-5', transport: 'interactive' });
    // Provider switch: nothing to carry — codex carries no transport at all.
    const switched = resolveRunConfig({ workflow: 'full', flagBinds: { builder: 'codex' } }, path);
    expect.soft(dutyBindingFor(switched.bindings, 'builder')).toEqual({ provider: 'codex' });
  });

  test('a binding for a duty the workflow lacks rejects rather than silently ignoring', ({ projectDir }) => {
    expect.soft(() => resolveRunConfig({ workflow: 'full', flagBinds: { judge: 'claude' } }, missing(projectDir))).toThrow(
      /the "full" workflow has no judge duty/,
    );
    expect.soft(() => resolveRunConfig({ workflow: 'relay', framingBinds: { critic: 'codex' } }, missing(projectDir))).toThrow(
      /the "relay" workflow has no critic duty/,
    );
  });
});

describe('the consultant’s on/off axis composes with its binding', () => {
  const bound = (dir: string) => configIn(dir, '[consultant]\nprovider = "codex"');

  test('--no-consultant removes a config-bound consultant, leaving the rest byte-for-byte', ({ projectDir }) => {
    const { bindings } = resolveRunConfig({ workflow: 'full', noConsultant: true }, bound(projectDir));
    expect.soft(bindings.consultant).toBeUndefined();
    expect.soft(bindings).toEqual(defaultBindingsFor('full'));
  });

  test('--no-consultant with --bind consultant is a rejected one-source contradiction', ({ projectDir }) => {
    expect(() =>
      resolveRunConfig({ workflow: 'full', noConsultant: true, flagBinds: { consultant: 'claude' } }, missing(projectDir)),
    ).toThrow(/contradict each other/);
  });

  test('the framing toggle: off disables a config-bound consultant; on enables the default claude one', ({ projectDir }) => {
    expect.soft(resolveRunConfig({ workflow: 'full', consultantToggle: 'off' }, bound(projectDir)).bindings.consultant).toBeUndefined();
    expect.soft(resolveRunConfig({ workflow: 'full', consultantToggle: 'on' }, missing(projectDir)).bindings.consultant).toEqual({
      provider: 'claude',
      model: 'claude-opus-4-8',
      transport: 'headless',
    });
    // on + config-bound: the toggle enables, the config supplies the binding.
    expect.soft(resolveRunConfig({ workflow: 'full', consultantToggle: 'on' }, bound(projectDir)).bindings.consultant).toEqual({ provider: 'codex' });
  });

  test('a bind.consultant alone implies bound; a flag bind wins over a framing off-toggle', ({ projectDir }) => {
    expect.soft(resolveRunConfig({ workflow: 'full', framingBinds: { consultant: 'claude' } }, missing(projectDir)).bindings.consultant).toEqual({
      provider: 'claude',
      model: 'claude-opus-4-8',
      transport: 'headless',
    });
    expect.soft(
      resolveRunConfig({ workflow: 'full', consultantToggle: 'off', flagBinds: { consultant: 'claude' } }, missing(projectDir)).bindings
        .consultant,
    ).toEqual({ provider: 'claude', model: 'claude-opus-4-8', transport: 'headless' });
  });
});

describe('the freeze-time continuity degrade — legitimate, echoed, never silent', () => {
  test('a provider-crossing maker edge degrades to fresh (full, build on codex) and names the reason', ({ projectDir }) => {
    const { degradedEdges } = resolveRunConfig({ workflow: 'full', flagBinds: { builder: 'codex' } }, missing(projectDir));
    expect(degradedEdges).toEqual([{ into: 'builder', from: 'architect', reason: 'claude → codex' }]);
  });

  test('a checker-lane crossing degrades its own edge independently', ({ projectDir }) => {
    const { degradedEdges } = resolveRunConfig({ workflow: 'rir', flagBinds: { critic: 'claude' } }, missing(projectDir));
    expect(degradedEdges).toEqual([{ into: 'critic', from: 'analyst', reason: 'codex → claude' }]);
  });

  test('relay declares no edges, so even a full criss-cross degrades nothing', ({ projectDir }) => {
    const { degradedEdges } = resolveRunConfig(
      { workflow: 'relay', flagBinds: { builder: 'codex', judge: 'claude:claude-fable-5' } },
      missing(projectDir),
    );
    expect(degradedEdges).toEqual([]);
  });

  test('a transport-crossing edge degrades too — an interactive↔headless swap-on-resume is unverified', ({ projectDir }) => {
    const path = configIn(projectDir, '[duties.architect]\nprovider = "claude"\ntransport = "interactive"');
    const { degradedEdges } = resolveRunConfig({ workflow: 'full' }, path);
    expect(degradedEdges).toEqual([{ into: 'builder', from: 'architect', reason: 'interactive → headless' }]);
  });

  test('sessionCompatible is the one rule: provider first, then claude transport', () => {
    expect.soft(sessionCompatible({ provider: 'codex' }, { provider: 'codex' })).toBe(true);
    expect.soft(sessionCompatible({ provider: 'claude', transport: 'headless' }, { provider: 'claude' })).toBe(true); // absent ≡ headless
    expect.soft(sessionCompatible({ provider: 'claude' }, { provider: 'codex' })).toBe(false);
    expect.soft(sessionCompatible({ provider: 'claude', transport: 'interactive' }, { provider: 'claude', transport: 'headless' })).toBe(false);
  });

  test('degradedEdgesFor is pure over the frozen state — re-derivable anywhere, no persisted copy', ({ projectDir }) => {
    const { bindings } = resolveRunConfig({ workflow: 'full', flagBinds: { builder: 'codex' } }, missing(projectDir));
    expect(degradedEdgesFor(bindings as VoiceBindings, 'full')).toEqual([{ into: 'builder', from: 'architect', reason: 'claude → codex' }]);
  });
});

describe('budget — flag over config over the off default', () => {
  test('parseBudget: off → undefined (never 0), default → 1, positive multiplier passes, junk rejects', () => {
    expect.soft(parseBudget('off')).toBeUndefined();
    expect.soft(parseBudget('default')).toBe(1);
    expect.soft(parseBudget(0.5)).toBe(0.5);
    expect.soft(() => parseBudget('0')).toThrow(/positive multiplier/);
    expect.soft(() => parseBudget('free')).toThrow(/positive multiplier/);
  });

  test('the config budget key resolves; the flag wins; an explicit off overrides a config budget', ({ projectDir }) => {
    const path = configIn(projectDir, 'budget = 2');
    expect.soft(resolveRunConfig({ workflow: 'full' }, path).budget).toBe(2);
    expect.soft(resolveRunConfig({ workflow: 'full', budgetOverride: 'default' }, path).budget).toBe(1);
    expect.soft(resolveRunConfig({ workflow: 'full', budgetOverride: 'off' }, path).budget).toBeUndefined();
  });
});

describe('formatBinding — the echo/status rendering', () => {
  test('provider, claude model, and the interactive marker', () => {
    expect.soft(formatBinding({ provider: 'codex' })).toBe('codex');
    expect.soft(formatBinding({ provider: 'claude', model: 'claude-opus-4-8', transport: 'headless' })).toBe('claude:claude-opus-4-8');
    expect.soft(formatBinding({ provider: 'claude', model: 'm', transport: 'interactive' })).toBe('claude:m (interactive)');
  });
});

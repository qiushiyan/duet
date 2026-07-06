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
} from '../src/voices/bindings.ts';
import type { VoiceBindings } from '../src/voices/bindings.ts';
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
  test('a bare claude spec leaves the model to resolution; claude:model keeps it', () => {
    // The spec parser no longer eagerly defaults claude's model — the fallback is
    // applied at resolution, so an omitted model can carry forward from config first.
    expect.soft(parseBindingSpec('builder', 'claude')).toEqual({ provider: 'claude' });
    expect.soft(parseBindingSpec('builder', 'claude:claude-fable-5')).toEqual({ provider: 'claude', model: 'claude-fable-5' });
  });

  test('codex can defer to config or carry an inline model', () => {
    expect.soft(parseBindingSpec('critic', 'codex')).toEqual({ provider: 'codex' });
    expect.soft(parseBindingSpec('critic', 'codex:gpt-5.5')).toEqual({ provider: 'codex', model: 'gpt-5.5' });
  });

  test('@effort parses for bare and modeled bindings', () => {
    expect.soft(parseBindingSpec('critic', 'codex@low')).toEqual({ provider: 'codex', effort: 'low' });
    expect.soft(parseBindingSpec('critic', 'codex:gpt-5.5@high')).toEqual({ provider: 'codex', model: 'gpt-5.5', effort: 'high' });
    expect.soft(parseBindingSpec('builder', 'claude:claude-opus-4-8@max')).toEqual({
      provider: 'claude',
      model: 'claude-opus-4-8',
      effort: 'max',
    });
  });

  test('effort is fail-closed per provider and @ is reserved for the suffix', () => {
    expect.soft(() => parseBindingSpec('critic', 'codex:gpt-5.5@max')).toThrow(/codex effort must be one of minimal, low, medium, high, xhigh/);
    expect.soft(() => parseBindingSpec('builder', 'claude:minimal-model@minimal')).toThrow(/claude effort must be one of low, medium, high, xhigh, max/);
    expect.soft(() => parseBindingSpec('builder', 'claude:model@name@high')).toThrow(/"@" is reserved/);
    expect.soft(() => parseBindingSpec('builder', 'claude@')).toThrow(/empty @effort suffix/);
  });

  test('an empty, empty-model, or unknown-provider spec rejects', () => {
    expect.soft(() => parseBindingSpec('builder', '')).toThrow(/binding is empty/);
    expect.soft(() => parseBindingSpec('builder', 'gemini')).toThrow(/provider must be "claude" or "codex"/);
    // A stray trailing ":" is a typo, not an empty-model request — reject rather
    // than emit an invisible `--model ""` (which formatBinding would hide).
    expect.soft(() => parseBindingSpec('builder', 'claude:')).toThrow(/empty model/);
    expect.soft(() => parseBindingSpec('critic', 'codex:')).toThrow(/empty model/);
    expect.soft(() => parseBindingSpec('builder', 'claude:@high')).toThrow(/empty model/);
  });

  test('a same-provider override without a model carries the configured model (both providers)', ({ projectDir }) => {
    // The symmetric case to the transport/effort carry-forward: an effort-only or
    // bare same-provider override must not silently drop a configured inline model.
    const claudeCfg = configIn(join(projectDir, 'c'), '[duties.builder]\nprovider = "claude"\nmodel = "claude-fable-5"');
    const claudeCarried = resolveRunConfig({ workflow: 'full', flagBinds: { builder: 'claude@low' } }, claudeCfg);
    expect.soft(dutyBindingFor(claudeCarried.bindings, 'builder')).toEqual({
      provider: 'claude',
      model: 'claude-fable-5',
      effort: 'low',
      transport: 'headless',
    });
    const codexCfg = configIn(join(projectDir, 'x'), '[duties.critic]\nprovider = "codex"\nmodel = "gpt-5.5"');
    const codexCarried = resolveRunConfig({ workflow: 'full', flagBinds: { critic: 'codex@high' } }, codexCfg);
    expect.soft(dutyBindingFor(codexCarried.bindings, 'critic')).toEqual({ provider: 'codex', model: 'gpt-5.5', effort: 'high' });
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

  test('effort fields validate per provider from config tables', ({ projectDir }) => {
    const ok = configIn(
      join(projectDir, 'ok'),
      '[duties.builder]\nprovider = "claude"\neffort = "xhigh"\n\n[duties.critic]\nprovider = "codex"\neffort = "minimal"',
    );
    const bindings = resolveRunConfig({ workflow: 'full' }, ok).bindings;
    expect.soft(dutyBindingFor(bindings, 'builder').effort).toBe('xhigh');
    expect.soft(dutyBindingFor(bindings, 'critic').effort).toBe('minimal');

    const codexMax = configIn(join(projectDir, 'bad-codex'), '[duties.critic]\nprovider = "codex"\neffort = "max"');
    const claudeMinimal = configIn(join(projectDir, 'bad-claude'), '[duties.builder]\nprovider = "claude"\neffort = "minimal"');
    expect.soft(() => resolveRunConfig({ workflow: 'full' }, codexMax)).toThrow(/codex effort must be one of minimal, low, medium, high, xhigh/);
    expect.soft(() => resolveRunConfig({ workflow: 'full' }, claudeMinimal)).toThrow(/claude effort must be one of low, medium, high, xhigh, max/);
  });

  test('native passthrough fields route structurally to their provider only', ({ projectDir }) => {
    const ok = configIn(
      join(projectDir, 'ok'),
      '[duties.builder]\nprovider = "claude"\nclaude_args = ["--fallback-model", "claude-opus-4-6"]\n\n[duties.critic]\nprovider = "codex"\ncodex_config = { model_reasoning_summary = "detailed" }',
    );
    const bindings = resolveRunConfig({ workflow: 'full' }, ok).bindings;
    expect.soft(dutyBindingFor(bindings, 'builder').native).toEqual({ claudeArgs: ['--fallback-model', 'claude-opus-4-6'] });
    expect.soft(dutyBindingFor(bindings, 'critic').native).toEqual({ codexConfig: { model_reasoning_summary: 'detailed' } });

    const claudeArgsOnCodex = configIn(join(projectDir, 'bad-a'), '[duties.critic]\nprovider = "codex"\nclaude_args = ["--debug"]');
    const codexConfigOnClaude = configIn(join(projectDir, 'bad-b'), '[duties.builder]\nprovider = "claude"\ncodex_config = { model = "gpt-5.5" }');
    const badClaudeArgs = configIn(join(projectDir, 'bad-c'), '[duties.builder]\nprovider = "claude"\nclaude_args = ["--debug", 1]');
    const badCodexConfig = configIn(join(projectDir, 'bad-d'), '[duties.critic]\nprovider = "codex"\ncodex_config = "model = gpt"');
    expect.soft(() => resolveRunConfig({ workflow: 'full' }, claudeArgsOnCodex)).toThrow(/claude_args is a claude-only native passthrough/);
    expect.soft(() => resolveRunConfig({ workflow: 'full' }, codexConfigOnClaude)).toThrow(/codex_config is a codex-only native passthrough/);
    expect.soft(() => resolveRunConfig({ workflow: 'full' }, badClaudeArgs)).toThrow(/claude_args must be an array of strings/);
    expect.soft(() => resolveRunConfig({ workflow: 'full' }, badCodexConfig)).toThrow(/codex_config must be a table/);
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
    const path = configIn(projectDir, '[duties.builder]\nprovider = "claude"\ntransport = "interactive"\nclaude_args = ["--fallback-model", "claude-opus-4-6"]');
    // Model-only override: the subscription-billed transport carries forward.
    const carried = resolveRunConfig({ workflow: 'full', flagBinds: { builder: 'claude:claude-sonnet-5' } }, path);
    expect.soft(dutyBindingFor(carried.bindings, 'builder')).toEqual({
      provider: 'claude',
      model: 'claude-sonnet-5',
      transport: 'interactive',
      native: { claudeArgs: ['--fallback-model', 'claude-opus-4-6'] },
    });
    // Provider switch: nothing to carry — codex carries no transport at all.
    const switched = resolveRunConfig({ workflow: 'full', flagBinds: { builder: 'codex' } }, path);
    expect.soft(dutyBindingFor(switched.bindings, 'builder')).toEqual({ provider: 'codex' });
  });

  test('a configured effort carries a same-provider override; an @effort wins; a provider switch drops it', ({ projectDir }) => {
    const path = configIn(projectDir, '[duties.builder]\nprovider = "claude"\neffort = "high"');
    // Model-only override, same provider: the configured effort carries (per key).
    const carried = resolveRunConfig({ workflow: 'full', flagBinds: { builder: 'claude:claude-sonnet-5' } }, path);
    expect.soft(dutyBindingFor(carried.bindings, 'builder')).toEqual({
      provider: 'claude',
      model: 'claude-sonnet-5',
      effort: 'high',
      transport: 'headless',
    });
    // An explicit @effort in the spec wins over the configured one.
    const overridden = resolveRunConfig({ workflow: 'full', flagBinds: { builder: 'claude:claude-sonnet-5@max' } }, path);
    expect.soft(dutyBindingFor(overridden.bindings, 'builder').effort).toBe('max');
    // Provider switch resets effort (a claude effort may be illegal for codex).
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
    const { degradedEdges } = resolveRunConfig({ workflow: 'short', flagBinds: { critic: 'claude' } }, missing(projectDir));
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

describe('corpus config — account-level archive root', () => {
  test('absent config keeps corpus off; [corpus].dir resolves once from the same config reader', ({ projectDir }) => {
    expect.soft(resolveRunConfig({ workflow: 'full' }, missing(projectDir)).corpusRoot).toBeUndefined();

    const root = join(projectDir, 'duet-corpus');
    const path = configIn(projectDir, `[corpus]\ndir = "${root}"`);
    expect.soft(resolveRunConfig({ workflow: 'full' }, path).corpusRoot).toBe(root);
  });

  test('tilde expands and malformed corpus tables fail closed', ({ projectDir }) => {
    const homePath = configIn(join(projectDir, 'homey'), '[corpus]\ndir = "~/duet-corpus"');
    expect.soft(resolveRunConfig({ workflow: 'full' }, homePath).corpusRoot).toMatch(/duet-corpus$/);

    const badTable = configIn(join(projectDir, 'bad-table'), 'corpus = "somewhere"');
    const badDir = configIn(join(projectDir, 'bad-dir'), '[corpus]\ndir = ""');
    expect.soft(() => resolveRunConfig({ workflow: 'full' }, badTable)).toThrow(/\[corpus\] must be a table/);
    expect.soft(() => resolveRunConfig({ workflow: 'full' }, badDir)).toThrow(/\[corpus\]\.dir/);
  });
});

describe('formatBinding — the echo/status rendering', () => {
  test('provider, model, effort, and the interactive marker', () => {
    expect.soft(formatBinding({ provider: 'codex' })).toBe('codex');
    expect.soft(formatBinding({ provider: 'codex', model: 'gpt-5.5' })).toBe('codex:gpt-5.5');
    expect.soft(formatBinding({ provider: 'codex', effort: 'high' })).toBe('codex@high');
    expect.soft(formatBinding({ provider: 'codex', model: 'gpt-5.5', effort: 'xhigh' })).toBe('codex:gpt-5.5@xhigh');
    expect.soft(formatBinding({ provider: 'claude', model: 'claude-opus-4-8', transport: 'headless' })).toBe('claude:claude-opus-4-8');
    expect.soft(formatBinding({ provider: 'claude', model: 'm', effort: 'max', transport: 'interactive' })).toBe('claude:m@max (interactive)');
  });
});

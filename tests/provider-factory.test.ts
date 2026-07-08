import { describe, expect, test, vi } from 'vitest';
import { ClaudeWorker } from '../src/voices/providers/claude.ts';
import { InteractiveClaudeWorker } from '../src/voices/providers/interactive-claude.ts';
import { createWorkers, providerFor } from '../src/voices/providers/index.ts';
import { defaultBindingsFor } from '../src/voices/bindings.ts';
import type { VoiceBindings } from '../src/voices/bindings.ts';
import { makerDutyOf, stageOf } from '../src/registry/workflows.ts';
import type { PhaseName } from '../src/registry/workflows.ts';

// execa is the provider's true external boundary (mock allowed there). No test
// in this file spawns the real `claude`, so a file-global mock is safe — it is
// configured only by the maker-binding argv test below.
const mockExeca = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: mockExeca }));

// The codex SDK is the codex provider's true external boundary — mocked because
// createWorkers constructs a CodexWorker, whose client resolves the codex binary
// at construction; no test in this file runs a codex turn, so the mock is inert
// beyond construction.
const codexRunStreamed = vi.hoisted(() => vi.fn());
const codexConstructedOptions = vi.hoisted((): unknown[] => []);
const codexStartThreadOptions = vi.hoisted(() => vi.fn());
const codexResumeThreadOptions = vi.hoisted(() => vi.fn());
vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    constructor(options?: unknown) {
      codexConstructedOptions.push(options);
    }
    startThread(options?: unknown) {
      codexStartThreadOptions(options);
      return { id: 'codex-thread', runStreamed: codexRunStreamed };
    }
    resumeThread(id: string, options?: unknown) {
      codexResumeThreadOptions(id, options);
      return { id: 'codex-thread', runStreamed: codexRunStreamed };
    }
  },
}));

describe('createWorkers', () => {
  test('binds each role to its provider with the phase rails applied', () => {
    const workers = createWorkers(defaultBindingsFor('full'), 'full', 'spec', { workerBudgetUsd: 10, timeoutMs: 60_000 });
    expect.soft(workers.architect?.name).toBe('claude');
    expect.soft(workers.analyst?.name).toBe('codex');
  });

  test('a workerBudgetUsd: undefined rail builds a ClaudeWorker (off → the cap is omitted downstream)', () => {
    // The undefined cap is now a legal rail (budgets off); it flows to the
    // ClaudeWorker's config, where claudeArgs leaves --max-budget-usd off the
    // argv (pinned directly by the claudeArgs omission test above).
    const workers = createWorkers(defaultBindingsFor('full'), 'full', 'spec', { workerBudgetUsd: undefined, timeoutMs: 60_000 });
    expect.soft(workers.architect).toBeInstanceOf(ClaudeWorker);
    expect.soft(workers.architect?.name).toBe('claude');
  });

  test('an interactive claude binding builds the interactive transport; headless stays ClaudeWorker', () => {
    const headless = createWorkers(defaultBindingsFor('full'), 'full', 'spec', { workerBudgetUsd: 10, timeoutMs: 60_000 });
    expect.soft(headless.architect).toBeInstanceOf(ClaudeWorker);

    const base = defaultBindingsFor('full');
    const interactive = createWorkers(
      { ...base, duties: { ...base.duties, architect: { provider: 'claude', model: 'claude-opus-4-8', transport: 'interactive' } } },
      'full',
      'spec',
      { workerBudgetUsd: 10, timeoutMs: 60_000 },
    );
    expect.soft(interactive.architect).toBeInstanceOf(InteractiveClaudeWorker);
    expect.soft(interactive.architect?.name).toBe('claude'); // the same WorkerProvider contract name
  });

  test('the maker builds with the builder duty\u2019s model/effort/native argv in delivery, the architect\u2019s in planning', async () => {
    // The true wiring, exercised through the public interface (createWorkers →
    // runTurn → the execa argv): the builder duty's model shows up on the
    // --model flag only for a delivery phase; a planning phase keeps the
    // architect's binding.
    const base = defaultBindingsFor('full');
    const bindings: VoiceBindings = {
      ...base,
      duties: {
        ...base.duties,
        builder: {
          provider: 'claude',
          model: 'claude-sonnet-5',
          effort: 'max',
          transport: 'headless',
          native: { claudeArgs: ['--fallback-model', 'claude-opus-4-6'] },
        },
      },
    };
    const argvForPhase = async (phase: PhaseName): Promise<string[]> => {
      let argv: string[] = [];
      mockExeca.mockImplementationOnce((_cmd: string, args: string[]) => {
        argv = args;
        return Promise.resolve({
          stdout: JSON.stringify([{ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's' }]),
        });
      });
      const maker = makerDutyOf('full', stageOf('full', phase));
      await providerFor(createWorkers(bindings, 'full', phase, { workerBudgetUsd: 10, timeoutMs: 60_000 }), maker).runTurn({ prompt: 'go', cwd: '/x' });
      return argv;
    };
    const planArgv = await argvForPhase('plan');
    expect.soft(planArgv[planArgv.indexOf('--model') + 1]).toBe('claude-opus-4-8'); // planning: the architect's smart base
    expect.soft(planArgv).not.toContain('--effort');

    const implArgv = await argvForPhase('implement');
    expect.soft(implArgv[implArgv.indexOf('--model') + 1]).toBe('claude-sonnet-5'); // delivery: the builder duty's own binding
    expect.soft(implArgv[implArgv.indexOf('--effort') + 1]).toBe('max');
    expect.soft(implArgv.slice(-2)).toEqual(['--fallback-model', 'claude-opus-4-6']);
  });

  test('per-stage duty bindings SWITCH THE PROVIDER at the stage boundary — the criss-cross falls out per phase', () => {
    // The T4 wiring: effectiveBindingFor resolves BEFORE the provider branch,
    // so the same bindings construct different worker classes per phase.
    const base = defaultBindingsFor('blueprint');
    const crisscross: VoiceBindings = {
      ...base,
      duties: {
        architect: { provider: 'claude', model: 'claude-opus-4-8', transport: 'headless' },
        analyst: { provider: 'codex' },
        builder: { provider: 'codex' },
        critic: { provider: 'claude', model: 'claude-fable-5', transport: 'headless' },
      },
    };
    const rails = { workerBudgetUsd: 10, timeoutMs: 60_000 };
    // Planning: architect on claude, analyst on codex (the base pair).
    const planning = createWorkers(crisscross, 'blueprint', 'spec', rails);
    expect.soft(planning.architect).toBeInstanceOf(ClaudeWorker);
    expect.soft(planning.analyst?.name).toBe('codex');
    // Delivery: the providers criss-cross — codex builds, claude critiques.
    const build = createWorkers(crisscross, 'blueprint', 'implement', rails);
    expect.soft(build.builder?.name).toBe('codex');
    expect.soft(build.critic).toBeInstanceOf(ClaudeWorker);
    expect.soft(build.critic?.name).toBe('claude');
  });

  test('the consultant provider is built only when bound; an un-enabled run has exactly today’s two', () => {
    const unbound = createWorkers(defaultBindingsFor('full'), 'full', 'spec', { workerBudgetUsd: 10, timeoutMs: 60_000 });
    expect.soft(unbound).not.toHaveProperty('consultant');
    expect.soft(unbound.consultant).toBeUndefined();

    const bound = createWorkers(
      { ...defaultBindingsFor('full'), consultant: { provider: 'claude', model: 'claude-opus-4-8', transport: 'headless' } },
      'full',
      'spec',
      { workerBudgetUsd: 10, timeoutMs: 60_000 },
    );
    expect.soft(bound.consultant).toBeInstanceOf(ClaudeWorker);
    expect.soft(bound.consultant?.name).toBe('claude');
  });
});

describe('providerFor (narrow-or-prescribed-error over the optional consultant)', () => {
  test('returns a built provider, and throws a prescribed-recovery error for an unbuilt role', () => {
    const unbound = createWorkers(defaultBindingsFor('full'), 'full', 'spec', { workerBudgetUsd: 10, timeoutMs: 60_000 });
    expect.soft(providerFor(unbound, 'architect').name).toBe('claude');
    expect.soft(providerFor(unbound, 'analyst').name).toBe('codex');
    expect.soft(() => providerFor(unbound, 'consultant')).toThrow(/no consultant worker is built/);

    const bound = createWorkers(
      { ...defaultBindingsFor('full'), consultant: { provider: 'codex' } },
      'full',
      'spec',
      { workerBudgetUsd: 10, timeoutMs: 60_000 },
    );
    expect.soft(providerFor(bound, 'consultant').name).toBe('codex');
  });
});

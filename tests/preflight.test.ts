import { describe, expect } from 'vitest';
import { defaultBindingsFor } from '../src/voices/bindings.ts';
import type { Binding, VoiceBindings } from '../src/voices/bindings.ts';
import {
  PreflightFailedError,
  bindingNeedsPreflight,
  preflightBinding,
  preflightCandidates,
  preflightMarker,
  preflightRunBindings,
} from '../src/voices/preflight.ts';
import { FakeWorker, test } from './helpers/fixtures.ts';

describe('bindingNeedsPreflight', () => {
  test('skips pure defaults but catches explicit provider-validated knobs', () => {
    expect.soft(bindingNeedsPreflight({ provider: 'codex' })).toBe(false);
    expect.soft(bindingNeedsPreflight({ provider: 'claude', model: 'claude-opus-4-8', transport: 'headless' })).toBe(false);
    expect.soft(bindingNeedsPreflight({ provider: 'codex', model: 'gpt-5.5' })).toBe(true);
    expect.soft(bindingNeedsPreflight({ provider: 'claude', model: 'claude-fable-5', transport: 'headless' })).toBe(true);
    expect.soft(bindingNeedsPreflight({ provider: 'codex', native: { codexConfig: { model_reasoning_summary: 'detailed' } } })).toBe(true);
    expect.soft(bindingNeedsPreflight({ provider: 'claude', model: 'claude-opus-4-8', native: { claudeArgs: ['--debug'] } })).toBe(true);
  });
});

describe('preflightBinding', () => {
  test('runs a throwaway turn through the WorkerProvider seam and discards session state', async ({ projectDir }) => {
    const worker = new FakeWorker('codex', [{ warnings: ['Warning: native warning'] }]);
    const outcome = await preflightBinding({ provider: 'codex', model: 'gpt-5.5' }, projectDir, {
      createWorker: () => worker,
      strictConfigProbe: async () => [],
    });

    expect.soft(outcome).toEqual({ status: 'warning', warnings: ['Warning: native warning'] });
    expect.soft(worker.calls).toHaveLength(1);
    expect.soft(worker.calls[0]?.prompt).toBe('Reply with the single word OK.');
    expect.soft(worker.calls[0]?.cwd).toBe(projectDir);
    expect.soft(worker.calls[0]?.sessionId).toBeUndefined();
    expect.soft(worker.calls[0]?.onSessionId).toBeUndefined();
  });

  test('aborts on unknown-class provider failures', async ({ projectDir }) => {
    const outcome = await preflightBinding({ provider: 'claude', model: 'bad-model', transport: 'headless' }, projectDir, {
      createWorker: () => new FakeWorker('claude', [new Error('unknown native flag --wat')]),
    });

    expect(outcome).toEqual({ status: 'abort', errorClass: 'unknown', message: 'unknown native flag --wat' });
  });

  test('warns and proceeds on classified infra/auth failures', async ({ projectDir }) => {
    const outcome = await preflightBinding({ provider: 'codex', model: 'gpt-5.5' }, projectDir, {
      createWorker: () => new FakeWorker('codex', [new Error('ECONNRESET while connecting')]),
    });

    expect.soft(outcome.status).toBe('warning');
    if (outcome.status !== 'warning') throw new Error(`expected warning outcome, got ${outcome.status}`);
    expect.soft(outcome.warnings.join('\n')).toMatch(/ECONNRESET/);
    expect.soft(outcome.warnings.join('\n')).toMatch(/will validate at first use/);
  });

  test('adds codex strict-config advisory warnings without aborting', async ({ projectDir }) => {
    const binding: Binding = { provider: 'codex', native: { codexConfig: { typo_key: true } } };
    const outcome = await preflightBinding(binding, projectDir, {
      createWorker: () => new FakeWorker('codex'),
      strictConfigProbe: async () => ['codex --strict-config advisory for codex: unknown configuration field `typo_key`'],
    });

    expect(outcome).toEqual({
      status: 'warning',
      warnings: ['codex --strict-config advisory for codex: unknown configuration field `typo_key`'],
    });
  });
});

describe('preflightRunBindings', () => {
  test('skips default worker bindings', async ({ projectDir }) => {
    let calls = 0;
    const report = await preflightRunBindings(defaultBindingsFor('full'), 'full', projectDir, {
      createWorker: () => {
        calls++;
        return new FakeWorker('codex');
      },
    });

    expect.soft(calls).toBe(0);
    expect.soft(report.byAddress).toEqual({});
  });

  test('dedupes identical explicit bindings and maps the result back to every address', async ({ projectDir }) => {
    const base = defaultBindingsFor('full');
    const shared: Binding = { provider: 'codex', model: 'gpt-5.5' };
    const bindings: VoiceBindings = {
      ...base,
      duties: { ...base.duties, analyst: shared, critic: { provider: 'codex', model: 'gpt-5.5' } },
    };
    const workers: FakeWorker[] = [];

    const candidates = preflightCandidates(bindings, 'full');
    expect.soft(candidates.map((c) => c.addresses)).toEqual([['analyst', 'critic']]);

    const report = await preflightRunBindings(bindings, 'full', projectDir, {
      createWorker: (binding) => {
        const worker = new FakeWorker(binding.provider);
        workers.push(worker);
        return worker;
      },
    });

    expect.soft(workers).toHaveLength(1);
    expect.soft(report.byAddress.analyst?.status).toBe('ok');
    expect.soft(report.byAddress.critic?.status).toBe('ok');
    expect.soft(preflightMarker(report.byAddress.analyst)).toBe(' ✓ preflighted');
  });

  test('throws a PreflightFailedError when any deduped binding aborts', async ({ projectDir }) => {
    const base = defaultBindingsFor('full');
    const bindings: VoiceBindings = {
      ...base,
      duties: { ...base.duties, critic: { provider: 'codex', model: 'bad-model' } },
    };

    await expect(
      preflightRunBindings(bindings, 'full', projectDir, {
        createWorker: () => new FakeWorker('codex', [new Error('model may not exist')]),
      }),
    ).rejects.toBeInstanceOf(PreflightFailedError);
  });

  test('renders warning markers with the provider warning', () => {
    expect(preflightMarker({ status: 'warning', binding: { provider: 'codex', model: 'gpt-5.5' }, messages: ['network blip'] })).toBe(
      ' ⚠ network blip',
    );
  });
});

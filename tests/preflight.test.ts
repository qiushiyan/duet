import { describe, expect } from 'vitest';
import { defaultBindingsFor } from '../src/voices/bindings.ts';
import type { Binding, VoiceBindings } from '../src/voices/bindings.ts';
import {
  PreflightFailedError,
  bindingNeedsPreflight,
  preflightBinding,
  preflightCandidates,
  preflightDisposition,
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
    });

    expect.soft(outcome).toEqual({ status: 'warning', warnings: ['Warning: native warning'] });
    expect.soft(worker.calls).toHaveLength(1);
    expect.soft(worker.calls[0]?.prompt).toBe('Reply with the single word OK.');
    expect.soft(worker.calls[0]?.cwd).toBe(projectDir);
    expect.soft(worker.calls[0]?.sessionId).toBeUndefined();
    expect.soft(worker.calls[0]?.onSessionId).toBeUndefined();
  });

  test('aborts on a provider rejection — a bad flag or an unusable model', async ({ projectDir }) => {
    const badFlag = await preflightBinding(
      { provider: 'claude', model: 'claude-opus-4-8', native: { claudeArgs: ['--wat'] }, transport: 'headless' },
      projectDir,
      { createWorker: () => new FakeWorker('claude', [new Error("error: unknown option '--wat'")]) },
    );
    expect.soft(badFlag).toEqual({ status: 'abort', message: "error: unknown option '--wat'" });

    const badModel = await preflightBinding({ provider: 'claude', model: 'claude-nope-9', transport: 'headless' }, projectDir, {
      createWorker: () => new FakeWorker('claude', [new Error("There's an issue with the selected model (claude-nope-9). It may not exist.")]),
    });
    expect.soft(badModel.status).toBe('abort');
  });

  test('warns and proceeds on a transient/environmental failure (never blocks a good run)', async ({ projectDir }) => {
    const outcome = await preflightBinding({ provider: 'codex', model: 'gpt-5.5' }, projectDir, {
      createWorker: () => new FakeWorker('codex', [new Error('ECONNRESET while connecting')]),
    });

    expect.soft(outcome.status).toBe('warning');
    if (outcome.status !== 'warning') throw new Error(`expected warning outcome, got ${outcome.status}`);
    expect.soft(outcome.warnings.join('\n')).toMatch(/ECONNRESET/);
    expect.soft(outcome.warnings.join('\n')).toMatch(/will validate at first use/);
  });
});

describe('preflightDisposition', () => {
  test('aborts only on a provider-config rejection; warns on transient/ambiguous', () => {
    for (const abort of [
      "error: unknown option '--wat'",
      "error: unexpected argument '--bogus' found",
      "There's an issue with the selected model (claude-nope). It may not exist.",
      'model_not_found: the model does not exist',
      'gpt-nope: no such model',
    ]) {
      expect.soft(preflightDisposition(abort), abort).toBe('abort');
    }
    for (const warn of [
      'Command timed out after 120000 milliseconds',
      'socket hang up',
      'Client network socket disconnected before secure TLS connection was established',
      'ECONNRESET',
      'Error 429: Too Many Requests', // a genuine rate limit, not a mistyped binding
      'could not launch tmux session',
    ]) {
      expect.soft(preflightDisposition(warn), warn).toBe('warn');
    }
    // A bad MODEL whose name contains a taxonomy token still aborts — the old
    // classifyError hole (a `429` in the name flipping abort→warn), closed.
    expect.soft(preflightDisposition("There's an issue with the selected model (gpt-429-x).")).toBe('abort');
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
        createWorker: () => new FakeWorker('codex', [new Error("There's an issue with the selected model (bad-model). It may not exist.")]),
      }),
    ).rejects.toBeInstanceOf(PreflightFailedError);
  });

  test('renders warning markers with the provider warning', () => {
    expect(preflightMarker({ status: 'warning', binding: { provider: 'codex', model: 'gpt-5.5' }, messages: ['network blip'] })).toBe(
      ' ⚠ network blip',
    );
  });
});

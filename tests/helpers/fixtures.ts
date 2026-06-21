import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base } from 'vitest';
import { DEFAULT_BINDINGS } from '../../src/config.ts';
import type { RunTurnOptions, WorkerProvider, WorkerTurn } from '../../src/providers/types.ts';
import { createRun, saveRunState } from '../../src/run-store.ts';
import type { RunState } from '../../src/run-store.ts';

/**
 * Shared fixtures (the test.extend DI chain): a throwaway project dir, and a
 * run created inside it. Tests destructure what they need; cleanup is owned
 * by each fixture.
 */

/**
 * A scripted worker — a third adapter on the WorkerProvider seam (next to
 * claude and codex), not a mock of internals. Each runTurn shifts the next
 * scripted turn; an Error entry throws it.
 */
export class FakeWorker implements WorkerProvider {
  readonly name: 'claude' | 'codex';
  readonly calls: RunTurnOptions[] = [];
  private readonly script: Array<Partial<WorkerTurn> | Error>;

  constructor(name: 'claude' | 'codex', script: Array<Partial<WorkerTurn> | Error> = []) {
    this.name = name;
    this.script = script;
  }

  async runTurn(opts: RunTurnOptions): Promise<WorkerTurn> {
    this.calls.push(opts);
    const next = this.script.shift() ?? {};
    if (next instanceof Error) throw next;
    return { text: 'scripted response', sessionId: `session-${this.calls.length}`, ...next };
  }
}

/**
 * A commandable worker — also a real adapter on the WorkerProvider seam — whose
 * runTurn returns a promise the test resolves or rejects on demand. It makes
 * "send_prompt returns before the worker completes" directly observable: the
 * turn stays pending until the test calls resolve()/reject(). FIFO over
 * concurrently-in-flight turns to this role (at most one, by the same-role
 * guard, but the queue keeps the helper honest).
 */
export class DeferredWorker implements WorkerProvider {
  readonly name: 'claude' | 'codex';
  readonly calls: RunTurnOptions[] = [];
  private readonly resolvers: Array<{ resolve: (t: WorkerTurn) => void; reject: (e: Error) => void }> = [];
  private resolved = 0;

  constructor(name: 'claude' | 'codex') {
    this.name = name;
  }

  runTurn(opts: RunTurnOptions): Promise<WorkerTurn> {
    this.calls.push(opts);
    return new Promise<WorkerTurn>((resolve, reject) => {
      this.resolvers.push({ resolve, reject });
    });
  }

  /** Number of turns dispatched but not yet resolved/rejected. */
  get pending(): number {
    return this.resolvers.length;
  }

  /** Resolve the oldest pending turn (a default sessionId, overridable). */
  resolve(turn: Partial<WorkerTurn> = {}): void {
    const r = this.resolvers.shift();
    if (!r) throw new Error('DeferredWorker.resolve: no pending turn');
    this.resolved += 1;
    r.resolve({ text: 'scripted response', sessionId: `session-${this.resolved}`, ...turn });
  }

  /** Reject the oldest pending turn (an infra failure). */
  reject(err: Error): void {
    const r = this.resolvers.shift();
    if (!r) throw new Error('DeferredWorker.reject: no pending turn');
    r.reject(err);
  }
}

export interface Fixtures {
  /** A fresh temp directory standing in for the target project root. */
  projectDir: string;
  /** A framing-only run created in projectDir with the default bindings. */
  run: RunState;
  /** A framing-only run whose orchestration host is the interactive session. */
  interactiveRun: RunState;
}

export const test = base.extend<Fixtures>({
  projectDir: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'duet-test-'));
    await use(dir);
    rmSync(dir, { recursive: true, force: true });
  },
  run: async ({ projectDir }, use) => {
    await use(createRun({ cwd: projectDir, bindings: DEFAULT_BINDINGS, framing: 'test framing' }));
  },
  interactiveRun: async ({ projectDir }, use) => {
    const state = createRun({ cwd: projectDir, bindings: DEFAULT_BINDINGS, framing: 'test framing' });
    state.orchestrationHost = 'interactive';
    saveRunState(state);
    await use(state);
  },
});

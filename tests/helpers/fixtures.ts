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

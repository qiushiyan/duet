import { existsSync, readFileSync, readdirSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import type { Snapshot } from 'xstate';
import { DEFAULT_BINDINGS } from '../src/config.ts';
import { claudeArgs } from '../src/providers/claude.ts';
import {
  acquireMcpOwner,
  appendVoiceLog,
  budgetFor,
  consumeHumanInput,
  createRun,
  gateAttended,
  highDecisionsAt,
  holdsMcpOwner,
  clearTurnActive,
  listRuns,
  loadMachineSnapshot,
  loadRunState,
  markTurnActive,
  recordPhaseLabel,
  runDirOf,
  saveMachineSnapshot,
  saveRunState,
  scratchDirOf,
  stageHumanInput,
  workflowOf,
} from '../src/run-store.ts';
import { test } from './helpers/fixtures.ts';

describe('recordPhaseLabel — the view-only tmux phase sidecar', () => {
  test('writes the current phase to context/phase, overwriting on the next phase', ({ projectDir, run }) => {
    recordPhaseLabel(run, 'impl');
    const sidecar = join(runDirOf(projectDir, run.runId), 'context', 'phase');
    expect.soft(readFileSync(sidecar, 'utf8')).toBe('impl\n');
    recordPhaseLabel(run, 'finish');
    expect.soft(readFileSync(sidecar, 'utf8')).toBe('finish\n'); // refreshed, not appended
  });
});

describe('a vanished .duet self-heals on the next harness write (ensureRunDir)', () => {
  // Regression for the observed failure: an implementer cleaning its scratch ran
  // `rm -rf .duet` mid-run, and the next voice-log append threw ENOENT, ending
  // the phase with no advance and no flag. The write must now recover the dir.
  test('appendVoiceLog recreates a deleted .duet (with its .gitignore) and writes', ({ projectDir, run }) => {
    rmSync(join(projectDir, '.duet'), { recursive: true, force: true });
    expect(existsSync(join(projectDir, '.duet'))).toBe(false);

    appendVoiceLog(run, 'implementer', 'build complete'); // would have thrown ENOENT before the fix
    const log = join(runDirOf(projectDir, run.runId), 'implementer.log');
    expect.soft(readFileSync(log, 'utf8')).toContain('build complete');
    expect.soft(readFileSync(join(projectDir, '.duet', '.gitignore'), 'utf8')).toBe('*\n'); // self-ignore restored
  });

  test('saveRunState recreates the dir and round-trips after a deletion', ({ projectDir, run }) => {
    rmSync(join(projectDir, '.duet'), { recursive: true, force: true });
    saveRunState(run);
    expect(loadRunState(projectDir, run.runId)).toEqual(run);
  });

  // saveMachineSnapshot is the durable quiescence writer Codex's adversarial
  // review flagged as the one run-dir write still bypassing the heal. The
  // worker-rm path heals before it runs (a settle's voice-log/state save lands
  // first), but routing it through ensureRunDir makes the invariant uniform —
  // every durable run-dir write self-heals, no implicit "something saves first".
  test('saveMachineSnapshot recreates the dir (with its .gitignore) and round-trips after a deletion', ({
    projectDir,
    run,
  }) => {
    const snapshot: Snapshot<unknown> = { status: 'active', output: undefined, error: undefined };
    rmSync(join(projectDir, '.duet'), { recursive: true, force: true });
    saveMachineSnapshot(run, snapshot); // would throw ENOENT on machine.json.tmp before the fix
    expect.soft(loadMachineSnapshot(run)).toEqual(snapshot);
    expect.soft(readFileSync(join(projectDir, '.duet', '.gitignore'), 'utf8')).toBe('*\n'); // self-ignore restored
  });
});

describe('the single-writer MCP lease (mcp-owner.json)', () => {
  test('acquire writes the lease file and the returned nonce holds', ({ projectDir, run }) => {
    const nonce = acquireMcpOwner(run);
    expect.soft(existsSync(join(runDirOf(projectDir, run.runId), 'mcp-owner.json'))).toBe(true);
    expect.soft(holdsMcpOwner(run, nonce)).toBe(true);
  });

  test('the newest acquirer wins — a prior nonce stops holding (last write)', ({ run }) => {
    const first = acquireMcpOwner(run);
    const second = acquireMcpOwner(run);
    expect.soft(first).not.toBe(second);
    expect.soft(holdsMcpOwner(run, second)).toBe(true);
    expect.soft(holdsMcpOwner(run, first)).toBe(false); // superseded
  });

  test('holds is false before any acquire (no file)', ({ run }) => {
    expect(holdsMcpOwner(run, 'never-acquired')).toBe(false);
  });
});

describe('run creation', () => {
  test('a created run round-trips through load', ({ projectDir, run }) => {
    const loaded = loadRunState(projectDir, run.runId);
    expect(loaded).toEqual(run);
  });

  test('the run dir is self-contained: state, framing archive, notes', ({ projectDir, run }) => {
    const dir = runDirOf(projectDir, run.runId);
    expect.soft(existsSync(join(dir, 'state.json'))).toBe(true);
    expect.soft(readFileSync(join(dir, 'framing.md'), 'utf8')).toBe('test framing');
    expect.soft(readFileSync(join(dir, 'notes.md'), 'utf8')).toContain('run created');
  });

  test('the framing archive prefers the verbatim file over the stripped body', ({ projectDir }) => {
    const run = createRun({
      cwd: projectDir,
      bindings: DEFAULT_BINDINGS,
      framing: 'body only',
      framingRaw: '---\ngates_at: frame\n---\n\nbody only',
    });
    const archived = readFileSync(join(runDirOf(projectDir, run.runId), 'framing.md'), 'utf8');
    expect(archived).toContain('gates_at: frame');
  });

  test('.duet self-ignores without touching the project gitignore', ({ projectDir, run }) => {
    expect(run.cwd).toBe(projectDir); // the run fixture created .duet here
    expect(readFileSync(join(projectDir, '.duet', '.gitignore'), 'utf8')).toBe('*\n');
    expect(existsSync(join(projectDir, '.gitignore'))).toBe(false);
  });

  test('the run-scoped scratch dir is pre-created under the run dir, not a top-level .duet/scratch', ({
    projectDir,
    run,
  }) => {
    expect.soft(scratchDirOf(projectDir, run.runId)).toBe(join(runDirOf(projectDir, run.runId), 'scratch'));
    expect.soft(existsSync(scratchDirOf(projectDir, run.runId))).toBe(true); // ready for the impl turn
    expect.soft(existsSync(join(projectDir, '.duet', 'scratch'))).toBe(false); // the old shared-parent location is gone
  });

  test('loading an unknown run names the path and the likely mistake', ({ projectDir }) => {
    expect(() => loadRunState(projectDir, 'nope')).toThrow(/is nope a run of this project/);
  });

  test('createRun without gatesAt leaves it absent when defaultPreAuthorized is empty (rir — legacy attend-all)', ({
    projectDir,
  }) => {
    // rir ships defaultPreAuthorized: [] → defaultPosture returns undefined →
    // gatesAt stays absent (attend-all). (full now materializes the overnight
    // posture ['frame','spec'] — see the default-posture test below.)
    const created = createRun({ cwd: projectDir, bindings: DEFAULT_BINDINGS, workflow: 'rir' });
    expect.soft(created.gatesAt).toBeUndefined();
    expect.soft(loadRunState(projectDir, created.runId).gatesAt).toBeUndefined();
  });

  test('createRun persists an explicit gatesAt unchanged (materialization does not override it)', ({ projectDir }) => {
    const created = createRun({ cwd: projectDir, bindings: DEFAULT_BINDINGS, gatesAt: ['frame', 'spec'] });
    expect.soft(created.gatesAt).toEqual(['frame', 'spec']);
    expect.soft(loadRunState(projectDir, created.runId).gatesAt).toEqual(['frame', 'spec']);
  });

  test('createRun persists an explicit empty gatesAt ([]) as first-class attend-none (bare duet afk relies on it)', ({
    projectDir,
  }) => {
    const created = createRun({ cwd: projectDir, bindings: DEFAULT_BINDINGS, gatesAt: [] });
    expect.soft(created.gatesAt).toEqual([]); // not coerced to absent — [] is a real "attend none" posture
    expect.soft(loadRunState(projectDir, created.runId).gatesAt).toEqual([]);
  });

  test('createRun persists the gateless flag present-only (default-off byte-for-byte)', ({ projectDir }) => {
    const gateless = createRun({ cwd: projectDir, bindings: DEFAULT_BINDINGS, gatesAt: [], gateless: true });
    expect.soft(gateless.gateless).toBe(true);
    expect.soft(loadRunState(projectDir, gateless.runId).gateless).toBe(true);
    // Absent on every non-gateless run — the surface reads byte-for-byte as before.
    const plain = createRun({ cwd: projectDir, bindings: DEFAULT_BINDINGS });
    expect.soft(plain.gateless).toBeUndefined();
    expect.soft('gateless' in loadRunState(projectDir, plain.runId)).toBe(false);
  });

  test('createRun freezes the resolved budget; a later budgetFor reads it back (scaled)', ({ projectDir }) => {
    const created = createRun({ cwd: projectDir, bindings: DEFAULT_BINDINGS, budget: 2 });
    expect.soft(created.budget).toBe(2);
    const reloaded = loadRunState(projectDir, created.runId);
    expect.soft(reloaded.budget).toBe(2);
    expect.soft(budgetFor(reloaded, 'impl')).toEqual({ worker: 50, orchestrator: 60 });
  });

  test('createRun omits budget when off (absent) ⇒ budgetFor reads off', ({ projectDir }) => {
    const created = createRun({ cwd: projectDir, bindings: DEFAULT_BINDINGS });
    expect.soft(created.budget).toBeUndefined();
    expect.soft('budget' in loadRunState(projectDir, created.runId)).toBe(false);
    expect.soft(budgetFor(created, 'impl')).toEqual({ worker: undefined, orchestrator: undefined });
  });
});

describe('persistence', () => {
  test('saves leave no temp debris behind (atomic write)', ({ projectDir, run }) => {
    run.lastActivity = 'something';
    saveRunState(run);
    const files = readdirSync(runDirOf(projectDir, run.runId));
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(loadRunState(projectDir, run.runId).lastActivity).toBe('something');
  });

  test('machine snapshots round-trip', ({ run }) => {
    const snapshot: Snapshot<unknown> = { status: 'active', output: undefined, error: undefined };
    expect(loadMachineSnapshot(run)).toBeUndefined();
    saveMachineSnapshot(run, snapshot);
    expect(loadMachineSnapshot(run)).toEqual(snapshot);
  });
});

describe('the mutate discipline (concurrency-safe crash-state)', () => {
  test('a concurrent cross-role write does not clobber the sibling role', ({ projectDir, run }) => {
    // Two in-memory copies of the same on-disk run, each unaware of the other.
    const copyA = loadRunState(projectDir, run.runId);
    const copyB = loadRunState(projectDir, run.runId);
    markTurnActive(copyA, 'implementer', 'impl-tag');
    // copyB was loaded before A's write, but markTurnActive reloads fresh and
    // merges its own role surgically — so the implementer entry survives.
    markTurnActive(copyB, 'reviewer', 'rev-tag');
    const disk = loadRunState(projectDir, run.runId);
    expect(disk.activeTurns?.implementer?.tag).toBe('impl-tag');
    expect(disk.activeTurns?.reviewer?.tag).toBe('rev-tag');
  });

  test('a no-op clear does not save its stale copy over a concurrent sibling write', ({ projectDir, run }) => {
    const stale = loadRunState(projectDir, run.runId); // captured before the sibling write
    markTurnActive(run, 'reviewer', 'rev-tag'); // a sibling writes the reviewer entry to disk
    // The implementer entry is absent for `stale`, so the clear is a no-op — and
    // must NOT save `stale`'s (reviewer-less) snapshot over the live write.
    clearTurnActive(stale, 'implementer');
    expect(loadRunState(projectDir, run.runId).activeTurns?.reviewer?.tag).toBe('rev-tag');
  });
});

describe('the human-input handshake', () => {
  test('staged input survives a process boundary and is consumed exactly once', ({ projectDir, run }) => {
    stageHumanInput(run, { kind: 'feedback', text: 'tighten the scope' });

    // The driver runs in another process: it loads its own copy.
    const driverCopy = loadRunState(projectDir, run.runId);
    expect(consumeHumanInput(driverCopy)).toEqual({ kind: 'feedback', text: 'tighten the scope' });

    // A crashed-and-retried invocation must not replay the input.
    const retryCopy = loadRunState(projectDir, run.runId);
    expect(consumeHumanInput(retryCopy)).toBeUndefined();
  });

  test('consuming an answer clears the question it answers', ({ projectDir, run }) => {
    run.pendingQuestion = { question: 'which migration?' };
    stageHumanInput(run, { kind: 'answer', text: 'the latest one' });

    const driverCopy = loadRunState(projectDir, run.runId);
    consumeHumanInput(driverCopy);
    expect(driverCopy.pendingQuestion).toBeUndefined();
    expect(loadRunState(projectDir, run.runId).pendingQuestion).toBeUndefined();
  });

  test('consuming feedback leaves an unrelated pending question in place', ({ projectDir, run }) => {
    run.pendingQuestion = { question: 'still open' };
    stageHumanInput(run, { kind: 'feedback', text: 'gate feedback' });

    const driverCopy = loadRunState(projectDir, run.runId);
    consumeHumanInput(driverCopy);
    expect(driverCopy.pendingQuestion).toEqual({ question: 'still open' });
  });
});

describe('gate attendance', () => {
  test('absent gates_at means every gate is attended', ({ run }) => {
    delete run.gatesAt; // a legacy run (or an explicit attend-all) carries no gatesAt
    expect(gateAttended(run, 'frame')).toBe(true);
    expect(gateAttended(run, 'impl')).toBe(true);
  });

  test('listed phases are attended, unlisted are pre-authorized', ({ run }) => {
    run.gatesAt = ['frame', 'spec', 'finish'];
    expect.soft(gateAttended(run, 'frame')).toBe(true);
    expect.soft(gateAttended(run, 'plan')).toBe(false);
    expect.soft(gateAttended(run, 'impl')).toBe(false);
    expect.soft(gateAttended(run, 'finish')).toBe(true); // attended because explicitly listed
  });

  test('a new Full run materializes the overnight posture — plan, Ship, and the Open-PR gate auto-cross by default (D)', ({ projectDir }) => {
    // A new default Full run materializes gatesAt = ['frame','spec']: plan, impl
    // (Ship), and finish (Open-PR) are all pre-authorized.
    const fresh = createRun({ cwd: projectDir, bindings: DEFAULT_BINDINGS });
    expect.soft(fresh.gatesAt).toEqual(['frame', 'spec']);
    expect.soft(gateAttended(fresh, 'plan')).toBe(false);
    expect.soft(gateAttended(fresh, 'impl')).toBe(false);
    expect.soft(gateAttended(fresh, 'finish')).toBe(false);

    // Listing finish restores the post-open review stop (opt-in).
    const attended = createRun({ cwd: projectDir, bindings: DEFAULT_BINDINGS, gatesAt: ['finish'] });
    expect.soft(gateAttended(attended, 'finish')).toBe(true);

    // A legacy run (absent gatesAt, predating the change) still attends every
    // gate — the overnight default never reaches an in-flight legacy run.
    const legacy = createRun({ cwd: projectDir, bindings: DEFAULT_BINDINGS });
    delete legacy.gatesAt;
    expect.soft(gateAttended(legacy, 'finish')).toBe(true);
  });
});

describe('highDecisionsAt — the severity-hold resolver', () => {
  test('returns the high decisions, filters low, and is empty with none or no packet', ({ run }) => {
    run.phaseSummaries.impl = {
      summary: 's',
      artifacts: [],
      humanDecisions: [
        { title: 'a', severity: 'high' },
        { title: 'b', severity: 'low' },
        { title: 'c', severity: 'high' },
      ],
    };
    expect.soft(highDecisionsAt(run, 'impl')).toEqual([
      { title: 'a', severity: 'high' },
      { title: 'c', severity: 'high' },
    ]);
    // Low-only → no hold.
    run.phaseSummaries.spec = { summary: 's', artifacts: [], humanDecisions: [{ title: 'x', severity: 'low' }] };
    expect.soft(highDecisionsAt(run, 'spec')).toEqual([]);
    // No packet at all → no hold.
    expect.soft(highDecisionsAt(run, 'plan')).toEqual([]);
  });
});

describe('budgetFor — the opt-in knob', () => {
  test('budget absent ⇒ OFF: both caps undefined (the maintainer default)', ({ run }) => {
    expect.soft(run.budget).toBeUndefined();
    expect.soft(budgetFor(run, 'impl')).toEqual({ worker: undefined, orchestrator: undefined });
    expect.soft(budgetFor(run, 'finish')).toEqual({ worker: undefined, orchestrator: undefined });
  });

  test('budget ×1 ("default") reproduces the registry profile verbatim', ({ run }) => {
    run.budget = 1;
    expect.soft(budgetFor(run, 'impl')).toEqual({ worker: 25, orchestrator: 30 });
    expect.soft(budgetFor(run, 'finish')).toEqual({ worker: 15, orchestrator: 15 });
    expect.soft(budgetFor(run, 'frame')).toEqual({ worker: 10, orchestrator: 15 });
  });

  test('a scalar scales BOTH the worker and orchestrator caps (one knob, both roles)', ({ run }) => {
    run.budget = 0.5;
    expect.soft(budgetFor(run, 'impl')).toEqual({ worker: 12.5, orchestrator: 15 });
    expect.soft(budgetFor(run, 'frame')).toEqual({ worker: 5, orchestrator: 7.5 });
  });

  test('off ⇒ a worker built from the resolved cap omits --max-budget-usd', ({ run }) => {
    const cap = budgetFor(run, 'impl').worker; // off → undefined
    expect.soft(cap).toBeUndefined();
    expect.soft(claudeArgs({ sessionId: 's', resume: false }, { model: 'claude-opus-4-8', maxBudgetUsd: cap })).not.toContain('--max-budget-usd');
  });
});

describe('workflow identity', () => {
  test('a created run defaults to the full workflow', ({ run }) => {
    expect(workflowOf(run)).toBe('full');
  });

  test('a state with no workflow field (pre-feature) resolves to full', ({ run }) => {
    delete run.workflow;
    expect(workflowOf(run)).toBe('full');
  });

  test('createRun persists an explicit workflow', ({ projectDir }) => {
    const created = createRun({ cwd: projectDir, bindings: DEFAULT_BINDINGS, workflow: 'full', framing: 'f' });
    expect(created.workflow).toBe('full');
    expect(loadRunState(projectDir, created.runId).workflow).toBe('full');
  });
});

describe('run listing', () => {
  test('lists newest first and skips non-run directories', ({ projectDir, run }) => {
    mkdirSync(join(projectDir, '.duet', 'runs', 'junk'));
    writeFileSync(join(projectDir, '.duet', 'runs', 'junk-file'), 'not a dir');

    const newer = createRun({ cwd: projectDir, bindings: DEFAULT_BINDINGS });
    newer.createdAt = new Date(Date.now() + 60_000).toISOString();
    saveRunState(newer);

    expect(listRuns(projectDir).map((r) => r.runId)).toEqual([newer.runId, run.runId]);
  });
});

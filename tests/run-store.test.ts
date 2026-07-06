import { existsSync, readFileSync, readdirSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import type { Snapshot } from 'xstate';
import { build, compileWorkflow, defineWorkflow, finish, frame } from '../src/workflows.ts';
import { defaultBindingsFor } from '../src/voices/bindings.ts';
import { claudeArgs } from '../src/voices/providers/claude.ts';
import { allocateCorpusRecordDir } from '../src/run/corpus.ts';
import { machineFor } from '../src/run/machine.ts';
import { workflowFor, workflowForRunDir, workflowPath } from '../src/run/workflow.ts';
import {
  acquireMcpOwner,
  appendNote,
  appendVoiceLog,
  budgetFor,
  clearContextUsage,
  consumeHumanInput,
  contextPercent,
  contextSafetyPercent,
  createRun,
  DEFAULT_RETRY_INFRA,
  gateAttended,
  highDecisionsAt,
  holdsMcpOwner,
  clearTurnActive,
  listRuns,
  scanRuns,
  loadMachineSnapshot,
  loadRunState,
  loadRunStateFromDir,
  markTurnActive,
  recordContextUsage,
  recordPhaseLabel,
  runDirOf,
  saveMachineSnapshot,
  saveRunState,
  scratchDirOf,
  stageHumanInput,
  } from '../src/run/store.ts';
import { test } from './helpers/fixtures.ts';

describe('recordPhaseLabel — the view-only tmux phase sidecar', () => {
  test('writes the current phase to context/phase, overwriting on the next phase', ({ projectDir, run }) => {
    recordPhaseLabel(run, 'implement');
    const sidecar = join(runDirOf(projectDir, run.runId), 'context', 'phase');
    expect.soft(readFileSync(sidecar, 'utf8')).toBe('implement\n');
    recordPhaseLabel(run, 'finish');
    expect.soft(readFileSync(sidecar, 'utf8')).toBe('finish\n'); // refreshed, not appended
  });
});

describe('context readings — last honest reading + high-water since compact', () => {
  test('a later lower reading keeps the high-water for safety, the last reading for display', ({ run }) => {
    recordContextUsage(run, 'architect', { usedTokens: 170_000, windowTokens: 1_000_000 });
    recordContextUsage(run, 'architect', { usedTokens: 500_000, windowTokens: 1_000_000 });
    recordContextUsage(run, 'architect', { usedTokens: 300_000, windowTokens: 1_000_000 });
    const reading = run.contextUsage?.architect;
    expect.soft(reading?.usedTokens).toBe(300_000); // display: the last honest reading
    expect.soft(reading?.highWaterTokens).toBe(500_000); // safety: the mark holds through the drop
    expect.soft(contextSafetyPercent(run, 'architect')).toBe(50);
    expect.soft(contextPercent(reading!)).toBe(30);
  });

  test('a climbing reading needs no separate mark — usedTokens IS the high-water', ({ run }) => {
    recordContextUsage(run, 'architect', { usedTokens: 170_000, windowTokens: 1_000_000 });
    recordContextUsage(run, 'architect', { usedTokens: 500_000, windowTokens: 1_000_000 });
    expect.soft(run.contextUsage?.architect?.highWaterTokens).toBeUndefined();
    expect.soft(contextSafetyPercent(run, 'architect')).toBe(50);
  });

  test('a window change (mid-run model swap) restarts the mark — cross-window token math is meaningless', ({ run }) => {
    recordContextUsage(run, 'architect', { usedTokens: 800_000, windowTokens: 1_000_000 });
    recordContextUsage(run, 'architect', { usedTokens: 100_000, windowTokens: 200_000 });
    expect.soft(run.contextUsage?.architect?.highWaterTokens).toBeUndefined();
    expect.soft(contextSafetyPercent(run, 'architect')).toBe(50); // 100k of the NEW 200k window
  });

  test('clearContextUsage drops the reading and the sidecar; the safety percent stands down', ({ projectDir, run }) => {
    recordContextUsage(run, 'architect', { usedTokens: 978_000, windowTokens: 1_000_000 });
    const sidecar = join(runDirOf(projectDir, run.runId), 'context', 'architect');
    expect.soft(existsSync(sidecar)).toBe(true);
    clearContextUsage(run, 'architect');
    expect.soft(run.contextUsage?.architect).toBeUndefined();
    expect.soft(existsSync(sidecar)).toBe(false);
    expect.soft(contextSafetyPercent(run, 'architect')).toBeUndefined();
  });
});

describe('a vanished .duet self-heals on the next harness write (ensureRunDir)', () => {
  // Regression for the observed failure: an architect cleaning its scratch ran
  // `rm -rf .duet` mid-run, and the next voice-log append threw ENOENT, ending
  // the phase with no advance and no flag. The write must now recover the dir.
  test('appendVoiceLog recreates a deleted .duet (with its .gitignore) and writes', ({ projectDir, run }) => {
    rmSync(join(projectDir, '.duet'), { recursive: true, force: true });
    expect(existsSync(join(projectDir, '.duet'))).toBe(false);

    appendVoiceLog(run, 'architect', 'build complete'); // would have thrown ENOENT before the fix
    const log = join(runDirOf(projectDir, run.runId), 'architect.log');
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

  test('a run can load directly from a record dir, with workflow resolved from that dir', ({ projectDir, run }) => {
    const dir = runDirOf(projectDir, run.runId);
    const loaded = loadRunStateFromDir(dir);
    expect.soft(loaded).toEqual(run);
    expect.soft(workflowForRunDir(loaded, dir).name).toBe('full');
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
      bindings: defaultBindingsFor('full'),
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

  test('loadRunState REJECTS a pre-remodel state file with a prescriptive error (no backward compatibility)', ({
    projectDir,
    run,
  }) => {
    // Hand-write a seat-keyed state file, exactly as a pre-remodel run on disk
    // would carry it: bindings keyed architect/analyst, no duties map.
    const legacy = JSON.parse(readFileSync(join(runDirOf(projectDir, run.runId), 'state.json'), 'utf8'));
    legacy.bindings = {
      orchestrator: { provider: 'claude', model: 'claude-opus-4-8', transport: 'headless' },
      architect: { provider: 'claude', model: 'claude-opus-4-8', transport: 'headless' },
      analyst: { provider: 'codex' },
    };
    writeFileSync(join(runDirOf(projectDir, run.runId), 'state.json'), JSON.stringify(legacy, null, 2));

    // The error names what happened AND the manual path out — transcripts are
    // intact, so the augmentation promise (finish by hand) survives the break.
    expect(() => loadRunState(projectDir, run.runId)).toThrow(/predates the duty-keyed remodel[\s\S]*claude --resume/);
  });

  test('loadRunState REJECTS a state file carrying the seat-keyed workerSessions map (the other pre-remodel signature)', ({
    projectDir,
    run,
  }) => {
    // A pre-remodel run persisted sessions under seat names; its presence is a
    // rejection signature of its own, even beside a plausible bindings shape.
    const legacy = JSON.parse(readFileSync(join(runDirOf(projectDir, run.runId), 'state.json'), 'utf8'));
    legacy.workerSessions = { implementer: { provider: 'claude', id: 's-1' } };
    writeFileSync(join(runDirOf(projectDir, run.runId), 'state.json'), JSON.stringify(legacy, null, 2));

    expect(() => loadRunState(projectDir, run.runId)).toThrow(/predates the duty-keyed remodel[\s\S]*claude --resume/);
  });

  test('loadRunState REJECTS a persisted unshipped workflow name with no frozen workflow and names the layers', ({
    projectDir,
    run,
  }) => {
    // A hand-crafted state with the NEW bindings shape but an unshipped
    // workflow and no frozen workflow must still die at the boundary, not fall
    // through to a lookup crash.
    const legacy = JSON.parse(readFileSync(join(runDirOf(projectDir, run.runId), 'state.json'), 'utf8'));
    legacy.workflow = 'design';
    writeFileSync(join(runDirOf(projectDir, run.runId), 'state.json'), JSON.stringify(legacy, null, 2));
    rmSync(workflowPath(projectDir, run.runId), { force: true });

    expect(() => loadRunState(projectDir, run.runId)).toThrow(
      /workflow "design"[\s\S]*no frozen workflow\.json[\s\S]*project\/user workflow files[\s\S]*claude --resume/,
    );
  });

  test('createRun without gatesAt leaves it absent when defaultPreAuthorized is empty (short — legacy attend-all)', ({
    projectDir,
  }) => {
    // short ships defaultPreAuthorized: [] → defaultPosture returns undefined →
    // gatesAt stays absent (attend-all). (full now materializes the overnight
    // posture ['frame','spec'] — see the default-posture test below.)
    const created = createRun({ cwd: projectDir, bindings: defaultBindingsFor('short'), workflow: 'short' });
    expect.soft(created.gatesAt).toBeUndefined();
    expect.soft(loadRunState(projectDir, created.runId).gatesAt).toBeUndefined();
  });

  test('createRun persists an explicit gatesAt unchanged (materialization does not override it)', ({ projectDir }) => {
    const created = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full'), gatesAt: ['frame', 'spec'] });
    expect.soft(created.gatesAt).toEqual(['frame', 'spec']);
    expect.soft(loadRunState(projectDir, created.runId).gatesAt).toEqual(['frame', 'spec']);
  });

  test('createRun persists an explicit empty gatesAt ([]) as first-class attend-none (bare duet afk relies on it)', ({
    projectDir,
  }) => {
    const created = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full'), gatesAt: [] });
    expect.soft(created.gatesAt).toEqual([]); // not coerced to absent — [] is a real "attend none" posture
    expect.soft(loadRunState(projectDir, created.runId).gatesAt).toEqual([]);
  });

  test('createRun persists the gateless flag present-only (default-off byte-for-byte)', ({ projectDir }) => {
    const gateless = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full'), gatesAt: [], gateless: true });
    expect.soft(gateless.gateless).toBe(true);
    expect.soft(loadRunState(projectDir, gateless.runId).gateless).toBe(true);
    // Absent on every non-gateless run — the surface reads byte-for-byte as before.
    const plain = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full') });
    expect.soft(plain.gateless).toBeUndefined();
    expect.soft('gateless' in loadRunState(projectDir, plain.runId)).toBe(false);
  });

  test('createRun materializes the default retry budget (3), nullish so 0 stays 0 and N stays N (S6)', ({ projectDir }) => {
    // Default-on for NEW runs, via materialization (the gatesAt discipline). An
    // absent opt ⇒ DEFAULT_RETRY_INFRA; an explicit 0 ⇒ 0 (off); an explicit N ⇒ N.
    const dflt = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full') });
    expect.soft(dflt.retryInfra).toBe(DEFAULT_RETRY_INFRA);
    expect.soft(loadRunState(projectDir, dflt.runId).retryInfra).toBe(3);

    const off = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full'), retryInfra: 0 });
    expect.soft(off.retryInfra).toBe(0); // nullish, not truthy — the explicit opt-out survives

    const five = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full'), retryInfra: 5 });
    expect.soft(five.retryInfra).toBe(5);
  });

  test('createRun freezes the resolved budget; a later budgetFor reads it back (scaled)', ({ projectDir }) => {
    const created = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full'), budget: 2 });
    expect.soft(created.budget).toBe(2);
    const reloaded = loadRunState(projectDir, created.runId);
    expect.soft(reloaded.budget).toBe(2);
    expect.soft(budgetFor(reloaded, 'implement')).toEqual({ worker: 50, orchestrator: 60 });
  });

  test('createRun omits budget when off (absent) ⇒ budgetFor reads off', ({ projectDir }) => {
    const created = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full') });
    expect.soft(created.budget).toBeUndefined();
    expect.soft('budget' in loadRunState(projectDir, created.runId)).toBe(false);
    expect.soft(budgetFor(created, 'implement')).toEqual({ worker: undefined, orchestrator: undefined });
  });

  test('createRun omits corpusDir without config (default-off byte-for-byte)', ({ projectDir }) => {
    const created = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full') });
    expect.soft(created.corpusDir).toBeUndefined();
    expect.soft('corpusDir' in loadRunState(projectDir, created.runId)).toBe(false);
  });

  test('createRun freezes the corpus record path and mirrors creation artifacts when configured', ({ projectDir }) => {
    const corpusRoot = join(projectDir, 'corpus');
    const created = createRun({
      cwd: projectDir,
      bindings: defaultBindingsFor('full'),
      framing: 'body only',
      corpusRoot,
    });

    expect.soft(created.corpusDir).toBe(join(corpusRoot, created.runId));
    expect.soft(readFileSync(join(created.corpusDir!, 'state.json'), 'utf8')).toContain(`"runId": "${created.runId}"`);
    expect.soft(readFileSync(join(created.corpusDir!, 'workflow.json'), 'utf8')).toContain('"name": "full"');
    expect.soft(readFileSync(join(created.corpusDir!, 'framing.md'), 'utf8')).toBe('body only');
    expect.soft(readFileSync(join(created.corpusDir!, 'notes.md'), 'utf8')).toContain('run created');
    expect.soft(JSON.parse(readFileSync(join(created.corpusDir!, 'corpus.json'), 'utf8'))).toMatchObject({
      runId: created.runId,
      sourceCwd: projectDir,
    });
  });

  test('corpus record allocation suffixes a run-id collision once at freeze time', ({ projectDir }) => {
    const root = join(projectDir, 'corpus');
    mkdirSync(join(root, '20260706-1200-abcd'), { recursive: true });
    writeFileSync(join(root, '20260706-1200-abcd', 'state.json'), JSON.stringify({ runId: 'other', cwd: '/elsewhere' }));

    expect(allocateCorpusRecordDir(root, '20260706-1200-abcd', projectDir)).toBe(join(root, '20260706-1200-abcd-2'));
  });

  test('createRun freezes shipped workflows into workflow.json', ({ projectDir }) => {
    const created = createRun({ cwd: projectDir, bindings: defaultBindingsFor('blueprint'), workflow: 'blueprint' });
    const frozen = JSON.parse(readFileSync(workflowPath(projectDir, created.runId), 'utf8'));

    expect.soft(frozen.name).toBe('blueprint');
    expect.soft(frozen.displayName).toBe('Blueprint (frame → design doc → implement → ship → PR)');
    expect.soft(workflowFor(created).phases.map((p) => p.name)).toEqual(['frame', 'design', 'implement', 'finish']);
  });

  test('a pre-feature shipped run with no workflow.json falls back to the shipped registry row', ({ projectDir }) => {
    const created = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full') });
    rmSync(workflowPath(projectDir, created.runId), { force: true });

    expect.soft(workflowFor(loadRunState(projectDir, created.runId)).displayName).toBe('Full (spec → plan → implement → ship → PR)');
  });

  test('a frozen custom workflow legitimizes a non-shipped workflow name', ({ projectDir }) => {
    const custom = compileWorkflow(
      defineWorkflow({
        name: 'instant',
        title: 'Instant (think → build → PR)',
        presets: { afk: [] },
        phases: [frame({ name: 'think' }), build({ review: 'writable', audit: true }), finish()],
      }),
    );
    const created = createRun({
      cwd: projectDir,
      workflow: custom.name,
      workflowSpec: custom,
      bindings: defaultBindingsFor(custom),
    });

    const reloaded = loadRunState(projectDir, created.runId);
    expect.soft(reloaded.workflow).toBe('instant');
    expect.soft(workflowFor(reloaded).displayName).toBe('Instant (think → build → PR)');
    expect.soft(workflowFor(reloaded).phases.map((p) => p.name)).toEqual(['think', 'implement', 'finish']);
  });

  test('budgetFor reads per-phase caps from the frozen workflow, not the live registry row', ({ projectDir }) => {
    const created = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full'), budget: 1 });
    const path = workflowPath(projectDir, created.runId);
    const frozen = JSON.parse(readFileSync(path, 'utf8'));
    const implement = frozen.phases.find((p: { name: string }) => p.name === 'implement');
    implement.workerBudgetUsd = 99;
    implement.orchestratorBudgetUsd = 77;
    writeFileSync(path, JSON.stringify(frozen, null, 2) + '\n');

    expect(budgetFor(loadRunState(projectDir, created.runId), 'implement')).toEqual({ worker: 99, orchestrator: 77 });
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

  test('corpus mirrors log appends, state saves, notes, and machine snapshots fail-softly', ({ projectDir }) => {
    const corpusRoot = join(projectDir, 'corpus');
    const run = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full'), corpusRoot });
    appendVoiceLog(run, 'architect', '◀ prompt (tag=write-spec)', 'body');
    appendNote(run, 'human', 'a note');
    run.lastActivity = 'saved';
    saveRunState(run);
    const snapshot: Snapshot<unknown> = { status: 'active', output: undefined, error: undefined };
    saveMachineSnapshot(run, snapshot);

    expect.soft(readFileSync(join(run.corpusDir!, 'architect.log'), 'utf8')).toContain('write-spec');
    expect.soft(readFileSync(join(run.corpusDir!, 'notes.md'), 'utf8')).toContain('a note');
    expect.soft(JSON.parse(readFileSync(join(run.corpusDir!, 'state.json'), 'utf8')).lastActivity).toBe('saved');
    expect.soft(JSON.parse(readFileSync(join(run.corpusDir!, 'machine.json'), 'utf8'))).toEqual(snapshot);

    run.corpusDir = join(projectDir, 'not-a-dir', 'record');
    writeFileSync(join(projectDir, 'not-a-dir'), 'blocks mkdir');
    expect(() => appendVoiceLog(run, 'architect', 'still local')).not.toThrow();
    expect(readFileSync(join(runDirOf(projectDir, run.runId), 'architect.log'), 'utf8')).toContain('still local');
  });
});

describe('the mutate discipline (concurrency-safe crash-state)', () => {
  test('a concurrent cross-role write does not clobber the sibling role', ({ projectDir, run }) => {
    // Two in-memory copies of the same on-disk run, each unaware of the other.
    const copyA = loadRunState(projectDir, run.runId);
    const copyB = loadRunState(projectDir, run.runId);
    markTurnActive(copyA, 'architect', 'impl-tag');
    // copyB was loaded before A's write, but markTurnActive reloads fresh and
    // merges its own role surgically — so the architect entry survives.
    markTurnActive(copyB, 'analyst', 'rev-tag');
    const disk = loadRunState(projectDir, run.runId);
    expect(disk.activeTurns?.architect?.tag).toBe('impl-tag');
    expect(disk.activeTurns?.analyst?.tag).toBe('rev-tag');
  });

  test('a no-op clear does not save its stale copy over a concurrent sibling write', ({ projectDir, run }) => {
    const stale = loadRunState(projectDir, run.runId); // captured before the sibling write
    markTurnActive(run, 'analyst', 'rev-tag'); // a sibling writes the analyst entry to disk
    // The architect entry is absent for `stale`, so the clear is a no-op — and
    // must NOT save `stale`'s (analyst-less) snapshot over the live write.
    clearTurnActive(stale, 'architect');
    expect(loadRunState(projectDir, run.runId).activeTurns?.analyst?.tag).toBe('rev-tag');
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
    expect(gateAttended(run, 'implement')).toBe(true);
  });

  test('listed phases are attended, unlisted are pre-authorized', ({ run }) => {
    run.gatesAt = ['frame', 'spec', 'finish'];
    expect.soft(gateAttended(run, 'frame')).toBe(true);
    expect.soft(gateAttended(run, 'plan')).toBe(false);
    expect.soft(gateAttended(run, 'implement')).toBe(false);
    expect.soft(gateAttended(run, 'finish')).toBe(true); // attended because explicitly listed
  });

  test('a new Full run materializes the overnight posture — plan, Ship, and the Open-PR gate auto-cross by default (D)', ({ projectDir }) => {
    // A new default Full run materializes gatesAt = ['frame','spec']: plan, impl
    // (Ship), and finish (Open-PR) are all pre-authorized.
    const fresh = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full') });
    expect.soft(fresh.gatesAt).toEqual(['frame', 'spec']);
    expect.soft(gateAttended(fresh, 'plan')).toBe(false);
    expect.soft(gateAttended(fresh, 'implement')).toBe(false);
    expect.soft(gateAttended(fresh, 'finish')).toBe(false);

    // Listing finish restores the post-open review stop (opt-in).
    const attended = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full'), gatesAt: ['finish'] });
    expect.soft(gateAttended(attended, 'finish')).toBe(true);

    // A legacy run (absent gatesAt, predating the change) still attends every
    // gate — the overnight default never reaches an in-flight legacy run.
    const legacy = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full') });
    delete legacy.gatesAt;
    expect.soft(gateAttended(legacy, 'finish')).toBe(true);
  });
});

describe('highDecisionsAt — the severity-hold resolver', () => {
  test('returns the high decisions, filters low, and is empty with none or no packet', ({ run }) => {
    run.phaseSummaries.implement = {
      summary: 's',
      artifacts: [],
      humanDecisions: [
        { title: 'a', severity: 'high' },
        { title: 'b', severity: 'low' },
        { title: 'c', severity: 'high' },
      ],
    };
    expect.soft(highDecisionsAt(run, 'implement')).toEqual([
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
    expect.soft(budgetFor(run, 'implement')).toEqual({ worker: undefined, orchestrator: undefined });
    expect.soft(budgetFor(run, 'finish')).toEqual({ worker: undefined, orchestrator: undefined });
  });

  test('budget ×1 ("default") reproduces the registry profile verbatim', ({ run }) => {
    run.budget = 1;
    expect.soft(budgetFor(run, 'implement')).toEqual({ worker: 25, orchestrator: 30 });
    expect.soft(budgetFor(run, 'finish')).toEqual({ worker: 15, orchestrator: 15 });
    expect.soft(budgetFor(run, 'frame')).toEqual({ worker: 10, orchestrator: 15 });
  });

  test('a scalar scales BOTH the worker and orchestrator caps (one knob, both roles)', ({ run }) => {
    run.budget = 0.5;
    expect.soft(budgetFor(run, 'implement')).toEqual({ worker: 12.5, orchestrator: 15 });
    expect.soft(budgetFor(run, 'frame')).toEqual({ worker: 5, orchestrator: 7.5 });
  });

  test('reads phase budgets from the run-carried workflow spec', ({ projectDir }) => {
    const base = compileWorkflow(
      defineWorkflow({
        name: 'budget-short',
        title: 'Budget Short',
        presets: { afk: [] },
        phases: [frame({ name: 'research' }), build({ review: 'writable', audit: true }), finish()],
      }),
    );
    const workflow = {
      ...base,
      phases: base.phases.map((phase) =>
        phase.name === 'implement' ? { ...phase, workerBudgetUsd: 7, orchestratorBudgetUsd: 11 } : phase,
      ),
    };
    const run = createRun({
      cwd: projectDir,
      workflow: workflow.name,
      workflowSpec: workflow,
      bindings: defaultBindingsFor(workflow),
      budget: 2,
    });
    expect(budgetFor(loadRunState(projectDir, run.runId), 'implement')).toEqual({ worker: 14, orchestrator: 22 });
  });

  test('off ⇒ a worker built from the resolved cap omits --max-budget-usd', ({ run }) => {
    const cap = budgetFor(run, 'implement').worker; // off → undefined
    expect.soft(cap).toBeUndefined();
    expect.soft(claudeArgs({ sessionId: 's', resume: false }, { model: 'claude-opus-4-8', maxBudgetUsd: cap })).not.toContain('--max-budget-usd');
  });
});

describe('workflow identity', () => {
  test('a created run materializes the full workflow by default — persisted, not defaulted at read time', ({ projectDir, run }) => {
    expect.soft(run.workflow).toBe('full');
    const onDisk = readFileSync(join(projectDir, '.duet', 'runs', run.runId, 'state.json'), 'utf8');
    expect(JSON.parse(onDisk).workflow).toBe('full');
  });

  test('a state file with no workflow field (remodel-era or hand-written) materializes full at the load boundary', ({ projectDir, run }) => {
    delete (run as { workflow?: string }).workflow;
    saveRunState(run);
    expect(loadRunState(projectDir, run.runId).workflow).toBe('full');
  });

  test('createRun persists an explicit workflow', ({ projectDir }) => {
    const created = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full'), workflow: 'full', framing: 'f' });
    expect(created.workflow).toBe('full');
    expect(loadRunState(projectDir, created.runId).workflow).toBe('full');
  });

  test('createRun freezes the resolved shipped workflow beside state.json', ({ projectDir }) => {
    const created = createRun({ cwd: projectDir, bindings: defaultBindingsFor('short'), workflow: 'short', framing: 'f' });
    const frozen = JSON.parse(readFileSync(workflowPath(projectDir, created.runId), 'utf8'));
    expect.soft(frozen.name).toBe('short');
    expect.soft(frozen.displayName).toMatch(/Short/);
    expect(workflowFor(loadRunState(projectDir, created.runId)).name).toBe('short');
  });

  test('loadRunState accepts an external workflow identity when workflow.json carries the spec', ({ projectDir }) => {
    const workflow = compileWorkflow(
      defineWorkflow({
        name: 'custom-short',
        title: 'Custom Short',
        presets: { afk: [] },
        phases: [frame({ name: 'research' }), build({ review: 'writable', audit: true }), finish()],
      }),
    );
    const created = createRun({ cwd: projectDir, workflow: workflow.name, workflowSpec: workflow, bindings: defaultBindingsFor(workflow), framing: 'f' });
    const loaded = loadRunState(projectDir, created.runId);
    expect.soft(loaded.workflow).toBe('custom-short');
    expect.soft(workflowFor(loaded).displayName).toBe('Custom Short');
    expect(() => machineFor(workflowFor(loaded))).not.toThrow();
  });

  test('workflow-file mismatch is rejected at the load boundary', ({ projectDir, run }) => {
    const state = JSON.parse(readFileSync(join(runDirOf(projectDir, run.runId), 'state.json'), 'utf8'));
    state.workflow = 'custom-short';
    writeFileSync(join(runDirOf(projectDir, run.runId), 'state.json'), JSON.stringify(state, null, 2));
    expect(() => loadRunState(projectDir, run.runId)).toThrow(/state names workflow "custom-short" but workflow\.json names "full"/);
  });
});

describe('run listing', () => {
  test('lists newest first and skips non-run directories', ({ projectDir, run }) => {
    mkdirSync(join(projectDir, '.duet', 'runs', 'junk'));
    writeFileSync(join(projectDir, '.duet', 'runs', 'junk-file'), 'not a dir');

    const newer = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full') });
    newer.createdAt = new Date(Date.now() + 60_000).toISOString();
    saveRunState(newer);

    expect(listRuns(projectDir).map((r) => r.runId)).toEqual([newer.runId, run.runId]);
  });

  test('scanRuns REPORTS a recognized-but-refused run (never silently hidden) while a corrupt dir still skips quietly', ({
    projectDir,
    run,
  }) => {
    // One loadable run (the fixture), one pre-remodel run (recognized, refused),
    // one corrupt dir (nothing prescriptive to say — quiet skip).
    const old = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full') });
    const oldState = JSON.parse(readFileSync(join(runDirOf(projectDir, old.runId), 'state.json'), 'utf8'));
    delete oldState.bindings.duties;
    writeFileSync(join(runDirOf(projectDir, old.runId), 'state.json'), JSON.stringify(oldState, null, 2));
    mkdirSync(join(projectDir, '.duet', 'runs', 'corrupt'));
    writeFileSync(join(projectDir, '.duet', 'runs', 'corrupt', 'state.json'), 'not json at all');

    const { runs, unloadable } = scanRuns(projectDir);
    expect.soft(runs.map((r) => r.runId)).toEqual([run.runId]);
    // The refusal carries the run id and the prescriptive way out, so a listing
    // surface can print it verbatim — a post-upgrade `duet status` must never
    // read as "no runs" when the truth is "your run no longer loads".
    expect.soft(unloadable).toHaveLength(1);
    expect.soft(unloadable[0]?.runId).toBe(old.runId);
    expect.soft(unloadable[0]?.reason).toMatch(/predates the duty-keyed remodel[\s\S]*claude --resume/);
    // listRuns stays the loadable view.
    expect.soft(listRuns(projectDir).map((r) => r.runId)).toEqual([run.runId]);
  });
});

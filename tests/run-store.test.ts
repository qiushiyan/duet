import { existsSync, readFileSync, readdirSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import type { Snapshot } from 'xstate';
import { build, compileWorkflow, defineWorkflow, finish, frame } from '../src/workflows.ts';
import type { CompiledWorkflow } from '../src/workflows.ts';
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
  contextEventReading,
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
  recordContextEvent,
  recordContextUsage,
  recordPhaseLabel,
  runDirOf,
  sampleContextUsage,
  saveMachineSnapshot,
  saveRunState,
  scratchDirOf,
  stageHumanInput,
  UnloadableRunError,
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

describe('sampleContextUsage — the mid-turn sampler writes through the mutate funnel', () => {
  test('persists the reading itself — disk and the sampler\'s own copy both carry it', ({ projectDir, run }) => {
    sampleContextUsage(run, 'architect', { usedTokens: 400_000, windowTokens: 1_000_000 });
    expect.soft(run.contextUsage?.architect?.usedTokens).toBe(400_000);
    const disk = loadRunState(projectDir, run.runId);
    expect.soft(disk.contextUsage?.architect?.usedTokens).toBe(400_000);
    expect.soft(contextSafetyPercent(disk, 'architect')).toBe(40);
  });

  test('a sample from a dispatch-time snapshot preserves a concurrent sibling write', ({ projectDir, run }) => {
    const snapshot = loadRunState(projectDir, run.runId); // held for the whole worker turn
    markTurnActive(run, 'analyst', 'rev-tag'); // a concurrent dispatch persisted since
    sampleContextUsage(snapshot, 'architect', { usedTokens: 250_000, windowTokens: 1_000_000 });
    const disk = loadRunState(projectDir, run.runId);
    expect.soft(disk.activeTurns?.analyst?.tag).toBe('rev-tag'); // not reverted by the stale snapshot
    expect.soft(disk.contextUsage?.architect?.usedTokens).toBe(250_000);
  });

  test('a lower sample from a stale copy cannot relax a higher persisted reading — the mark re-derives against disk', ({ projectDir, run }) => {
    const snapshot = loadRunState(projectDir, run.runId); // captured before any reading existed
    recordContextUsage(run, 'architect', { usedTokens: 500_000, windowTokens: 1_000_000 });
    saveRunState(run); // a settle persisted a higher reading meanwhile
    sampleContextUsage(snapshot, 'architect', { usedTokens: 300_000, windowTokens: 1_000_000 });
    const disk = loadRunState(projectDir, run.runId);
    expect.soft(disk.contextUsage?.architect?.usedTokens).toBe(300_000); // display: the last honest reading
    expect.soft(disk.contextUsage?.architect?.highWaterTokens).toBe(500_000); // safety: judged against disk's own previous reading
    expect.soft(contextSafetyPercent(disk, 'architect')).toBe(50);
  });
});

describe('the contextEvents ledger — interventions stamped with their pre-fill', () => {
  test('contextEventReading derives the safety token form — the high-water, not the relaxed display reading', ({ run }) => {
    recordContextUsage(run, 'architect', { usedTokens: 500_000, windowTokens: 1_000_000 });
    recordContextUsage(run, 'architect', { usedTokens: 300_000, windowTokens: 1_000_000 });
    expect(contextEventReading(run, 'architect')).toEqual({ preTokens: 500_000, windowTokens: 1_000_000 });
  });

  test('contextEventReading is empty with no reading — an event never carries a guessed number', ({ run }) => {
    expect(contextEventReading(run, 'architect')).toEqual({});
  });

  test('recordContextEvent appends with the pre-intervention snapshot and round-trips; capture happens before the clear', ({ projectDir, run }) => {
    recordContextUsage(run, 'architect', { usedTokens: 850_000, windowTokens: 1_000_000 });
    recordContextEvent(run, { kind: 'compact', voice: 'architect', ...contextEventReading(run, 'architect') });
    clearContextUsage(run, 'architect'); // the intervention clears the reading — the ledger entry keeps it
    recordContextEvent(run, { kind: 'session-reset', voice: 'architect', ...contextEventReading(run, 'architect') });
    saveRunState(run); // the caller owns the save, like every handler-side mutation

    const disk = loadRunState(projectDir, run.runId);
    expect.soft(disk.contextEvents).toHaveLength(2);
    expect.soft(disk.contextEvents?.[0]).toMatchObject({ kind: 'compact', voice: 'architect', preTokens: 850_000, windowTokens: 1_000_000 });
    expect.soft(disk.contextEvents?.[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/); // stamped at append
    // A post-clear event carries no guessed numbers.
    expect.soft(disk.contextEvents?.[1]?.kind).toBe('session-reset');
    expect.soft(disk.contextEvents?.[1]?.preTokens).toBeUndefined();
    expect.soft(disk.contextEvents?.[1]?.windowTokens).toBeUndefined();
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
    legacy.workflow = 'nonesuch';
    writeFileSync(join(runDirOf(projectDir, run.runId), 'state.json'), JSON.stringify(legacy, null, 2));
    rmSync(workflowPath(projectDir, run.runId), { force: true });

    expect(() => loadRunState(projectDir, run.runId)).toThrow(
      /workflow "nonesuch"[\s\S]*no frozen workflow\.json[\s\S]*project\/user workflow files[\s\S]*claude --resume/,
    );
  });

  // gatesAt materialization — one behavior × {absent, explicit-[], explicit-list}.
  // Absent defers to the workflow's default posture (full materializes overnight;
  // short its one-interruption ['research']; the empty-defaultPreAuthorized
  // stays-absent branch is owned by phases.test.ts on the pure defaultPosture);
  // an explicit list — including the first-class [] attend-none — always wins,
  // and gates_at is the complete attend set, not a delta.
  type GatesAtCase = {
    name: string;
    workflow: string;
    gatesAt?: string[];
    persisted: string[] | undefined;
    attended: Array<[phase: string, attends: boolean]>;
  };
  const GATES_AT_CASES: GatesAtCase[] = [
    {
      name: "absent on full ⇒ materializes the overnight posture ['frame','spec'] — plan, Ship, and Open-PR auto-cross (D)",
      workflow: 'full',
      persisted: ['frame', 'spec'],
      attended: [
        ['frame', true],
        ['spec', true],
        ['plan', false],
        ['implement', false],
        ['finish', false],
      ],
    },
    {
      name: "absent on short ⇒ materializes the one-interruption posture ['research'] — Ship and Open-PR auto-cross (2026-07-11 flip)",
      workflow: 'short',
      persisted: ['research'],
      attended: [
        ['research', true],
        ['implement', false],
        ['finish', false],
      ],
    },
    {
      name: 'explicit [] ⇒ persisted as first-class attend-none (bare duet afk relies on it), never coerced to absent',
      workflow: 'full',
      gatesAt: [],
      persisted: [],
      attended: [
        ['frame', false],
        ['finish', false],
      ],
    },
    {
      name: "explicit ['frame','spec'] ⇒ persisted unchanged — materialization never overrides an explicit list",
      workflow: 'full',
      gatesAt: ['frame', 'spec'],
      persisted: ['frame', 'spec'],
      attended: [
        ['frame', true],
        ['plan', false],
      ],
    },
    {
      name: "explicit ['finish'] ⇒ attends only the post-open review stop (opt back in); everything earlier auto-crosses",
      workflow: 'full',
      gatesAt: ['finish'],
      persisted: ['finish'],
      attended: [
        ['finish', true],
        ['frame', false],
        ['spec', false],
      ],
    },
  ];

  test.for(GATES_AT_CASES)('createRun gatesAt: $name', (c, { expect, projectDir }) => {
    const created = createRun({
      cwd: projectDir,
      workflow: c.workflow,
      bindings: defaultBindingsFor(c.workflow),
      ...(c.gatesAt === undefined ? {} : { gatesAt: c.gatesAt }),
    });
    expect.soft(created.gatesAt).toEqual(c.persisted);
    expect.soft(loadRunState(projectDir, created.runId).gatesAt).toEqual(c.persisted);
    for (const [phase, attends] of c.attended) {
      expect.soft(gateAttended(created, phase), `gateAttended(${phase})`).toBe(attends);
    }
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

  // retryInfra materialization (S6) — one behavior × {absent, explicit-0, explicit-N}.
  // Default-on for NEW runs via materialization (the gatesAt discipline), and
  // nullish (not truthy) so the explicit opt-out survives.
  const RETRY_INFRA_CASES: Array<{ name: string; retryInfra: number | undefined; expected: number }> = [
    {
      name: 'absent ⇒ materialized to the default retry budget (DEFAULT_RETRY_INFRA = 3) — default-on for NEW runs',
      retryInfra: undefined,
      expected: DEFAULT_RETRY_INFRA,
    },
    { name: 'explicit 0 ⇒ stays 0 (off) — nullish, not truthy, so the opt-out survives', retryInfra: 0, expected: 0 },
    { name: 'explicit 5 ⇒ stays 5 — materialization never overrides an explicit N', retryInfra: 5, expected: 5 },
  ];

  test.for(RETRY_INFRA_CASES)('createRun retryInfra: $name', (c, { expect, projectDir }) => {
    const created = createRun({
      cwd: projectDir,
      bindings: defaultBindingsFor('full'),
      ...(c.retryInfra === undefined ? {} : { retryInfra: c.retryInfra }),
    });
    expect.soft(created.retryInfra).toBe(c.expected);
    expect.soft(loadRunState(projectDir, created.runId).retryInfra).toBe(c.expected);
  });

  // Worker-budget materialization — one behavior × {absent, explicit-N}. Off ≡
  // absent (never 0): the key is omitted byte-for-byte and budgetFor reads off.
  const BUDGET_CASES: Array<{
    name: string;
    budget: number | undefined;
    implementCaps: { worker: number | undefined; orchestrator: number | undefined };
  }> = [
    {
      name: 'absent ⇒ OFF byte-for-byte — no budget key persisted; budgetFor reads both caps undefined',
      budget: undefined,
      implementCaps: { worker: undefined, orchestrator: undefined },
    },
    {
      name: 'explicit 2 ⇒ frozen on state; a later budgetFor reads it back scaled (×2 the registry profile)',
      budget: 2,
      implementCaps: { worker: 50, orchestrator: 60 },
    },
  ];

  test.for(BUDGET_CASES)('createRun budget: $name', (c, { expect, projectDir }) => {
    const created = createRun({
      cwd: projectDir,
      bindings: defaultBindingsFor('full'),
      ...(c.budget === undefined ? {} : { budget: c.budget }),
    });
    expect.soft(created.budget).toBe(c.budget);
    const reloaded = loadRunState(projectDir, created.runId);
    expect.soft(reloaded.budget).toBe(c.budget);
    expect.soft('budget' in reloaded).toBe(c.budget !== undefined);
    expect.soft(budgetFor(reloaded, 'implement')).toEqual(c.implementCaps);
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

  // Workflow freeze-then-reload — one parameterized behavior across shipped and
  // non-shipped names: createRun freezes the resolved workflow into workflow.json
  // beside state.json, persists the identity on state (materialized at create,
  // not defaulted at read time), and a reload resolves the frozen artifact
  // through workflowFor.
  const INSTANT = compileWorkflow(
    defineWorkflow({
      name: 'instant',
      title: 'Instant (think → build → PR)',
      presets: { afk: [] },
      phases: [frame({ name: 'think' }), build({ review: 'writable', audit: true }), finish()],
    }),
  );
  type WorkflowFreezeCase = {
    name: string;
    /** createRun's workflow opt; absent exercises the materialized-full default. */
    workflow?: string;
    /** A compiled non-shipped spec — freezing it legitimizes the non-shipped name. */
    spec?: CompiledWorkflow;
    frozenName: string;
    displayName: RegExp;
    phases: string[];
  };
  const WORKFLOW_FREEZE_CASES: WorkflowFreezeCase[] = [
    {
      name: 'absent workflow ⇒ full, materialized at create',
      frozenName: 'full',
      displayName: /Full/,
      phases: ['frame', 'spec', 'plan', 'implement', 'finish'],
    },
    {
      name: 'explicit full',
      workflow: 'full',
      frozenName: 'full',
      displayName: /Full/,
      phases: ['frame', 'spec', 'plan', 'implement', 'finish'],
    },
    {
      name: 'blueprint',
      workflow: 'blueprint',
      frozenName: 'blueprint',
      displayName: /Blueprint/,
      phases: ['frame', 'spec', 'implement', 'finish'],
    },
    {
      name: 'short',
      workflow: 'short',
      frozenName: 'short',
      displayName: /Short/,
      phases: ['research', 'implement', 'finish'],
    },
    {
      name: 'a frozen custom spec legitimizes a non-shipped name',
      workflow: 'instant',
      spec: INSTANT,
      frozenName: 'instant',
      displayName: /^Instant \(think → build → PR\)$/,
      phases: ['think', 'implement', 'finish'],
    },
  ];

  test.for(WORKFLOW_FREEZE_CASES)('createRun freezes the workflow, a reload reads it back: $name', (c, { expect, projectDir }) => {
    const created = createRun({
      cwd: projectDir,
      bindings: defaultBindingsFor(c.spec ?? c.workflow ?? 'full'),
      ...(c.workflow === undefined ? {} : { workflow: c.workflow }),
      ...(c.spec === undefined ? {} : { workflowSpec: c.spec }),
    });

    // Frozen beside state.json at creation — later processes read this artifact.
    const frozen = JSON.parse(readFileSync(workflowPath(projectDir, created.runId), 'utf8'));
    expect.soft(frozen.name).toBe(c.frozenName);
    expect.soft(frozen.displayName).toMatch(c.displayName);

    // The identity is persisted on state (not defaulted at read time) …
    const onDisk = JSON.parse(readFileSync(join(runDirOf(projectDir, created.runId), 'state.json'), 'utf8'));
    expect.soft(onDisk.workflow).toBe(c.frozenName);

    // … and a reload resolves the same workflow through workflowFor.
    const reloaded = loadRunState(projectDir, created.runId);
    expect.soft(reloaded.workflow).toBe(c.frozenName);
    const workflow = workflowFor(reloaded);
    expect.soft(workflow.name).toBe(c.frozenName);
    expect.soft(workflow.displayName).toMatch(c.displayName);
    expect.soft(workflow.phases.map((p) => p.name)).toEqual(c.phases);
    expect(() => machineFor(workflow)).not.toThrow(); // the frozen spec drives a real machine
  });

  // The deliberate break: runs frozen before 2026-07-08 carry a `design`
  // doc-loop, a vocabulary duet no longer speaks. They must fail LOUD and
  // ACTIONABLE — an UnloadableRunError the listing surfaces report, naming the
  // retired knob, the era, and a way out — never by silently vanishing from the
  // run list. The validator's own words carry the knob; the boundary adds the rest.
  test('a run frozen with the retired "design" artifact is refused with a named era and a way out', ({ projectDir }) => {
    const created = createRun({ cwd: projectDir, bindings: defaultBindingsFor('blueprint'), workflow: 'blueprint' });
    const path = workflowPath(projectDir, created.runId);
    const frozen = JSON.parse(readFileSync(path, 'utf8'));
    const doc = frozen.phases.find((p: { semantics: { block: string } }) => p.semantics.block === 'doc-loop');
    doc.semantics = { block: 'doc-loop', artifactKind: 'design', examplesKey: 'design' };
    writeFileSync(path, JSON.stringify(frozen));

    let thrown: unknown;
    try {
      workflowFor(created);
    } catch (error) {
      thrown = error;
    }
    expect.soft(thrown).toBeInstanceOf(UnloadableRunError);
    const message = (thrown as Error).message;
    expect.soft(message, 'names the retired vocabulary').toContain('design');
    expect.soft(message, 'names the era so a reader knows which runs are affected').toContain('2026-07-08');
    expect.soft(message, 'every stop needs a next command — the transcripts are still there').toContain('transcripts');
    expect.soft(message, 'says plainly that replay/grading of these runs is gone').toMatch(/replay and grading/i);
  });

  // The refusal carries the validator's own reason, so it works for a knob duet
  // retired AND a knob duet never spoke — no second category, nothing to translate.
  // The era rides as the known cause, never as the diagnosis: a corrupt file must
  // not be told it belongs to a cohort it was never part of.
  test('a frozen doc-loop duet cannot parse is refused with the reason, not a guess at its era', ({ projectDir }) => {
    for (const artifactKind of ['memo', undefined]) {
      const created = createRun({ cwd: projectDir, bindings: defaultBindingsFor('blueprint'), workflow: 'blueprint' });
      const path = workflowPath(projectDir, created.runId);
      const frozen = JSON.parse(readFileSync(path, 'utf8'));
      const doc = frozen.phases.find((p: { semantics: { block: string } }) => p.semantics.block === 'doc-loop');
      doc.semantics = { ...doc.semantics, artifactKind }; // undefined drops the key entirely
      writeFileSync(path, JSON.stringify(frozen));

      let thrown: unknown;
      try {
        workflowFor(created);
      } catch (error) {
        thrown = error;
      }
      const label = artifactKind ?? 'a missing artifactKind';
      const message = thrown instanceof Error ? thrown.message : '<loaded without complaint>';
      expect.soft(thrown, `${label}: reported by the listing surfaces, not skipped`).toBeInstanceOf(UnloadableRunError);
      expect.soft(message, `${label}: names the knob the validator actually rejected`).toContain('artifactKind');
      expect.soft(message, `${label}: never claims the run froze a retired artifact`).not.toMatch(/froze a "(memo|undefined|design)"/);
    }
  });

  // `loadRunStateFromDir` blanket-wraps a throw from the workflow boundary to add a
  // way out. When the boundary already refused prescriptively, that appended a
  // SECOND and contradictory one — "read them directly" followed by "finish
  // manually with --resume". Mutation guard: drop the instanceof rethrow and the
  // way out appears twice.
  test('an unloadable frozen workflow states its way out exactly once through loadRunState', ({ projectDir }) => {
    const created = createRun({ cwd: projectDir, bindings: defaultBindingsFor('blueprint'), workflow: 'blueprint' });
    const path = workflowPath(projectDir, created.runId);
    const frozen = JSON.parse(readFileSync(path, 'utf8'));
    frozen.phases.find((p: { semantics: { block: string } }) => p.semantics.block === 'doc-loop').semantics.artifactKind = 'design';
    writeFileSync(path, JSON.stringify(frozen));

    let thrown: unknown;
    try {
      loadRunState(projectDir, created.runId);
    } catch (error) {
      thrown = error;
    }
    expect.soft(thrown).toBeInstanceOf(UnloadableRunError);
    const message = (thrown as Error).message;
    expect.soft(message.match(/intact/g) ?? [], 'one statement of the way out, not two').toHaveLength(1);
    expect.soft(message, 'and it is the boundary’s own, which knows the transcripts are readable').toContain('read them directly');
  });

  test('a pre-feature shipped run with no workflow.json falls back to the shipped registry row', ({ projectDir }) => {
    const created = createRun({ cwd: projectDir, bindings: defaultBindingsFor('full') });
    rmSync(workflowPath(projectDir, created.runId), { force: true });

    expect.soft(workflowFor(loadRunState(projectDir, created.runId)).displayName).toMatch(/Full/);
  });

  test('a state file with no workflow field (remodel-era or hand-written) materializes full at the load boundary', ({ projectDir, run }) => {
    delete (run as { workflow?: string }).workflow;
    saveRunState(run);
    expect(loadRunState(projectDir, run.runId).workflow).toBe('full');
  });

  test('workflow-file mismatch is rejected at the load boundary', ({ projectDir, run }) => {
    const state = JSON.parse(readFileSync(join(runDirOf(projectDir, run.runId), 'state.json'), 'utf8'));
    state.workflow = 'custom-short';
    writeFileSync(join(runDirOf(projectDir, run.runId), 'state.json'), JSON.stringify(state, null, 2));
    expect(() => loadRunState(projectDir, run.runId)).toThrow(/state names workflow "custom-short" but workflow\.json names "full"/);
  });

  test('a project-composed workflow record loads from the corpus after its source dir is gone', ({ projectDir }) => {
    const workflow = compileWorkflow(
      defineWorkflow({
        name: 'custom-short',
        title: 'Custom Short',
        presets: { afk: [] },
        phases: [frame({ name: 'research' }), build({ review: 'writable', audit: true }), finish()],
      }),
    );
    const corpusRoot = join(projectDir, 'corpus');
    const created = createRun({
      cwd: projectDir,
      workflow: workflow.name,
      workflowSpec: workflow,
      bindings: defaultBindingsFor(workflow),
      framing: 'f',
      corpusRoot,
    });
    const record = created.corpusDir!;
    expect.soft(existsSync(join(record, 'workflow.json'))).toBe(true);

    // Simulate the worktree being cleaned up — the whole reason the corpus exists.
    rmSync(runDirOf(projectDir, created.runId), { recursive: true, force: true });

    // The record still loads, resolving its non-shipped workflow from the record
    // dir it was handed — NOT the deleted state.cwd/.duet/runs path.
    const loaded = loadRunStateFromDir(record);
    expect.soft(loaded.workflow).toBe('custom-short');
    expect.soft(workflowForRunDir(loaded, record).displayName).toBe('Custom Short');
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

  // A new run's materialized postures (full's overnight default, the ['finish']
  // opt-in, short's absent attend-all) live in the createRun gatesAt table under
  // 'run creation'; the absent-gatesAt legacy attend-all is the first test above.
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

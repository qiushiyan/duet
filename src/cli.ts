#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { Command } from 'commander';
import { execa } from 'execa';
import { createActor, waitFor } from 'xstate';
import type { AnyMachineSnapshot } from 'xstate';
import { loadRoleBindings } from './config.ts';
import { duetMachine } from './harness/machine.ts';
import { ROUND_CAPS } from './harness/driver.ts';
import { editFramingForRun } from './framing-editor.ts';
import { notify } from './notify.ts';
import { openTmuxView } from './tmux-view.ts';
import {
  createRun,
  latestRun,
  listRuns,
  loadMachineSnapshot,
  loadRunState,
  runDirOf,
  saveMachineSnapshot,
  saveRunState,
} from './run-state.ts';
import type { RunState } from './run-state.ts';

/**
 * duet — one-shot CLI, alive through a phase (docs/automation-design.md
 * §"Not a daemon — but alive through a phase"). `new` and gate-crossing
 * `continue` invocations return immediately: the phase is driven by a
 * detached per-phase child (`_drive`) that runs the statechart to the next
 * quiescent state (a gate, a queued flag, or done), persists, notifies, and
 * exits. Nothing runs between quiescent stops — still no resident daemon —
 * but the invoking terminal stays free for follow-up duet commands.
 */

const QUIESCENCE_TIMEOUT_MS = 6 * 60 * 60_000;

/**
 * Spawn the detached phase driver and return its pid. Its stdout/stderr go
 * to `.duet/runs/<id>/driver.log` (crash evidence lives there); the pid file
 * is how later invocations refuse to start a second concurrent driver.
 */
function spawnDrive(state: RunState, eventType?: 'approve' | 'reject' | 'answer'): number {
  const runDir = runDirOf(state.cwd, state.runId);
  const out = openSync(join(runDir, 'driver.log'), 'a');
  const child = spawn(
    process.execPath,
    [process.argv[1]!, '_drive', state.runId, ...(eventType ? [eventType] : [])],
    { cwd: state.cwd, detached: true, stdio: ['ignore', out, out] },
  );
  closeSync(out);
  writeFileSync(join(runDir, 'driver.pid'), `${child.pid}\n`);
  child.unref();
  return child.pid!;
}

/** The driver pid when one is alive for this run, else undefined. */
function aliveDriverPid(state: RunState): number | undefined {
  const path = join(runDirOf(state.cwd, state.runId), 'driver.pid');
  if (!existsSync(path)) return undefined;
  const pid = Number.parseInt(readFileSync(path, 'utf8'), 10);
  if (!Number.isFinite(pid)) return undefined;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined; // stale pid — the driver exited (or crashed)
  }
}

function printWatchHints(state: RunState, pid: number, phaseLabel: string): void {
  console.log(`${phaseLabel} running in the background (pid ${pid})`);
  console.log(`  live logs:  duet view ${state.runId}`);
  console.log(`  status:     duet status ${state.runId}`);
  console.log(`you'll get a notification at the next gate or queued question`);
}

async function driveToQuiescence(
  state: RunState,
  options?: { snapshot?: unknown; event?: { type: 'human.approve' | 'human.reject' | 'human.answer' } },
): Promise<AnyMachineSnapshot> {
  const actor = createActor(duetMachine, {
    input: { runId: state.runId, cwd: state.cwd, hasSpec: Boolean(state.specPath) },
    ...(options?.snapshot ? { snapshot: options.snapshot as never } : {}),
  });
  actor.start();
  if (options?.event) actor.send(options.event);

  const snapshot = await waitFor(
    actor,
    (s) => s.hasTag('quiescent') || s.status === 'done',
    { timeout: QUIESCENCE_TIMEOUT_MS },
  );

  saveMachineSnapshot(state, actor.getPersistedSnapshot());
  const fresh = loadRunState(state.cwd, state.runId);
  fresh.machineState = typeof snapshot.value === 'string' ? snapshot.value : JSON.stringify(snapshot.value);
  saveRunState(fresh);
  actor.stop();
  printStatus(fresh, snapshot);
  await notify(`duet ${fresh.runId}`, describeStop(fresh, snapshot));
  return snapshot;
}

function describeStop(state: RunState, snapshot: AnyMachineSnapshot): string {
  if (snapshot.status === 'done') return 'run complete — the PR is open';
  const machineState = state.machineState ?? '';
  if (state.pendingQuestion && machineState.includes('FlagWait')) {
    return `question queued: ${state.pendingQuestion.question}`;
  }
  if (machineState === 'directionGate') return 'Direction gate — synthesized direction ready';
  if (machineState === 'commitSpecGate') return 'Commit-spec gate — spec ready for review';
  if (machineState === 'planApprovalGate') return 'Plan-approval gate — plan ready for review';
  if (machineState === 'shipGate') return 'Ship gate — implementation packet ready';
  if (machineState === 'docsPlanGate') return 'Docs-plan gate — proposal ready';
  if (machineState === 'openPrGate') return 'Open-PR gate — PR description ready';
  return `stopped at ${machineState}`;
}

const GATE_PHASE = {
  directionGate: 'frame',
  commitSpecGate: 'spec',
  planApprovalGate: 'plan',
  shipGate: 'impl',
  docsPlanGate: 'docs',
  openPrGate: 'pr',
} as const;

const GATE_HEADING: Record<keyof typeof GATE_PHASE, string> = {
  directionGate: 'DIRECTION gate — the synthesized direction',
  commitSpecGate: "SPEC gate — the orchestrator's summary",
  planApprovalGate: "PLAN gate — the orchestrator's summary",
  shipGate: 'SHIP gate — the orchestrator’s packet (CEO summary first)',
  docsPlanGate: 'DOCS-PLAN gate — the proposal',
  openPrGate: 'OPEN-PR gate — the PR description',
};

function printStatus(state: RunState, snapshot?: AnyMachineSnapshot): void {
  const machineState = state.machineState ?? '(not started)';
  console.log(`\n━━━ duet run ${state.runId} ━━━`);
  console.log(`state:    ${machineState}`);
  const livePid = aliveDriverPid(state);
  if (livePid !== undefined && livePid !== process.pid) {
    console.log(`phase:    running in the background (pid ${livePid})`);
  }
  console.log(`spec:     ${state.specPath ?? '(not yet drafted — framing-only entry)'}`);
  if (state.branch) console.log(`branch:   ${state.branch}`);
  if (state.lastActivity) console.log(`last:     ${state.lastActivity}`);
  const roundOrder: Array<'frame' | 'spec' | 'plan' | 'impl' | 'docs' | 'pr'> = ['frame', 'spec', 'plan', 'impl', 'docs', 'pr'];
  const rounds = roundOrder
    .filter((p) => (state.rounds[p] ?? 0) > 0 || p === 'spec' || p === 'plan' || p === 'impl')
    .map((p) => `${p} ${state.rounds[p] ?? 0}/${ROUND_CAPS[p]}`)
    .join(', ');
  console.log(`rounds:   ${rounds}`);
  console.log(
    `cost:     orchestrator $${state.costs.orchestratorUsd.toFixed(2)}, claude workers $${state.costs.claudeWorkersUsd.toFixed(2)}, codex ${state.costs.codexTokens.input}/${state.costs.codexTokens.output} tokens`,
  );
  if (state.snippetProposals.length > 0) {
    console.log(`proposals: ${state.snippetProposals.length} snippet edit(s) queued (details in state.json)`);
  }

  if (state.pendingQuestion && machineState.includes('FlagWait')) {
    console.log(`\nQUEUED QUESTION for you:`);
    console.log(`  ${state.pendingQuestion.question}`);
    if (state.pendingQuestion.context) console.log(`  context: ${state.pendingQuestion.context}`);
    console.log(`\nanswer with:  duet continue ${state.runId} --answer "<your answer>"`);
    return;
  }

  if (machineState in GATE_PHASE) {
    const gate = machineState as keyof typeof GATE_PHASE;
    const summary = state.phaseSummaries[GATE_PHASE[gate]];
    console.log(`\n━━━ ${GATE_HEADING[gate]} ━━━`);
    if (summary) {
      console.log(summary.summary);
      if (summary.artifacts.length > 0) console.log(`\nartifacts: ${summary.artifacts.join(', ')}`);
    }
    console.log(`\ndecide with:`);
    console.log(`  duet continue ${state.runId} --approve`);
    console.log(`  duet continue ${state.runId} --reject "<feedback>"`);
    if (gate === 'shipGate') {
      console.log(`\n(verify in your environment before deciding — migrations, smoke tests; approving enters FINAL REVIEW: docs → PR description → Open-PR gate)`);
    }
    if (gate === 'openPrGate') {
      console.log(`\n(approving opens the PR: the implementer pushes the branch and runs gh pr create)`);
    }
    return;
  }

  if (snapshot?.status === 'done' || machineState === 'done') {
    console.log(`\nrun complete — the PR is open.`);
    const open = state.phaseSummaries.open;
    if (open) console.log(open.summary);
    if (state.snippetProposals.length > 0) {
      console.log(`\n━━━ queued snippet proposals (your end-of-run editorial review) ━━━`);
      for (const p of state.snippetProposals) {
        console.log(`\n• ${p.snippetKey} — ${p.rationale}`);
      }
      console.log(`\nfull bodies in .duet/runs/${state.runId}/state.json; apply the ones you accept to snippets.toml.`);
    }
    console.log(`\ntranscripts: .duet/runs/${state.runId}/*.log (and the providers' standard session locations)`);
  }
}

const program = new Command();

function fail(message: string): never {
  program.error(message);
  throw new Error(message); // unreachable — program.error exits
}
program
  .name('duet')
  .description('Semi-AFK orchestrator for the two-agent cross-review workflow.')
  .version('0.1.0');

program
  .command('new')
  .description('Start a run: [FRAME →] SPEC → PLAN (walk away) → AFK IMPLEMENTATION → DOCS → PR → opened PR.')
  .option('--spec <path>', 'path to a draft spec file; omit to start from the framing alone (the FRAME phase drafts it)')
  .option('--framing <file>', 'project briefing file — the only place project knowledge enters; omit both flags to write it in your editor')
  .option('--orchestrator <provider[:model]>', 'role binding override (claude[:model] only in v1)')
  .option('--impl <provider[:model]>', 'implementer binding override')
  .option('--reviewer <provider[:model]>', 'reviewer binding override')
  .option('--tmux', 'open a tmux viewer: one live pane per voice, tailing the run logs')
  .action(async (opts: { spec?: string; framing?: string; orchestrator?: string; impl?: string; reviewer?: string; tmux?: boolean }) => {
    const cwd = process.cwd();
    let framingFile = opts.framing;
    if (!opts.spec && !framingFile) {
      try {
        framingFile = await editFramingForRun(cwd);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    }
    let specPath: string | undefined;
    if (opts.spec) {
      specPath = relative(cwd, resolve(cwd, opts.spec));
      if (!existsSync(resolve(cwd, specPath))) {
        fail(`spec file not found: ${opts.spec}`);
      }
    }
    const bindings = loadRoleBindings({
      ...(opts.orchestrator ? { orchestrator: opts.orchestrator } : {}),
      ...(opts.impl ? { implementer: opts.impl } : {}),
      ...(opts.reviewer ? { reviewer: opts.reviewer } : {}),
    });
    const framing = framingFile ? readFileSync(resolve(cwd, framingFile), 'utf8') : undefined;

    let branch: string | undefined;
    try {
      branch = (await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })).stdout.trim();
    } catch {
      // Not a git repo (or detached weirdness) — the orchestrator will surface it.
    }

    const state = createRun({
      cwd,
      ...(specPath ? { specPath } : {}),
      ...(framing ? { framing } : {}),
      ...(branch ? { branch } : {}),
      bindings,
    });
    console.log(`run ${state.runId} created`);
    if (opts.tmux) await openTmuxView(state);
    console.log(
      `roles: orchestrator=${bindings.orchestrator.provider}:${bindings.orchestrator.model ?? ''} implementer=${bindings.implementer.provider}${bindings.implementer.model ? ':' + bindings.implementer.model : ''} reviewer=${bindings.reviewer.provider}${bindings.reviewer.model ? ':' + bindings.reviewer.model : ''}\n`,
    );
    const pid = spawnDrive(state);
    printWatchHints(state, pid, specPath ? 'SPEC review loop' : 'FRAME phase');
  });

program
  .command('continue')
  .description('Resume a run past its gate or queued flag.')
  .argument('[runId]', 'run id (defaults to the latest run in this project)')
  .option('--approve', 'approve the current gate')
  .option('--reject <feedback>', 'send the artifact back with feedback')
  .option('--answer <text>', 'answer the queued question')
  .option('--tmux', 'open (or reuse) the tmux viewer for this run')
  .action(async (runId: string | undefined, opts: { approve?: boolean; reject?: string; answer?: string; tmux?: boolean }) => {
    const cwd = process.cwd();
    const state = runId ? loadRunState(cwd, runId) : latestRun(cwd);
    if (!state) fail('no runs found in this project (start one with: duet new --spec <path>)');
    if (opts.tmux) await openTmuxView(state);

    const chosen = [opts.approve, opts.reject, opts.answer].filter((v) => v !== undefined);
    if (chosen.length > 1) fail('choose one of --approve, --reject, --answer');

    // A phase driver already running owns this run — a second one would race
    // it on the orchestrator session and the state file.
    const runningPid = aliveDriverPid(state);
    if (runningPid !== undefined) {
      if (chosen.length > 0) {
        fail(
          `the phase is still running (pid ${runningPid}) — there's no gate or flag to act on yet; watch with: duet view ${state.runId}`,
        );
      }
      printStatus(state);
      console.log(`\nphase running in the background (pid ${runningPid}) — live logs: duet view ${state.runId}`);
      return;
    }

    const snapshot = loadMachineSnapshot(state);

    if (!snapshot) {
      // No quiescent snapshot and no live driver — the run crashed mid-phase
      // (or was killed). Re-enter; the driver re-derives position from the
      // run state + transcripts (which is where truth always lived).
      if (chosen.length > 0) {
        fail(
          'this run has no gate to act on (it stopped mid-phase) — rerun without flags to let it pick up from the transcripts',
        );
      }
      console.log(`run ${state.runId}: no quiescent snapshot — re-entering the current phase from the transcripts`);
      const pid = spawnDrive(state);
      printWatchHints(state, pid, 'recovered phase');
      return;
    }

    let event: { type: 'human.approve' | 'human.reject' | 'human.answer' };
    if (opts.approve) event = { type: 'human.approve' };
    else if (opts.reject !== undefined) event = { type: 'human.reject' };
    else if (opts.answer !== undefined) event = { type: 'human.answer' };
    else {
      printStatus(state);
      return;
    }

    // Validate the event against the restored state before committing side
    // effects, so a wrong flag gets a friendly error instead of a no-op.
    const probe = createActor(duetMachine, {
      input: { runId: state.runId, cwd: state.cwd, hasSpec: Boolean(state.specPath) },
      snapshot: snapshot as never,
    });
    const restored = probe.getSnapshot() as AnyMachineSnapshot;
    if (restored.status === 'done') fail(`run ${state.runId} is complete — nothing to continue`);
    if (!restored.can(event)) {
      fail(
        `--${event.type.split('.')[1]} is not valid at ${JSON.stringify(restored.value)} — ` +
          (restored.hasTag('gate') ? 'this is a gate: use --approve or --reject "<feedback>"' : 'a question is queued: use --answer "<text>"'),
      );
    }

    if (opts.reject !== undefined) state.pendingMessage = { kind: 'feedback', text: opts.reject };
    if (opts.answer !== undefined) state.pendingMessage = { kind: 'answer', text: opts.answer };
    saveRunState(state);

    const eventType = event.type.split('.')[1] as 'approve' | 'reject' | 'answer';
    const pid = spawnDrive(state, eventType);
    printWatchHints(state, pid, `phase (after --${eventType})`);
  });

// Internal: the detached phase driver `new`/`continue` spawn. Drives the
// statechart to the next quiescent stop, persists, notifies, exits.
const driveCommand = new Command('_drive')
  .argument('<runId>')
  .argument('[eventType]')
  .action(async (runId: string, eventType?: string) => {
    const state = loadRunState(process.cwd(), runId);
    const snapshot = loadMachineSnapshot(state);
    const event =
      eventType === 'approve' || eventType === 'reject' || eventType === 'answer'
        ? ({ type: `human.${eventType}` } as { type: 'human.approve' | 'human.reject' | 'human.answer' })
        : undefined;
    await driveToQuiescence(state, {
      ...(snapshot ? { snapshot } : {}),
      ...(event ? { event } : {}),
    });
  });
program.addCommand(driveCommand, { hidden: true });

program
  .command('view')
  .description('Open (or reuse) the tmux viewer: one live pane per voice, tailing the run logs.')
  .argument('[runId]', 'run id (defaults to the latest run in this project)')
  .action(async (runId: string | undefined) => {
    const cwd = process.cwd();
    const state = runId ? loadRunState(cwd, runId) : latestRun(cwd);
    if (!state) fail('no runs found in this project');
    await openTmuxView(state);
    console.log(`raw logs: ${join(runDirOf(state.cwd, state.runId))}/{orchestrator,implementer,reviewer,driver}.log`);
  });

program
  .command('status')
  .description('Show a run’s phase, queued flags, rounds, costs, and next command.')
  .argument('[runId]', 'run id (defaults to the latest run in this project)')
  .action((runId: string | undefined) => {
    const cwd = process.cwd();
    const state = runId ? loadRunState(cwd, runId) : latestRun(cwd);
    if (!state) fail('no runs found in this project');
    printStatus(state);
  });

program
  .command('runs')
  .description('List known runs in this project.')
  .action(() => {
    const all = listRuns(process.cwd());
    if (all.length === 0) {
      console.log('no runs');
      return;
    }
    for (const r of all) {
      const waiting = r.pendingQuestion ? 'waiting-on-answer' : '';
      console.log(`${r.runId}  ${r.machineState ?? '?'}  ${waiting}  ${r.specPath ?? '(framing-only)'}`);
    }
  });

await program.parseAsync(process.argv);

#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { Command } from 'commander';
import { execa } from 'execa';
import { createActor, waitFor } from 'xstate';
import type { AnyMachineSnapshot } from 'xstate';
import { loadRoleBindings } from './config.ts';
import { duetMachine } from './harness/machine.ts';
import { ROUND_CAPS } from './harness/driver.ts';
import { notify } from './notify.ts';
import {
  createRun,
  latestRun,
  listRuns,
  loadMachineSnapshot,
  loadRunState,
  saveMachineSnapshot,
  saveRunState,
} from './run-state.ts';
import type { RunState } from './run-state.ts';

/**
 * duet — one-shot CLI, alive through a phase (docs/automation-design.md
 * §"Not a daemon — but alive through a phase"). Each invocation drives the
 * statechart to the next quiescent state (a gate, a queued flag, or done),
 * persists, and exits. The human resumes with `duet continue`.
 */

const QUIESCENCE_TIMEOUT_MS = 6 * 60 * 60_000;

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
  .option('--framing <file>', 'project briefing file — the only place project knowledge enters')
  .option('--orchestrator <provider[:model]>', 'role binding override (claude[:model] only in v1)')
  .option('--impl <provider[:model]>', 'implementer binding override')
  .option('--reviewer <provider[:model]>', 'reviewer binding override')
  .action(async (opts: { spec?: string; framing?: string; orchestrator?: string; impl?: string; reviewer?: string }) => {
    const cwd = process.cwd();
    if (!opts.spec && !opts.framing) {
      fail('provide --spec, --framing, or both — a framing-only run drafts the spec itself, but needs the briefing to do it');
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
    const framing = opts.framing ? readFileSync(resolve(cwd, opts.framing), 'utf8') : undefined;

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
    console.log(`run ${state.runId} created — entering the ${specPath ? 'SPEC review loop' : 'FRAME phase'}`);
    console.log(
      `roles: orchestrator=${bindings.orchestrator.provider}:${bindings.orchestrator.model ?? ''} implementer=${bindings.implementer.provider}${bindings.implementer.model ? ':' + bindings.implementer.model : ''} reviewer=${bindings.reviewer.provider}${bindings.reviewer.model ? ':' + bindings.reviewer.model : ''}\n`,
    );
    await driveToQuiescence(state);
  });

program
  .command('continue')
  .description('Resume a run past its gate or queued flag.')
  .argument('[runId]', 'run id (defaults to the latest run in this project)')
  .option('--approve', 'approve the current gate')
  .option('--reject <feedback>', 'send the artifact back with feedback')
  .option('--answer <text>', 'answer the queued question')
  .action(async (runId: string | undefined, opts: { approve?: boolean; reject?: string; answer?: string }) => {
    const cwd = process.cwd();
    const state = runId ? loadRunState(cwd, runId) : latestRun(cwd);
    if (!state) fail('no runs found in this project (start one with: duet new --spec <path>)');

    const chosen = [opts.approve, opts.reject, opts.answer].filter((v) => v !== undefined);
    if (chosen.length > 1) fail('choose one of --approve, --reject, --answer');

    const snapshot = loadMachineSnapshot(state);

    if (!snapshot) {
      // No quiescent snapshot — the run crashed mid-phase (or was killed).
      // Recreate from the start state; the driver re-derives position from
      // the run state + transcripts (which is where truth always lived).
      if (chosen.length > 0) {
        fail(
          'this run has no gate to act on (it stopped mid-phase) — rerun without flags to let it pick up from the transcripts',
        );
      }
      console.log(`run ${state.runId}: no quiescent snapshot — re-entering the current phase from the transcripts`);
      await driveToQuiescence(state);
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

    await driveToQuiescence(state, { snapshot, event });
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

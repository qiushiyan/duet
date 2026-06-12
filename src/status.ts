import { PHASES, gateOf, phaseOfGateState } from './phases.ts';
import type { RunState } from './run-store.ts';

/**
 * Status rendering — the human-facing view of a run, as pure string
 * builders. The CLI and the lifecycle loop print these; nothing here touches
 * the filesystem, the process table, or the statechart, so the copy is
 * directly testable.
 */

/** One line describing why the run stopped — the notification body. */
export function describeStop(state: RunState, done: boolean): string {
  if (done) return 'run complete — the PR is open';
  const machineState = state.machineState ?? '';
  if (state.pendingQuestion && machineState.includes('FlagWait')) {
    return `question queued: ${state.pendingQuestion.question}`;
  }
  const gatePhase = phaseOfGateState(machineState);
  if (gatePhase) return gateOf(gatePhase).ready;
  return `stopped at ${machineState}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/**
 * The full status block: run header, gate packet or queued question, the
 * while-you-were-away section, and the next command. `livePid` is the
 * still-running phase driver's pid when one exists, `done` whether the
 * machine has finished — the caller owns the process table and the
 * statechart; this function only renders.
 */
export function renderStatus(state: RunState, opts: { done?: boolean; livePid?: number } = {}): string {
  const lines: string[] = [];
  const machineState = state.machineState ?? '(not started)';
  lines.push(`\n━━━ duet run ${state.runId} ━━━`);
  lines.push(`state:    ${machineState}`);
  if (opts.livePid !== undefined) {
    lines.push(`phase:    running in the background (pid ${opts.livePid})`);
  }
  lines.push(`spec:     ${state.specPath ?? '(not yet drafted — framing-only entry)'}`);
  if (state.branch) lines.push(`branch:   ${state.branch}`);
  if (state.gatesAt) lines.push(`gates:    attending ${state.gatesAt.join(', ')} — other gates pre-authorized`);
  if (state.lastActivity) lines.push(`last:     ${state.lastActivity}`);
  const rounds = PHASES.filter((p) => p.name !== 'open' && ((state.rounds[p.name] ?? 0) > 0 || p.reviewLoop))
    .map((p) => `${p.name} ${state.rounds[p.name] ?? 0}/${p.roundCap}`)
    .join(', ');
  lines.push(`rounds:   ${rounds}`);
  lines.push(
    `cost:     orchestrator $${state.costs.orchestratorUsd.toFixed(2)}, claude workers $${state.costs.claudeWorkersUsd.toFixed(2)}, codex ${fmtTokens(state.costs.codexTokens.input)} in / ${fmtTokens(state.costs.codexTokens.output)} out tokens`,
  );
  if (state.snippetProposals.length > 0) {
    lines.push(`proposals: ${state.snippetProposals.length} snippet edit(s) queued (details in state.json)`);
  }

  if (state.autoApprovals && state.autoApprovals.length > 0) {
    lines.push(`\nwhile you were away — gates auto-approved (pre-authorized):`);
    for (const a of state.autoApprovals) {
      const phase = phaseOfGateState(a.gate);
      const headline = phase
        ? (state.phaseSummaries[phase]?.summary.split('\n').find((l) => l.trim()) ?? '').slice(0, 96)
        : '';
      lines.push(`  ✓ ${a.gate}  ${a.at.slice(0, 16).replace('T', ' ')}  ${headline}`);
    }
    lines.push(`  full packets: duet logs ${state.runId}`);
  }

  if (state.pendingQuestion && machineState.includes('FlagWait')) {
    lines.push(`\nQUEUED QUESTION for you:`);
    lines.push(`  ${state.pendingQuestion.question}`);
    if (state.pendingQuestion.context) lines.push(`  context: ${state.pendingQuestion.context}`);
    lines.push(`\nanswer with:  duet continue ${state.runId} --answer "<your answer>"`);
    return lines.join('\n');
  }

  const gatePhase = phaseOfGateState(machineState);
  if (gatePhase) {
    const gate = gateOf(gatePhase);
    const summary = state.phaseSummaries[gatePhase];
    lines.push(`\n━━━ ${gate.heading} ━━━`);
    if (summary) {
      lines.push(summary.summary);
      if (summary.artifacts.length > 0) lines.push(`\nartifacts: ${summary.artifacts.join(', ')}`);
    }
    lines.push(`\ndecide with:`);
    lines.push(`  duet continue ${state.runId} --approve`);
    lines.push(`  duet continue ${state.runId} --reject "<feedback>"`);
    if (gate.hint) lines.push(`\n${gate.hint}`);
    return lines.join('\n');
  }

  if (opts.done || machineState === 'done') {
    lines.push(`\nrun complete — the PR is open.`);
    const open = state.phaseSummaries.open;
    if (open) lines.push(open.summary);
    if (state.snippetProposals.length > 0) {
      lines.push(`\n━━━ queued snippet proposals (your end-of-run editorial review) ━━━`);
      for (const p of state.snippetProposals) {
        lines.push(`\n• ${p.snippetKey} — ${p.rationale}`);
      }
      lines.push(`\nfull bodies in .duet/runs/${state.runId}/state.json; apply the ones you accept to snippets.toml.`);
    }
    lines.push(`\ntranscripts: .duet/runs/${state.runId}/*.log (and the providers' standard session locations)`);
  }
  return lines.join('\n');
}

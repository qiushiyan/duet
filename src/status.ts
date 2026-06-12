import type { RunPosition } from './harness/lifecycle.ts';
import { PHASES, gateOf, phaseOfGateState } from './phases.ts';
import type { GatePhase, PhaseName } from './phases.ts';
import type { RunState, Steer } from './run-store.ts';

/**
 * Status — one derivation, two renderers. `buildStatusModel` joins the run
 * state with the position probe into the StatusModel; the human renderer
 * (`renderStatus`) and `duet status --json` (`JSON.stringify` of the model,
 * verbatim) both consume it. Everything here is pure string/object building:
 * no fs, no process table, no xstate — the caller gathers the position and
 * the pending steers and passes them in.
 *
 * The JSON schema's compatibility promise is ADDITIVE-ONLY: the concierge
 * skill's reference doc documents these fields, so a rename or removal is a
 * breaking change to the shipped skill (and fails the pinned-keys test).
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

/**
 * Why `duet steer` is refused at this position, or undefined when steering
 * is legal (a live or crashed phase). Quiescent stops have their own
 * channel, and the copy names it — gates stay explicit.
 */
export function steerRefusal(position: RunPosition, runId: string): string | undefined {
  switch (position.kind) {
    case 'running':
    case 'crashed':
      return undefined;
    case 'gate': {
      const gate = gateOf(position.phase);
      return (
        `the run is waiting at the ${gate.state} — steering here is the gate decision itself: ` +
        `duet continue ${runId} --approve, or duet continue ${runId} --reject "<feedback>" (your feedback reaches the orchestrator verbatim).`
      );
    }
    case 'flag':
      return (
        `the run is paused on a queued question — the answer is the steering channel here: ` +
        `duet continue ${runId} --answer "<your answer>".`
      );
    case 'done':
      return `run ${runId} is complete — there is no phase to steer. A new run starts with duet new.`;
  }
}

/** The discriminated stop — what the run is waiting on, and the command that acts there. */
export type StopModel =
  | { kind: 'running'; pid: number; phase: PhaseName }
  | {
      kind: 'gate';
      phase: GatePhase;
      gate: string;
      heading: string;
      hint?: string;
      packet?: { summary: string; artifacts: string[] };
      commands: { approve: string; reject: string };
    }
  | { kind: 'flag'; question: string; context?: string; command: string }
  | { kind: 'crashed'; phase: PhaseName; command: string }
  | { kind: 'done'; summary?: string };

export interface StatusModel {
  runId: string;
  createdAt: string;
  branch?: string;
  specPath?: string;
  /** The last quiescent stop's machine state — a display hint, not resume truth. */
  machineState?: string;
  stop: StopModel;
  gatesAt?: GatePhase[];
  autoApprovals: Array<{ gate: string; at: string; headline: string }>;
  rounds: Array<{ phase: PhaseName; used: number; cap: number }>;
  costs: RunState['costs'];
  /** Staged steers not yet delivered to the orchestrator. */
  pendingSteers: Array<{ stagedAt: string; stagedDuring?: PhaseName; text: string }>;
  /** Queued library edits (rationale only — full bodies stay in state.json). */
  snippetProposals: Array<{ snippetKey: string; rationale: string; at: string }>;
  lastActivity?: string;
}

export function buildStatusModel(state: RunState, position: RunPosition, pendingSteers: Steer[]): StatusModel {
  return {
    runId: state.runId,
    createdAt: state.createdAt,
    ...(state.branch ? { branch: state.branch } : {}),
    ...(state.specPath ? { specPath: state.specPath } : {}),
    ...(state.machineState ? { machineState: state.machineState } : {}),
    stop: stopModel(state, position),
    ...(state.gatesAt ? { gatesAt: state.gatesAt } : {}),
    autoApprovals: (state.autoApprovals ?? []).map((a) => ({ ...a, headline: packetHeadline(state, a.gate) })),
    rounds: PHASES.filter((p) => p.name !== 'open' && ((state.rounds[p.name] ?? 0) > 0 || p.reviewLoop)).map(
      (p) => ({ phase: p.name, used: state.rounds[p.name] ?? 0, cap: p.roundCap }),
    ),
    costs: state.costs,
    pendingSteers: pendingSteers.map(({ stagedAt, stagedDuring, text }) => ({
      stagedAt,
      ...(stagedDuring ? { stagedDuring } : {}),
      text,
    })),
    snippetProposals: state.snippetProposals.map(({ snippetKey, rationale, at }) => ({ snippetKey, rationale, at })),
    ...(state.lastActivity ? { lastActivity: state.lastActivity } : {}),
  };
}

function stopModel(state: RunState, position: RunPosition): StopModel {
  switch (position.kind) {
    case 'running':
      return position;
    case 'gate': {
      const gate = gateOf(position.phase);
      const packet = state.phaseSummaries[position.phase];
      return {
        kind: 'gate',
        phase: position.phase,
        gate: gate.state,
        heading: gate.heading,
        ...(gate.hint ? { hint: gate.hint } : {}),
        ...(packet ? { packet } : {}),
        commands: {
          approve: `duet continue ${state.runId} --approve`,
          reject: `duet continue ${state.runId} --reject "<feedback>"`,
        },
      };
    }
    case 'flag':
      return {
        kind: 'flag',
        question: state.pendingQuestion?.question ?? '(question missing — check the orchestrator log)',
        ...(state.pendingQuestion?.context ? { context: state.pendingQuestion.context } : {}),
        command: `duet continue ${state.runId} --answer "<your answer>"`,
      };
    case 'crashed':
      return { kind: 'crashed', phase: position.phase, command: `duet continue ${state.runId}` };
    case 'done':
      return {
        kind: 'done',
        ...(state.phaseSummaries.open ? { summary: state.phaseSummaries.open.summary } : {}),
      };
  }
}

function packetHeadline(state: RunState, gateState: string): string {
  const phase = phaseOfGateState(gateState);
  if (!phase) return '';
  return (state.phaseSummaries[phase]?.summary.split('\n').find((l) => l.trim()) ?? '').slice(0, 96);
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/**
 * The human-facing status block: run header, the stop (gate packet, queued
 * question, crash notice, or completion), the while-you-were-away section,
 * staged steers, and the next command.
 */
export function renderStatus(model: StatusModel): string {
  const lines: string[] = [];
  lines.push(`\n━━━ duet run ${model.runId} ━━━`);
  lines.push(`state:    ${model.machineState ?? '(not started)'}`);
  if (model.stop.kind === 'running') {
    lines.push(`phase:    running in the background (pid ${model.stop.pid})`);
  }
  lines.push(`spec:     ${model.specPath ?? '(not yet drafted — framing-only entry)'}`);
  if (model.branch) lines.push(`branch:   ${model.branch}`);
  if (model.gatesAt) lines.push(`gates:    attending ${model.gatesAt.join(', ')} — other gates pre-authorized`);
  if (model.lastActivity) lines.push(`last:     ${model.lastActivity}`);
  lines.push(`rounds:   ${model.rounds.map((r) => `${r.phase} ${r.used}/${r.cap}`).join(', ')}`);
  lines.push(
    `cost:     orchestrator $${model.costs.orchestratorUsd.toFixed(2)}, claude workers $${model.costs.claudeWorkersUsd.toFixed(2)}, codex ${fmtTokens(model.costs.codexTokens.input)} in / ${fmtTokens(model.costs.codexTokens.output)} out tokens`,
  );
  if (model.snippetProposals.length > 0) {
    lines.push(`proposals: ${model.snippetProposals.length} snippet edit(s) queued (details in state.json)`);
  }

  if (model.pendingSteers.length > 0) {
    lines.push(`\nstaged steers awaiting delivery:`);
    for (const s of model.pendingSteers) {
      lines.push(`  • ${s.stagedAt.slice(0, 16).replace('T', ' ')}  ${s.text}`);
    }
  }

  if (model.autoApprovals.length > 0) {
    lines.push(`\nwhile you were away — gates auto-approved (pre-authorized):`);
    for (const a of model.autoApprovals) {
      lines.push(`  ✓ ${a.gate}  ${a.at.slice(0, 16).replace('T', ' ')}  ${a.headline}`);
    }
    lines.push(`  full packets: duet logs ${model.runId}`);
  }

  const stop = model.stop;
  if (stop.kind === 'flag') {
    lines.push(`\nQUEUED QUESTION for you:`);
    lines.push(`  ${stop.question}`);
    if (stop.context) lines.push(`  context: ${stop.context}`);
    lines.push(`\nanswer with:  ${stop.command}`);
    return lines.join('\n');
  }

  if (stop.kind === 'gate') {
    lines.push(`\n━━━ ${stop.heading} ━━━`);
    if (stop.packet) {
      lines.push(stop.packet.summary);
      if (stop.packet.artifacts.length > 0) lines.push(`\nartifacts: ${stop.packet.artifacts.join(', ')}`);
    }
    lines.push(`\ndecide with:`);
    lines.push(`  ${stop.commands.approve}`);
    lines.push(`  ${stop.commands.reject}`);
    if (stop.hint) lines.push(`\n${stop.hint}`);
    return lines.join('\n');
  }

  if (stop.kind === 'crashed') {
    lines.push(`\nthe ${stop.phase} phase stopped mid-flight — no driver is running.`);
    lines.push(`resume with:  ${stop.command}   (the run re-enters from the transcripts)`);
    return lines.join('\n');
  }

  if (stop.kind === 'done') {
    lines.push(`\nrun complete — the PR is open.`);
    if (stop.summary) lines.push(stop.summary);
    if (model.snippetProposals.length > 0) {
      lines.push(`\n━━━ queued snippet proposals (your end-of-run editorial review) ━━━`);
      for (const p of model.snippetProposals) {
        lines.push(`\n• ${p.snippetKey} — ${p.rationale}`);
      }
      lines.push(`\nfull bodies in .duet/runs/${model.runId}/state.json; apply the ones you accept to snippets.toml.`);
    }
    lines.push(`\ntranscripts: .duet/runs/${model.runId}/*.log (and the providers' standard session locations)`);
  }
  return lines.join('\n');
}

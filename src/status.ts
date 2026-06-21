import type { RunPosition } from './harness/lifecycle.ts';
import { PHASES, gateOf, phaseOfGateState } from './phases.ts';
import type { GatePhase, PhaseName } from './phases.ts';
import type { WorkerRole } from './providers/types.ts';
import { contextPercent } from './run-store.ts';
import type { HumanDecision, RunState, Steer, Voice } from './run-store.ts';
import { resolveSessions } from './sessions.ts';
import type { SessionRef } from './sessions.ts';
import type { ErrorClass } from './worker-health.ts';

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
 * The acting command at each stop, built in one place so the refusal copy,
 * the stop model, and the human renderer can never drift apart — these exact
 * strings are also what the concierge skill's reference documents.
 */
const continueCommand = {
  approve: (runId: string) => `duet continue ${runId} --approve`,
  reject: (runId: string) => `duet continue ${runId} --reject "<feedback>"`,
  answer: (runId: string) => `duet continue ${runId} --answer "<your answer>"`,
  resume: (runId: string) => `duet continue ${runId}`,
};

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
        `${continueCommand.approve(runId)}, or ${continueCommand.reject(runId)} (your feedback reaches the orchestrator verbatim).`
      );
    }
    case 'flag':
      return (
        `the run is paused on a queued question — the answer is the steering channel here: ` +
        `${continueCommand.answer(runId)}.`
      );
    case 'interactive':
      // The behaviour is correct — there is no headless driver to deliver a
      // staged steer to — but the channel is the interactive orchestrator session (chat), not duet steer.
      return (
        `run ${runId} is orchestrated in your interactive orchestrator session — steer it there in chat, ` +
        `as your editor-in-chief voice (the conversation is the channel, no relay). ` +
        `duet steer is for the headless phases.`
      );
    case 'abandoned':
      return `run ${runId} was abandoned — there is no live phase to steer. Revive it with ${continueCommand.resume(runId)}, or start fresh with duet new.`;
    case 'done':
      return `run ${runId} is complete — there is no phase to steer. A new run starts with duet new.`;
  }
}

/** The discriminated stop — what the run is waiting on, and the command that acts there. */
export type StopModel =
  | { kind: 'running'; pid: number; phase: PhaseName }
  | { kind: 'interactive'; phase: PhaseName }
  | {
      kind: 'gate';
      phase: GatePhase;
      gate: string;
      heading: string;
      hint?: string;
      packet?: { summary: string; artifacts: string[]; humanDecisions?: HumanDecision[] };
      commands: { approve: string; reject: string };
    }
  | { kind: 'flag'; question: string; context?: string; command: string; cause?: 'human' | 'infra'; errorClass?: ErrorClass }
  | { kind: 'crashed'; phase: PhaseName; command: string }
  | { kind: 'abandoned'; at: string; revive: string; purge: string }
  | { kind: 'done'; summary?: string };

export interface StatusModel {
  runId: string;
  createdAt: string;
  branch?: string;
  specPath?: string;
  /** The last quiescent stop's machine state — a display hint, not resume truth. */
  machineState?: string;
  stop: StopModel;
  /**
   * The cheap exact session map (#1): each known voice's `{ role, provider,
   * sessionId }`, a state-only read (no transcript scan, even under --wait).
   * Always present ([] when no session yet); the resolved path + verdicts are
   * `duet doctor`'s job, off this hot path. Known sessions only.
   */
  sessions: SessionRef[];
  gatesAt?: GatePhase[];
  autoApprovals: Array<{ gate: string; at: string; headline: string }>;
  rounds: Array<{ phase: PhaseName; used: number; cap: number }>;
  costs: RunState['costs'];
  /** Context-window fill per voice, captured at turn boundaries (a hint; stale after manual takeover). */
  context: Array<{ role: Voice; usedTokens: number; windowTokens: number; percent: number; at: string }>;
  /** Staged steers not yet delivered to the orchestrator. */
  pendingSteers: Array<{ stagedAt: string; stagedDuring?: PhaseName; text: string }>;
  /**
   * Interactive-host worker turns in flight or settled-uncollected (the async
   * send_prompt lifecycle). Present only when `state.pendingTurns` has entries;
   * a `ready`/`failed` turn signals "collect with check_turns" and is what
   * `duet status --wait` (slice 5) wakes on. Additive (schema-additive-only).
   */
  pendingTurns?: Array<{ role: WorkerRole; tag: string; status: 'running' | 'ready' | 'failed'; startedAt: string }>;
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
    sessions: resolveSessions(state),
    ...(state.gatesAt ? { gatesAt: state.gatesAt } : {}),
    autoApprovals: (state.autoApprovals ?? []).map((a) => ({ ...a, headline: packetHeadline(state, a.gate) })),
    rounds: PHASES.filter((p) => p.name !== 'open' && ((state.rounds[p.name] ?? 0) > 0 || p.reviewLoop)).map(
      (p) => ({ phase: p.name, used: state.rounds[p.name] ?? 0, cap: p.roundCap }),
    ),
    costs: state.costs,
    context: (['orchestrator', 'implementer', 'reviewer'] as const).flatMap((role) => {
      const usage = state.contextUsage?.[role];
      return usage ? [{ role, ...usage, percent: contextPercent(usage) }] : [];
    }),
    pendingSteers: pendingSteers.map(({ stagedAt, stagedDuring, text }) => ({
      stagedAt,
      ...(stagedDuring ? { stagedDuring } : {}),
      text,
    })),
    ...(state.pendingTurns && Object.keys(state.pendingTurns).length > 0
      ? {
          pendingTurns: (['implementer', 'reviewer'] as const).flatMap((role) => {
            const t = state.pendingTurns?.[role];
            return t ? [{ role, tag: t.tag, status: t.status, startedAt: t.startedAt }] : [];
          }),
        }
      : {}),
    snippetProposals: state.snippetProposals.map(({ snippetKey, rationale, at }) => ({ snippetKey, rationale, at })),
    ...(state.lastActivity ? { lastActivity: state.lastActivity } : {}),
  };
}

function stopModel(state: RunState, position: RunPosition): StopModel {
  switch (position.kind) {
    case 'running':
    case 'interactive':
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
          approve: continueCommand.approve(state.runId),
          reject: continueCommand.reject(state.runId),
        },
      };
    }
    case 'flag':
      return {
        kind: 'flag',
        question: state.pendingQuestion?.question ?? '(question missing — check the orchestrator log)',
        ...(state.pendingQuestion?.context ? { context: state.pendingQuestion.context } : {}),
        command: continueCommand.answer(state.runId),
        ...(state.pendingQuestion?.cause ? { cause: state.pendingQuestion.cause } : {}),
        ...(state.pendingQuestion?.errorClass ? { errorClass: state.pendingQuestion.errorClass } : {}),
      };
    case 'crashed':
      return { kind: 'crashed', phase: position.phase, command: continueCommand.resume(state.runId) };
    case 'abandoned':
      return {
        kind: 'abandoned',
        at: state.abandoned?.at ?? '',
        revive: continueCommand.resume(state.runId),
        purge: `duet abandon ${state.runId} --purge`,
      };
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

/** ISO timestamp → the short human form the status lists use. */
function fmtStamp(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
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
  // The claude-workers figure is the KNOWN cost; when a claude turn reported no
  // cost (the interactive transport, by P5) the total is partial, so say so
  // rather than imply completeness — P5 is "cost shown unavailable, never faked".
  const claudeWorkers = model.costs.claudeWorkersCostPartial
    ? `claude workers $${model.costs.claudeWorkersUsd.toFixed(2)} known (+ interactive turns: cost unavailable)`
    : `claude workers $${model.costs.claudeWorkersUsd.toFixed(2)}`;
  // The orchestrator total is partial when the interactive host drove it (flat
  // subscription quota, no per-turn cost) — say so rather than imply completeness.
  const orchestrator = model.costs.orchestratorCostPartial
    ? `orchestrator $${model.costs.orchestratorUsd.toFixed(2)} known (interactive turns on the subscription quota: cost unavailable)`
    : `orchestrator $${model.costs.orchestratorUsd.toFixed(2)}`;
  lines.push(
    `cost:     ${orchestrator}, ${claudeWorkers}, codex ${fmtTokens(model.costs.codexTokens.input)} in / ${fmtTokens(model.costs.codexTokens.output)} out tokens`,
  );
  if (model.context.length > 0) {
    lines.push(
      `context:  ${model.context.map((c) => `${c.role} ${c.percent}% (${fmtTokens(c.usedTokens)}/${fmtTokens(c.windowTokens)})`).join(' · ')}`,
    );
  }
  if (model.snippetProposals.length > 0) {
    lines.push(`proposals: ${model.snippetProposals.length} snippet edit(s) queued (details in state.json)`);
  }

  if (model.pendingSteers.length > 0) {
    lines.push(`\nstaged steers awaiting delivery:`);
    for (const s of model.pendingSteers) {
      lines.push(`  • ${fmtStamp(s.stagedAt)}  ${s.text}`);
    }
  }

  if (model.pendingTurns && model.pendingTurns.length > 0) {
    lines.push(`\nworker turns dispatched (interactive host):`);
    for (const t of model.pendingTurns) {
      const note =
        t.status === 'running'
          ? 'running in the background'
          : t.status === 'ready'
            ? 'ready — collect with check_turns'
            : 'failed — collect with check_turns to see the error';
      lines.push(`  • ${t.role} (${t.tag}): ${note}`);
    }
  }

  if (model.autoApprovals.length > 0) {
    lines.push(`\nwhile you were away — gates auto-approved (pre-authorized):`);
    for (const a of model.autoApprovals) {
      lines.push(`  ✓ ${a.gate}  ${fmtStamp(a.at)}  ${a.headline}`);
    }
    lines.push(`  full packets: duet logs ${model.runId}`);
  }

  const stop = model.stop;
  if (stop.kind === 'interactive') {
    lines.push(`\nthe interactive orchestrator is driving the ${stop.phase} phase — steer it in your interactive orchestrator session.`);
    return lines.join('\n');
  }

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
    lines.push(`  ${stop.commands.approve}   (add "<rider>" to approve with adjustments)`);
    lines.push(`  ${stop.commands.reject}`);
    lines.push(`  (a bare flag opens your editor — feedback and riders compose better there)`);
    if (stop.hint) lines.push(`\n${stop.hint}`);
    return lines.join('\n');
  }

  if (stop.kind === 'crashed') {
    lines.push(`\nthe ${stop.phase} phase stopped mid-flight — no driver is running.`);
    lines.push(`resume with:  ${stop.command}   (the run re-enters from the transcripts)`);
    return lines.join('\n');
  }

  if (stop.kind === 'abandoned') {
    lines.push(`\nthis run was abandoned${stop.at ? ` ${fmtStamp(stop.at)}` : ''} — no driver is running.`);
    lines.push(`the session transcripts are intact, so it's revivable:`);
    lines.push(`  revive with:  ${stop.revive}   (re-enters from where it last stopped)`);
    lines.push(`  wipe with:    ${stop.purge}   (deletes the run dir and the session transcripts)`);
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
    lines.push(`nothing is running — merge the PR on GitHub. To remove this run's local artifacts and session transcripts: duet abandon ${model.runId} --purge`);
  }
  return lines.join('\n');
}

/**
 * The lean status digest (#5/#8) — a DERIVED projection of the full StatusModel
 * carrying only the fields that drive the next action, plus a computed one-line
 * `headline` the full model doesn't expose as a top-level field. `--brief`
 * selects this projection; it composes orthogonally with `--json` (renderer) and
 * `--wait` (timing). Every field but `headline` is taken straight from the full
 * model — nothing is invented, only narrowed.
 */
export interface BriefModel {
  runId: string;
  machineState?: string;
  stopKind: StopModel['kind'];
  headline: string;
  nextCommand?: string;
  pendingSteers: number;
  autoApprovals: Array<{ gate: string; at: string; headline: string }>;
  humanDecisions?: HumanDecision[];
  /**
   * Interactive-host worker turns in flight or settled-uncollected — narrowed
   * from the full model's `pendingTurns` (startAt dropped; brief renders no
   * timestamps). Present only when there are entries, so the lean supervision
   * path (`--brief`, what the concierge reads remotely) still surfaces the one
   * thing async turns add: a `ready`/`failed` turn to collect with check_turns.
   * Additive (schema-additive-only).
   */
  pendingTurns?: Array<{ role: WorkerRole; tag: string; status: 'running' | 'ready' | 'failed' }>;
}

function briefHeadline(stop: StopModel): string {
  switch (stop.kind) {
    case 'gate':
      return (stop.packet ? (stop.packet.summary.split('\n').find((l) => l.trim()) ?? stop.heading) : stop.heading).slice(0, 96);
    case 'flag':
      return stop.question.slice(0, 96);
    case 'running':
      return `phase ${stop.phase} running`;
    case 'interactive':
      return `interactive orchestrator driving ${stop.phase}`;
    case 'crashed':
      return `phase ${stop.phase} crashed mid-flight`;
    case 'abandoned':
      return 'run abandoned';
    case 'done':
      return 'run complete — the PR is open';
  }
}

function briefNextCommand(stop: StopModel): string | undefined {
  switch (stop.kind) {
    case 'gate':
      return stop.commands.approve;
    case 'flag':
    case 'crashed':
      return stop.command;
    case 'abandoned':
      return stop.revive;
    default:
      return undefined; // running / interactive / done — nothing to type
  }
}

export function buildBrief(model: StatusModel): BriefModel {
  const stop = model.stop;
  const nextCommand = briefNextCommand(stop);
  return {
    runId: model.runId,
    ...(model.machineState ? { machineState: model.machineState } : {}),
    stopKind: stop.kind,
    headline: briefHeadline(stop),
    ...(nextCommand ? { nextCommand } : {}),
    pendingSteers: model.pendingSteers.length,
    autoApprovals: model.autoApprovals,
    ...(stop.kind === 'gate' && stop.packet?.humanDecisions ? { humanDecisions: stop.packet.humanDecisions } : {}),
    ...(model.pendingTurns && model.pendingTurns.length > 0
      ? { pendingTurns: model.pendingTurns.map(({ role, tag, status }) => ({ role, tag, status })) }
      : {}),
  };
}

/** The lean human render of the digest — a few lines, not the full packet. */
export function renderBrief(brief: BriefModel): string {
  const lines: string[] = [];
  lines.push(`duet ${brief.runId} — ${brief.machineState ?? '(not started)'} [${brief.stopKind}]`);
  lines.push(brief.headline);
  if (brief.humanDecisions && brief.humanDecisions.length > 0) {
    const anyHigh = brief.humanDecisions.some((d) => d.severity === 'high');
    const list = brief.humanDecisions.map((d) => `${d.severity === 'high' ? '●' : '○'} ${d.title}`).join(' · ');
    lines.push(`decisions: ${list}${anyHigh ? '  (hold — a high decision is the human’s to make)' : ''}`);
  }
  if (brief.pendingSteers > 0) lines.push(`pending steers: ${brief.pendingSteers}`);
  if (brief.pendingTurns && brief.pendingTurns.length > 0) {
    lines.push(`pending turns: ${brief.pendingTurns.map((t) => `${t.role} ${t.status}`).join(' · ')}`);
  }
  if (brief.autoApprovals.length > 0) lines.push(`auto-approved: ${brief.autoApprovals.map((a) => a.gate).join(', ')}`);
  if (brief.nextCommand) lines.push(`next: ${brief.nextCommand}`);
  return lines.join('\n');
}

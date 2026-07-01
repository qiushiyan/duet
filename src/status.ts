import type { RunPosition } from './harness/lifecycle.ts';
import { WORKFLOWS, gateOf, phaseOfGateState, phasesOf } from './phases.ts';
import type { GatePhase, PhaseName, WorkflowName } from './phases.ts';
import type { WorkerRole } from './providers/types.ts';
import { voicesFor, workerRolesFor } from './roles.ts';
import { contextPercent, fmtTokens, workflowOf } from './run-store.ts';
import type { HumanDecision, RunState, Voice } from './run-store.ts';
import type { Steer } from './steer-store.ts';
import { resolveSessions } from './sessions.ts';
import type { SessionRef } from './sessions.ts';
import { localStamp } from './timefmt.ts';
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

/** Whether a workflow's arc ends by opening a PR — true when a phase carries the Open-PR gate (both arcs do: full's `finish`, rir's `publish`). */
function opensPr(workflow: WorkflowName): boolean {
  return phasesOf(workflow).some((p) => p.gate?.state === 'openPrGate');
}

/** The run-complete line, workflow-aware — only a PR-opening arc claims a PR. */
function completionLine(workflow: WorkflowName): string {
  return opensPr(workflow) ? 'run complete — the PR is open' : 'run complete';
}

/** Whether a workflow has a spec phase (so a missing spec is worth reporting). */
function hasSpecPhase(workflow: WorkflowName): boolean {
  return phasesOf(workflow).some((p) => p.name === 'spec');
}

/** One line describing why the run stopped — the notification body. */
export function describeStop(state: RunState, done: boolean): string {
  if (done) return completionLine(workflowOf(state));
  const machineState = state.machineState ?? '';
  if (state.pendingQuestion && machineState.includes('FlagWait')) {
    return `question queued: ${state.pendingQuestion.question}`;
  }
  const gatePhase = phaseOfGateState(workflowOf(state), machineState);
  if (gatePhase) return gateOf(workflowOf(state), gatePhase).ready;
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
export function steerRefusal(workflow: WorkflowName, position: RunPosition, runId: string): string | undefined {
  switch (position.kind) {
    case 'running':
    case 'crashed':
      return undefined;
    case 'gate': {
      const gate = gateOf(workflow, position.phase);
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
  | { kind: 'flag'; question: string; context?: string; command: string; cause?: 'human' | 'infra' | 'budget'; errorClass?: ErrorClass }
  | { kind: 'crashed'; phase: PhaseName; command: string }
  | { kind: 'abandoned'; at: string; revive: string; purge: string }
  | { kind: 'done'; summary?: string };

export interface StatusModel {
  runId: string;
  createdAt: string;
  /** The run's workflow arc (additive; absent state resolves to 'full'). */
  workflow: WorkflowName;
  /** The workflow's human-facing name, e.g. "Research → Implement → Review". */
  workflowDisplayName: string;
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
  /** Infra failures auto-retried while away (#4b) — a sibling of autoApprovals, not gate-shaped. */
  awayRetries: Array<{ phase: PhaseName; errorClass: ErrorClass; attempt: number; at: string }>;
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
  const workflow = workflowOf(state);
  return {
    runId: state.runId,
    createdAt: state.createdAt,
    workflow,
    workflowDisplayName: WORKFLOWS[workflow].displayName,
    ...(state.branch ? { branch: state.branch } : {}),
    ...(state.specPath ? { specPath: state.specPath } : {}),
    ...(state.machineState ? { machineState: state.machineState } : {}),
    stop: stopModel(state, position),
    sessions: resolveSessions(state),
    ...(state.gatesAt ? { gatesAt: state.gatesAt } : {}),
    autoApprovals: (state.autoApprovals ?? []).map((a) => ({ ...a, headline: packetHeadline(state, a.gate) })),
    awayRetries: state.autoRetries ?? [],
    rounds: phasesOf(workflow)
      .filter((p) => (state.rounds[p.name] ?? 0) > 0 || p.reviewLoop)
      .map((p) => ({ phase: p.name, used: state.rounds[p.name] ?? 0, cap: p.roundCap })),
    costs: state.costs,
    context: voicesFor(state).flatMap((role) => {
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
          pendingTurns: workerRolesFor(state).flatMap((role) => {
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
      const gate = gateOf(workflowOf(state), position.phase);
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
    case 'done': {
      // The run's last phase carries the completion summary — Full's `finish`,
      // RIR's `implement` — not a hardcoded phase.
      const lastPhase = phasesOf(workflowOf(state)).at(-1)?.name;
      const summary = lastPhase ? state.phaseSummaries[lastPhase]?.summary : undefined;
      return { kind: 'done', ...(summary ? { summary } : {}) };
    }
  }
}

function packetHeadline(state: RunState, gateState: string): string {
  const phase = phaseOfGateState(workflowOf(state), gateState);
  if (!phase) return '';
  return (state.phaseSummaries[phase]?.summary.split('\n').find((l) => l.trim()) ?? '').slice(0, 96);
}

/** ISO timestamp → the short human form the status lists use — localized to the
 *  human's zone (the stored fields + `status --json` keep raw UTC ISO). */
function fmtStamp(iso: string): string {
  return localStamp(iso);
}

/**
 * The human-facing status block: run header, the stop (gate packet, queued
 * question, crash notice, or completion), the while-you-were-away section,
 * staged steers, and the next command.
 */
/**
 * The display label for a run's state (F5). Prefer the quiescent `machineState`
 * mirror when present (the headless stop labels), else derive an honest label
 * from the probed stop — so an interactive run whose crossInteractive never set
 * machineState shows its live phase/gate, not the misleading `(not started)`.
 * `(not started)` is reserved for the genuine no-state case. Every stop kind is
 * mapped explicitly — there is no `unstarted` RunPosition kind to lean on.
 */
export function displayState(stop: StopModel, machineState?: string): string {
  if (machineState) return machineState;
  switch (stop.kind) {
    case 'running':
    case 'interactive':
    case 'crashed':
      return stop.phase;
    case 'gate':
      return stop.gate;
    case 'flag':
      return 'flag';
    case 'done':
      return 'done';
    case 'abandoned':
      return 'abandoned';
  }
}

/**
 * The gate-posture sentence ("attending X — … pre-authorized"), the single
 * source for the three surfaces that build it — `duet status`, `duet new`,
 * `duet afk`. They share the attending-vs-none SHAPE but not the copy: the
 * label/padding, the attended suffix (afk threads its explicit pre-authorized
 * list; the others say "other gates"), and the trailing parenthetical differ
 * per surface. The shape lives here; each caller supplies its own copy, so the
 * helper never merges a byte away.
 */
export function formatGatePosture(
  attended: readonly string[],
  copy: { label: string; attendedSuffix: string; noneSuffix: string },
): string {
  return attended.length > 0
    ? `${copy.label}attending ${attended.join(', ')} — ${copy.attendedSuffix}`
    : `${copy.label}attending none — ${copy.noneSuffix}`;
}

/** A compact per-class tally of auto-retries — e.g. `network ×2, server ×1` (first-seen order). */
function summarizeRetriesByClass(retries: ReadonlyArray<{ errorClass: ErrorClass }>): string {
  const counts = new Map<ErrorClass, number>();
  for (const r of retries) counts.set(r.errorClass, (counts.get(r.errorClass) ?? 0) + 1);
  return [...counts].map(([cls, n]) => `${cls} ×${n}`).join(', ');
}

export function renderStatus(model: StatusModel): string {
  const lines: string[] = [];
  lines.push(`\n━━━ duet run ${model.runId} ━━━`);
  lines.push(`workflow: ${model.workflowDisplayName}`);
  lines.push(`state:    ${displayState(model.stop, model.machineState)}`);
  if (model.stop.kind === 'running') {
    lines.push(`phase:    running in the background (pid ${model.stop.pid})`);
  }
  // Only a workflow with a spec phase reports a (missing) spec — RIR has none.
  if (model.specPath) lines.push(`spec:     ${model.specPath}`);
  else if (hasSpecPhase(model.workflow)) lines.push(`spec:     (not yet drafted — framing-only entry)`);
  if (model.branch) lines.push(`branch:   ${model.branch}`);
  // gatesAt: [] is the afk "attend none" signal (kept in the JSON model) — it
  // renders as explicit copy rather than an empty `attending  — …` join.
  if (model.gatesAt) {
    lines.push(
      formatGatePosture(model.gatesAt, {
        label: 'gates:    ',
        attendedSuffix: 'other gates pre-authorized',
        noneSuffix: 'all gates pre-authorized',
      }),
    );
  }
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

  if (model.awayRetries.length > 0) {
    lines.push(`\nwhile you were away — infra auto-retries: ${model.awayRetries.length} (${summarizeRetriesByClass(model.awayRetries)}):`);
    for (const r of model.awayRetries) {
      lines.push(`  ↻ ${r.phase} ${r.errorClass} (attempt ${r.attempt})  ${fmtStamp(r.at)}`);
    }
  }

  // The per-stop tail — an exhaustive switch (matching the sibling renderers
  // displayState/briefHeadline/briefNextCommand/steerRefusal), so a future
  // stop.kind is a compile error here instead of a silent blank render.
  // `running` emits no tail (its pid line rode the header); every other case
  // pushes its lines, and the single `return` below joins them.
  const stop = model.stop;
  switch (stop.kind) {
    case 'running':
      break;
    case 'interactive':
      lines.push(`\nthe interactive orchestrator is driving the ${stop.phase} phase — steer it in your interactive orchestrator session.`);
      break;
    case 'flag':
      lines.push(`\nQUEUED QUESTION for you:`);
      lines.push(`  ${stop.question}`);
      if (stop.context) lines.push(`  context: ${stop.context}`);
      // A budget stop is resumable, not an infra failure — name that so the human
      // reaches for "raise the budget / resume" rather than triaging an outage.
      if (stop.cause === 'budget') lines.push(`  (budget-control stop — resumable: raise the budget or resume, not an infra failure)`);
      lines.push(`\nanswer with:  ${stop.command}`);
      break;
    case 'gate': {
      lines.push(`\n━━━ ${stop.heading} ━━━`);
      if (stop.packet) {
        lines.push(stop.packet.summary);
        if (stop.packet.artifacts.length > 0) lines.push(`\nartifacts: ${stop.packet.artifacts.join(', ')}`);
      }
      // The structured human decisions, rendered in the PRIMARY view (not only
      // --brief): a hold the human can't see explained is half a feature. When a
      // `high` is present the gate holds for it — and when the gate was
      // pre-authorized, the high is precisely why the run stopped here.
      const decisions = stop.packet?.humanDecisions ?? [];
      if (decisions.length > 0) {
        lines.push(`\ndecisions for you:`);
        for (const d of decisions) lines.push(`  ${d.severity === 'high' ? '●' : '○'} ${d.title}`);
        if (decisions.some((d) => d.severity === 'high')) {
          const preAuthorized = model.gatesAt !== undefined && !model.gatesAt.includes(stop.phase);
          lines.push(
            preAuthorized
              ? `  (this gate was pre-authorized, but a high decision held it for you — approve explicitly to cross, or reject)`
              : `  (a high decision is yours to make; this gate holds for it — an explicit approve still crosses)`,
          );
        }
      }
      lines.push(`\ndecide with:`);
      lines.push(`  ${stop.commands.approve}   (add "<rider>" to approve with adjustments)`);
      lines.push(`  ${stop.commands.reject}`);
      lines.push(`  (a bare flag opens your editor — feedback and riders compose better there)`);
      if (stop.hint) lines.push(`\n${stop.hint}`);
      break;
    }
    case 'crashed':
      lines.push(`\nthe ${stop.phase} phase stopped mid-flight — no driver is running.`);
      lines.push(`resume with:  ${stop.command}   (the run re-enters from the transcripts)`);
      break;
    case 'abandoned':
      lines.push(`\nthis run was abandoned${stop.at ? ` ${fmtStamp(stop.at)}` : ''} — no driver is running.`);
      lines.push(`the session transcripts are intact, so it's revivable:`);
      lines.push(`  revive with:  ${stop.revive}   (re-enters from where it last stopped)`);
      lines.push(`  wipe with:    ${stop.purge}   (deletes the run dir and the session transcripts)`);
      break;
    case 'done':
      lines.push(`\n${completionLine(model.workflow)}.`);
      if (stop.summary) lines.push(stop.summary);
      if (model.snippetProposals.length > 0) {
        lines.push(`\n━━━ queued snippet proposals (your end-of-run editorial review) ━━━`);
        for (const p of model.snippetProposals) {
          lines.push(`\n• ${p.snippetKey} — ${p.rationale}`);
        }
        lines.push(`\nfull bodies in .duet/runs/${model.runId}/state.json; apply the ones you accept to snippets.toml.`);
      }
      lines.push(`\ntranscripts: .duet/runs/${model.runId}/*.log (and the providers' standard session locations)`);
      lines.push(`nothing is running${opensPr(model.workflow) ? ' — merge the PR on GitHub' : ''}. To remove this run's local artifacts and session transcripts: duet abandon ${model.runId} --purge`);
      break;
    default: {
      const _exhaustive: never = stop;
      void _exhaustive;
    }
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
  /** The honest display label (F5): machineState when present, else derived from the stop. */
  displayState: string;
  stopKind: StopModel['kind'];
  headline: string;
  nextCommand?: string;
  pendingSteers: number;
  autoApprovals: Array<{ gate: string; at: string; headline: string }>;
  /** Infra auto-retries while away (#4b) — surfaced as a per-class tally in the brief. */
  awayRetries: Array<{ phase: PhaseName; errorClass: ErrorClass; attempt: number; at: string }>;
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

function briefHeadline(stop: StopModel, workflow: WorkflowName): string {
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
      return completionLine(workflow);
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
    displayState: displayState(stop, model.machineState),
    stopKind: stop.kind,
    headline: briefHeadline(stop, model.workflow),
    ...(nextCommand ? { nextCommand } : {}),
    pendingSteers: model.pendingSteers.length,
    autoApprovals: model.autoApprovals,
    awayRetries: model.awayRetries,
    ...(stop.kind === 'gate' && stop.packet?.humanDecisions ? { humanDecisions: stop.packet.humanDecisions } : {}),
    ...(model.pendingTurns && model.pendingTurns.length > 0
      ? { pendingTurns: model.pendingTurns.map(({ role, tag, status }) => ({ role, tag, status })) }
      : {}),
  };
}

/** The lean human render of the digest — a few lines, not the full packet. */
export function renderBrief(brief: BriefModel): string {
  const lines: string[] = [];
  lines.push(`duet ${brief.runId} — ${brief.displayState} [${brief.stopKind}]`);
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
  if (brief.awayRetries.length > 0) lines.push(`auto-retried: ${summarizeRetriesByClass(brief.awayRetries)}`);
  if (brief.nextCommand) lines.push(`next: ${brief.nextCommand}`);
  return lines.join('\n');
}

import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { execa } from 'execa';
import { z } from 'zod';
import { PHASE, isGatePhase } from '../phases.ts';
import type { PhaseName } from '../phases.ts';
import { BudgetCutoffError } from '../providers/types.ts';
import type { WorkerProvider, WorkerRole, WorkerTurn } from '../providers/types.ts';
import { getSnippet, renderSnippetLibrary } from '../snippets.ts';
import {
  appendNote,
  appendVoiceLog,
  clearTurnActive,
  consumeHumanInput,
  contextPercent,
  fmtTokens,
  gateAttended,
  listPendingSteers,
  loadRunState,
  markSteersDelivered,
  markTurnActive,
  recordContextUsage,
  saveRunState,
  workflowOf,
} from '../run-store.ts';
import type { HumanMessage, RunState } from '../run-store.ts';
import { readRoleTranscriptTail } from '../sessions.ts';
import type { TurnDispatcher } from './turn-dispatcher.ts';
import { formatAge, probeRole } from '../worker-health.ts';
import { activityLine, latestActivity } from '../worker-activity.ts';
import {
  answerResumePrompt,
  approvalRiderBlock,
  buildPhaseBrief,
  feedbackResumePrompt,
  renderSteerBlock,
} from './orchestrator-prompts.ts';

/**
 * A host-neutral tool definition — the single source of truth for the
 * orchestrator's surface, independent of any one SDK. It carries exactly what
 * both transports need (name, description, a zod input shape, MCP annotations,
 * and an async handler returning an MCP CallToolResult). Two thin adapters host
 * it: the in-process Agent SDK server (src/harness/driver.ts) and the standard
 * stdio MCP server (src/harness/mcp-server.ts). Keeping the Agent SDK's tool
 * type out of here is the point — nothing that hosts the kernel should have to
 * import it.
 */
export interface KernelTool<Schema extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  inputSchema: Schema;
  annotations?: ToolAnnotations;
  handler: (args: z.infer<z.ZodObject<Schema>>, extra: unknown) => Promise<CallToolResult>;
}

/**
 * Package a kernel tool — the same call shape the Agent SDK's `tool()` helper
 * used, so the handler bodies below are unchanged; only the type they land in
 * differs (KernelTool, not SdkMcpToolDefinition).
 */
function kernelTool<Schema extends z.ZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (args: z.infer<z.ZodObject<Schema>>, extra: unknown) => Promise<CallToolResult>,
  extras?: { annotations?: ToolAnnotations },
): KernelTool<Schema> {
  return {
    name,
    description,
    inputSchema,
    handler,
    ...(extras?.annotations ? { annotations: extras.annotations } : {}),
  };
}

/**
 * The orchestrator's tool surface — the harness tools and every
 * protocol rail they enforce: once-per-phase template economy
 * (warn-once-then-allow), review-round backstop caps, the
 * branch-fixed-after-first-prompt rule, advance-needs-a-review-round, and
 * the cooperative ask_human pause (repros: src/spike/). This module IS the orchestrator's
 * interface to the run; the driver only hosts it inside an SDK session.
 *
 * Handlers persist state at the moment of the call (the human-visible
 * artifact exists before the model regains control) and their result text
 * tells the orchestrator what happens next — both binding conventions from
 * docs/prompting-and-tool-design.md.
 */

export interface PhaseToolsDeps {
  /** The driver invocation's single live RunState copy — handlers mutate and persist it. */
  state: RunState;
  phase: PhaseName;
  providers: Record<WorkerRole, WorkerProvider>;
  /** Narration sink (driver stdout → driver.log; view-time color). */
  log: (line: string) => void;
  /** A staged human answer, delivered to the first ask_human call instead of pausing. */
  stagedAnswer?: string;
  /**
   * The per-phase in-memory rails — the same-role in-flight guard and the
   * warn-once resend set — injected by a host that rebuilds the tool surface per
   * call against fresh disk state but must keep these alive across calls within
   * a phase (the run-scoped interactive server, mcp-server.ts). Omitted by the
   * headless driver and the explicit-phase server, which build one registry per
   * phase invocation and so own a fresh pair.
   */
  rails?: { turnsInFlight: Set<WorkerRole>; resendWarned: Set<string> };
  /**
   * Home dir for the heartbeat's transcript tail read (the environment seam,
   * like `sessions.ts`/`purgeRun`). Omitted in production → `homedir()`; tests
   * point it at a planted fake home.
   */
  home?: string;
  /**
   * Present only on the interactive host (the run-scoped server, mcp-server.ts):
   * the TurnDispatcher that makes send_prompt async (dispatch-now / collect with
   * check_turns). Its presence is the host switch — it flips send_prompt from
   * blocking to dispatching AND exposes check_turns. Absent → the headless host,
   * which blocks and never exposes check_turns.
   */
  async?: { dispatcher: TurnDispatcher };
}

export interface PhaseTools {
  // Each tool has its own schema, so the list is heterogeneous by nature.
  tools: Array<KernelTool<any>>;
}

/**
 * The best-effort health suffix for a heartbeat line: ` · last activity <age>
 * ago · <N> retries`, or ` · RETRYING (<N> retries)` when this turn has retried
 * (the COUNT, never a fabricated class — api_retry carries no usable status).
 * Reads the worker's own transcript tail and probes it scoped to THIS turn (the
 * turn start anchors both in-flight and retry attribution). Returns '' on the
 * first turn (no session id yet) or on ANY read/probe failure — telemetry never
 * throws into a worker turn.
 */
function heartbeatHealth(state: RunState, role: WorkerRole, startedAt: number, now: number, home?: string): string {
  try {
    if (!state.workerSessions[role]) return ''; // first turn — session id learned only on return
    const tail = readRoleTranscriptTail(state, role, home !== undefined ? { home } : {});
    if (!tail) return '';
    const h = probeRole(tail.jsonl, { schema: tail.schema, now, inFlightSince: startedAt, retriesSince: startedAt });
    const activity = h.lastActivityAgeMs !== undefined ? ` · last activity ${formatAge(h.lastActivityAgeMs)} ago` : '';
    const retries = h.retries > 0 ? ` · RETRYING (${h.retries} retries)` : ` · ${h.retries} retries`;
    return `${activity}${retries}`;
  } catch {
    return ''; // best-effort: degrade to elapsed-only
  }
}

/** A base template (warned once per phase per worker) vs. a delta (custom / -again). */
export function isBaseTemplate(tag: string): boolean {
  return tag !== 'custom' && !tag.endsWith('-again');
}

// ── send_prompt's three lifecycle steps, as module-level functions ──
// One blocking call on the headless host runs them in immediate succession
// (startHeartbeat → await runTurn → settleTurn → renderTurnResult); the
// interactive host's TurnDispatcher (turn-dispatcher.ts) calls the SAME three
// across dispatch / settle / collect. Module-level (not closures) precisely so
// the dispatcher can call them with fresh state at settle/collect time, long
// after the send_prompt call that dispatched the turn has returned. The rails
// and bookkeeping are therefore written exactly once, host-agnostic.

/** How often the activity poll samples the worker's transcript for its current
 *  action — finer than the 5-minute heartbeat so a long quiet turn shows
 *  progress, change-detected so it never floods (≤1 line per tick per role). */
const ACTIVITY_POLL_MS = 30_000;

/**
 * The voice-log keep-alive for a long, non-streaming worker turn — two cadences
 * off one timer pair, both best-effort:
 *   - every 5 min, a `⏳` heartbeat (elapsed + transcript recency/retries via
 *     heartbeatHealth) so the pane never looks hung;
 *   - every 30s, a `⋯` activity line naming the worker's current action (the
 *     file it is reading, that an edit happened), read from the same transcript
 *     tail and emitted only when it changed since the last tick — so a healthy
 *     worker grinding for 30 minutes reads differently from a stalled one.
 * Both cadences degrade to silence on the first turn (no session id yet) or any
 * read/parse failure — telemetry never throws into a worker turn. Returns one
 * stop fn that clears both intervals.
 */
export function startHeartbeat(
  deps: { state: RunState; log: (line: string) => void; home?: string },
  meta: { role: WorkerRole; tag: string; startedAt: number },
): () => void {
  const { state, log, home } = deps;
  const { role, tag, startedAt } = meta;
  const heartbeat = setInterval(() => {
    const mins = Math.round((Date.now() - startedAt) / 60_000);
    const health = heartbeatHealth(state, role, startedAt, Date.now(), home);
    log(`[send_prompt] ⏳ ${role} turn running — ${mins}m elapsed (tag=${tag})${health}`);
    appendVoiceLog(state, role, `⏳ turn running — ${mins}m elapsed (tag=${tag})${health}`);
  }, 5 * 60_000);
  let lastActivityId: string | undefined;
  const activity = setInterval(() => {
    try {
      if (!state.workerSessions[role]) return; // first turn — session id learned only on return
      const tail = readRoleTranscriptTail(state, role, home !== undefined ? { home } : {});
      if (!tail) return;
      const act = latestActivity(tail.jsonl, tail.schema);
      if (!act || act.id === lastActivityId) return; // nothing new since the last tick
      lastActivityId = act.id;
      const line = activityLine(act);
      log(`[send_prompt] ${line} (${role})`);
      appendVoiceLog(state, role, line);
    } catch {
      // best-effort: an unreadable/parse failure degrades to no line, never throws
    }
  }, ACTIVITY_POLL_MS);
  return () => {
    clearInterval(heartbeat);
    clearInterval(activity);
  };
}

/**
 * The worker-settled half: commit the turn's DURABLE bookkeeping (success) or
 * log the infra failure (no round, no sent tag), and clear the activeTurns hint
 * either way. Persists; builds no orchestrator-facing text (renderTurnResult's
 * job). The load → merge → save runs against FRESH disk state so a concurrent
 * cross-role settle never clobbers the sibling role's session / cost /
 * sent-snippets / rounds / context; `deps.state` is re-synced afterward so
 * same-phase reads (the warn-once / round rails) see this turn's result.
 */
export function settleTurn(
  deps: { state: RunState; phase: PhaseName; providers: Record<WorkerRole, WorkerProvider>; log: (line: string) => void },
  meta: { role: WorkerRole; tag: string; isReviewRound: boolean },
  outcome: WorkerTurn | Error,
): void {
  const { state, phase, providers, log } = deps;
  const { role, tag, isReviewRound } = meta;
  if (outcome instanceof Error) {
    // A budget cutoff with no recoverable session is a budget-control stop, not
    // an infra failure — the log/voice must say so (the work ran and may be on
    // disk), so the driver log reads honestly when no reviewer is watching. It
    // still commits no bookkeeping (no session/round/cost): "no settlement".
    if (outcome instanceof BudgetCutoffError) {
      log(`[send_prompt] ◼ ${role} turn stopped at its budget cap: ${outcome.message}`);
      appendVoiceLog(state, role, `◼ budget-control stop: ${outcome.message}`);
    } else {
      log(`[send_prompt] ✗ ${role} turn failed: ${outcome.message}`);
      appendVoiceLog(state, role, `✗ turn failed: ${outcome.message}`);
    }
    clearTurnActive(state, role);
    return;
  }
  const turn = outcome;
  const fresh = loadRunState(state.cwd, state.runId);
  fresh.workerSessions[role] = turn.sessionId;
  // Re-read off fresh rather than a call-start snapshot: the minutes-long await
  // means a parallel call may have moved the round count.
  if (isReviewRound) fresh.rounds[phase] = (fresh.rounds[phase] ?? 0) + 1;
  if (isBaseTemplate(tag)) {
    const sent = ((fresh.sentSnippets ??= {})[phase] ??= {});
    const tags = (sent[role] ??= []);
    if (!tags.includes(tag)) tags.push(tag);
  }
  // Accounting is provider-scoped: Claude bills in dollars, Codex in tokens. The
  // costUsd add is gated on the claude provider (not merely costUsd's presence),
  // so a malformed codex adapter that returned a stray costUsd can't be
  // misaccounted as Claude spend. An absent costUsd on a claude turn (the
  // interactive transport, by P5) makes the running total partial — mark it so
  // status/footer never present the known sum as the complete total.
  if (providers[role].name === 'claude') {
    if (turn.costUsd !== undefined) fresh.costs.claudeWorkersUsd += turn.costUsd;
    else fresh.costs.claudeWorkersCostPartial = true;
  } else if (providers[role].name === 'codex' && turn.tokens) {
    fresh.costs.codexTokens.input += turn.tokens.input;
    fresh.costs.codexTokens.output += turn.tokens.output;
  }
  if (turn.context) recordContextUsage(fresh, role, turn.context);
  fresh.lastActivity = `send_prompt → ${role} (${tag})`;
  saveRunState(fresh);
  Object.assign(state, fresh);
  const ctx = turn.context ? ` · context ${contextPercent(turn.context)}%` : '';
  appendVoiceLog(state, role, `▶ response (session ${turn.sessionId})${ctx}`, turn.text);
  log(`[send_prompt] ← ${role} responded (${turn.text.length} chars${ctx})`);
  clearTurnActive(state, role);
}

/**
 * The result-collected half: build the orchestrator-facing CallToolResult from
 * the settled outcome — the worker's text plus the near-cap nudge, or the
 * prescribed-recovery infra error. Reads `deps.state.rounds` for the nudge, so
 * it must run AFTER settleTurn (which lands this round's +1); persists nothing.
 */
export function renderTurnResult(
  deps: { state: RunState; phase: PhaseName },
  meta: { role: WorkerRole; isReviewRound: boolean; cap: number },
  outcome: WorkerTurn | Error,
): CallToolResult {
  const { state, phase } = deps;
  const { role, isReviewRound, cap } = meta;
  // A budget cutoff with no recoverable session — a budget-control recovery, NOT
  // the infra envelope and NOT the retry path: the worker ran (committed work may
  // be on disk), but nothing settled, so resume manually / raise the budget /
  // surface to the human. Checked before the generic Error arm (it is an Error).
  if (outcome instanceof BudgetCutoffError) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `The ${role} worker reached its budget cap — a budget-control stop, not an infrastructure failure. The worker ran and committed work may be on disk (check git), but no resumable session id was recovered. Do NOT retry this send_prompt as infra: resume the work manually once you have a session id, raise the budget, or surface it to the human via ask_human.`,
        },
      ],
      isError: true,
    };
  }
  if (outcome instanceof Error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `The ${role} worker's turn failed at the infrastructure layer (${outcome.message}). The worker never saw your prompt, so this is not a content problem. Retry this same send_prompt call once; if the retry also fails, stop routing and report the failure to the human via ask_human instead of continuing the round.`,
        },
      ],
      isError: true,
    };
  }
  const content: Array<{ type: 'text'; text: string }> = [{ type: 'text' as const, text: outcome.text }];
  // A budget-truncated turn DID settle (session/cost committed) — surface it as a
  // resumable checkpoint, never the infra "retry this same call" envelope.
  if (outcome.budgetTruncated) {
    content.push({
      type: 'text' as const,
      text: `(budget reached — the worker saw your prompt and committed work is on disk; its session is resumable. Resume that session for the remainder, or raise the budget. This is a checkpoint, not a failure — do not re-send the original prompt.)`,
    });
  }
  // Reactive state-triggered nudge (docs/prompting-and-tool-design.md
  // §"Results nudge the next step"): when this review round leaves exactly one
  // before the backstop cap, say so once — the cap is runaway protection, not a
  // target, so the reminder steers toward converging or flagging.
  if (isReviewRound && (state.rounds[phase] ?? 0) === cap - 1) {
    content.push({
      type: 'text' as const,
      text: `(${state.rounds[phase]} of ${cap} review rounds used — one remains before this phase’s backstop cap. The cap is runaway protection, not a target: if the loop has converged, advance_phase now; if a substantive disagreement is still open, that is the human’s call via ask_human. Spend the last round only on a genuinely open structural point.)`,
    });
  }
  // F5: a compact per-turn footer — this role's context fill, the cumulative
  // worker cost, and the round vs cap. Both hosts flow through here (blocking
  // send_prompt and check_turns via the dispatcher's collect), so one edit
  // covers both.
  const ctxUsage = state.contextUsage?.[role];
  const footer = [
    ...(ctxUsage ? [`context ${contextPercent(ctxUsage)}%`] : []),
    footerWorkerCost(state.costs),
    `round ${state.rounds[phase] ?? 0}/${cap}`,
  ].join(' · ');
  content.push({ type: 'text' as const, text: `[${footer}]` });
  return { content };
}

/**
 * The footer's cumulative worker-cost fragment — honest about BOTH providers,
 * mirroring `duet status` semantics: Claude bills in dollars (with a `+` when
 * the total is partial/unmetered — an interactive-transport turn reports no
 * cost), Codex bills in tokens. Each side shows only when it has activity, so a
 * Claude-only round reads `claude $1.25` and a Codex-only round reads
 * `codex 2k/400 tok` — never the old `workers $0.00`, which implied no cost while
 * Codex tokens accumulated. Falls back to `claude $0.00` only in the (post-settle
 * unreachable) no-activity case, so the slot is never empty.
 */
function footerWorkerCost(costs: RunState['costs']): string {
  const parts: string[] = [];
  if (costs.claudeWorkersUsd > 0 || costs.claudeWorkersCostPartial) {
    parts.push(`claude $${costs.claudeWorkersUsd.toFixed(2)}${costs.claudeWorkersCostPartial ? '+' : ''}`);
  }
  if (costs.codexTokens.input + costs.codexTokens.output > 0) {
    parts.push(`codex ${fmtTokens(costs.codexTokens.input)}/${fmtTokens(costs.codexTokens.output)} tok`);
  }
  return parts.length > 0 ? parts.join(' · ') : `claude $${costs.claudeWorkersUsd.toFixed(2)}`;
}

export function createPhaseTools({ state, phase, providers, log, stagedAnswer: initialAnswer, rails, home, async: asyncDeps }: PhaseToolsDeps): PhaseTools {
  let stagedAnswer = initialAnswer ?? null;

  // First-terminal-wins: advance_phase and ask_human each end the phase, so the
  // first to run this phase records the terminal marker; a second terminal call
  // afterward is refused (the phase is already ending) so exactly one phase.*
  // event is emitted at quiescence. Scoped to this phase: a stale marker from a
  // prior phase (a crash re-delivered it across the snapshot boundary) does not
  // block this phase's first terminal call — it is overwritten.
  const terminalAlreadySet = (): boolean => state.terminalMarker?.phase === phase;
  const alreadyEnding = (): { content: Array<{ type: 'text'; text: string }>; isError: true } => ({
    content: [
      {
        type: 'text' as const,
        text: 'This phase is already ending — you have already called advance_phase or ask_human this turn, and that decision is recorded. A second terminal call is ignored. End your turn with a one-line status; the run proceeds from the decision already made.',
      },
    ],
    isError: true,
  });

  // Roles with a worker turn currently in flight. Parallel send_prompt calls
  // to DIFFERENT roles are legal and wanted (the scheduler runs them
  // concurrently — see the readOnlyHint note on send_prompt); two concurrent
  // turns into the SAME role would race one session's resume, so that case is
  // refused here. In-memory is correct: concurrency exists only within one
  // driver process (the pid guard excludes a second).
  const turnsInFlight = rails?.turnsInFlight ?? new Set<WorkerRole>();

  // Once-per-phase template discipline (system prompt <protocol>): a base
  // template re-sent to the same worker in the same phase gets one steering
  // refusal; repeating the identical call passes — judgment can override,
  // the harness just makes the choice deliberate.
  const sentThisPhase = (role: WorkerRole): string[] => {
    const phases = (state.sentSnippets ??= {});
    const roles = (phases[phase] ??= {});
    return (roles[role] ??= []);
  };
  const resendWarned = rails?.resendWarned ?? new Set<string>();

  // get_task folds a staged human input (an approval rider, a reject's
  // feedback, or an answer) into the phase brief as an appended block — reusing
  // the same resume/rider prose the headless prompt path builds, so the
  // orchestrator reads the human's words identically in either host.
  const stagedInputBlock = (msg: HumanMessage): string => {
    switch (msg.kind) {
      case 'approval':
        return approvalRiderBlock(msg.text);
      case 'answer':
        return answerResumePrompt(msg.text);
      case 'feedback':
        return feedbackResumePrompt(phase, msg.text);
    }
  };
  // When this phase's terminal marker is set, get_task is the one surface the
  // post-terminal rail leaves open: it reports the park and re-anchors, with no
  // side effects.
  const parkedBrief = (kind: 'advance' | 'flag'): string =>
    kind === 'advance'
      ? 'This phase is parked at its gate — your advance_phase packet is recorded. Present it to the human and propose the crossing (duet continue --approve "<rider>", or --reject "<feedback>"); a gate is crossed by the human’s tap, never by a tool of yours. Do not start new work — the phase is ending. Re-anchor here any time with get_task.'
      : 'This phase is parked on a queued question — your ask_human flag is recorded. Present it to the human and wait for their answer (duet continue --answer "<answer>"). Do not start new work until it arrives. Re-anchor here any time with get_task.';

  // The interactive host's pending-turn lifecycle (async send_prompt) is owned
  // by the injected dispatcher; absent → the headless host, blocking. The
  // same-role guard, the phase-exit gate, and check_turns all branch on it.
  const dispatcher = asyncDeps?.dispatcher;
  const ROLES: WorkerRole[] = ['implementer', 'reviewer'];
  // A reconnect ORPHAN: a pending-turn record exists on disk for this role, but
  // the live dispatcher has no record for it — a prior server dispatched the
  // turn and died, and this (fresh) server does not own it. Detection is purely
  // the durable record's existence-without-a-live-owner; no transcript claim.
  // Branch-aware orphan recovery (slice 4): the two sub-cases have different
  // hazards, so the prescribed recovery differs. A SESSION orphan can be
  // resumed (and a re-send would race that session); a NO-SESSION orphan has no
  // session to resume, but the old worker process may still be running and
  // editing the repo — so dropping it is a deliberate ABANDON, stated honestly.
  // Either way `duet takeover <role>` is the single resolution affordance.
  const orphanRefusalText = (role: WorkerRole): string =>
    state.workerSessions[role]
      ? `The prior turn to the ${role} was orphaned when its session ended — its pending record is still on disk, and that session may still be resumable. Inspect or finish it with \`duet takeover ${role}\`, then re-send. Do not re-send into this role until the orphan is resolved: an immediate re-send would resume and race the orphaned worker on that same session.`
      : `The prior turn to the ${role} was orphaned before a session id was captured — there is no session to resume, and the old worker process may still be running and editing the repo. Dropping the orphan ABANDONS that in-flight turn: confirm it is done (or accept the risk), then run \`duet takeover ${role}\` to drop the orphan and re-send. Do not re-send until then.`;
  // The phase-exit gate (async only): advance_phase and ask_human are both
  // refused while ANY pending-turn record is non-collected — live (the
  // dispatcher owns it) OR on disk (a reconnect orphan the fresh dispatcher
  // doesn't). A turn dispatched-but-uncollected means the phase isn't done;
  // advancing would strand the turn and its bookkeeping, and the disk half also
  // keeps the per-phase ctx registry safe to rebuild at a boundary. Returns a
  // prescribed-recovery refusal, or null when nothing is outstanding.
  const pendingTurnGate = (verb: 'advance the phase' | 'queue a question'): CallToolResult | null => {
    if (!dispatcher) return null;
    const live = dispatcher.hasPending();
    const onDisk = state.pendingTurns !== undefined && Object.keys(state.pendingTurns).length > 0;
    if (!live && !onDisk) return null;
    return {
      content: [
        {
          type: 'text' as const,
          text: `A worker turn dispatched in this phase has not been collected yet, so you can't ${verb} — advancing or flagging now would strand the turn and its bookkeeping. Collect it with check_turns first (or, if it was orphaned when a prior session ended, recover it with duet takeover <role>), then ${verb === 'advance the phase' ? 'advance' : 'ask'} once nothing is outstanding.`,
        },
      ],
      isError: true,
    };
  };

  const tools: Array<KernelTool<any>> = [
    kernelTool(
      'get_task',
      'Read your task for the current phase — the orchestrator’s entry brief: the documents in scope, the branch policy, the attendance posture, and the worked examples, returned in full every time you call it. Call it at the start of each phase, and to re-anchor on disk truth whenever your context may be stale (your operating instructions name when). Not read-only: the first call in a phase marks the phase started, and a pending piece of human input — a gate-approval rider, a reject’s feedback, or an answer to a queued question — is folded into the brief as an appended block exactly once; a later call returns the brief alone, with nothing left to consume. When the phase is already parked at its gate or flag (you have called advance_phase or ask_human), this instead reports that you are parked and should present the packet and propose duet continue, and performs no side effect.',
      {},
      async () => {
        // Parked: a current-phase terminal marker means the orchestrator
        // already advanced/flagged. Report the park; touch nothing.
        const marker = state.terminalMarker;
        if (marker?.phase === phase) {
          return { content: [{ type: 'text' as const, text: parkedBrief(marker.kind) }] };
        }
        // Side effect 1 — mark the phase started once per phase (the first call
        // that finds it unset), exactly as the headless basePrompt does.
        if (!state.phaseStarted[phase]) {
          state.phaseStarted[phase] = true;
          saveRunState(state);
        }
        // Side effect 2 — consume any staged human input, once per message and
        // independent of phaseStarted, so a same-phase reject/answer (where the
        // phase is long since started) still folds. consumeHumanInput persists,
        // so a later call finds nothing and returns the base brief alone.
        const pending = consumeHumanInput(state);
        const brief = buildPhaseBrief(state, phase);
        if (!pending) return { content: [{ type: 'text' as const, text: brief }] };
        log(`[get_task] folded staged ${pending.kind} into the ${phase} brief`);
        return { content: [{ type: 'text' as const, text: `${brief}\n\n${stagedInputBlock(pending)}` }] };
      },
    ),

    kernelTool(
      'list_snippets',
      'Read the snippet library — the prompt templates the workflow uses, which encode its conventions (altitude lenses, round-2 discipline, compaction shapes); read them before composing worker prompts. By default the result is focused on the current phase: this phase’s templates and the always-available helpers in full, plus a by-key index of the other phases’ templates in arc order — the snippets you actually reach for now, without the rest as noise. Pass all=true for every snippet’s full body, which you want when you genuinely need a template from another phase. Snippets you have already sent this phase are annotated: those workers still hold the instructions, so later turns want the delta, not the template.',
      {
        all: z
          .boolean()
          .optional()
          .describe('Set true to get every snippet’s full body, ungrouped — for when you need a template outside the current phase. Default (false) shows the phase-focused view.'),
      },
      async (args) => {
        const sent: Record<string, string[]> = {};
        for (const role of ['implementer', 'reviewer'] as const) {
          for (const tag of state.sentSnippets?.[phase]?.[role] ?? []) {
            (sent[tag] ??= []).push(role);
          }
        }
        return { content: [{ type: 'text' as const, text: renderSnippetLibrary({ phase, workflow: workflowOf(state), sentTo: sent, all: args.all }) }] };
      },
      { annotations: { readOnlyHint: true } }, // genuinely read-only; also batches with parallel sends
    ),

    kernelTool(
      'send_prompt',
      'Send a prompt to a worker agent and return its final response. Each role is one persistent session: a later call to the same role continues that worker’s conversation, so refer back to earlier turns instead of repeating context the worker has already seen — and the instructions you send persist the same way, so a full snippet template goes to a given worker once per phase, with later turns steered by deltas (-again variants, short frame-referencing follow-ups). Worker turns are slow (often minutes) and a sent prompt becomes a permanent part of the session — there is no unsend — so compose the full body before calling and send one well-formed prompt rather than iterating by sending. Independent turns to different roles can be issued as parallel tool calls in one message and run concurrently — the frame phase’s two unshared analyses are the canonical case; a second turn to the same role while one is in flight is refused until the first returns (one session is one conversation). Sending the reviewer a prompt whose tag starts with "review" counts as a review round against the phase’s backstop cap. A claude-bound worker’s context can be deliberately compacted: a body that is literally "/compact " followed by your instructions (e.g. an adapted compact-for-* snippet) resets that session in place, keeping what the instructions name; codex-bound workers compact themselves automatically, so this applies only to claude.',
      {
        role: z
          .enum(['implementer', 'reviewer'])
          .describe('implementer produces and revises artifacts (write access); reviewer critiques them (read-only).'),
        tag: z
          .string()
          .describe('Source snippet key this prompt was built from, e.g. "review-spec". Use "custom" if composed from scratch.'),
        body: z
          .string()
          .describe(
            'The full prompt text to send — the template adapted to this run: generality collapsed onto the actual task, discipline intact.',
          ),
      },
      async (args) => {
        // Same-role guard (host-divergent). Blocking: the in-memory
        // turnsInFlight set. Async: the pending-turn record IS the guard — a
        // live running/settled-uncollected record refuses a re-send, AND a
        // reconnect orphan (a record on disk this fresh server doesn't own)
        // keeps the role closed until the human recovers it (slice 4 refines).
        const inFlight = dispatcher ? dispatcher.statusOf(args.role) !== undefined : turnsInFlight.has(args.role);
        if (inFlight) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `A turn to the ${args.role} is already in flight — each role is one persistent session, a single conversation that cannot take two turns at once (a parallel send to the same worker would race its session). Wait for that turn's result; if this prompt is a follow-up, fold it into your next message to the ${args.role} after the response arrives. A turn to the other role can run concurrently — that is what parallel send_prompt calls are for.`,
              },
            ],
            isError: true,
          };
        }
        if (dispatcher && state.pendingTurns?.[args.role]) {
          // A non-collected record with no live owner is an orphan, not a live
          // turn — refuse the re-send (it would race the orphaned worker).
          return { content: [{ type: 'text' as const, text: orphanRefusalText(args.role) }], isError: true };
        }
        const isReviewRound = args.role === 'reviewer' && args.tag.startsWith('review');
        const cap = PHASE[phase].roundCap;
        const used = state.rounds[phase] ?? 0;
        if (isReviewRound && used >= cap) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `The ${phase} phase has hit its backstop cap of ${cap} review rounds — this cap exists as runaway protection, and reaching it means the loop has not converged by judgment alone. Stop starting new rounds: either call advance_phase if the loop has actually converged and you were re-checking out of caution, or call ask_human so the human can decide how to proceed.`,
              },
            ],
            isError: true,
          };
        }

        if (isBaseTemplate(args.tag) && sentThisPhase(args.role).includes(args.tag)) {
          const warnKey = `${args.role}:${args.tag}`;
          if (!resendWarned.has(warnKey)) {
            resendWarned.add(warnKey);
            const again = `${args.tag}-again`;
            const hasAgain = getSnippet(again) !== undefined;
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `You already sent ${args.tag} to the ${args.role} this phase, and that session still holds its instructions — a full re-send makes the worker restart the exercise instead of continuing it, and spends a minutes-long turn re-covering ground. Send the delta instead: ${
                    hasAgain ? `the ${again} variant, or ` : ''
                  }a short follow-up that references the established frame and states only what changed. If the full template is genuinely warranted (the human re-scoped the problem, or the prior turn was lost), repeat this exact call and it will go through.`,
                },
              ],
              isError: true,
            };
          }
          log(`[send_prompt] resend of ${args.tag} → ${args.role} allowed after steering (deliberate)`);
        }

        const provider = providers[args.role];
        log(`[send_prompt] → ${args.role} (${provider.name})  tag=${args.tag}  body=${args.body.length} chars`);
        appendVoiceLog(state, args.role, `◀ prompt (tag=${args.tag}, from orchestrator)`, args.body);

        // Async (interactive host): dispatch the turn into the background and
        // return at once, so the session stays live. The dispatcher takes the
        // pending-turn record, the branch-fixed flag, the activeTurns hint, and
        // the heartbeat; the turn settles (durable bookkeeping commits) when its
        // promise resolves; check_turns collects the result later.
        if (dispatcher) {
          dispatcher.dispatch({ role: args.role, tag: args.tag, body: args.body, isReviewRound });
          return {
            content: [
              {
                type: 'text' as const,
                text: `Dispatched to the ${args.role} — the turn runs in the background and this session stays live: keep talking with the human, steer, check status, or fire the other role meanwhile, then pull the result with check_turns once it lands (it returns the moment the turn settles; a phase can't advance while a turn is uncollected). If you've nothing to do meanwhile and are about to end your turn, start \`duet status --wait\` in the background first — it wakes you the moment the turn settles, so the result gets collected instead of sitting idle while the run stalls. A turn to the other role can run in parallel.`,
              },
            ],
          };
        }

        // Blocking (headless host): run dispatch → settle → collect in one call.
        // Persist the in-flight hint (a separate doctor process reads it to tell
        // long-inference from idle). Best-effort like all of state.json.
        turnsInFlight.add(args.role);
        markTurnActive(state, args.role, args.tag);
        const startedAt = Date.now();
        const stopHeartbeat = startHeartbeat({ state, log, ...(home !== undefined ? { home } : {}) }, { role: args.role, tag: args.tag, startedAt });
        // settleTurn + renderTurnResult are kept INSIDE this try/catch (in both
        // arms) so a throw during the merge renders as an infra failure exactly
        // as the inline block did — the await and the settle share one boundary.
        try {
          const turn = await provider.runTurn({
            prompt: args.body,
            sessionId: state.workerSessions[args.role],
            readOnly: args.role === 'reviewer',
            cwd: state.cwd,
          });
          settleTurn({ state, phase, providers, log }, { role: args.role, tag: args.tag, isReviewRound }, turn);
          return renderTurnResult({ state, phase }, { role: args.role, isReviewRound, cap }, turn);
        } catch (err) {
          const outcome = err instanceof Error ? err : new Error(String(err));
          settleTurn({ state, phase, providers, log }, { role: args.role, tag: args.tag, isReviewRound }, outcome);
          return renderTurnResult({ state, phase }, { role: args.role, isReviewRound, cap }, outcome);
        } finally {
          turnsInFlight.delete(args.role);
          stopHeartbeat();
        }
      },
      // CLI quirk, load-bearing: readOnlyHint here is a CONCURRENCY HINT, not
      // a purity claim — send_prompt plainly has side effects. The claude CLI
      // runs MCP tools strictly serially unless this annotation is set
      // (verified against CLI 2.1.175: its scheduler's isConcurrencySafe for
      // MCP tools is `annotations?.readOnlyHint ?? false`, and a non-safe
      // tool call waits for everything before it). Without it, two
      // send_prompt calls emitted in one orchestrator turn serialize
      // minutes-long worker turns that should overlap — observed live in the
      // planlab frame phase (run 20260612-1254-a575: both think-holistic
      // sends in one message, reviewer queued behind the implementer's whole
      // turn). The annotation's only consumer in this closed system is that
      // scheduler (allowedTools already pre-approves the surface); the truly
      // unsafe case — two concurrent turns into one session — is refused by
      // the turnsInFlight rail above. If parallel sends stop overlapping
      // after a CLI upgrade, re-verify this mapping first.
      { annotations: { readOnlyHint: true } },
    ),

    kernelTool(
      'ask_human',
      'Flag a question for the human: product or direction calls, environment actions only they can take (deploys, credentials, migrations), or blockers you cannot route around. Route technical and content questions to a worker instead — the human is the editor-in-chief, not a third engineer. Asking always pauses the run until the answer arrives: minutes when the human is at the terminal, hours during the AFK phase — so make every question self-contained, and let questions that can wait for a gate wait.',
      {
        question: z.string().describe('The question, self-contained enough to answer from a phone.'),
        context: z.string().optional().describe('One or two sentences of background the human needs to answer well.'),
      },
      async (args) => {
        if (stagedAnswer !== null) {
          const answer = stagedAnswer;
          stagedAnswer = null;
          return { content: [{ type: 'text' as const, text: `The human answered: ${answer}` }] };
        }
        if (terminalAlreadySet()) return alreadyEnding();
        const stranded = pendingTurnGate('queue a question');
        if (stranded) return stranded;
        state.pendingQuestion = { question: args.question, ...(args.context ? { context: args.context } : {}), cause: 'human' };
        state.lastActivity = 'ask_human (queued)';
        // The marker rides the SAME atomic write as the question it carries, so
        // first-terminal-wins and the flag packet land together — never a
        // half-state where one persisted and the other did not.
        state.terminalMarker = { phase, kind: 'flag' };
        saveRunState(state);
        log(`[ask_human] queued: ${args.question}`);
        appendVoiceLog(state, 'orchestrator', `ask_human queued`, args.question);
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Your question is queued and the run is pausing until the human answers. End your turn with a one-line status — anything you do past this point happens without the answer you just asked for. The run resumes with the human’s answer.',
            },
          ],
        };
      },
    ),

    kernelTool(
      'create_branch',
      'Create and switch to the run’s working branch — for when the repo sits on its default branch (or one unrelated to this problem) at run start. The branch is fixed once a worker has been prompted, so this is only callable before your first send_prompt; after creating it, name the branch in your first prompt to each worker with the note that branch management is settled outside their sessions.',
      {
        name: z.string().describe('Branch name fitting the work and the project’s conventions, e.g. "feat/queued-flags".'),
      },
      async (args) => {
        // Branch fixed once any worker prompt has been issued. workerDispatched
        // (the durable one-way flag) covers the async window where a turn was
        // dispatched but its session id isn't yet persisted; workerSessions
        // covers the headless host (and a settled interactive turn).
        if (state.workerDispatched || state.workerSessions.implementer || state.workerSessions.reviewer) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'A worker has already been prompted, so the run’s branch is fixed — creating one now would strand the work done so far. Continue on the current branch; if it is genuinely wrong, that is the human’s call: ask_human.',
              },
            ],
            isError: true,
          };
        }
        try {
          await execa('git', ['switch', '-c', args.name], { cwd: state.cwd, timeout: 30_000 });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: 'text' as const,
                text: `Branch creation failed at the git layer (${detail}). If the name already exists, choose another; if the failure looks environmental (locks, permissions), ask_human with the error.`,
              },
            ],
            isError: true,
          };
        }
        state.branch = args.name;
        state.lastActivity = `create_branch (${args.name})`;
        saveRunState(state);
        log(`[create_branch] switched to ${args.name}`);
        appendVoiceLog(state, 'orchestrator', `create_branch (${args.name})`);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Created and switched to "${args.name}" — the run’s working branch. Name it in your first prompt to each worker, with the note that branch management is settled outside their sessions.`,
            },
          ],
        };
      },
    ),

    kernelTool(
      'advance_phase',
      'Declare the current phase complete. Legal only when the phase’s exit criteria are met (the review loop converged, open points are minor or settled). Lands on the phase’s human gate — your summary is what the human decides from, so make it honest about what changed, what was rejected, and what remains open.',
      {
        summary: z
          .string()
          .describe(
            'The gate packet the human decides from: what the reviewer flagged, what changed, rejections with rationale, and any open points. Follow the packet shape your phase’s brief specifies — it names what that phase’s gate packet should lead with (e.g. an implementation/ship packet’s review history, deviations, and test state).',
          ),
        artifacts: z
          .array(z.string())
          .describe(
            'Repo paths of the phase’s outputs (e.g. the spec file), one per entry. Where no file exists, a short one-line label — the summary carries the prose, not this list.',
          ),
        spec_path: z
          .string()
          .optional()
          .describe('Repo-relative path of the spec file, when this phase produced or moved it — the harness records it for later phases.'),
        human_decisions: z
          .array(z.object({ title: z.string(), severity: z.enum(['low', 'high']) }))
          .optional()
          .describe(
            'A SIGNAL-ONLY structured echo of the genuine human decisions this gate carries — the "things for you to decide" you would otherwise leave only in the prose summary. severity: "high" = a real product/direction call the human must make; "low" = notable but not blocking. The human/concierge reads it to decide hold-vs-relay; it never affects gate-crossing (only the human’s tap crosses a gate). Omit it when the gate is a routine convergence with nothing for the human to weigh.',
          ),
      },
      async (args) => {
        if (terminalAlreadySet()) return alreadyEnding();
        const stranded = pendingTurnGate('advance the phase');
        if (stranded) return stranded;
        const roundsRun = state.rounds[phase] ?? 0;
        if (PHASE[phase].reviewLoop && roundsRun === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'No review round has run in this phase yet, so there is nothing for the human to gate on. Run the review loop first (send the reviewer a review-* prompt); advance_phase is for after the loop converges.',
              },
            ],
            isError: true,
          };
        }
        if (args.spec_path) state.specPath = args.spec_path;
        state.phaseSummaries[phase] = {
          summary: args.summary,
          artifacts: args.artifacts,
          ...(args.human_decisions && args.human_decisions.length > 0 ? { humanDecisions: args.human_decisions } : {}),
        };
        state.lastActivity = `advance_phase (${phase})`;
        // The marker rides the SAME atomic write as the gate packet, so
        // first-terminal-wins and the packet are one durable record.
        state.terminalMarker = { phase, kind: 'advance' };
        saveRunState(state);
        log(`[advance_phase] ${phase} phase complete (${roundsRun} review rounds)`);
        appendVoiceLog(state, 'orchestrator', `advance_phase (${phase})`, args.summary);
        // Convention 5 (docs/prompting-and-tool-design.md): the result must
        // say what actually happens next — a live gate decision, an
        // auto-crossed pre-authorized gate, or (open phase) run completion.
        const next =
          !isGatePhase(phase)
            ? 'the run is complete. End your turn with a one-line status.'
            : gateAttended(state, phase)
              ? 'the run moves to the human gate. End your turn with a one-line status; the gate decision arrives as your next message.'
              : dispatcher
                ? // The interactive host (a dispatcher is present): a pre-authorized
                  // gate does NOT auto-continue here — only the headless driver
                  // auto-crosses — so the message must not promise the next phase
                  // arrives automatically. It says to hand off instead.
                  'this phase’s gate was pre-authorized, so your packet is saved for the human’s later review. On this interactive host the run does NOT auto-continue here — hand off with `duet afk` (or `duet continue --approve --headless`) to run the pre-authorized rest unattended. End your turn with a one-line status.'
                : 'this phase’s gate was pre-authorized by the human at run start, so your packet is saved for their later review and the run continues immediately. End your turn with a one-line status; the next phase’s instructions arrive as your next message.';
        return {
          content: [{ type: 'text' as const, text: `Phase advance recorded — ${next}` }],
        };
      },
    ),

    kernelTool(
      'propose_snippet_edit',
      'Queue a persistent change to the snippet library for the human’s end-of-run review. Library edits never apply mid-run: a silently changed prompt would compound across every later run, so the human stays editor-in-chief of the library. Use this when a snippet was persistently inadequate, not for one-off adaptations (those you just make per-turn).',
      {
        snippet_key: z.string().describe('The snippet to change, or a new key to add.'),
        proposed_body: z.string().describe('The full proposed snippet body.'),
        rationale: z.string().describe('What inadequacy this fixes, with the evidence from this run.'),
      },
      async (args) => {
        state.snippetProposals.push({
          snippetKey: args.snippet_key,
          proposedBody: args.proposed_body,
          rationale: args.rationale,
          at: new Date().toISOString(),
        });
        saveRunState(state);
        log(`[propose_snippet_edit] queued for ${args.snippet_key}`);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Proposal queued (${state.snippetProposals.length} pending) — it appears in duet status and the human reviews it at the end of the run. Continue the phase with your per-turn adaptation in the meantime.`,
            },
          ],
        };
      },
    ),

    kernelTool(
      'write_note',
      'Append a friction observation to the run’s notes file — the shared journal the human reviews to improve the workflow between runs. Note things like a snippet that didn’t fit, a triage call you were unsure about, or worker behavior worth remembering.',
      {
        observation: z.string(),
      },
      async (args) => {
        appendNote(state, 'orchestrator', args.observation);
        return { content: [{ type: 'text' as const, text: 'Noted.' }] };
      },
    ),
  ];

  // check_turns — interactive host only (present iff a dispatcher is injected).
  // Instant, role-keyed: collect every settled turn (delivering the same text /
  // near-cap nudge / infra error a blocking send_prompt would have returned),
  // report each still-running role, and surface any reconnect orphan rather than
  // hide it behind "nothing in flight". Never blocks — "block until ready" lives
  // in `duet status --wait`, off the session.
  if (dispatcher) {
    tools.push(
      kernelTool(
        'check_turns',
        'Collect the results of worker turns dispatched with send_prompt. On the interactive host send_prompt returns immediately and the turn runs in the background; check_turns is how you pull a finished turn’s response back into the conversation — the worker’s text (with any checkpoint note if it hit its budget cap), or, if the turn stopped short, the prescribed recovery: a budget-control stop (resume the session / raise the budget) or an infrastructure failure (retry once, then ask_human). The same bookkeeping a blocking turn would have done is already committed. It is instant: it delivers whatever has settled, names any role whose turn is still running (call it again later — or background `duet status --wait` so its settling re-invokes you), and never waits. Collecting a role’s result re-opens it for the next send_prompt; a phase cannot advance while any dispatched turn is still uncollected.',
        {},
        async () => {
          const ready = dispatcher.collectReady();
          const content: Array<{ type: 'text'; text: string }> = [];
          for (const { role, result } of ready) {
            content.push({ type: 'text' as const, text: `── ${role} ──` });
            for (const block of result.content) {
              if (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text') {
                content.push({ type: 'text' as const, text: (block as { text: string }).text });
              }
            }
          }
          for (const role of ROLES) {
            if (dispatcher.statusOf(role) === 'running') {
              content.push({
                type: 'text' as const,
                text: `The ${role} turn is still running — keep the conversation going and call check_turns again later, or, with nothing more to do meanwhile, arm \`duet status --wait\` in the background so its settling brings you back.`,
              });
            }
          }
          // collectReady cleared the just-collected records from disk; re-read so
          // a freshly-collected role isn't mistaken for an orphan. A reconnect
          // orphan (on disk, no live owner) is reported, never hidden.
          const afterCollect = loadRunState(state.cwd, state.runId);
          for (const role of ROLES) {
            if (afterCollect.pendingTurns?.[role] && dispatcher.statusOf(role) === undefined) {
              content.push({ type: 'text' as const, text: orphanRefusalText(role) });
            }
          }
          if (content.length === 0) {
            content.push({
              type: 'text' as const,
              text: 'No worker turns are in flight — nothing to collect. Dispatch one with send_prompt, or advance the phase if the work is done.',
            });
          }
          return { content };
        },
      ),
    );
  }

  /**
   * Steer delivery rides every tool result (docs/specs/2026-06-12-concierge-package.md):
   * after a handler produces its result — refusals included — pending human
   * steers are appended as a tagged block and consumed. Two exceptions, one
   * rule: steers deliver only on results that CONTINUE the phase. A call that
   * recorded this phase's terminal marker (advance requested, question queued)
   * is ending the turn, and guidance appended to a dying turn lands and dies —
   * those steers stay pending and ride the next harness prompt instead
   * (carry-forward, src/harness/driver.ts). Peek → append → mark-delivered order: a crash in
   * between redelivers (a repeated instruction is benign where a lost one is
   * not). The steer path is fail-soft — it must never corrupt a tool result.
   */
  const withSteerDelivery = (def: KernelTool<any>): KernelTool<any> => ({
    ...def,
    handler: async (args, extra) => {
      const result = await def.handler(args, extra);
      // A turn-ending result (this phase's terminal marker is now set) is not a
      // delivery surface: steers appended to a dying turn land and die, so they
      // stay pending and ride the next harness prompt (carry-forward). The
      // phase scope matters — a stale marker from a prior phase must not
      // suppress delivery on this phase's continuing results.
      if (state.terminalMarker?.phase === phase) return result;
      try {
        const steers = listPendingSteers(state);
        if (steers.length === 0) return result;
        result.content.push({ type: 'text' as const, text: renderSteerBlock(steers, 'live') });
        markSteersDelivered(state, steers);
        for (const steer of steers) {
          appendVoiceLog(state, 'orchestrator', `human steer delivered (staged ${steer.stagedAt})`, steer.text);
        }
        log(`[steer] delivered ${steers.length} human steer(s) on ${def.name}'s result`);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        log(`[steer] delivery failed (${detail}) — steers remain staged for the next result`);
      }
      return result;
    },
  });

  /**
   * The post-terminal quiescence rail (Stage 1): a long-lived interactive
   * kernel server has no process exit to make a phase quiescent, so once this
   * phase's terminal marker is set, every phase-CONTINUING tool is refused
   * structurally — the orchestrator must present the packet and cross, not send
   * another worker turn or mutate the run after the gate packet is recorded.
   * get_task stays open (the status/re-anchor read), and the terminal tools
   * self-gate via terminalAlreadySet, so neither is wrapped. Harmless headless
   * (the turn has already ended), load-bearing interactive. Scoped to THIS
   * phase: a stale marker from a prior phase does not refuse this phase's work.
   */
  const REFUSED_AFTER_TERMINAL = new Set([
    'send_prompt',
    'list_snippets',
    'create_branch',
    'propose_snippet_edit',
    // write_note is NOT here (F2): a pure append to notes.md has no statechart
    // effect, so the quiescence rationale for refusing work tools doesn't apply
    // — a friction observation can be recorded at the gate moment it crystallizes.
  ]);
  const phaseEnding = (toolName: string): CallToolResult => ({
    content: [
      {
        type: 'text' as const,
        text: `This phase is ending — it is parked at its gate or flag and that decision is recorded, so ${toolName} is refused here. Present the packet to the human and cross with duet continue, or re-anchor with get_task; the run proceeds from the decision already made.`,
      },
    ],
    isError: true,
  });
  const withPostTerminalRail = (def: KernelTool<any>): KernelTool<any> => ({
    ...def,
    handler: async (args, extra) => {
      if (state.terminalMarker?.phase === phase) return phaseEnding(def.name);
      return def.handler(args, extra);
    },
  });

  // Rail first, then steer delivery: a refused call returns before any steer
  // could ride a dying phase (withSteerDelivery's own marker guard also holds,
  // so this is belt-and-suspenders — the rail adds the refusal of the handler
  // itself, which withSteerDelivery alone would not).
  return {
    tools: tools.map((def) =>
      REFUSED_AFTER_TERMINAL.has(def.name)
        ? withSteerDelivery(withPostTerminalRail(def))
        : withSteerDelivery(def),
    ),
  };
}

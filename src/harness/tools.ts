import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { execa } from 'execa';
import { z } from 'zod';
import { PHASE, acceptanceContractPathForSpec } from '../phases.ts';
import type { PhaseName } from '../phases.ts';
import { providerFor } from '../providers/index.ts';
import { BudgetCutoffError } from '../providers/types.ts';
import type { WorkerProviders, WorkerRole, WorkerTurn } from '../providers/types.ts';
import { countsReviewRound, orphanRecoveryFor, readOnlyFor, sessionIdFor, workerRolesFor } from '../roles.ts';
import { getSnippet, renderSnippetLibrary, runtimeLibraryContext } from '../snippets.ts';
import {
  appendNote,
  appendVoiceLog,
  clearPendingTurn,
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
  recordTurnSessionId,
  saveRunState,
  workflowOf,
} from '../run-store.ts';
import type { HumanMessage, RunState } from '../run-store.ts';
import { bindingFor } from '../config.ts';
import { readTranscriptTailAtPath, readTranscriptTailForSession } from '../sessions.ts';
import type { TurnDispatcher } from './turn-dispatcher.ts';
import { formatAge, probeRole } from '../worker-health.ts';
import { activityLine, latestActivity, repoRelative } from '../worker-activity.ts';
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
  providers: WorkerProviders;
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
 * turn start anchors both in-flight and retry attribution). Locates by the
 * in-flight session id (staged on the active-turn hint as soon as the provider
 * announces it), so it works from at/near a turn's start — including a first
 * turn. Returns '' before the id is announced or on ANY read/probe failure —
 * telemetry never throws into a worker turn.
 */
function heartbeatHealth(state: RunState, role: WorkerRole, startedAt: number, now: number, home?: string): string {
  try {
    const sessionId = state.activeTurns?.[role]?.sessionId;
    if (!sessionId) return ''; // the provider hasn't announced this turn's id yet
    const tail = readTranscriptTailForSession(bindingFor(state.bindings, role).provider, sessionId, home !== undefined ? { home } : {});
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
 * Both cadences locate the transcript by THIS turn's session id off the
 * active-turn hint (`state.activeTurns[role].sessionId`), staged as soon as the
 * provider announces it — so they work from at/near a turn's start, on EVERY
 * turn and for every role (the implementer's first turn, the codex reviewer, the
 * ephemeral consultant). They degrade to silence before the id is announced or on
 * any read/parse failure — telemetry never throws into a worker turn. Returns one
 * stop fn that clears both intervals.
 */
export function startHeartbeat(
  deps: { state: RunState; log: (line: string) => void; home?: string; blockingHost?: boolean },
  meta: { role: WorkerRole; tag: string; startedAt: number },
): () => void {
  const { state, log, home, blockingHost } = deps;
  const { role, tag, startedAt } = meta;
  const heartbeat = setInterval(() => {
    const mins = Math.round((Date.now() - startedAt) / 60_000);
    const health = heartbeatHealth(state, role, startedAt, Date.now(), home);
    log(`[send_prompt] ⏳ ${role} turn running — ${mins}m elapsed (tag=${tag})${health}`);
    appendVoiceLog(state, role, `⏳ turn running — ${mins}m elapsed (tag=${tag})${health}`);
    // Control-plane mirror onto the orchestrator pane — ONLY on the headless
    // host (blockingHost), where the orchestrator is an in-process Agent SDK
    // session blocked inside `await runTurn` while this turn runs, so its pane
    // freezes on the last line and "awaiting <role>" is literally true; it reads
    // no files, so it has no `⋯` activity of its own to fill the gap. On the
    // interactive (async) host send_prompt is fire-and-collect — the orchestrator
    // is the human's live CC session, free to keep working or dispatch another
    // role — so "awaiting" would be false, and no mirror is emitted there.
    // `⏳`-prefixed, so the colorizer dims it like the worker heartbeat;
    // voice-log only — the driver log already mirrors the worker line above.
    if (blockingHost) appendVoiceLog(state, 'orchestrator', `⏳ awaiting ${role} — ${mins}m`);
  }, 5 * 60_000);
  let lastActivityId: string | undefined;
  // Cache the located transcript path/schema after the first successful read so
  // the 30s poll does not re-scan the sessions dir every tick (codex's locate is
  // a recursive readdir). KEYED BY the session id it was located for: the in-flight
  // id can change mid-turn (codex resume announces once from the resume id and
  // again from `thread.started`), so a cache that ignored the id would keep
  // following the FIRST transcript after a re-announce. On an id change we drop the
  // cache and re-locate. If the path vanishes the cached read returns undefined and
  // we re-locate too. The full locate stays as the fallback / first read.
  let located: { sessionId: string; path: string; schema: 'claude' | 'codex' } | undefined;
  const activity = setInterval(() => {
    try {
      const sessionId = state.activeTurns?.[role]?.sessionId;
      if (!sessionId) return; // the provider hasn't announced this turn's id yet
      if (located && located.sessionId !== sessionId) located = undefined; // id changed → re-locate
      let tail = located ? readTranscriptTailAtPath(located.path, located.schema) : undefined;
      if (!tail) {
        tail = readTranscriptTailForSession(bindingFor(state.bindings, role).provider, sessionId, home !== undefined ? { home } : {});
        located = tail ? { sessionId, path: tail.path, schema: tail.schema } : undefined;
      }
      if (!tail) return;
      const act = latestActivity(tail.jsonl, tail.schema);
      if (!act || act.id === lastActivityId) return; // nothing new since the last tick
      lastActivityId = act.id;
      // Normalize a read/write path to repo-relative for the log (the canonical
      // artifact form) — search/run subjects are already concise. Produce-time,
      // here, where state.cwd is in hand (worker-activity stays pure).
      const display = act.kind === 'read' || act.kind === 'write' ? { ...act, path: repoRelative(act.path, state.cwd) } : act;
      const line = activityLine(display);
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
 * The `onSessionId` callback both hosts hand a provider: stage this turn's id onto
 * the active-turn hint, swallowing any staging fault. `onSessionId` is best-effort
 * telemetry — it feeds only the live-activity poll — yet providers invoke it at
 * load-bearing moments (claude before spawn, codex inside its stream reduction), so
 * a throw out of the staging write would fail the worker turn itself. Guarding here,
 * once, keeps every provider's call site a plain `opts.onSessionId?.(id)` and keeps
 * the telemetry's failure mode (no activity line) off the turn's success path.
 */
export function stageSessionId(state: RunState, role: WorkerRole, log: (line: string) => void): (id: string) => void {
  return (id) => {
    try {
      recordTurnSessionId(state, role, id);
    } catch (err) {
      log(`[send_prompt] could not stage the ${role} session id for the activity trace (${err instanceof Error ? err.message : String(err)}) — the turn is unaffected`);
    }
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
  deps: { state: RunState; phase: PhaseName; providers: WorkerProviders; log: (line: string) => void },
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
  const provider = providerFor(providers, role);
  if (provider.name === 'claude') {
    if (turn.costUsd !== undefined) fresh.costs.claudeWorkersUsd += turn.costUsd;
    else fresh.costs.claudeWorkersCostPartial = true;
  } else if (provider.name === 'codex' && turn.tokens) {
    fresh.costs.codexTokens.input += turn.tokens.input;
    fresh.costs.codexTokens.output += turn.tokens.output;
  }
  if (turn.context) recordContextUsage(fresh, role, turn.context);
  // Acceptance-contract authorship/verification evidence — durable proof THIS run's
  // consultant ran the checkpoint, which the freeze and the advance_phase rails
  // require (so guarantee 2 holds mechanically, not by prompt compliance). Keyed on
  // the registry checkpoint mode, so only full's plan/impl ever set it.
  if (role === 'consultant') {
    const mode = PHASE[phase].consultantCheckpoint;
    if (mode === 'contract' && fresh.specPath) {
      // A consultant turn settled at the contract checkpoint — this run authored.
      fresh.acceptanceContractDraft = {
        path: acceptanceContractPathForSpec(fresh.specPath),
        sessionId: turn.sessionId,
        authoredAt: new Date().toISOString(),
      };
    } else if (mode === 'verify' && fresh.acceptanceContract) {
      // A consultant turn settled at the verify checkpoint — verification RAN
      // (pass/fail rides the gate packet; this only records that it happened).
      fresh.acceptanceContract = { ...fresh.acceptanceContract, verifiedAt: new Date().toISOString() };
    }
  }
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
  // A mid-response interruption (a connection drop after real generation) also
  // settled — the partial work above is committed to a resumable session. The
  // recovery is a short continuation, NOT a re-send: re-sending the original
  // prompt would restart work the worker already partly did.
  if (outcome.interrupted) {
    content.push({
      type: 'text' as const,
      text: `(the connection dropped mid-response — the worker's partial work above is committed to its session, which is resumable. Send it a short continuation to finish from where it stopped; do not re-send the original prompt. This is a checkpoint, not a failure.)`,
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

/** "implementer and reviewer" / "a, b and c" — the human-legible role list. */
function joinRoles(roles: WorkerRole[]): string {
  if (roles.length <= 1) return roles[0] ?? '';
  return `${roles.slice(0, -1).join(', ')} and ${roles[roles.length - 1]}`;
}

/**
 * The interactive-host "dispatched" result for a send (single or fan-out). It
 * carries per-call STATE (which role(s) were dispatched) and the single next
 * action (collect with check_turns) — deliberately terse from the first call.
 *
 * It does NOT re-teach the fire-and-collect model (keep the session live, fire
 * the other role in parallel, can't-advance-while-uncollected, arm
 * `duet status --wait` before idling): that whole contract is the durable
 * orchestrator identity's §"Fire-and-collect" (prompts/orchestrator-identity.md),
 * fed as a system prompt on every interactive session — so it is compaction-proof
 * and present from turn one. Repeating it on every dispatch was automatic +
 * invariant coaching (the friction kind), and a tool result re-teaching it can't
 * even be relied on: a /compact discards the turn that carried it. The moment a
 * dispatch model fact is genuinely conditional (idle-risk), it fires on the
 * relevant surface instead — check_turns' "still running" branch carries the
 * `status --wait` anti-stall reminder, where the condition actually holds.
 * (docs/prompting-and-tool-design.md §"Results nudge the next step".)
 */
function dispatchedMessage(roles: WorkerRole[]): string {
  if (roles.length === 1) {
    return `Dispatched to the ${roles[0]} — running in the background; collect it with check_turns when it settles.`;
  }
  return `Dispatched to the ${joinRoles(roles)} — running in the background; collect them with check_turns as they settle.`;
}

/**
 * Combine the per-role blocking results of a headless fan-out into one tool
 * result: each role's blocks under a `── <role> ──` header, in send order, so the
 * orchestrator reads them as one labeled batch. isError if any role's turn
 * errored. Used only on the headless host's array send; a single role returns its
 * own result unwrapped.
 */
function combineFanoutResults(parts: Array<{ role: WorkerRole; result: CallToolResult }>): CallToolResult {
  const content: Array<{ type: 'text'; text: string }> = [];
  for (const { role, result } of parts) {
    content.push({ type: 'text' as const, text: `── ${role} ──` });
    for (const c of result.content) {
      if (c.type === 'text') content.push({ type: 'text' as const, text: c.text });
    }
  }
  return parts.some((p) => p.result.isError) ? { content, isError: true } : { content };
}

/**
 * Above this, a collected turn's text is a candidate for the runaway head+tail
 * guard. Set generously above legitimate long worker analyses (which run tens of
 * KB) so real output is never clipped — only genuinely runaway content is.
 */
const RUNAWAY_DETAIL_CHARS = 50_000;

/**
 * High-value projection of a leaked provider failure envelope (the claude `-p`
 * JSON stream): the dump is a tiny signal — the result event's error reason —
 * wrapped in KB of init payload, per-event stream, and ids. Keep the diagnostic
 * fields, drop the rest, in place (the surrounding human-authored framing — the
 * role header, the "failed at the infrastructure layer" wrapper — is preserved).
 * Returns null when the text is not such a dump, so a normal response is never
 * mangled. Recognized by the distinctive init+result event combo (structure),
 * never by an error's wording.
 */
export function summarizeProviderEnvelope(text: string): string | null {
  if (!(text.includes('"type":"result"') && text.includes('"type":"system"'))) return null;
  const m = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (!m) return null;
  let arr: unknown;
  try {
    arr = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const result = arr.find(
    (e): e is Record<string, unknown> => typeof e === 'object' && e !== null && (e as { type?: unknown }).type === 'result',
  );
  if (!result) return null;
  const KEEP = ['subtype', 'is_error', 'result', 'session_id', 'total_cost_usd', 'num_turns', 'duration_ms'];
  const kept: Record<string, unknown> = {};
  for (const k of KEEP) if (k in result) kept[k] = result[k];
  return text.replace(m[0], JSON.stringify(kept));
}

/**
 * Project a collected turn's text to a context-friendly form — check_turns'
 * default (raw=true bypasses it). A leaked provider failure envelope is reduced to
 * its high-value fields; otherwise the text is returned untouched unless it is a
 * true runaway, in which case the head and tail are kept (both ends carry signal —
 * an error reason or a conclusion) and the middle is elided. Never a blind
 * top-to-bottom trim, and never clipping a normal worker response.
 */
export function projectDetail(text: string): string {
  const summary = summarizeProviderEnvelope(text);
  if (summary) return summary;
  if (text.length <= RUNAWAY_DETAIL_CHARS) return text;
  const head = text.slice(0, 8_000);
  const tail = text.slice(-4_000);
  return `${head}\n\n…[${text.length - 12_000} chars elided — call check_turns with raw=true for the full text]…\n\n${tail}`;
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
  const ROLES: WorkerRole[] = workerRolesFor(state);
  // A reconnect ORPHAN: a pending-turn record exists on disk for this role, but
  // the live dispatcher has no record for it — a prior server dispatched the
  // turn and died, and this (fresh) server does not own it. Detection is purely
  // the durable record's existence-without-a-live-owner; no transcript claim.
  // Branch-aware orphan recovery: the prescribed recovery differs by the role's
  // orphan POLICY (orphanRecoveryFor), not a role check. A `takeover` role's
  // orphan can be resumed (and a re-send would race that session — or, with no
  // session, the old worker may still be editing the repo), so it refuses until
  // `duet takeover <role>`. A `discard-and-reseed` role (the ephemeral,
  // read-only consultant) has nothing to resume and no repo to race, so its
  // orphan is dropped and the fresh body re-dispatched — no human action needed.
  const orphanRefusalText = (role: WorkerRole): string =>
    state.workerSessions[role]
      ? `The prior turn to the ${role} was orphaned when its session ended — its pending record is still on disk, and that session may still be resumable. Inspect or finish it with \`duet takeover ${role}\`, then re-send. Do not re-send into this role until the orphan is resolved: an immediate re-send would resume and race the orphaned worker on that same session.`
      : `The prior turn to the ${role} was orphaned before a session id was captured — there is no session to resume, and the old worker process may still be running and editing the repo. Dropping the orphan ABANDONS that in-flight turn: confirm it is done (or accept the risk), then run \`duet takeover ${role}\` to drop the orphan and re-send. Do not re-send until then.`;
  const orphanDiscardText = (role: WorkerRole): string =>
    `The prior turn to the ${role} was orphaned when its session ended, but the ${role} is ephemeral and read-only — there is nothing to resume and no repo it could have edited, so just resend: your next send_prompt to the ${role} clears the stale record and dispatches the fresh body in one call. (Or run \`duet takeover ${role}\` to clear it by hand — it opens no resume target, since the next turn seeds a new session.)`;
  // The phase-exit gate (async only): advance_phase and ask_human are both
  // refused while ANY pending-turn record is non-collected — live (the
  // dispatcher owns it) OR on disk (a reconnect orphan the fresh dispatcher
  // doesn't). A turn dispatched-but-uncollected means the phase isn't done;
  // advancing would strand the turn and its bookkeeping, and the disk half also
  // keeps the per-phase ctx registry safe to rebuild at a boundary.
  //
  // The recovery is per-role and policy-aware, not one generic line: a live turn
  // collects with check_turns; an orphan recovers by its role's orphan POLICY
  // (orphanRecoveryFor) — a `takeover` role refuses until `duet takeover`, but a
  // `discard-and-reseed` role (the ephemeral consultant) just resends (or clears
  // by hand), needing no human escalation. The generic "duet takeover <role>"
  // copy steered a consultant orphan to a takeover it doesn't need — this is the
  // third orphan-recovery surface, aligned with send_prompt's branch and
  // check_turns. Returns the refusal, or null when nothing is outstanding.
  const pendingTurnGate = (verb: 'advance the phase' | 'queue a question'): CallToolResult | null => {
    if (!dispatcher) return null;
    const outstanding = ROLES.filter((r) => dispatcher.statusOf(r) !== undefined || state.pendingTurns?.[r]);
    if (outstanding.length === 0) return null;
    const recovery = (role: WorkerRole): string => {
      // Live: the dispatcher owns the turn (running, or settled-but-uncollected) — collect it.
      if (dispatcher.statusOf(role) !== undefined) return `Collect the ${role}'s turn with check_turns.`;
      // On-disk orphan with no live owner — recover by the role's policy.
      return orphanRecoveryFor(role) === 'discard-and-reseed'
        ? `The ${role} turn was orphaned, but the ${role} is ephemeral and read-only — resend to it (your next send_prompt clears the stale record and reseeds), or run \`duet takeover ${role}\` to clear it; no human action is needed.`
        : `The ${role} turn was orphaned when its session ended — recover it with \`duet takeover ${role}\` (its session may still be resumable), then re-send.`;
    };
    const action = verb === 'advance the phase' ? 'advance' : 'ask';
    return {
      content: [
        {
          type: 'text' as const,
          text: `A worker turn dispatched in this phase has not been collected yet, so you can't ${verb} — doing so would strand the turn and its bookkeeping. ${outstanding.map(recovery).join(' ')} Then ${action} once nothing is outstanding.`,
        },
      ],
      isError: true,
    };
  };

  // send_prompt's role surface is the run's BOUND worker roles: the consultant
  // is an enum value (and named in the role/description copy) ONLY when bound, so
  // an un-enabled run's tool schema is byte-for-byte today's and the orchestrator
  // cannot route to a role that does not exist.
  const workerRoles = workerRolesFor(state);
  const consultantBound = workerRoles.includes('consultant');
  // send_prompt's role accepts a single role (a normal turn) or an array (fan one
  // identical body to several workers at once — the framing analysis pass). One
  // enum, reused for both arms of the union.
  const roleEnum = z.enum(workerRoles as [WorkerRole, ...WorkerRole[]]);
  const sendPromptRoleDescribe = consultantBound
    ? 'implementer produces and revises artifacts (write access); reviewer critiques them (read-only); consultant is the independent cross-family second reviewer — read-only, and a fresh seeded session each turn (it does not accumulate the run’s context the way the persistent implementer and reviewer do). Pass one role for a normal turn, or an array to send this identical body to several workers at once (the framing analysis pass: ["implementer", "reviewer"]) — use the array only when the read is genuinely role-neutral. The consultant’s read is different, so send it on its own, never inside the array.'
    : 'implementer produces and revises artifacts (write access); reviewer critiques them (read-only). Pass one role for a normal turn, or an array to send this identical body to several workers at once (the framing analysis pass: ["implementer", "reviewer"]) — use the array only when the read is genuinely role-neutral.';
  // The session paragraph, reconciled by binding so persistent-vs-ephemeral reads
  // as one coherent rule (not a persistent claim with a later exception). Unbound,
  // it is byte-for-byte today's text; bound, it scopes "persistent" to the
  // implementer and reviewer and states the consultant's ephemerality as the
  // contrast at the same altitude.
  const sendPromptSessionParagraph = consultantBound
    ? 'The implementer and reviewer are each one persistent session: a later call to that role continues the worker’s conversation, so refer back to earlier turns instead of repeating context it has already seen — and the instructions you send persist the same way, so a full snippet template goes to such a worker once per phase, with later turns steered by deltas (-again variants, short frame-referencing follow-ups). The consultant is the exception: it is ephemeral — a fresh seeded session each turn, carrying no prior context — so seed it fully each time rather than referring back.'
    : 'Each role is one persistent session: a later call to the same role continues that worker’s conversation, so refer back to earlier turns instead of repeating context the worker has already seen — and the instructions you send persist the same way, so a full snippet template goes to a given worker once per phase, with later turns steered by deltas (-again variants, short frame-referencing follow-ups).';

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
        for (const role of workerRolesFor(state)) {
          for (const tag of state.sentSnippets?.[phase]?.[role] ?? []) {
            (sent[tag] ??= []).push(role);
          }
        }
        // Resolve against the run's project root (the `<cwd>/.duet/snippets.toml`
        // project override) and the user config dir; runtimeLibraryContext owns the
        // single OS-home read, which the test suite isolates via $HOME.
        const libraryContext = runtimeLibraryContext(state.cwd);
        // A malformed or unknown-key override file fails closed — surface it as a
        // readable tool error (not a crashed turn): the orchestrator can't compose
        // prompts from a broken library, so it must stop and flag rather than serve
        // a silently-partial one.
        let library: string;
        try {
          library = renderSnippetLibrary({ phase, workflow: workflowOf(state), sentTo: sent, all: args.all, consultantBound: Boolean(state.bindings.consultant), libraryContext });
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `The snippet library could not be loaded — ${err instanceof Error ? err.message : String(err)} Fix or remove the override file before composing worker prompts; ask_human if you need the human to resolve it.` }],
            isError: true,
          };
        }
        return { content: [{ type: 'text' as const, text: library }] };
      },
      { annotations: { readOnlyHint: true } }, // genuinely read-only; also batches with parallel sends
    ),

    kernelTool(
      'send_prompt',
      `Send a prompt to a worker agent and return its final response. ${sendPromptSessionParagraph} Worker turns are slow (often minutes) and a sent prompt becomes a permanent part of the session — there is no unsend — so compose the full body before calling and send one well-formed prompt rather than iterating by sending. To run the same body on several workers at once, pass role as an array — the framing analysis pass is the canonical case: one role-neutral problem read to ["implementer", "reviewer"], each analyzing it independently and in parallel${consultantBound ? '; the consultant’s framing read is deliberately different, so send it on its own, never inside the array' : ''}. (Independent single-role turns to different workers can also be issued as parallel tool calls.) A second turn to a role while one is in flight is refused until it returns (one session is one conversation). Sending the reviewer a prompt whose tag starts with "review" counts as a review round against the phase’s backstop cap. A claude-bound worker’s context can be deliberately compacted: a body that is literally "/compact " followed by your instructions (e.g. an adapted compact-for-* snippet) resets that session in place, keeping what the instructions name; codex-bound workers compact themselves automatically, so this applies only to claude.`,
      {
        role: z
          // A single role or an array of them. Non-emptiness is enforced in the
          // handler, not as a zod .min(1): the two transports' zod→JSON-schema
          // converters disagree on minItems (the Agent SDK emits it, the MCP SDK
          // drops it), which would break the one-source-of-truth schema parity —
          // and the stdio path the interactive host actually uses drops it anyway.
          .union([roleEnum, z.array(roleEnum)])
          .describe(sendPromptRoleDescribe),
        tag: z
          .string()
          .describe('Source snippet key this prompt was built from, e.g. "review-spec". Use "custom" if composed from scratch.'),
        body: z
          .string()
          .describe(
            'The full prompt text to send — the template adapted to this run: generality collapsed onto the actual task, discipline intact. A worker reads it cold, so a first prompt of a phase opens with the work (what is being built and the goal this turn) before the role and task, and carries none of duet’s internal vocabulary — arc, gate, or checkpoint names orient you, not the worker.',
          ),
      },
      async (args) => {
        const { tag, body } = args;
        // Normalize role to a deduped list: a single role is a 1-element fan-out,
        // so one path serves both — a single role behaves exactly as before, an
        // array fans the SAME body to each worker (the framing analysis pass).
        // Dedupe so ["implementer","implementer"] can't self-race.
        const roles = [...new Set(Array.isArray(args.role) ? args.role : [args.role])];
        if (roles.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'role was an empty array — name at least one worker to send to (a single role, or several to fan the same body to each).' }],
            isError: true,
          };
        }
        const cap = PHASE[phase].roundCap;
        const isReviewRoundFor = (role: WorkerRole): boolean => countsReviewRound(role, tag);

        // Validate EVERY target before dispatching ANY: the rails (same-role
        // guard, reconnect orphan, review-round backstop, warn-once template
        // economy) run per role, and the first refusal returns before a single
        // turn launches — a half-dispatched fan-out would strand turns. Returns a
        // refusal CallToolResult, or null when the role is clear to send.
        const validateRole = (role: WorkerRole): CallToolResult | null => {
          // Same-role guard (host-divergent). Blocking: the in-memory turnsInFlight
          // set. Async: a live running/settled-uncollected record IS the guard.
          const inFlight = dispatcher ? dispatcher.statusOf(role) !== undefined : turnsInFlight.has(role);
          if (inFlight) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `A turn to the ${role} is already in flight — each role is one persistent session, a single conversation that cannot take two turns at once (a parallel send to the same worker would race its session). Wait for that turn's result; if this prompt is a follow-up, fold it into your next message to the ${role} after the response arrives. A turn to another role can run concurrently — that is what an array role (or parallel send_prompt calls) is for.`,
                },
              ],
              isError: true,
            };
          }
          if (dispatcher && state.pendingTurns?.[role]) {
            // A non-collected record with no live owner is a reconnect orphan, not
            // a live turn. A `takeover` role refuses the re-send (it would race the
            // orphaned worker); a `discard-and-reseed` role (the ephemeral,
            // read-only consultant) clears the stale record and re-dispatches the
            // newly supplied body — the durable record holds no body (run-store.ts),
            // so recovery is a fresh send, not a replay.
            if (orphanRecoveryFor(role) === 'discard-and-reseed') {
              clearPendingTurn(state, role);
              log(`[send_prompt] discarded an orphaned ${role} turn — reseeding with the newly supplied body`);
            } else {
              return { content: [{ type: 'text' as const, text: orphanRefusalText(role) }], isError: true };
            }
          }
          if (isReviewRoundFor(role) && (state.rounds[phase] ?? 0) >= cap) {
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
          if (isBaseTemplate(tag) && sentThisPhase(role).includes(tag)) {
            const warnKey = `${role}:${tag}`;
            if (!resendWarned.has(warnKey)) {
              resendWarned.add(warnKey);
              const again = `${tag}-again`;
              const hasAgain = getSnippet(again) !== undefined;
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `You already sent ${tag} to the ${role} this phase, and that session still holds its instructions — a full re-send makes the worker restart the exercise instead of continuing it, and spends a minutes-long turn re-covering ground. Send the delta instead: ${
                      hasAgain ? `the ${again} variant, or ` : ''
                    }a short follow-up that references the established frame and states only what changed. If the full template is genuinely warranted (the human re-scoped the problem, or the prior turn was lost), repeat this exact call and it will go through.`,
                  },
                ],
                isError: true,
              };
            }
            log(`[send_prompt] resend of ${tag} → ${role} allowed after steering (deliberate)`);
          }
          return null;
        };
        for (const role of roles) {
          const refusal = validateRole(role);
          if (refusal) return refusal;
        }

        // All targets clear: log + voice-log each, then dispatch (interactive) or
        // run them concurrently (headless).
        for (const role of roles) {
          log(`[send_prompt] → ${role} (${providerFor(providers, role).name})  tag=${tag}  body=${body.length} chars`);
          appendVoiceLog(state, role, `◀ prompt (tag=${tag}, from orchestrator)`, body);
        }

        // Async (interactive host): dispatch each turn into the background and
        // return at once, so the session stays live. The dispatcher takes the
        // pending-turn record, the branch-fixed flag, the activeTurns hint, and the
        // heartbeat per role; each turn settles (durable bookkeeping commits) when
        // its promise resolves; check_turns collects the results later.
        if (dispatcher) {
          for (const role of roles) {
            dispatcher.dispatch({ role, tag, body, isReviewRound: isReviewRoundFor(role) });
          }
          return { content: [{ type: 'text' as const, text: dispatchedMessage(roles) }] };
        }

        // Blocking (headless host): run dispatch → settle → collect per role. A
        // single role keeps today's one-await path; an array runs the worker turns
        // CONCURRENTLY (Promise.all) so a fan-out never serializes two minutes-long
        // turns — the regression the readOnlyHint scheduler hint fixed for parallel
        // single-role calls. settleTurn merges against fresh disk, so concurrent
        // cross-role settles don't clobber each other.
        const runBlockingTurn = async (role: WorkerRole): Promise<WorkerTurn | Error> => {
          const isReviewRound = isReviewRoundFor(role);
          turnsInFlight.add(role);
          markTurnActive(state, role, tag);
          const startedAt = Date.now();
          const stopHeartbeat = startHeartbeat({ state, log, blockingHost: true, ...(home !== undefined ? { home } : {}) }, { role, tag, startedAt });
          // settleTurn is kept INSIDE this try/catch (both arms) so a throw during
          // the merge renders as an infra failure exactly as a runTurn throw does.
          try {
            const turn = await providerFor(providers, role).runTurn({
              prompt: body,
              sessionId: sessionIdFor(state, role),
              readOnly: readOnlyFor(role),
              cwd: state.cwd,
              // Stage this turn's id onto the active-turn hint the moment the
              // provider announces it, so the heartbeat poll (closed over the
              // same `state`) can locate the transcript from the turn's start.
              onSessionId: stageSessionId(state, role, log),
            });
            settleTurn({ state, phase, providers, log }, { role, tag, isReviewRound }, turn);
            return turn;
          } catch (err) {
            const outcome = err instanceof Error ? err : new Error(String(err));
            settleTurn({ state, phase, providers, log }, { role, tag, isReviewRound }, outcome);
            return outcome;
          } finally {
            turnsInFlight.delete(role);
            stopHeartbeat();
          }
        };
        const settled = await Promise.all(roles.map(async (role) => ({ role, outcome: await runBlockingTurn(role) })));
        // Render AFTER every settle so each role's footer/near-cap nudge reflects
        // the final round/cost state (settleTurn re-syncs `state` on each commit).
        const rendered = settled.map(({ role, outcome }) => ({
          role,
          result: renderTurnResult({ state, phase }, { role, isReviewRound: isReviewRoundFor(role), cap }, outcome),
        }));
        return rendered.length === 1 ? rendered[0]!.result : combineFanoutResults(rendered);
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
        if (state.workerDispatched || workerRolesFor(state).some((r) => state.workerSessions[r])) {
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
            'A structured echo of the genuine human decisions this gate carries — the "things for you to decide" you would otherwise leave only in the prose summary. severity: "high" = a real product/direction call the human must make; "low" = notable but not blocking. A high holds a non-explicit crossing: a pre-authorized gate will not auto-cross over it and a one-tap `duet afk` handoff is refused — both stop for the human so they weigh the call before it ships; an explicit human approval still crosses. A low rides the packet as advisory. Omit the field on a routine convergence with nothing for the human to weigh.',
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
        // Acceptance-contract checkpoint rail (full + consultant): the contract
        // can't be SILENTLY skipped — guarantee 2 holds mechanically, not by prompt
        // compliance. Mirrors the review-round rail above. The escape hatch is a
        // `high` (the orchestrator flagging the checkpoint's absence/failure as a
        // human decision), which itself holds the AFK crossing — so the run can
        // never auto-cross past a missing contract or an unrun verification.
        if (state.bindings.consultant) {
          const mode = PHASE[phase].consultantCheckpoint;
          const hasHigh = (args.human_decisions ?? []).some((d) => d.severity === 'high');
          if (mode === 'contract' && !state.acceptanceContractDraft && !hasHigh) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'A consultant is bound, so this phase owes its acceptance contract before it advances: send the consultant a consultant-contract turn (it authors the contract, blind to the plan), then advance. If it genuinely could not author one, record a high human_decision ("acceptance contract not authored — proceeding freezes no target") so the gate stops for the human rather than shipping with no frozen target.',
                },
              ],
              isError: true,
            };
          }
          if (mode === 'verify' && state.acceptanceContract && !state.acceptanceContract.verifiedAt && !hasHigh) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'A frozen acceptance contract exists for this run but has not been verified: send the consultant a consultant-verify turn (it runs the built system and returns a per-assertion pass/fail), then advance. Record each failed assertion as a high human_decision; if verification genuinely could not run, record a high so the gate stops for the human rather than shipping unverified.',
                },
              ],
              isError: true,
            };
          }
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
        // say what actually happens next — a live gate decision, or an
        // auto-crossed pre-authorized gate. Every phase gates, so there is no
        // run-completion arm here.
        const next =
          gateAttended(state, phase)
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
        {
          raw: z
            .boolean()
            .optional()
            .describe(
              'Set true to get each collected turn’s full, unmodified text. By default (false) an over-long machine dump — a failed turn’s raw provider error envelope — is reduced to its high-value fields to save context; a worker’s normal response is always returned in full either way.',
            ),
        },
        async (args) => {
          const raw = args.raw === true;
          const ready = dispatcher.collectReady();
          const content: Array<{ type: 'text'; text: string }> = [];
          for (const { role, result } of ready) {
            content.push({ type: 'text' as const, text: `── ${role} ──` });
            for (const block of result.content) {
              if (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text') {
                const t = (block as { text: string }).text;
                content.push({ type: 'text' as const, text: raw ? t : projectDetail(t) });
              }
            }
          }
          for (const role of ROLES) {
            if (dispatcher.statusOf(role) === 'running') {
              // Per-poll STATE (this role isn't ready) + the idle-risk pointer.
              // The fire-and-collect rhythm itself (keep the human talking, fire
              // the other role) is the identity's durable contract, not re-taught
              // on every poll; `status --wait` stays because this is the surface
              // nearest the idle moment (docs/prompting-and-tool-design.md).
              content.push({
                type: 'text' as const,
                text: `The ${role} turn is still running — collect it on a later check_turns, or arm \`duet status --wait\` so its settling brings you back.`,
              });
            }
          }
          // collectReady cleared the just-collected records from disk; re-read so
          // a freshly-collected role isn't mistaken for an orphan. A reconnect
          // orphan (on disk, no live owner) is reported, never hidden.
          const afterCollect = loadRunState(state.cwd, state.runId);
          for (const role of ROLES) {
            if (afterCollect.pendingTurns?.[role] && dispatcher.statusOf(role) === undefined) {
              // A discard-and-reseed role's orphan is "just resend," not "takeover".
              const text = orphanRecoveryFor(role) === 'discard-and-reseed' ? orphanDiscardText(role) : orphanRefusalText(role);
              content.push({ type: 'text' as const, text });
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

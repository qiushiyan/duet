import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { execa } from 'execa';
import { z } from 'zod';
import { PHASE } from '../phases.ts';
import type { PhaseName } from '../phases.ts';
import type { WorkerProvider, WorkerRole } from '../providers/types.ts';
import { getSnippet, renderSnippetLibrary } from '../snippets.ts';
import {
  appendNote,
  appendVoiceLog,
  contextPercent,
  gateAttended,
  listPendingSteers,
  markSteersDelivered,
  recordContextUsage,
  saveRunState,
} from '../run-store.ts';
import type { RunState } from '../run-store.ts';
import { renderSteerBlock } from './orchestrator-prompts.ts';

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
 * The orchestrator's tool surface — the seven harness tools and every
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
}

export interface PhaseTools {
  // Each tool has its own schema, so the list is heterogeneous by nature.
  tools: Array<KernelTool<any>>;
}

export function createPhaseTools({ state, phase, providers, log, stagedAnswer: initialAnswer }: PhaseToolsDeps): PhaseTools {
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
  const turnsInFlight = new Set<WorkerRole>();

  // Once-per-phase template discipline (system prompt <protocol>): a base
  // template re-sent to the same worker in the same phase gets one steering
  // refusal; repeating the identical call passes — judgment can override,
  // the harness just makes the choice deliberate.
  const sentThisPhase = (role: WorkerRole): string[] => {
    const phases = (state.sentSnippets ??= {});
    const roles = (phases[phase] ??= {});
    return (roles[role] ??= []);
  };
  const resendWarned = new Set<string>();
  const isBaseTemplate = (tag: string): boolean => tag !== 'custom' && !tag.endsWith('-again');

  const tools: Array<KernelTool<any>> = [
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
        return { content: [{ type: 'text' as const, text: renderSnippetLibrary({ phase, sentTo: sent, all: args.all }) }] };
      },
      { annotations: { readOnlyHint: true } }, // genuinely read-only; also batches with parallel sends
    ),

    kernelTool(
      'send_prompt',
      'Send a prompt to a worker agent and return its final response. Each role is one persistent session: a later call to the same role continues that worker’s conversation, so refer back to earlier turns instead of repeating context the worker has already seen — and the instructions you send persist the same way, so a full snippet template goes to a given worker once per phase, with later turns steered by deltas (-again variants, short frame-referencing follow-ups). Worker turns are slow (often minutes) and a sent prompt becomes a permanent part of the session — there is no unsend — so compose the full body before calling and send one well-formed prompt rather than iterating by sending. Independent turns to different roles can be issued as parallel tool calls in one message and run concurrently — the frame phase’s two unshared analyses are the canonical case; a second turn to the same role while one is in flight is refused until the first returns (one session is one conversation). Worker budget is per-turn: each call carries a fresh cost ceiling, so a worker reporting low budget mid-turn means the remaining work continues in another turn — never let the budget rail shrink the scope; descoping is a product decision that needs work-content reasons. Sending the reviewer a prompt whose tag starts with "review" counts as a review round against the phase’s backstop cap. A claude-bound worker’s context can be deliberately compacted: a body that is literally "/compact " followed by your instructions (e.g. an adapted compact-for-* snippet) resets that session in place, keeping what the instructions name; codex-bound workers compact themselves automatically, so this applies only to claude.',
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
        if (turnsInFlight.has(args.role)) {
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

        turnsInFlight.add(args.role);
        const provider = providers[args.role];
        log(`[send_prompt] → ${args.role} (${provider.name})  tag=${args.tag}  body=${args.body.length} chars`);
        appendVoiceLog(state, args.role, `◀ prompt (tag=${args.tag}, from orchestrator)`, args.body);

        // Worker turns are non-streaming and can run 30+ minutes; heartbeat
        // lines keep the voice log (and its tmux pane) visibly alive.
        const startedAt = Date.now();
        const heartbeat = setInterval(() => {
          const mins = Math.round((Date.now() - startedAt) / 60_000);
          log(`[send_prompt] ⏳ ${args.role} turn running — ${mins}m elapsed (tag=${args.tag})`);
          appendVoiceLog(state, args.role, `⏳ turn running — ${mins}m elapsed (tag=${args.tag})`);
        }, 5 * 60_000);

        try {
          const turn = await provider.runTurn({
            prompt: args.body,
            sessionId: state.workerSessions[args.role],
            readOnly: args.role === 'reviewer',
            cwd: state.cwd,
          });
          state.workerSessions[args.role] = turn.sessionId;
          // Re-read rather than reusing `used`: the worker turn above is a
          // minutes-long await, and the orchestrator may issue tool calls in
          // parallel — a stale capture would undercount the round.
          if (isReviewRound) state.rounds[phase] = (state.rounds[phase] ?? 0) + 1;
          if (isBaseTemplate(args.tag) && !sentThisPhase(args.role).includes(args.tag)) {
            sentThisPhase(args.role).push(args.tag);
          }
          if (turn.costUsd) state.costs.claudeWorkersUsd += turn.costUsd;
          // A claude turn that reported no cost (the interactive transport, by
          // P5) means the claudeWorkersUsd total is partial — mark it so the
          // status never presents the known sum as the complete total. The
          // claim is about cost completeness, not transport: total_cost_usd is
          // optional in the envelope, so anything needing "interactive"
          // specifically reads the binding's transport, never a missing cost.
          if (provider.name === 'claude' && turn.costUsd === undefined) {
            state.costs.claudeWorkersCostPartial = true;
          }
          if (provider.name === 'codex' && turn.tokens) {
            state.costs.codexTokens.input += turn.tokens.input;
            state.costs.codexTokens.output += turn.tokens.output;
          }
          if (turn.context) recordContextUsage(state, args.role, turn.context);
          state.lastActivity = `send_prompt → ${args.role} (${args.tag})`;
          saveRunState(state);
          const ctx = turn.context ? ` · context ${contextPercent(turn.context)}%` : '';
          appendVoiceLog(state, args.role, `▶ response (session ${turn.sessionId})${ctx}`, turn.text);
          log(`[send_prompt] ← ${args.role} responded (${turn.text.length} chars${ctx})`);
          const content: Array<{ type: 'text'; text: string }> = [{ type: 'text' as const, text: turn.text }];
          // Reactive state-triggered nudge (docs/prompting-and-tool-design.md
          // §"Results nudge the next step"): when this review round leaves
          // exactly one before the backstop cap, say so once — the cap is
          // runaway protection, not a target, so the reminder steers toward
          // converging or flagging rather than spending the last round idly.
          if (isReviewRound && (state.rounds[phase] ?? 0) === cap - 1) {
            content.push({
              type: 'text' as const,
              text: `(${state.rounds[phase]} of ${cap} review rounds used — one remains before this phase’s backstop cap. The cap is runaway protection, not a target: if the loop has converged, advance_phase now; if a substantive disagreement is still open, that is the human’s call via ask_human. Spend the last round only on a genuinely open structural point.)`,
            });
          }
          return { content };
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          log(`[send_prompt] ✗ ${args.role} turn failed: ${detail}`);
          appendVoiceLog(state, args.role, `✗ turn failed: ${detail}`);
          return {
            content: [
              {
                type: 'text' as const,
                text: `The ${args.role} worker's turn failed at the infrastructure layer (${detail}). The worker never saw your prompt, so this is not a content problem. Retry this same send_prompt call once; if the retry also fails, stop routing and report the failure to the human via ask_human instead of continuing the round.`,
              },
            ],
            isError: true,
          };
        } finally {
          turnsInFlight.delete(args.role);
          clearInterval(heartbeat);
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
        state.pendingQuestion = { question: args.question, ...(args.context ? { context: args.context } : {}) };
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
        if (state.workerSessions.implementer || state.workerSessions.reviewer) {
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
            'The gate packet the human decides from: what the reviewer flagged, what changed, rejections with rationale, open points. For the implementation phase, lead with the CEO summary verbatim, then review history, deviations from the plan, and test state.',
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
      },
      async (args) => {
        if (terminalAlreadySet()) return alreadyEnding();
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
        state.phaseSummaries[phase] = { summary: args.summary, artifacts: args.artifacts };
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
          phase === 'open'
            ? 'the run is complete. End your turn with a one-line status.'
            : gateAttended(state, phase)
              ? 'the run moves to the human gate. End your turn with a one-line status; the gate decision arrives as your next message.'
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

  return { tools: tools.map(withSteerDelivery) };
}

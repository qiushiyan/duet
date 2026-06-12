import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { execa } from 'execa';
import { z } from 'zod';
import { PHASE } from '../phases.ts';
import type { PhaseName } from '../phases.ts';
import type { WorkerProvider, WorkerRole } from '../providers/types.ts';
import { getSnippet, renderSnippetLibrary } from '../snippets.ts';
import {
  appendNote,
  appendVoiceLog,
  gateAttended,
  listPendingSteers,
  markSteersDelivered,
  saveRunState,
} from '../run-store.ts';
import type { RunState } from '../run-store.ts';
import { renderSteerBlock } from './orchestrator-prompts.ts';

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
  // The SDK's own surface takes Array<SdkMcpToolDefinition<any>> — each tool
  // has its own schema, so the list is heterogeneous by nature.
  tools: Array<SdkMcpToolDefinition<any>>;
  /**
   * Live outcome flags the driver loop reads after each orchestrator turn:
   * advance_phase and ask_human set them at call time.
   */
  outcome: { advanceRequested: boolean; questionQueued: boolean };
}

export function createPhaseTools({ state, phase, providers, log, stagedAnswer: initialAnswer }: PhaseToolsDeps): PhaseTools {
  const outcome = { advanceRequested: false, questionQueued: false };
  let stagedAnswer = initialAnswer ?? null;

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

  const tools: Array<SdkMcpToolDefinition<any>> = [
    tool(
      'list_snippets',
      'Read the snippet library: every prompt template the workflow uses, by key. The snippets encode the protocol’s conventions (altitude lenses, round-2 discipline, compaction shapes) — read them before composing worker prompts. Snippets you have already sent this phase are annotated: those workers still hold the instructions, so later turns want the delta, not the template.',
      {},
      async () => {
        const sent: Record<string, string[]> = {};
        for (const role of ['implementer', 'reviewer'] as const) {
          for (const tag of state.sentSnippets?.[phase]?.[role] ?? []) {
            (sent[tag] ??= []).push(role);
          }
        }
        return { content: [{ type: 'text' as const, text: renderSnippetLibrary(sent) }] };
      },
    ),

    tool(
      'send_prompt',
      'Send a prompt to a worker agent and return its final response. Each role is one persistent session: a later call to the same role continues that worker’s conversation, so refer back to earlier turns instead of repeating context the worker has already seen — and the instructions you send persist the same way, so a full snippet template goes to a given worker once per phase, with later turns steered by deltas (-again variants, short frame-referencing follow-ups). Worker turns are slow (often minutes) and a sent prompt becomes a permanent part of the session — there is no unsend — so compose the full body before calling and send one well-formed prompt rather than iterating by sending. Worker budget is per-turn: each call carries a fresh cost ceiling, so a worker reporting low budget mid-turn means the remaining work continues in another turn — never let the budget rail shrink the scope; descoping is a product decision that needs work-content reasons. Sending the reviewer a prompt whose tag starts with "review" counts as a review round against the phase’s backstop cap. A claude-bound worker’s context can be deliberately compacted: a body that is literally "/compact " followed by your instructions (e.g. an adapted compact-for-* snippet) resets that session in place, keeping what the instructions name; codex-bound workers compact themselves automatically, so this applies only to claude.',
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
          if (provider.name === 'codex' && turn.tokens) {
            state.costs.codexTokens.input += turn.tokens.input;
            state.costs.codexTokens.output += turn.tokens.output;
          }
          state.lastActivity = `send_prompt → ${args.role} (${args.tag})`;
          saveRunState(state);
          appendVoiceLog(state, args.role, `▶ response (session ${turn.sessionId})`, turn.text);
          log(`[send_prompt] ← ${args.role} responded (${turn.text.length} chars)`);
          return { content: [{ type: 'text' as const, text: turn.text }] };
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
          clearInterval(heartbeat);
        }
      },
    ),

    tool(
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
        state.pendingQuestion = { question: args.question, ...(args.context ? { context: args.context } : {}) };
        state.lastActivity = 'ask_human (queued)';
        saveRunState(state);
        outcome.questionQueued = true;
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

    tool(
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

    tool(
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
        saveRunState(state);
        outcome.advanceRequested = true;
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

    tool(
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

    tool(
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
   * set an outcome flag (advance requested, question queued) is ending the
   * turn, and guidance appended to a dying turn lands and dies — those steers
   * stay pending and ride the next harness prompt instead (carry-forward,
   * src/harness/driver.ts). Peek → append → mark-delivered order: a crash in
   * between redelivers (a repeated instruction is benign where a lost one is
   * not). The steer path is fail-soft — it must never corrupt a tool result.
   */
  const withSteerDelivery = (def: SdkMcpToolDefinition<any>): SdkMcpToolDefinition<any> => ({
    ...def,
    handler: async (args, extra) => {
      const result = await def.handler(args, extra);
      if (outcome.advanceRequested || outcome.questionQueued) return result;
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

  return { tools: tools.map(withSteerDelivery), outcome };
}

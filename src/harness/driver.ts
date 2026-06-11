import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { execa } from 'execa';
import { z } from 'zod';
import { DEFAULT_CLAUDE_MODEL } from '../config.ts';
import { ClaudeWorker } from '../providers/claude.ts';
import { CodexWorker } from '../providers/codex.ts';
import type { WorkerProvider } from '../providers/types.ts';
import { renderSnippetLibrary } from '../snippets.ts';
import {
  appendNote,
  appendVoiceLog,
  loadRunState,
  saveRunState,
} from '../run-state.ts';
import type { PhaseName, RunState } from '../run-state.ts';
import {
  ORCHESTRATOR_SYSTEM_PROMPT,
  answerResumePrompt,
  docsPhaseEntryPrompt,
  feedbackResumePrompt,
  framePhaseEntryPrompt,
  implPhaseEntryPrompt,
  nudgeContinuePrompt,
  openPhaseEntryPrompt,
  planPhaseEntryPrompt,
  prPhaseEntryPrompt,
  specPhaseEntryPrompt,
} from './orchestrator-prompts.ts';

/**
 * The phase driver — Layer 2's runtime. One invocation drives the
 * orchestrator session through one phase until it either advances
 * (advance_phase called, exit criteria summarized) or pauses on a queued
 * ask_human flag. The cooperative-pause pattern is Q11's verified mechanism:
 * tool handlers persist state at the moment of the call, the result text
 * nudges the orchestrator to end its turn, and the process exits at
 * quiescence — never a mechanical mid-call interrupt (those corrupt resume;
 * see src/spike/repro-*.ts).
 */

export interface DriverInput {
  runId: string;
  cwd: string;
  phase: PhaseName;
}

export interface DriverOutput {
  outcome: 'advanced' | 'flagged';
}

/** Runaway backstops, not exit mechanisms — generous by design (~2× observed rounds). */
export const ROUND_CAPS: Record<PhaseName, number> = {
  frame: 2,
  spec: 6,
  plan: 4,
  impl: 6,
  docs: 2,
  pr: 2,
  open: 1,
};

/**
 * Phases whose substance IS the review loop — advance_phase refuses with
 * zero rounds there. The others (synthesis, docs mechanics, PR mechanics)
 * may legitimately advance without the reviewer.
 */
const REVIEW_LOOP_PHASES: ReadonlySet<PhaseName> = new Set(['spec', 'plan', 'impl']);

/**
 * Per-phase rails. The AFK impl phase runs 1–3 hours with many worker turns,
 * so its ceilings are wider; hitting any of them flags the human rather than
 * crashing (the budget-exhausted result subtype and worker-timeout error both
 * land on the existing flag paths).
 */
const ORCHESTRATOR_MAX_BUDGET_USD: Record<PhaseName, number> = {
  frame: 15,
  spec: 15,
  plan: 15,
  impl: 30,
  docs: 10,
  pr: 10,
  open: 5,
};
const WORKER_MAX_BUDGET_USD: Record<PhaseName, number> = {
  frame: 10,
  spec: 10,
  plan: 10,
  impl: 25,
  docs: 10,
  pr: 10,
  open: 5,
};
const WORKER_TURN_TIMEOUT_MS: Record<PhaseName, number> = {
  frame: 30 * 60_000,
  spec: 30 * 60_000,
  plan: 30 * 60_000,
  impl: 60 * 60_000,
  docs: 30 * 60_000,
  pr: 30 * 60_000,
  open: 15 * 60_000,
};

export async function runPhase({ runId, cwd, phase }: DriverInput): Promise<DriverOutput> {
  const state = loadRunState(cwd, runId);

  // Consume the human input the CLI staged for this invocation.
  const pendingMessage = state.pendingMessage;
  delete state.pendingMessage;
  if (pendingMessage?.kind === 'answer') delete state.pendingQuestion;
  saveRunState(state);

  const workerBudgetUsd = WORKER_MAX_BUDGET_USD[phase];
  const workerTimeoutMs = WORKER_TURN_TIMEOUT_MS[phase];
  const providers: Record<'implementer' | 'reviewer', WorkerProvider> = {
    implementer:
      state.bindings.implementer.provider === 'claude'
        ? new ClaudeWorker({
            model: state.bindings.implementer.model ?? DEFAULT_CLAUDE_MODEL.implementer,
            maxBudgetUsd: workerBudgetUsd,
            timeoutMs: workerTimeoutMs,
          })
        : new CodexWorker({ timeoutMs: workerTimeoutMs }),
    reviewer:
      state.bindings.reviewer.provider === 'claude'
        ? new ClaudeWorker({
            model: state.bindings.reviewer.model ?? DEFAULT_CLAUDE_MODEL.reviewer,
            maxBudgetUsd: workerBudgetUsd,
            timeoutMs: workerTimeoutMs,
          })
        : new CodexWorker({ timeoutMs: workerTimeoutMs }),
  };

  // Per-invocation flags the tool handlers and the loop share.
  let advanceRequested = false;
  let questionQueued = false;
  let stagedAnswer = pendingMessage?.kind === 'answer' ? pendingMessage.text : null;

  // Colored [tag] prefixes on plain stdout — the no-tmux sink of the same
  // lines the voice logs carry (the concurrently/turbo idiom). TTY-only so
  // piped output stays clean.
  const TAG_COLORS: Record<string, string> = {
    '[orchestrator]': '\x1b[36m', // cyan
    '[send_prompt]': '\x1b[32m', // green
    '[ask_human]': '\x1b[33m', // yellow
    '[advance_phase]': '\x1b[33m',
    '[create_branch]': '\x1b[33m',
    '[propose_snippet_edit]': '\x1b[33m',
  };
  const log = (line: string) => {
    if (process.stdout.isTTY) {
      const tag = Object.keys(TAG_COLORS).find((t) => line.startsWith(t));
      if (tag) {
        console.log(`${TAG_COLORS[tag]}${tag}\x1b[0m${line.slice(tag.length)}`);
        return;
      }
    }
    console.log(line);
  };

  const tools = [
    tool(
      'list_snippets',
      'Read the snippet library: every prompt template the workflow uses, by key. The snippets encode the protocol’s conventions (altitude lenses, round-2 discipline, compaction shapes) — read them before composing worker prompts.',
      {},
      async () => ({ content: [{ type: 'text' as const, text: renderSnippetLibrary() }] }),
    ),

    tool(
      'send_prompt',
      'Send a prompt to a worker agent and return its final response. Each role is one persistent session: a later call to the same role continues that worker’s conversation, so refer back to earlier turns instead of repeating context the worker has already seen. Worker turns are slow (often minutes) — prefer one well-composed prompt over several small ones. Sending the reviewer a prompt whose tag starts with "review" counts as a review round against the phase’s backstop cap. A claude-bound worker’s context can be deliberately compacted: a body that is literally "/compact " followed by your instructions (e.g. an adapted compact-for-* snippet) resets that session in place, keeping what the instructions name; codex-bound workers compact themselves automatically, so this applies only to claude.',
      {
        role: z
          .enum(['implementer', 'reviewer'])
          .describe('implementer produces and revises artifacts (write access); reviewer critiques them (read-only).'),
        tag: z
          .string()
          .describe('Source snippet key this prompt was built from, e.g. "review-spec". Use "custom" if composed from scratch.'),
        body: z.string().describe('The full prompt text to send, after your per-turn adaptation.'),
      },
      async (args) => {
        const isReviewRound = args.role === 'reviewer' && args.tag.startsWith('review');
        const cap = ROUND_CAPS[phase];
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

        const provider = providers[args.role];
        log(`[send_prompt] → ${args.role} (${provider.name})  tag=${args.tag}  body=${args.body.length} chars`);
        appendVoiceLog(state, args.role, `◀ prompt (tag=${args.tag}, from orchestrator)`, args.body);

        try {
          const turn = await provider.runTurn({
            prompt: args.body,
            sessionId: state.workerSessions[args.role],
            readOnly: args.role === 'reviewer',
            cwd: state.cwd,
          });
          state.workerSessions[args.role] = turn.sessionId;
          if (isReviewRound) state.rounds[phase] = used + 1;
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
        questionQueued = true;
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
        artifacts: z.array(z.string()).describe('Paths or descriptions of the phase’s outputs (e.g. the spec file).'),
        spec_path: z
          .string()
          .optional()
          .describe('Repo-relative path of the spec file, when this phase produced or moved it — the harness records it for later phases.'),
      },
      async (args) => {
        const roundsRun = state.rounds[phase] ?? 0;
        if (REVIEW_LOOP_PHASES.has(phase) && roundsRun === 0) {
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
        advanceRequested = true;
        log(`[advance_phase] ${phase} phase complete (${roundsRun} review rounds)`);
        appendVoiceLog(state, 'orchestrator', `advance_phase (${phase})`, args.summary);
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Phase advance recorded — the run moves to the human gate. End your turn with a one-line status; the gate decision arrives as your next message.',
            },
          ],
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

  const options: Options = {
    model: state.bindings.orchestrator.model ?? DEFAULT_CLAUDE_MODEL.orchestrator,
    cwd: state.cwd,
    // Read-only by construction: no built-in tools, only the harness MCP
    // server, and no user-config MCP servers (strictMcpConfig — the Q11 spike
    // showed claude.ai connectors and plugins leaking into the surface).
    tools: [],
    strictMcpConfig: true,
    mcpServers: {
      orchestrator: createSdkMcpServer({
        name: 'orchestrator',
        version: '0.1.0',
        tools,
        // Tools must be present when a RESUMED session's first prompt is
        // built; without alwaysLoad, resume races MCP startup (Q11 finding).
        alwaysLoad: true,
      }),
    },
    allowedTools: [
      'mcp__orchestrator__list_snippets',
      'mcp__orchestrator__send_prompt',
      'mcp__orchestrator__ask_human',
      'mcp__orchestrator__advance_phase',
      'mcp__orchestrator__create_branch',
      'mcp__orchestrator__propose_snippet_edit',
      'mcp__orchestrator__write_note',
    ],
    maxBudgetUsd: ORCHESTRATOR_MAX_BUDGET_USD[phase],
    systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
    // send_prompt calls outlive the default 60s SDK MCP stream window.
    env: { ...process.env, CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: String(2 * 60 * 60_000) },
    ...(state.orchestratorSessionId ? { resume: state.orchestratorSessionId } : {}),
  };

  const prompt = buildPrompt(state, phase, pendingMessage);

  appendVoiceLog(state, 'orchestrator', `◀ harness prompt (phase=${phase})`, prompt);
  let outcome = await driveTurn(state, prompt, options);

  if (outcome === 'continue') {
    // The orchestrator ended its turn without advancing or flagging — nudge
    // once, then treat persistent silence as a flag so the human sees it.
    appendVoiceLog(state, 'orchestrator', '◀ harness nudge (turn ended without advance/flag)');
    outcome = await driveTurn(state, nudgeContinuePrompt(), {
      ...options,
      ...(state.orchestratorSessionId ? { resume: state.orchestratorSessionId } : {}),
    });
    if (outcome === 'continue') {
      state.pendingQuestion = {
        question:
          'The orchestrator twice ended its turn without advancing the phase or asking a question — the run is stuck. Check the orchestrator log and answer with how to proceed.',
      };
      saveRunState(state);
      outcome = 'flagged';
    }
  }

  return { outcome };

  async function driveTurn(
    runState: RunState,
    turnPrompt: string,
    turnOptions: Options,
  ): Promise<'advanced' | 'flagged' | 'continue'> {
    const q = query({ prompt: turnPrompt, options: turnOptions });
    for await (const message of q as AsyncIterable<SDKMessage>) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'text') {
            const text = (block as { text: string }).text;
            log(`[orchestrator] ${text}`);
            appendVoiceLog(runState, 'orchestrator', '▶ orchestrator', text);
          }
        }
      } else if (message.type === 'result') {
        runState.orchestratorSessionId = message.session_id;
        runState.costs.orchestratorUsd += message.total_cost_usd;
        saveRunState(runState);
        if (message.subtype !== 'success') {
          // Budget/turn caps and execution errors become flags, not crashes —
          // the human decides whether to top up and continue.
          runState.pendingQuestion = {
            question: `The orchestrator run ended abnormally (${message.subtype}). Check the orchestrator log; answer with how to proceed (the session resumes from where it stopped).`,
          };
          saveRunState(runState);
          return 'flagged';
        }
      }
    }
    if (advanceRequested) return 'advanced';
    if (questionQueued) return 'flagged';
    return 'continue';
  }
}

function buildPrompt(
  state: RunState,
  phase: PhaseName,
  pendingMessage: { kind: 'answer' | 'feedback'; text: string } | undefined,
): string {
  if (!state.phaseStarted[phase]) {
    state.phaseStarted[phase] = true;
    saveRunState(state);
    const cap = ROUND_CAPS[phase];
    switch (phase) {
      case 'frame':
        return framePhaseEntryPrompt(state, cap);
      case 'spec':
        return specPhaseEntryPrompt(state, cap);
      case 'plan':
        return planPhaseEntryPrompt(state, cap);
      case 'impl':
        return implPhaseEntryPrompt(state, cap);
      case 'docs':
        return docsPhaseEntryPrompt(state, cap);
      case 'pr':
        return prPhaseEntryPrompt(state, cap);
      case 'open':
        return openPhaseEntryPrompt(state);
    }
  }
  if (pendingMessage?.kind === 'answer') return answerResumePrompt(pendingMessage.text);
  if (pendingMessage?.kind === 'feedback') return feedbackResumePrompt(phase, pendingMessage.text);
  // Re-entered the phase with no staged input (e.g. recovery after a crash):
  // ask the orchestrator to take stock and continue.
  return nudgeContinuePrompt();
}

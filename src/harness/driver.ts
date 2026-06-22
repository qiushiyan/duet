import { createSdkMcpServer, query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKMessage, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { colorizeDriverLine } from '../colorize.ts';
import { DEFAULT_CLAUDE_MODEL } from '../config.ts';
import { PHASE } from '../phases.ts';
import type { PhaseName } from '../phases.ts';
import { createWorkers } from '../providers/index.ts';
import {
  appendVoiceLog,
  budgetFor,
  consumeHumanInput,
  listPendingSteers,
  loadRunState,
  markSteersDelivered,
  recordContextUsage,
  saveRunState,
} from '../run-store.ts';
import type { HumanMessage, RunState } from '../run-store.ts';
import { readRoleTranscriptTail } from '../sessions.ts';
import { classifyError, currentTerminalError, retryDecision } from '../worker-health.ts';
import type { ErrorClass } from '../worker-health.ts';
import { markerToEvent } from './phase-events.ts';
import type { PhaseEvent } from './phase-events.ts';
import { createPhaseTools } from './tools.ts';
import type { KernelTool } from './tools.ts';
import {
  ORCHESTRATOR_SYSTEM_PROMPT,
  answerResumePrompt,
  approvalRiderBlock,
  buildPhaseBrief,
  feedbackResumePrompt,
  nudgeContinuePrompt,
  renderSteerBlock,
} from './orchestrator-prompts.ts';

/**
 * The phase driver — Layer 2's runtime. One invocation drives the
 * orchestrator session through one phase until it either advances
 * (advance_phase called, exit criteria summarized) or pauses on a queued
 * ask_human flag. The cooperative-pause pattern is the spike-verified mechanism:
 * tool handlers persist state at the moment of the call, the result text
 * nudges the orchestrator to end its turn, and the process exits at
 * quiescence — never a mechanical mid-call interrupt (those corrupt resume;
 * see src/spike/repro-*.ts).
 *
 * The tool surface itself — and every protocol rail it enforces — lives in
 * ./tools.ts; this module hosts it inside an SDK session and resolves the
 * session's end into the machine's phase.* event vocabulary (./phase-events.ts).
 */

export interface DriverInput {
  runId: string;
  cwd: string;
  phase: PhaseName;
}

/**
 * One orchestrator turn — the SDK boundary, injectable for tests. Given the
 * turn's prompt, the session options, and the harness tools, yield the
 * session's messages (invoking tools as the model chooses).
 */
export type RunOrchestratorTurn = (args: {
  prompt: string;
  options: Options;
  tools: Array<KernelTool<any>>;
}) => AsyncIterable<SDKMessage>;

/**
 * The in-process host adapter: a KernelTool is structurally an Agent SDK tool
 * definition, so this is a re-typing, not a rewrite. Keeping the SDK tool shape
 * here (rather than in the registry) is the point — the kernel surface stays
 * host-neutral; only this adapter knows the Agent SDK.
 */
export const toSdkTools = (tools: Array<KernelTool<any>>): Array<SdkMcpToolDefinition<any>> =>
  tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    ...(t.annotations ? { annotations: t.annotations } : {}),
    handler: t.handler,
  }));

const sdkTurn: RunOrchestratorTurn = ({ prompt, options, tools }) =>
  query({
    prompt,
    options: {
      ...options,
      mcpServers: {
        orchestrator: createSdkMcpServer({
          name: 'orchestrator',
          version: '0.1.0',
          tools: toSdkTools(tools),
          // Tools must be present when a RESUMED session's first prompt is
          // built; without alwaysLoad, resume races MCP startup (spike finding).
          alwaysLoad: true,
        }),
      },
      allowedTools: tools.map((t) => `mcp__orchestrator__${t.name}`),
    },
  }) as AsyncIterable<SDKMessage>;

export async function runPhase(
  { runId, cwd, phase }: DriverInput,
  runTurn: RunOrchestratorTurn = sdkTurn,
): Promise<PhaseEvent> {
  const state = loadRunState(cwd, runId);

  // Crash re-entry into the SAME phase: a terminal marker for this phase
  // survived from a session that decided before the machine could transition
  // (the snapshot was never saved). Re-emit that decision without re-running
  // the session — the packet it carries was persisted atomically with it. A
  // terminal outcome ends the retry episode, so conclude it (reset retryState).
  const persisted = markerToEvent(state.terminalMarker, phase);
  if (persisted) return concludeEpisode(state, persisted);

  // The first attempt consumes any staged human input; a retry re-enters as a
  // pure session resume (the input was already consumed), so it must not replay.
  let pendingMessage = consumeHumanInput(state);

  for (;;) {
    try {
      return concludeEpisode(state, await drivePhase(state, phase, pendingMessage, runTurn));
    } catch (err) {
      // A terminal decision the orchestrator persisted before the stream threw
      // IS the phase outcome — first-terminal-wins means a throw cannot override
      // it into a false infra flag or a spurious retry. Honor it BEFORE the crash
      // log/classification: within this invocation a this-phase marker can only
      // have been written by this turn's terminal tool call (a pre-existing one
      // was consumed at entry above), so it is the live decision, returned once.
      const decided = markerToEvent(state.terminalMarker, phase);
      if (decided) return concludeEpisode(state, decided);

      // A genuine infrastructure failure (SDK crash, spawn failure, driver bug)
      // is classified BEFORE any flag is persisted, so opt-in auto-retry can
      // resume a transient class in-process (the existing session-resume path)
      // rather than parking the human. The retry policy is the single
      // retryDecision mechanism: default-off, auth-once, login/quota/unknown
      // never retried, exhaustion → flag.
      const detail = err instanceof Error ? err.message : String(err);
      console.log(`[driver] ✗ ${phase} phase crashed: ${detail}`);
      const errorClass = classifyInfraError(state, detail);
      const decision = retryDecision(errorClass, state.retryState, state.retryInfra ?? 0);
      if (decision.action === 'retry') {
        state.retryState = decision.nextRetryState;
        saveRunState(state);
        console.log(
          `[driver] infra ${errorClass} — auto-retry ${decision.nextRetryState.attempts}/${state.retryInfra} after ${Math.round(decision.delayMs / 1000)}s`,
        );
        await new Promise((resolve) => setTimeout(resolve, decision.delayMs));
        pendingMessage = undefined; // retry = resume; never replay consumed input
        continue;
      }
      // Escalate: a question the orchestrator already queued this invocation
      // wins (it is the more meaningful one, and stays cause:'human'); otherwise
      // queue the infra question with its classified cause/class.
      if (!state.pendingQuestion) {
        state.pendingQuestion = {
          question: `The ${phase} phase failed at the infrastructure layer (${detail}). Check driver.log and the orchestrator log; answer with how to proceed — the orchestrator session resumes from its last completed turn.`,
          cause: 'infra',
          errorClass: decision.errorClass,
        };
        saveRunState(state);
      }
      return { type: 'phase.flag' };
    }
  }
}

/**
 * Conclude a phase's retry episode: a terminal/clean outcome ends it, so reset
 * the per-episode retry budget (persisted across re-spawns only while an episode
 * is live) before returning the event. The single concluding path behind all
 * three terminal exits — entry replay, a marker honored in the catch, and a
 * clean drivePhase outcome — so the cleanup can't drift between them. Touches
 * only retryState, never the terminal marker (its deliver-before-clear lifecycle
 * is the machine's, unchanged).
 */
function concludeEpisode(state: RunState, event: PhaseEvent): PhaseEvent {
  if (state.retryState) {
    delete state.retryState;
    saveRunState(state);
  }
  return event;
}

/**
 * Classify a caught phase failure: the CURRENT failure (the thrown message) is
 * authoritative; only when that is opaque (`unknown`) do we consult the
 * orchestrator transcript's most recent terminal error — and only a RECENT one,
 * so a stale error a later turn already recovered from is never read as the
 * current cause (the #1 staleness lesson, applied to classification).
 */
function classifyInfraError(state: RunState, detail: string): ErrorClass {
  const fromThrow = classifyError(detail);
  if (fromThrow !== 'unknown') return fromThrow;
  try {
    const tail = readRoleTranscriptTail(state, 'orchestrator');
    // Only a LIVE terminal error may name an opaque throw — recent AND not
    // superseded by later activity, the same rule the `crashed` verdict uses,
    // shared via currentTerminalError so a recovered error never hijacks the
    // class (and so an `unknown` throw stays `unknown`, never auto-retried).
    const cur = tail ? currentTerminalError(tail.jsonl, tail.schema, Date.now()) : undefined;
    if (cur) return cur.errorClass;
  } catch {
    // best-effort — a transcript read failure leaves the throw's classification
  }
  return 'unknown';
}

async function drivePhase(
  state: RunState,
  phase: PhaseName,
  pendingMessage: HumanMessage | undefined,
  runTurn: RunOrchestratorTurn,
): Promise<PhaseEvent> {
  // Narration goes to plain stdout — the detached driver's log file. The
  // [tag] palette is applied through the one view-time colorizer (picocolors
  // auto-disables off-TTY, so the file stays plain; `duet logs` and the tmux
  // panes re-apply it where a human is watching).
  const log = (line: string) => console.log(colorizeDriverLine(line));

  const budget = budgetFor(state, phase);
  const { tools } = createPhaseTools({
    state,
    phase,
    providers: createWorkers(state.bindings, {
      workerBudgetUsd: budget.worker,
      timeoutMs: PHASE[phase].workerTurnTimeoutMs,
    }),
    log,
    ...(pendingMessage?.kind === 'answer' ? { stagedAnswer: pendingMessage.text } : {}),
  });

  const options: Options = {
    model: state.bindings.orchestrator.model ?? DEFAULT_CLAUDE_MODEL.orchestrator,
    cwd: state.cwd,
    // Read-only by construction: no built-in tools, only the harness MCP
    // server (attached by sdkTurn), and no user-config MCP servers
    // (strictMcpConfig — the substrate spike showed claude.ai connectors and
    // plugins leaking into the surface).
    tools: [],
    strictMcpConfig: true,
    // Set only when defined — an undefined cap (budgets off) omits the SDK option.
    ...(budget.orchestrator !== undefined ? { maxBudgetUsd: budget.orchestrator } : {}),
    systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
    // send_prompt calls outlive the default 60s SDK MCP stream window.
    env: { ...process.env, CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: String(2 * 60 * 60_000) },
    ...(state.orchestratorSessionId ? { resume: state.orchestratorSessionId } : {}),
  };

  const prompt = buildPrompt(state, phase, pendingMessage);

  appendVoiceLog(state, 'orchestrator', `◀ harness prompt (phase=${phase})`, prompt);
  let result = await driveTurn(prompt, options);

  if (result === 'continue') {
    // The orchestrator ended its turn without advancing or flagging — nudge
    // once, then treat persistent silence as a flag so the human sees it.
    appendVoiceLog(state, 'orchestrator', '◀ harness nudge (turn ended without advance/flag)');
    result = await driveTurn(nudgeContinuePrompt(), {
      ...options,
      ...(state.orchestratorSessionId ? { resume: state.orchestratorSessionId } : {}),
    });
    if (result === 'continue') {
      state.pendingQuestion = {
        question:
          'The orchestrator twice ended its turn without advancing the phase or asking a question — the run is stuck. Check the orchestrator log and answer with how to proceed.',
        cause: 'infra',
        errorClass: 'unknown',
      };
      saveRunState(state);
      result = 'flagged';
    }
  }

  return result === 'advanced' ? { type: 'phase.advance' } : { type: 'phase.flag' };

  async function driveTurn(turnPrompt: string, turnOptions: Options): Promise<'advanced' | 'flagged' | 'continue'> {
    // The last request's usage IS the current context fill (fresh input +
    // cache reads + cache writes + output — the claude statusline formula);
    // the result message's modelUsage supplies the window.
    let lastUsage: { input_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null; output_tokens?: number } | undefined;
    for await (const message of runTurn({ prompt: turnPrompt, options: turnOptions, tools })) {
      if (message.type === 'assistant') {
        if (message.message.usage) lastUsage = message.message.usage;
        for (const block of message.message.content) {
          if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'text') {
            const text = (block as { text: string }).text;
            log(`[orchestrator] ${text}`);
            appendVoiceLog(state, 'orchestrator', '▶ orchestrator', text);
          }
        }
      } else if (message.type === 'result') {
        state.orchestratorSessionId = message.session_id;
        state.costs.orchestratorUsd += message.total_cost_usd;
        const windowTokens = Math.max(0, ...Object.values(message.modelUsage ?? {}).map((m) => m.contextWindow ?? 0));
        if (lastUsage && windowTokens > 0) {
          recordContextUsage(state, 'orchestrator', {
            usedTokens:
              (lastUsage.input_tokens ?? 0) +
              (lastUsage.cache_read_input_tokens ?? 0) +
              (lastUsage.cache_creation_input_tokens ?? 0) +
              (lastUsage.output_tokens ?? 0),
            windowTokens,
          });
        }
        saveRunState(state);
        if (message.subtype !== 'success') {
          // Abnormal exits become flags, not crashes — the human decides how to
          // proceed. An orchestrator budget cap is its OWN cause: a real stop,
          // but resumable (raise the budget / resume), distinct from both an
          // infra-retry and a human-product question — so it carries cause:
          // 'budget' and no errorClass (budget is not an infra taxonomy class).
          // Every other abnormal subtype stays infra-caused but not a taxonomy
          // class (a turn/execution error is not network/auth), so it is never
          // auto-retried — errorClass:'unknown'.
          state.pendingQuestion =
            message.subtype === 'error_max_budget_usd'
              ? {
                  question: `The orchestrator reached its budget cap (${message.subtype}). This is a budget-control stop, not an infrastructure failure: raise the budget or resume, and the session continues from where it stopped.`,
                  cause: 'budget',
                }
              : {
                  question: `The orchestrator run ended abnormally (${message.subtype}). Check the orchestrator log; answer with how to proceed (the session resumes from where it stopped).`,
                  cause: 'infra',
                  errorClass: 'unknown',
                };
          saveRunState(state);
          return 'flagged';
        }
      }
    }
    // The terminal decision is read from the persisted marker (set by
    // advance_phase/ask_human on the live state this loop shares), not a polled
    // flag — the one channel every host reads, in or across a process boundary.
    // Phase-scoped: a stale marker from a prior phase reads as continue.
    const event = markerToEvent(state.terminalMarker, phase);
    if (event) return event.type === 'phase.advance' ? 'advanced' : 'flagged';
    return 'continue';
  }
}

/**
 * The turn's prompt: the phase entry or resume prompt, plus the rider when
 * the gate just crossed was approved with one, plus any steers that missed
 * their delivery window (the phase ended, or the run was paused, before
 * another tool result could carry them). Draining steers here mirrors
 * consumeHumanInput's consume-then-crash trade: a crash between this drain and
 * the turn reaching the model loses the carry — accepted, the voice log keeps
 * the evidence — where not draining would redeliver into every later prompt.
 */
function buildPrompt(
  state: RunState,
  phase: PhaseName,
  pendingMessage: HumanMessage | undefined,
): string {
  let prompt = basePrompt(state, phase, pendingMessage);
  if (pendingMessage?.kind === 'approval') {
    appendVoiceLog(state, 'orchestrator', '◀ approval rider (attached to the gate decision)', pendingMessage.text);
    prompt = `${prompt}\n\n${approvalRiderBlock(pendingMessage.text)}`;
  }
  const steers = listPendingSteers(state);
  if (steers.length === 0) return prompt;
  markSteersDelivered(state, steers);
  for (const steer of steers) {
    appendVoiceLog(
      state,
      'orchestrator',
      `human steer carried forward (staged ${steer.stagedAt}${steer.stagedDuring ? `, during ${steer.stagedDuring}` : ''})`,
      steer.text,
    );
  }
  return `${prompt}\n\n${renderSteerBlock(steers, 'carried')}`;
}

function basePrompt(
  state: RunState,
  phase: PhaseName,
  pendingMessage: HumanMessage | undefined,
): string {
  if (!state.phaseStarted[phase]) {
    state.phaseStarted[phase] = true;
    saveRunState(state);
    return buildPhaseBrief(state, phase);
  }
  if (pendingMessage?.kind === 'answer') return answerResumePrompt(pendingMessage.text);
  if (pendingMessage?.kind === 'feedback') return feedbackResumePrompt(phase, pendingMessage.text);
  // Re-entered the phase with no staged input (e.g. recovery after a crash):
  // ask the orchestrator to take stock and continue.
  return nudgeContinuePrompt();
}

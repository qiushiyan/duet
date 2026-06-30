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
  loadRunState,
  recordContextUsage,
  recordPhaseLabel,
  saveRunState,
} from '../run-store.ts';
import type { HumanMessage, RunState } from '../run-store.ts';
import { listPendingSteers, markSteersDelivered } from '../steer-store.ts';
import { readRoleTranscriptTail } from '../sessions.ts';
import { classifyError, currentTerminalError } from '../worker-health.ts';
import type { ErrorClass } from '../worker-health.ts';
import { markerToEvent } from './phase-events.ts';
import type { PhaseEvent } from './phase-events.ts';
import { runHostedPhase } from './host-runner.ts';
import type { HostedSession, PhaseHost, PhaseInput, TurnOutcome } from './host-runner.ts';
import { createPhaseTools } from './tools.ts';
import type { KernelTool } from './tools.ts';
import {
  orchestratorSystemPrompt,
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
 *
 * The phase RUN LOOP — entry marker-replay, nudge-once, the twice-ended flag,
 * crash → flag + opt-in retry — is shared with the stdio host in
 * ./host-runner.ts; this module is now the in-process `PhaseHost` adapter
 * (`makeInProcessHost`): it drives one SDK turn, classifies a failure with the
 * staleness-aware `classifyInfraError`, and opts into retry (the one headless
 * place auto-retry runs).
 */

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

export async function runPhase(input: PhaseInput, runTurn: RunOrchestratorTurn = sdkTurn): Promise<PhaseEvent> {
  return runHostedPhase(input, makeInProcessHost(runTurn));
}

/** Driver narration → plain stdout (the detached driver's log file). The [tag]
 *  palette is view-time only: picocolors auto-disables off-TTY, so the file stays
 *  plain; `duet logs` and the tmux panes re-apply color where a human watches. */
const driverLog = (line: string): void => console.log(colorizeDriverLine(line));

/**
 * The in-process `PhaseHost`: an Agent SDK orchestrator session driven in this
 * process. `openSession` builds the tool surface and SDK options once — consuming
 * any staged human input — and each `driveTurn` streams one SDK turn (the phase
 * prompt, then the nudge). `classifyFailure` is the staleness-aware
 * `classifyInfraError`; `retryable` is true (the headless driver is the one place
 * opt-in infra auto-retry runs). The run-loop rails around it live in
 * ./host-runner.ts.
 */
function makeInProcessHost(runTurn: RunOrchestratorTurn): PhaseHost {
  return {
    retryable: true,
    classifyFailure: classifyInfraError,
    async openSession({ runId, cwd, phase }): Promise<HostedSession> {
      const state = loadRunState(cwd, runId);
      // The first attempt consumes any staged human input; a retry re-opens and
      // finds it already consumed (consumeHumanInput persists), so the resumed
      // turn falls to the nudge prompt and never replays.
      const pendingMessage = consumeHumanInput(state);
      const budget = budgetFor(state, phase);
      const { tools } = createPhaseTools({
        state,
        phase,
        providers: createWorkers(state.bindings, {
          workerBudgetUsd: budget.worker,
          timeoutMs: PHASE[phase].workerTurnTimeoutMs,
        }),
        log: driverLog,
        ...(pendingMessage?.kind === 'answer' ? { stagedAnswer: pendingMessage.text } : {}),
      });
      const options = buildOrchestratorOptions(state, budget);
      return {
        async driveTurn(kind): Promise<TurnOutcome> {
          if (kind === 'phase') {
            const prompt = buildPrompt(state, phase, pendingMessage);
            // Refresh the view-only phase sidecar the tmux orchestrator border reads.
            recordPhaseLabel(state, phase);
            appendVoiceLog(state, 'orchestrator', `◀ harness prompt (phase=${phase})`, prompt);
            return streamTurn(state, phase, prompt, options, tools, runTurn);
          }
          // The nudge continues the SAME session, so re-attach resume (the phase
          // turn set orchestratorSessionId).
          appendVoiceLog(state, 'orchestrator', '◀ harness nudge (turn ended without advance/flag)');
          const nudgeOptions: Options = {
            ...options,
            ...(state.orchestratorSessionId ? { resume: state.orchestratorSessionId } : {}),
          };
          return streamTurn(state, phase, nudgeContinuePrompt(), nudgeOptions, tools, runTurn);
        },
        async close(): Promise<void> {
          // No persistent resources — the SDK query is per turn.
        },
      };
    },
  };
}

/** The orchestrator session's SDK options: read-only by construction (no
 *  built-in tools, only the harness MCP server attached by sdkTurn; no
 *  user-config MCP servers via strictMcpConfig — the spike showed claude.ai
 *  connectors leaking in). The budget cap and resume id are set only when
 *  present. */
export function buildOrchestratorOptions(state: RunState, budget: ReturnType<typeof budgetFor>): Options {
  return {
    model: state.bindings.orchestrator.model ?? DEFAULT_CLAUDE_MODEL.orchestrator,
    cwd: state.cwd,
    tools: [],
    strictMcpConfig: true,
    ...(budget.orchestrator !== undefined ? { maxBudgetUsd: budget.orchestrator } : {}),
    systemPrompt: orchestratorSystemPrompt(state),
    // send_prompt calls outlive the default 60s SDK MCP stream window; and
    // API_FORCE_IDLE_TIMEOUT=1 forces the native byte-stream idle watchdog on for
    // the orchestrator's own SDK session, so a stalled orchestrator connection
    // aborts in ~5 min (the headless host then classifies + auto-retries it).
    env: {
      ...process.env,
      CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: String(2 * 60 * 60_000),
      API_FORCE_IDLE_TIMEOUT: '1',
    },
    ...(state.orchestratorSessionId ? { resume: state.orchestratorSessionId } : {}),
  };
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

/**
 * Stream ONE orchestrator turn over the SDK seam and report its TurnOutcome —
 * the in-process host's per-turn mechanics, called by `makeInProcessHost`'s
 * `driveTurn` for both the phase prompt and the nudge. It logs the assistant
 * text, captures the orchestrator's own cost/context, and turns an abnormal
 * result subtype into a self-flag (a budget cap is its own resumable cause; any
 * other abnormal exit is an infra flag, never auto-retried), then reads the
 * persisted terminal marker (set by advance_phase/ask_human on the shared
 * in-memory state) to map the turn to advanced / flagged / continue.
 */
async function streamTurn(
  state: RunState,
  phase: PhaseName,
  turnPrompt: string,
  turnOptions: Options,
  tools: Array<KernelTool<any>>,
  runTurn: RunOrchestratorTurn,
): Promise<TurnOutcome> {
  // The last request's usage IS the current context fill (fresh input + cache
  // reads + cache writes + output — the claude statusline formula); the result
  // message's modelUsage supplies the window.
  let lastUsage: { input_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null; output_tokens?: number } | undefined;
  for await (const message of runTurn({ prompt: turnPrompt, options: turnOptions, tools })) {
    if (message.type === 'assistant') {
      if (message.message.usage) lastUsage = message.message.usage;
      for (const block of message.message.content) {
        if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'text') {
          const text = (block as { text: string }).text;
          driverLog(`[orchestrator] ${text}`);
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
        // First-terminal-wins: if the orchestrator already recorded a terminal
        // decision THIS turn (advance_phase / ask_human persisted a marker), that
        // decision owns the outcome — an abnormal SDK exit must not overwrite the
        // real decision or its queued question. This mirrors the run loop's catch
        // for the throw path (host-runner.ts); here it guards the in-band result
        // path, where a coincident budget/abnormal exit would otherwise clobber a
        // just-queued ask_human question or mask a recorded advance.
        const decided = markerToEvent(state.terminalMarker, phase);
        if (decided) return decided.type === 'phase.advance' ? 'advanced' : 'flagged';
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
                question: `The orchestrator run ended abnormally (${message.subtype}). Run duet doctor for per-role health, or check the orchestrator log; answer with how to proceed (the session resumes from where it stopped).`,
                cause: 'infra',
                errorClass: 'unknown',
              };
        saveRunState(state);
        return 'flagged';
      }
    }
  }
  // The terminal decision is read from the persisted marker (set by
  // advance_phase/ask_human on the live state this turn shares), not a polled
  // flag — the one channel every host reads. Phase-scoped: a stale marker from a
  // prior phase reads as continue, leaving the run-loop's nudge/flag to resolve it.
  const event = markerToEvent(state.terminalMarker, phase);
  if (event) return event.type === 'phase.advance' ? 'advanced' : 'flagged';
  return 'continue';
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

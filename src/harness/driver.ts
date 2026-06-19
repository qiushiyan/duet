import { createSdkMcpServer, query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKMessage, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { colorizeDriverLine } from '../colorize.ts';
import { DEFAULT_CLAUDE_MODEL } from '../config.ts';
import { PHASE } from '../phases.ts';
import type { PhaseName } from '../phases.ts';
import { createWorkers } from '../providers/index.ts';
import {
  appendVoiceLog,
  consumeHumanInput,
  listPendingSteers,
  loadRunState,
  markSteersDelivered,
  recordContextUsage,
  saveRunState,
} from '../run-store.ts';
import type { HumanMessage, RunState } from '../run-store.ts';
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
  // the session — the packet it carries was persisted atomically with it.
  const persisted = markerToEvent(state.terminalMarker, phase);
  if (persisted) return persisted;

  const pendingMessage = consumeHumanInput(state);

  try {
    return await drivePhase(state, phase, pendingMessage, runTurn);
  } catch (err) {
    // An infrastructure failure (SDK crash, spawn failure, driver bug) must
    // land the human on an actionable question, not a silent flag-wait. A
    // question the orchestrator already queued this invocation wins — it is
    // the more meaningful one; the crash detail is in driver.log either way.
    const detail = err instanceof Error ? err.message : String(err);
    console.log(`[driver] ✗ ${phase} phase crashed: ${detail}`);
    if (!state.pendingQuestion) {
      state.pendingQuestion = {
        question: `The ${phase} phase crashed at the infrastructure layer (${detail}). Check driver.log and the orchestrator log; answer with how to proceed — the orchestrator session resumes from its last completed turn.`,
      };
      saveRunState(state);
    }
    return { type: 'phase.flag' };
  }
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

  const { tools } = createPhaseTools({
    state,
    phase,
    providers: createWorkers(state.bindings, {
      workerBudgetUsd: PHASE[phase].workerBudgetUsd,
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
    maxBudgetUsd: PHASE[phase].orchestratorBudgetUsd,
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
          // Budget/turn caps and execution errors become flags, not crashes —
          // the human decides whether to top up and continue.
          state.pendingQuestion = {
            question: `The orchestrator run ended abnormally (${message.subtype}). Check the orchestrator log; answer with how to proceed (the session resumes from where it stopped).`,
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

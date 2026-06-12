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
  loadRunState,
  saveRunState,
} from '../run-store.ts';
import type { HumanMessage, RunState } from '../run-store.ts';
import { createPhaseTools } from './tools.ts';
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
 *
 * The tool surface itself — and every protocol rail it enforces — lives in
 * ./tools.ts; this module hosts it inside an SDK session and maps the
 * session's end into the statechart's outcome vocabulary.
 */

export interface DriverInput {
  runId: string;
  cwd: string;
  phase: PhaseName;
}

export interface DriverOutput {
  outcome: 'advanced' | 'flagged';
}

/**
 * One orchestrator turn — the SDK boundary, injectable for tests. Given the
 * turn's prompt, the session options, and the harness tools, yield the
 * session's messages (invoking tools as the model chooses).
 */
export type RunOrchestratorTurn = (args: {
  prompt: string;
  options: Options;
  tools: Array<SdkMcpToolDefinition<any>>;
}) => AsyncIterable<SDKMessage>;

const sdkTurn: RunOrchestratorTurn = ({ prompt, options, tools }) =>
  query({
    prompt,
    options: {
      ...options,
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
      allowedTools: tools.map((t) => `mcp__orchestrator__${t.name}`),
    },
  }) as AsyncIterable<SDKMessage>;

export async function runPhase(
  { runId, cwd, phase }: DriverInput,
  runTurn: RunOrchestratorTurn = sdkTurn,
): Promise<DriverOutput> {
  const state = loadRunState(cwd, runId);
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
    return { outcome: 'flagged' };
  }
}

async function drivePhase(
  state: RunState,
  phase: PhaseName,
  pendingMessage: HumanMessage | undefined,
  runTurn: RunOrchestratorTurn,
): Promise<DriverOutput> {
  // Narration goes to plain stdout — the detached driver's log file. The
  // [tag] palette is applied through the one view-time colorizer (picocolors
  // auto-disables off-TTY, so the file stays plain; `duet logs` and the tmux
  // panes re-apply it where a human is watching).
  const log = (line: string) => console.log(colorizeDriverLine(line));

  const { tools, outcome } = createPhaseTools({
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
    // (strictMcpConfig — the Q11 spike showed claude.ai connectors and
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

  return { outcome: result };

  async function driveTurn(turnPrompt: string, turnOptions: Options): Promise<'advanced' | 'flagged' | 'continue'> {
    for await (const message of runTurn({ prompt: turnPrompt, options: turnOptions, tools })) {
      if (message.type === 'assistant') {
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
    if (outcome.advanceRequested) return 'advanced';
    if (outcome.questionQueued) return 'flagged';
    return 'continue';
  }
}

function buildPrompt(
  state: RunState,
  phase: PhaseName,
  pendingMessage: HumanMessage | undefined,
): string {
  if (!state.phaseStarted[phase]) {
    state.phaseStarted[phase] = true;
    saveRunState(state);
    const cap = PHASE[phase].roundCap;
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
        return openPhaseEntryPrompt();
    }
  }
  if (pendingMessage?.kind === 'answer') return answerResumePrompt(pendingMessage.text);
  if (pendingMessage?.kind === 'feedback') return feedbackResumePrompt(phase, pendingMessage.text);
  // Re-entered the phase with no staged input (e.g. recovery after a crash):
  // ask the orchestrator to take stock and continue.
  return nudgeContinuePrompt();
}

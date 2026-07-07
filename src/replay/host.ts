import { createSdkMcpServer, query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { budgetFor, loadRunState, recordContextUsage, saveRunState } from '../run/store.ts';
import type { RunState } from '../run/store.ts';
import type { PhaseName } from '../registry/workflows.ts';
import { classifyError } from '../voices/health.ts';
import type { ErrorClass } from '../voices/health.ts';
import { markerToEvent } from '../run/phase-events.ts';
import type { HostedSession, PhaseHost, TurnOutcome } from '../orchestrator/hosts/host-runner.ts';
import { createPhaseTools } from '../orchestrator/tools.ts';
import type { KernelTool } from '../orchestrator/tools.ts';
import { buildOrchestratorOptions, toSdkTools } from '../orchestrator/hosts/driver.ts';
import type { RunOrchestratorTurn } from '../orchestrator/hosts/driver.ts';
import type { WorkerProviders } from '../voices/providers/types.ts';

export interface CapturedSendPrompt {
  readonly kind: 'send_prompt';
  readonly duty: readonly string[];
  readonly tag: string;
  readonly body: string;
}

export interface CapturedTerminal {
  readonly kind: 'terminal';
  readonly verb: 'advance_phase' | 'ask_human';
  readonly body: string;
}

export interface CapturedRefusedSendPrompt extends CapturedSendPrompt {
  readonly reason: string;
}

export type CapturedToolEvent = CapturedSendPrompt | CapturedTerminal;

export interface ReplayHostCapture {
  readonly events: CapturedToolEvent[];
  readonly refusedSends: CapturedRefusedSendPrompt[];
  readonly notes: string[];
}

export interface ReplayHostOptions {
  readonly providers: WorkerProviders;
  readonly recordedBrief: string;
  readonly outputDir: string;
  readonly runTurn?: RunOrchestratorTurn;
  readonly log?: (line: string) => void;
}

export function makeReplayHost(options: ReplayHostOptions): { host: PhaseHost; capture: ReplayHostCapture } {
  const capture: ReplayHostCapture = { events: [], refusedSends: [], notes: [] };
  return {
    capture,
    host: {
      retryable: false,
      classifyFailure: (_state: RunState, detail: string): ErrorClass => classifyError(detail),
      async openSession({ runId, cwd, phase }): Promise<HostedSession> {
        const state = loadRunState(cwd, runId);
        const budget = budgetFor(state, phase);
        const providerHome = join(options.outputDir, 'provider-home');
        const tools = wrapTools(
          createPhaseTools({
            state,
            phase,
            providers: options.providers,
            log: options.log ?? (() => {}),
          }).tools,
          options.recordedBrief,
          capture,
        );
        const turnOptions = replayOrchestratorOptions(state, budget, providerHome);
        const runTurn = options.runTurn ?? defaultReplayTurn;
        return {
          async driveTurn(kind): Promise<TurnOutcome> {
            const prompt = kind === 'phase' ? options.recordedBrief : 'Continue the replayed phase: advance_phase or ask_human if ready.';
            const nudgeOptions: Options = kind === 'phase' ? turnOptions : { ...turnOptions, ...(state.orchestratorSessionId ? { resume: state.orchestratorSessionId } : {}) };
            return streamReplayTurn(state, phase, prompt, nudgeOptions, tools, runTurn);
          },
          async close(): Promise<void> {},
        };
      },
    },
  };
}

export function replayOrchestratorOptions(state: RunState, budget: ReturnType<typeof budgetFor>, providerHome: string): Options {
  mkdirSync(providerHome, { recursive: true });
  const claudeHome = join(providerHome, '.claude');
  mkdirSync(claudeHome, { recursive: true });
  const options = buildOrchestratorOptions(state, budget);
  delete (options as Options & { resume?: string }).resume;
  return {
    ...options,
    cwd: state.cwd,
    env: {
      ...options.env,
      HOME: providerHome,
      XDG_CONFIG_HOME: join(providerHome, '.config'),
      XDG_DATA_HOME: join(providerHome, '.local', 'share'),
      XDG_STATE_HOME: join(providerHome, '.local', 'state'),
      XDG_CACHE_HOME: join(providerHome, '.cache'),
      CLAUDE_CONFIG_DIR: claudeHome,
      CLAUDE_HOME: claudeHome,
    },
  };
}

const defaultReplayTurn: RunOrchestratorTurn = ({ prompt, options, tools }) =>
  query({
    prompt,
    options: {
      ...options,
      mcpServers: {
        orchestrator: createSdkMcpServer({
          name: 'orchestrator',
          version: '0.1.0',
          tools: toSdkTools(tools),
          alwaysLoad: true,
        }),
      },
      allowedTools: tools.map((t) => `mcp__orchestrator__${t.name}`),
    },
  }) as AsyncIterable<SDKMessage>;

function wrapTools(tools: readonly KernelTool<any>[], recordedBrief: string, capture: ReplayHostCapture): Array<KernelTool<any>> {
  return tools.map((tool) => {
    if (tool.name === 'get_task') {
      return { ...tool, handler: async () => textResult(recordedBrief) };
    }
    if (tool.name === 'send_prompt') {
      return {
        ...tool,
        handler: async (args, extra) => {
          const duty = Array.isArray(args.duty) ? args.duty.map(String) : [String(args.duty)];
          const event = { kind: 'send_prompt' as const, duty, tag: String(args.tag), body: String(args.body) };
          const result = await tool.handler(args, extra);
          if (result.isError) {
            const reason = toolText(result);
            capture.refusedSends.push({ ...event, reason });
            capture.notes.push(`send_prompt returned a tool error and was excluded from aligned replay sends: ${duty.join('+')} tag=${event.tag}`);
            return result;
          }
          capture.events.push(event);
          return result;
        },
      };
    }
    if (tool.name === 'advance_phase') {
      return {
        ...tool,
        handler: async (args, extra) => {
          capture.events.push({ kind: 'terminal', verb: 'advance_phase', body: String(args.summary ?? '') });
          return tool.handler(args, extra);
        },
      };
    }
    if (tool.name === 'ask_human') {
      return {
        ...tool,
        handler: async (args, extra) => {
          capture.events.push({ kind: 'terminal', verb: 'ask_human', body: String(args.question ?? '') });
          return tool.handler(args, extra);
        },
      };
    }
    if (tool.name === 'list_snippets') {
      return {
        ...tool,
        handler: async (args, extra) => tool.handler(args, extra),
      };
    }
    return tool;
  });
}

async function streamReplayTurn(
  state: RunState,
  phase: PhaseName,
  prompt: string,
  options: Options,
  tools: Array<KernelTool<any>>,
  runTurn: RunOrchestratorTurn,
): Promise<TurnOutcome> {
  let lastUsage:
    | {
        input_tokens?: number;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
        output_tokens?: number;
      }
    | undefined;
  for await (const message of runTurn({ prompt, options, tools })) {
    if (message.type === 'assistant' && message.message.usage) {
      lastUsage = message.message.usage;
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
      if (message.subtype !== 'success') return 'flagged';
    }
  }
  const event = markerToEvent(state.terminalMarker, phase);
  if (event) return event.type === 'phase.advance' ? 'advanced' : 'flagged';
  return 'continue';
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function toolText(result: CallToolResult): string {
  return result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
}

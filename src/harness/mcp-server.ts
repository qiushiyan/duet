import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PHASE, PHASES } from '../phases.ts';
import type { PhaseName } from '../phases.ts';
import { createWorkers } from '../providers/index.ts';
import { loadRunState } from '../run-store.ts';
import { createPhaseTools } from './tools.ts';
import type { KernelTool } from './tools.ts';

/**
 * The standard-MCP adapter over the host-neutral kernel registry — the sibling
 * of driver.ts's in-process Agent SDK adapter, and the seam Stage 1's
 * interactive Claude Code session connects to. The same KernelTool handlers
 * serve both transports; nothing here knows the Agent SDK.
 *
 * Reached in production only through `duet _mcp <runId> <phase>` (a hidden
 * developer/test harness — production `_drive` stays in-process). The explicit
 * phase is deliberate: createPhaseTools needs a PhaseName and a quiescent run
 * has no live phase, so inferring it would be guesswork.
 */

const VALID_PHASES = new Set<string>(PHASES.map((p) => p.name));

/**
 * Build the kernel tool surface for a run + explicit phase, or throw a
 * prescribed-recovery error (convention 4) for a run/phase it can't host. The
 * narration `log` goes to STDERR, never stdout: under the stdio transport
 * stdout is the JSON-RPC channel, and a stray write there corrupts the stream.
 */
export function buildKernelTools(cwd: string, runId: string, phaseRaw: string): { tools: Array<KernelTool<any>>; phase: PhaseName } {
  if (!VALID_PHASES.has(phaseRaw)) {
    throw new Error(
      `cannot host phase "${phaseRaw}": not a duet phase. Pass an explicit phase — one of ${PHASES.map((p) => p.name).join(', ')} — because a quiescent run has no live phase context for _mcp to infer.`,
    );
  }
  const phase = phaseRaw as PhaseName;
  // Throws a clear "no run state at … — is <id> a run of this project?" when unknown.
  const state = loadRunState(cwd, runId);
  const tools = createPhaseTools({
    state,
    phase,
    providers: createWorkers(state.bindings, {
      workerBudgetUsd: PHASE[phase].workerBudgetUsd,
      timeoutMs: PHASE[phase].workerTurnTimeoutMs,
    }),
    log: (line) => console.error(line),
  }).tools;
  return { tools, phase };
}

/** Register a kernel registry on a standard MCP server (no transport attached yet). */
export function buildKernelMcpServer(tools: Array<KernelTool<any>>): McpServer {
  const server = new McpServer({ name: 'orchestrator', version: '0.1.0' });
  for (const t of tools) {
    server.registerTool(
      t.name,
      {
        description: t.description,
        inputSchema: t.inputSchema,
        ...(t.annotations ? { annotations: t.annotations } : {}),
      },
      t.handler as ToolCallback<typeof t.inputSchema>,
    );
  }
  return server;
}

/**
 * Serve a run + phase's kernel surface over stdio — the body of `duet _mcp`.
 * Resolves when the transport closes (the peer disconnected).
 */
export async function serveKernelStdio(cwd: string, runId: string, phaseRaw: string): Promise<void> {
  const { tools } = buildKernelTools(cwd, runId, phaseRaw);
  const server = buildKernelMcpServer(tools);
  await server.connect(new StdioServerTransport());
}

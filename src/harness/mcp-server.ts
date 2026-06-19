import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PHASE, PHASES } from '../phases.ts';
import type { PhaseName } from '../phases.ts';
import { createWorkers } from '../providers/index.ts';
import type { WorkerProvider, WorkerRole } from '../providers/types.ts';
import { loadRunState } from '../run-store.ts';
import type { RunState } from '../run-store.ts';
import { probeRunPosition } from './lifecycle.ts';
import type { RunPosition } from './lifecycle.ts';
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

/**
 * The run-scoped, phase-less kernel — Stage 1's server for the human's
 * interactive Claude Code session. One long-lived stdio server spans the whole
 * FRAME → PLAN arc: it resolves the active phase from disk per call (a
 * long-lived session can't keep swapping a static `.mcp.json` phase arg) and
 * serves that phase's tool surface, so one connection follows the run across its
 * gates.
 *
 * Hosting is gated on a LIVE interactive marker (orchestrationHost ===
 * 'interactive'): once the run hands off to a headless `_drive` at the plan gate
 * (or drops to headless via `--headless`, or finishes/abandons), the marker is
 * gone and every call is refused with a prescribed-recovery error — so an old
 * still-connected session can never write into a headless-owned run (two
 * writers). When hosting, the phase comes from probeRunPosition: interactive,
 * gate, flag, and crashed all carry the phase to host; running/done/abandoned
 * (no hostable phase) are refused rather than served at an invented phase.
 */
const NOT_HOSTABLE_MESSAGE =
  'This run is no longer being orchestrated interactively — a headless _drive now owns it, or it has finished or been abandoned. The interactive orchestrator session has nothing left to drive here: end the session. Observe the run with `duet status`; relaunch `duet orchestrate <runId>` only if it becomes interactive again.';

/** The phase the run-scoped server hosts for a position, or undefined when none can be. */
function hostablePhase(position: RunPosition): PhaseName | undefined {
  switch (position.kind) {
    case 'interactive':
    case 'gate':
    case 'flag':
    case 'crashed':
      return position.phase;
    case 'running':
    case 'done':
    case 'abandoned':
      return undefined;
  }
}

/** Build the two worker providers for a run + phase — the seam tests fake. */
export type WorkerFactory = (state: RunState, phase: PhaseName) => Record<WorkerRole, WorkerProvider>;

const defaultWorkerFactory: WorkerFactory = (state, phase) =>
  createWorkers(state.bindings, {
    workerBudgetUsd: PHASE[phase].workerBudgetUsd,
    timeoutMs: PHASE[phase].workerTurnTimeoutMs,
  });

export interface RunScopedKernel {
  /** The phase-independent tool surface (names/descriptions/schemas) for registration. */
  surface(): Array<KernelTool<any>>;
  /** Route a tool call through the current phase's handler, over fresh disk state. */
  callTool(name: string, args: unknown, extra: unknown): Promise<CallToolResult>;
}

/**
 * The run-scoped resolver. The tool surface is rebuilt per call against FRESH
 * disk state — so a `duet continue` write from a separate process (a reject or
 * answer that re-enters the SAME phase) is seen immediately, not served stale —
 * while the per-phase rails (the same-role in-flight guard, the warn-once set)
 * and providers are preserved across calls within a phase and rebuilt only at a
 * phase boundary. This keeps the Stage-0 one-instance-per-phase rail semantics
 * without pinning a stale RunState into the long-lived server.
 */
export function createRunScopedKernel(
  cwd: string,
  runId: string,
  makeWorkers: WorkerFactory = defaultWorkerFactory,
): RunScopedKernel {
  let ctx: { phase: PhaseName; providers: Record<WorkerRole, WorkerProvider>; rails: { turnsInFlight: Set<WorkerRole>; resendWarned: Set<string> } } | null = null;

  const toolsFor = (): Array<KernelTool<any>> => {
    const state = loadRunState(cwd, runId);
    if (state.orchestrationHost !== 'interactive') throw new Error(NOT_HOSTABLE_MESSAGE);
    const phase = hostablePhase(probeRunPosition(state));
    if (!phase) throw new Error(NOT_HOSTABLE_MESSAGE);
    if (!ctx || ctx.phase !== phase) {
      ctx = { phase, providers: makeWorkers(state, phase), rails: { turnsInFlight: new Set(), resendWarned: new Set() } };
    }
    return createPhaseTools({ state, phase, providers: ctx.providers, log: (line) => console.error(line), rails: ctx.rails }).tools;
  };

  const errorResult = (message: string): CallToolResult => {
    console.error(`[_mcp] ${message}`);
    return { content: [{ type: 'text' as const, text: message }], isError: true };
  };

  return {
    // The surface is phase-independent, so build it for any phase (frame) purely
    // to register stable tool metadata; the delegating handlers never run these.
    surface: () => {
      const state = loadRunState(cwd, runId);
      return createPhaseTools({ state, phase: 'frame', providers: makeWorkers(state, 'frame'), log: () => {} }).tools;
    },
    callTool: async (name, args, extra) => {
      let tools: Array<KernelTool<any>>;
      try {
        tools = toolsFor();
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
      const tool = tools.find((t) => t.name === name);
      if (!tool) return errorResult(`tool "${name}" is not part of the kernel surface`);
      return tool.handler(args as never, extra);
    },
  };
}

/** Register the run-scoped kernel on a standard MCP server (delegating handlers route per call). */
export function buildRunScopedKernelServer(cwd: string, runId: string, makeWorkers: WorkerFactory = defaultWorkerFactory): McpServer {
  const resolver = createRunScopedKernel(cwd, runId, makeWorkers);
  const delegating: Array<KernelTool<any>> = resolver.surface().map((t) => ({
    ...t,
    handler: (args, extra) => resolver.callTool(t.name, args, extra),
  }));
  return buildKernelMcpServer(delegating);
}

/**
 * Serve a run's phase-less kernel over stdio — the body of `duet _mcp <runId>`
 * (no phase). The launcher bakes this into the interactive session's
 * `--mcp-config`. Resolves when the transport closes.
 */
export async function serveRunScopedKernelStdio(cwd: string, runId: string): Promise<void> {
  const server = buildRunScopedKernelServer(cwd, runId);
  await server.connect(new StdioServerTransport());
}

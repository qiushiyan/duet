import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PHASE, phasesOf } from '../phases.ts';
import type { PhaseName } from '../phases.ts';
import { createWorkers } from '../providers/index.ts';
import type { WorkerProvider, WorkerRole } from '../providers/types.ts';
import { acquireMcpOwner, holdsMcpOwner, loadRunState, workflowOf } from '../run-store.ts';
import type { RunState } from '../run-store.ts';
import { probeRunPosition } from './lifecycle.ts';
import type { RunPosition } from './lifecycle.ts';
import { createPhaseTools } from './tools.ts';
import type { KernelTool } from './tools.ts';
import { createTurnDispatcher } from './turn-dispatcher.ts';
import type { TurnDispatcher } from './turn-dispatcher.ts';

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

/**
 * Build the kernel tool surface for a run + explicit phase, or throw a
 * prescribed-recovery error (convention 4) for a run/phase it can't host. The
 * narration `log` goes to STDERR, never stdout: under the stdio transport
 * stdout is the JSON-RPC channel, and a stray write there corrupts the stream.
 *
 * The phase is validated against THIS run's workflow, not a global phase set:
 * the run is loaded first, then the phase must be a member of its workflow's
 * arc — so a RIR run can't be asked to host a Full-only phase's tools.
 */
export function buildKernelTools(cwd: string, runId: string, phaseRaw: string): { tools: Array<KernelTool<any>>; phase: PhaseName } {
  // Throws a clear "no run state at … — is <id> a run of this project?" when unknown.
  const state = loadRunState(cwd, runId);
  const workflow = workflowOf(state);
  const legal = phasesOf(workflow).map((p) => p.name);
  if (!(legal as string[]).includes(phaseRaw)) {
    throw new Error(
      `cannot host phase "${phaseRaw}" for run ${runId}: it is not a phase of the "${workflow}" workflow. Pass an explicit phase — one of ${legal.join(', ')} — because a quiescent run has no live phase context for _mcp to infer.`,
    );
  }
  const phase = phaseRaw as PhaseName;
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

/**
 * Refusal when this run-scoped server no longer holds the single-writer lease
 * (run-store.ts acquireMcpOwner): a newer `duet orchestrate` over the same run
 * took ownership, so this (superseded) server must write nothing — every tool
 * call is refused, read or write, so no stale-owner mutation can ever land.
 */
const SUPERSEDED_MESSAGE =
  'This interactive orchestrator server was superseded by a newer `duet orchestrate` session for the same run, so it is no longer the run’s single writer — every tool call here is refused to keep a stale session from writing over the live one. End this session; observe the run with `duet status`, and relaunch `duet orchestrate <runId>` only if it becomes interactive again.';

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
  /** Whether this server still holds the single-writer lease (false once superseded). */
  holdsLease(): boolean;
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
  // Acquire the single-writer lease at construction: the newest run-scoped
  // server over this run becomes the sole writer (run-store.ts acquireMcpOwner).
  // A superseded old server reads `leaseHeld()` false and refuses every call —
  // the interactive analogue of the headless driver.pid guard. The thunk
  // re-reads disk per check, so a takeover by a newer server is seen at once.
  const ownerNonce = acquireMcpOwner(loadRunState(cwd, runId));
  const leaseHeld = (): boolean => holdsMcpOwner(loadRunState(cwd, runId), ownerNonce);

  let ctx:
    | { phase: PhaseName; providers: Record<WorkerRole, WorkerProvider>; rails: { turnsInFlight: Set<WorkerRole>; resendWarned: Set<string> }; dispatcher: TurnDispatcher }
    | null = null;

  const toolsFor = (): Array<KernelTool<any>> => {
    const state = loadRunState(cwd, runId);
    if (state.orchestrationHost !== 'interactive') throw new Error(NOT_HOSTABLE_MESSAGE);
    // The broad lease rule: a superseded server refuses EVERY tool call (read or
    // write). Because this check runs synchronously immediately before the
    // handler — no await between it and a tool's dispatch-time writes — it also
    // fences the dispatcher's dispatch-time mutations without a redundant inner
    // check; the one path it cannot reach is the background settle (no tool call
    // to gate), which the dispatcher fences with the same leaseHeld thunk.
    if (!holdsMcpOwner(state, ownerNonce)) throw new Error(SUPERSEDED_MESSAGE);
    const phase = hostablePhase(probeRunPosition(state));
    if (!phase) throw new Error(NOT_HOSTABLE_MESSAGE);
    if (!ctx || ctx.phase !== phase) {
      // Rebuild the per-phase context — providers, rails, AND the dispatcher —
      // at a phase boundary. Safe because the phase-exit gate forbids advancing
      // with a pending turn, so the old dispatcher is always drained here.
      const providers = makeWorkers(state, phase);
      ctx = {
        phase,
        providers,
        rails: { turnsInFlight: new Set(), resendWarned: new Set() },
        dispatcher: createTurnDispatcher({
          state,
          phase,
          cap: PHASE[phase].roundCap,
          providers,
          log: (line) => console.error(line),
          holdsLease: leaseHeld,
        }),
      };
    }
    return createPhaseTools({
      state,
      phase,
      providers: ctx.providers,
      log: (line) => console.error(line),
      rails: ctx.rails,
      async: { dispatcher: ctx.dispatcher },
    }).tools;
  };

  const errorResult = (message: string): CallToolResult => {
    console.error(`[_mcp] ${message}`);
    return { content: [{ type: 'text' as const, text: message }], isError: true };
  };

  return {
    // The surface is phase-independent, so build it for any phase (frame) purely
    // to register stable tool metadata; the delegating handlers never run these.
    // An inert dispatcher is passed so check_turns appears in the advertised
    // surface — its methods are never invoked (callTool routes through toolsFor,
    // which supplies the live dispatcher).
    surface: () => {
      const state = loadRunState(cwd, runId);
      const inertDispatcher: TurnDispatcher = {
        dispatch: () => {},
        statusOf: () => undefined,
        collectReady: () => [],
        hasPending: () => false,
      };
      return createPhaseTools({
        state,
        phase: 'frame',
        providers: makeWorkers(state, 'frame'),
        log: () => {},
        async: { dispatcher: inertDispatcher },
      }).tools;
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
    holdsLease: leaseHeld,
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

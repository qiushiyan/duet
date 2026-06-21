import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect } from 'vitest';
import { createActor } from 'xstate';
import { toSdkTools } from '../src/harness/driver.ts';
import { crossInteractive } from '../src/harness/lifecycle.ts';
import { interactiveMachine } from '../src/harness/machine.ts';
import { buildKernelMcpServer, buildKernelTools, buildRunScopedKernelServer, createRunScopedKernel } from '../src/harness/mcp-server.ts';
import { createPhaseTools } from '../src/harness/tools.ts';
import type { KernelTool } from '../src/harness/tools.ts';
import { renderSnippetLibrary } from '../src/snippets.ts';
import { FakeWorker, test } from './helpers/fixtures.ts';
import { loadRunState, markAbandoned, runDirOf, saveMachineSnapshot, saveRunState, stageHumanInput } from '../src/run-store.ts';
import type { RunState } from '../src/run-store.ts';

const CLI_ENTRY = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

/** Extract the first text block of an MCP/kernel tool result. */
const textOf = (result: unknown): string =>
  ((result as { content?: Array<{ text?: string }> }).content ?? [])[0]?.text ?? '';

/**
 * The stdio-MCP adapter over the host-neutral registry: a standard MCP client
 * reaches the kernel tools over the boundary, the read-only poke (list_snippets)
 * answers identically to in-process, and the two transports advertise the same
 * surface from one registry. The MCP protocol is the boundary the tests exercise
 * — a real client/server over the in-memory transport, never a mocked internal.
 * (Slice 3 drives control events over a real subprocess; here it's the surface.)
 */

const ALL_TOOLS = [
  'get_task',
  'list_snippets',
  'send_prompt',
  'ask_human',
  'create_branch',
  'advance_phase',
  'propose_snippet_edit',
  'write_note',
].sort();

// The interactive host adds one tool — check_turns — to collect async turns.
// The headless/single-phase surface stays ALL_TOOLS (send_prompt blocks there).
const INTERACTIVE_TOOLS = [...ALL_TOOLS, 'check_turns'].sort();

function registryFor(run: RunState, phase: Parameters<typeof createPhaseTools>[0]['phase'] = 'spec'): Array<KernelTool<any>> {
  return createPhaseTools({
    state: run,
    phase,
    providers: { implementer: new FakeWorker('claude'), reviewer: new FakeWorker('codex') },
    log: () => {},
  }).tools;
}

/** Link a standard MCP client to a server over the in-memory transport (no subprocess). */
async function linkedClient(server: ReturnType<typeof buildKernelMcpServer>): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  return client;
}

describe('the stdio-MCP adapter over the kernel registry', () => {
  test('a standard MCP client enumerates all eight tools by name and schema', async ({ run }) => {
    const client = await linkedClient(buildKernelMcpServer(registryFor(run)));
    const { tools } = await client.listTools();

    expect.soft(tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS);
    for (const t of tools) {
      expect.soft(t.description, t.name).toBeTruthy();
      expect.soft(t.inputSchema, t.name).toMatchObject({ type: 'object' });
    }
    await client.close();
  });

  test('list_snippets over the boundary returns the phase-focused library — identical to in-process', async ({
    run,
  }) => {
    const client = await linkedClient(buildKernelMcpServer(registryFor(run, 'spec')));
    const result = await client.callTool({ name: 'list_snippets', arguments: {} });
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text;

    // The safe read-only poke (readOnlyHint, no side effects): identical bytes to
    // calling the renderer directly proves a real handler ran over the boundary.
    expect(text).toBe(renderSnippetLibrary({ phase: 'spec', sentTo: {}, all: undefined }));
    await client.close();
  });

  test('one source of truth, two transports: the SDK host and the stdio host advertise identical schema', async ({
    run,
  }) => {
    const registry = registryFor(run);

    const stdioClient = await linkedClient(buildKernelMcpServer(registry));
    const sdkServer = createSdkMcpServer({ name: 'orchestrator', version: '0.1.0', tools: toSdkTools(registry) });
    const sdkClient = await linkedClient(sdkServer.instance);

    const normalize = (list: Awaited<ReturnType<Client['listTools']>>['tools']) =>
      list
        .map((t) => ({ name: t.name, inputSchema: t.inputSchema }))
        .sort((a, b) => a.name.localeCompare(b.name));

    const fromStdio = normalize((await stdioClient.listTools()).tools);
    const fromSdk = normalize((await sdkClient.listTools()).tools);

    // The MCP-visible shape (serialized JSON schema), not Zod internals or object
    // identity — both transports derive it from the same registry.
    expect(fromStdio).toEqual(fromSdk);
    await stdioClient.close();
    await sdkClient.close();
  });
});

describe('duet _mcp refuses a run/phase it cannot host', () => {
  test('an unknown phase is refused with a prescribed-recovery error', ({ projectDir, run }) => {
    expect(() => buildKernelTools(projectDir, run.runId, 'fraem')).toThrow(/not a duet phase.*Pass an explicit phase/s);
  });

  test('an unknown run is refused with a prescribed-recovery error', ({ projectDir }) => {
    expect(() => buildKernelTools(projectDir, 'nope-not-a-run', 'spec')).toThrow(/no run state.*is .* a run of this project/s);
  });
});

describe('the run-scoped, phase-less kernel server (Stage 1)', () => {
  /** A worker whose turn resolves only when the test says so. */
  function slowWorker(name: 'claude' | 'codex') {
    const worker = new FakeWorker(name);
    let finish!: (turn: { text: string; sessionId: string }) => void;
    worker.runTurn = (opts) => {
      worker.calls.push(opts);
      return new Promise((resolve) => (finish = resolve));
    };
    return { worker, finish: () => finish({ text: 'done', sessionId: 's' }) };
  }

  /** Persist an interactive rest at the spec loop (frame advanced, direction approved). */
  function restAtSpec(state: RunState): void {
    const actor = createActor(interactiveMachine, {
      input: { runId: state.runId, cwd: state.cwd, hasSpec: Boolean(state.specPath) },
    });
    actor.start();
    actor.send({ type: 'phase.advance' });
    actor.send({ type: 'human.approve' });
    saveMachineSnapshot(state, actor.getPersistedSnapshot());
    actor.stop();
  }

  test('resolves the phase from disk per call — one connection follows the run across a gate', async ({
    projectDir,
    interactiveRun,
  }) => {
    const kernel = createRunScopedKernel(projectDir, interactiveRun.runId);

    // Resting at frame (no snapshot) → the frame-focused library.
    expect.soft(textOf(await kernel.callTool('list_snippets', {}, {}))).toBe(
      renderSnippetLibrary({ phase: 'frame', sentTo: {}, all: undefined }),
    );

    // Advance on disk to rest at spec; the next call on the same kernel follows.
    restAtSpec(loadRunState(projectDir, interactiveRun.runId));
    expect.soft(textOf(await kernel.callTool('list_snippets', {}, {}))).toBe(
      renderSnippetLibrary({ phase: 'spec', sentTo: {}, all: undefined }),
    );
  });

  test('the in-flight rail is shared within a phase — a second concurrent same-role send is refused', async ({
    projectDir,
    interactiveRun,
  }) => {
    const slow = slowWorker('claude');
    const kernel = createRunScopedKernel(projectDir, interactiveRun.runId, () => ({
      implementer: slow.worker,
      reviewer: new FakeWorker('codex'),
    }));

    const first = kernel.callTool('send_prompt', { role: 'implementer', tag: 'custom', body: 'one' }, {});
    await new Promise((r) => setTimeout(r, 0)); // let the first turn enter flight
    const refused = await kernel.callTool('send_prompt', { role: 'implementer', tag: 'custom', body: 'two' }, {});

    // The rail only refuses if turnsInFlight is shared across the per-call tool
    // rebuilds — which is the cache's whole point.
    expect.soft(refused.isError).toBe(true);
    expect.soft(textOf(refused)).toContain('already in flight');
    expect.soft(slow.worker.calls).toHaveLength(1); // the second prompt never reached the worker

    slow.finish();
    expect.soft((await first).isError).toBeUndefined();
  });

  /** A worker whose turn resolves with a caller-supplied result when finished. */
  function controllableWorker(name: 'claude' | 'codex') {
    const worker = new FakeWorker(name);
    let resolveTurn!: (over: { sessionId: string; costUsd?: number; tokens?: { input: number; output: number } }) => void;
    worker.runTurn = (opts) => {
      worker.calls.push(opts);
      return new Promise((resolve) => {
        resolveTurn = (over) => resolve({ text: 'done', ...over });
      });
    };
    // runTurn (and so resolveTurn's assignment) fires during callTool, before finish.
    return { worker, finish: (over: { sessionId: string; costUsd?: number; tokens?: { input: number; output: number } }) => resolveTurn(over) };
  }

  test('concurrent cross-role sends both survive — the per-call state load does not clobber', async ({
    projectDir,
    interactiveRun,
  }) => {
    // The price the rails-only cache must pay: each call loads its own RunState,
    // so without the fresh-load/merge/save the later post-await save would erase
    // the other role's session/cost/sent-snippets/rounds. FRAME fans out exactly
    // this way (implementer + reviewer in parallel).
    const impl = controllableWorker('claude');
    const rev = controllableWorker('codex');
    const kernel = createRunScopedKernel(projectDir, interactiveRun.runId, () => ({
      implementer: impl.worker,
      reviewer: rev.worker,
    }));

    const implSend = kernel.callTool('send_prompt', { role: 'implementer', tag: 'think-holistic', body: 'analyze' }, {});
    const revSend = kernel.callTool('send_prompt', { role: 'reviewer', tag: 'review-spec', body: 'critique' }, {});
    await new Promise((r) => setTimeout(r, 0)); // both turns in flight

    impl.finish({ sessionId: 'impl-session', costUsd: 1.5 });
    rev.finish({ sessionId: 'rev-session', tokens: { input: 100, output: 20 } });
    await Promise.all([implSend, revSend]);

    const disk = loadRunState(projectDir, interactiveRun.runId);
    expect.soft(disk.workerSessions.implementer).toBe('impl-session'); // not clobbered by the reviewer's save
    expect.soft(disk.workerSessions.reviewer).toBe('rev-session');
    expect.soft(disk.sentSnippets?.frame?.implementer).toEqual(['think-holistic']);
    expect.soft(disk.sentSnippets?.frame?.reviewer).toEqual(['review-spec']);
    expect.soft(disk.costs.claudeWorkersUsd).toBe(1.5);
    expect.soft(disk.costs.codexTokens).toEqual({ input: 100, output: 20 });
    expect.soft(disk.rounds.frame).toBe(1); // the reviewer's review-* send counted a round
  });

  test('crossing to a new phase resets the warn-once rail — a re-sent base template warns fresh', async ({
    projectDir,
    interactiveRun,
  }) => {
    const kernel = createRunScopedKernel(projectDir, interactiveRun.runId, () => ({
      implementer: new FakeWorker('claude'),
      reviewer: new FakeWorker('codex'),
    }));
    const t = { role: 'implementer', tag: 'think-holistic', body: 'x' };
    // send_prompt is async here: dispatch, let the FakeWorker turn settle, then
    // collect (which re-opens the role). The warn-once rail is unchanged — it
    // just runs once the same-role guard is clear.
    const sendAndCollect = async () => {
      await kernel.callTool('send_prompt', t, {});
      await new Promise((r) => setTimeout(r, 0)); // let the turn settle
      await kernel.callTool('check_turns', {}, {}); // collect → re-opens the role
    };

    // Frame: send+collect, re-send (warns once), re-send passes (then collect).
    await sendAndCollect();
    expect.soft((await kernel.callTool('send_prompt', t, {})).isError).toBe(true);
    expect.soft((await kernel.callTool('send_prompt', t, {})).isError).toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    await kernel.callTool('check_turns', {}, {}); // drain the dispatched turn

    // Cross to spec on disk; the per-phase rails AND dispatcher are rebuilt.
    restAtSpec(loadRunState(projectDir, interactiveRun.runId));
    await sendAndCollect(); // first send in the new phase — passes
    // The second identical send warns FRESH, proving the rail reset at the boundary.
    expect((await kernel.callTool('send_prompt', t, {})).isError).toBe(true);
  });

  test('a live connection sees a cross-process duet continue --reject and folds the feedback on its next get_task', async ({
    projectDir,
    interactiveRun,
  }) => {
    // Park spec at its gate: the session drove into spec and advanced.
    restAtSpec(loadRunState(projectDir, interactiveRun.runId));
    const parked = loadRunState(projectDir, interactiveRun.runId);
    parked.phaseStarted.spec = true;
    parked.terminalMarker = { phase: 'spec', kind: 'advance' };
    saveRunState(parked);

    const kernel = createRunScopedKernel(projectDir, interactiveRun.runId);
    // Parked: get_task reports the park, not a fresh brief.
    expect.soft(textOf(await kernel.callTool('get_task', {}, {}))).toContain('parked at its gate');

    // Simulate `duet continue --reject "..."` from the CLI process — a SEPARATE
    // writer stages the feedback and crosses inline.
    const cli = loadRunState(projectDir, interactiveRun.runId);
    stageHumanInput(cli, { kind: 'feedback', text: 'invert the data model' });
    crossInteractive(cli, { type: 'human.reject' });

    // The SAME live kernel, on its next get_task, sees the fresh disk state: the
    // marker is gone, the run re-enters spec, and the feedback folds — once. This
    // is the whole point of rebuilding the tool surface per call against disk.
    const folded = textOf(await kernel.callTool('get_task', {}, {}));
    expect.soft(folded).toContain('invert the data model');
    expect.soft(folded).toContain('Draft the spec'); // the spec brief, intact
    const second = textOf(await kernel.callTool('get_task', {}, {}));
    expect.soft(second).not.toContain('invert the data model'); // consumed exactly once
  });

  test('refuses a run it cannot host — handed off (orchestrationHost unset) or abandoned (no hostable phase)', async ({
    projectDir,
    run,
    interactiveRun,
  }) => {
    // A headless run (orchestrationHost never set) → refused, never served.
    const r1 = await createRunScopedKernel(projectDir, run.runId).callTool('list_snippets', {}, {});
    expect.soft(r1.isError).toBe(true);
    expect.soft(textOf(r1)).toContain('no longer being orchestrated interactively');

    // An abandoned interactive run: markAbandoned leaves orchestrationHost set,
    // but the probe short-circuits to abandoned — no hostable phase → refused.
    markAbandoned(loadRunState(projectDir, interactiveRun.runId));
    const r2 = await createRunScopedKernel(projectDir, interactiveRun.runId).callTool('list_snippets', {}, {});
    expect.soft(r2.isError).toBe(true);
    expect.soft(textOf(r2)).toContain('finished or been abandoned');
  });

  test('handoff safety: serves while interactive, refuses the next call once the host marker is cleared on disk', async ({
    projectDir,
    interactiveRun,
  }) => {
    const kernel = createRunScopedKernel(projectDir, interactiveRun.runId);
    expect.soft((await kernel.callTool('list_snippets', {}, {})).isError).toBeUndefined();

    // The plan-gate handoff / --headless drop clears orchestrationHost on disk.
    const handed = loadRunState(projectDir, interactiveRun.runId);
    delete handed.orchestrationHost;
    saveRunState(handed);

    // The next mutating call on the SAME connection cannot write into a now
    // headless-owned run — the two-writer gap is closed.
    const refused = await kernel.callTool('write_note', { observation: 'too late' }, {});
    expect.soft(refused.isError).toBe(true);
    expect.soft(textOf(refused)).toContain('no longer being orchestrated interactively');
  });

  test('host-divergent surface: the run-scoped (interactive) server advertises check_turns; the single-phase one does not', async ({
    projectDir,
    interactiveRun,
    run,
  }) => {
    // Interactive run-scoped server → 9 tools (adds check_turns).
    const runScoped = buildRunScopedKernelServer(projectDir, interactiveRun.runId);
    const interactiveClient = await linkedClient(runScoped);
    expect.soft((await interactiveClient.listTools()).tools.map((t) => t.name).sort()).toEqual(INTERACTIVE_TOOLS);
    await interactiveClient.close();

    // Single-phase buildKernelTools (the headless/_drive shape) → 8, no check_turns.
    const { tools } = buildKernelTools(projectDir, run.runId, 'spec');
    const singleClient = await linkedClient(buildKernelMcpServer(tools));
    expect.soft((await singleClient.listTools()).tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS);
    await singleClient.close();
  });

  test('acquires the single-writer lease on construction, and a newer server supersedes it', ({
    projectDir,
    interactiveRun,
  }) => {
    const a = createRunScopedKernel(projectDir, interactiveRun.runId);
    // The lease file exists and this server holds it.
    expect.soft(existsSync(join(runDirOf(projectDir, interactiveRun.runId), 'mcp-owner.json'))).toBe(true);
    expect.soft(a.holdsLease()).toBe(true);

    // A second server over the same run takes ownership — the first is superseded.
    const b = createRunScopedKernel(projectDir, interactiveRun.runId);
    expect.soft(b.holdsLease()).toBe(true);
    expect.soft(a.holdsLease()).toBe(false);
  });

  test('a superseded server refuses every tool call and mutates nothing (the broad lease gate)', async ({
    projectDir,
    interactiveRun,
  }) => {
    const a = createRunScopedKernel(projectDir, interactiveRun.runId);
    createRunScopedKernel(projectDir, interactiveRun.runId); // b takes the lease

    // get_task would normally mark phaseStarted — under supersession it must not.
    const refused = await a.callTool('get_task', {}, {});
    expect.soft(refused.isError).toBe(true);
    expect.soft(textOf(refused)).toContain('superseded by a newer');
    expect.soft(loadRunState(projectDir, interactiveRun.runId).phaseStarted.frame).toBeUndefined();
  });

  test(
    'phase-less duet _mcp over a real subprocess enumerates the surface and answers list_snippets at zero worker cost',
    async ({ projectDir, interactiveRun }) => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [CLI_ENTRY, '_mcp', interactiveRun.runId],
        cwd: projectDir,
        stderr: 'inherit',
      });
      const client = new Client({ name: 'test', version: '0' });
      await client.connect(transport);
      try {
        expect.soft((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(INTERACTIVE_TOOLS); // incl check_turns
        const result = await client.callTool({ name: 'list_snippets', arguments: {} });
        expect.soft(textOf(result)).toBe(renderSnippetLibrary({ phase: 'frame', sentTo: {}, all: undefined }));
      } finally {
        await client.close();
        await transport.close();
      }
    },
    30_000,
  );
});

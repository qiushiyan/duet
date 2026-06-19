import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect } from 'vitest';
import { toSdkTools } from '../src/harness/driver.ts';
import { buildKernelMcpServer, buildKernelTools } from '../src/harness/mcp-server.ts';
import { createPhaseTools } from '../src/harness/tools.ts';
import type { KernelTool } from '../src/harness/tools.ts';
import { renderSnippetLibrary } from '../src/snippets.ts';
import { FakeWorker, test } from './helpers/fixtures.ts';
import type { RunState } from '../src/run-store.ts';

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

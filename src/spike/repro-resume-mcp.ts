import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const ping = tool('ping', 'Returns pong with the given word.', { word: z.string() }, async (a) => {
  console.log(`  [ping handler invoked: ${a.word}]`);
  return { content: [{ type: 'text' as const, text: `pong:${a.word}` }] };
});

function opts(resume?: string) {
  return {
    model: 'claude-haiku-4-5',
    cwd: new URL('../..', import.meta.url).pathname,
    tools: [] as string[],
    mcpServers: {
      orchestrator: createSdkMcpServer({ name: 'orchestrator', tools: [ping], alwaysLoad: true }),
    },
    allowedTools: ['mcp__orchestrator__ping'],
    maxBudgetUsd: 1,
    ...(resume ? { resume } : {}),
  };
}

let sid: string | undefined;
for await (const m of query({ prompt: 'Call ping with word "alpha", then reply done.', options: opts() })) {
  if (m.type === 'system' && m.subtype === 'init') console.log('RUN1 init tools:', (m as any).tools, 'mcp:', JSON.stringify((m as any).mcp_servers));
  if (m.type === 'result') { sid = m.session_id; console.log('RUN1 result:', m.subtype, m.subtype === 'success' ? (m as any).result : ''); }
}

console.log('--- resuming session', sid, '---');
for await (const m of query({ prompt: 'Call ping again with word "beta", then reply done.', options: opts(sid) })) {
  if (m.type === 'system' && m.subtype === 'init') console.log('RUN2 init tools:', (m as any).tools, 'mcp:', JSON.stringify((m as any).mcp_servers));
  if (m.type === 'result') console.log('RUN2 result:', m.subtype, m.subtype === 'success' ? (m as any).result : '');
}

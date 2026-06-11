import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

let allowPing = false;

const ping = tool('ping', 'Returns pong with the given word.', { word: z.string() }, async (a) => {
  console.log(`  [ping handler invoked: ${a.word}]`);
  return { content: [{ type: 'text' as const, text: `pong:${a.word}` }] };
});

const canUseTool: CanUseTool = async (toolName, input) => {
  console.log(`  [canUseTool] ${toolName} → ${allowPing ? 'allow' : 'DENY+interrupt'}  input=${JSON.stringify(input)}`);
  if (allowPing) return { behavior: 'allow' as const, updatedInput: input };
  return {
    behavior: 'deny' as const,
    message: 'The human is away; your question has been queued. The run will pause now and resume when they answer.',
    interrupt: true,
  };
};

function opts(resume?: string) {
  return {
    model: 'claude-haiku-4-5',
    cwd: new URL('../..', import.meta.url).pathname,
    tools: [] as string[],
    mcpServers: {
      orchestrator: createSdkMcpServer({ name: 'orchestrator', tools: [ping], alwaysLoad: true }),
    },
    // ping deliberately NOT in allowedTools — it must reach canUseTool.
    canUseTool,
    maxBudgetUsd: 1,
    ...(resume ? { resume } : {}),
  };
}

let sid: string | undefined;
for await (const m of query({ prompt: 'Call ping with word "alpha", then reply done.', options: opts() })) {
  if (m.type === 'system' && m.subtype === 'init') console.log('RUN1 init has ping:', (m as any).tools.includes('mcp__orchestrator__ping'));
  if (m.type === 'result') {
    sid = m.session_id;
    console.log('RUN1 result:', m.subtype, 'terminal_reason:', (m as any).terminal_reason, 'denials:', JSON.stringify((m as any).permission_denials));
  }
}

console.log('--- resuming (denied+interrupted) session', sid, '---');
allowPing = true;
for await (const m of query({ prompt: 'The human is back and says yes. Call ping with word "beta", then reply done.', options: opts(sid) })) {
  if (m.type === 'system' && m.subtype === 'init') console.log('RUN2 init has ping:', (m as any).tools.includes('mcp__orchestrator__ping'));
  if (m.type === 'result') console.log('RUN2 result:', m.subtype, 'terminal_reason:', (m as any).terminal_reason, '|', m.subtype === 'success' ? (m as any).result : '');
}

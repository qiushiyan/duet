import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

let allowPing = false;

const ping = tool('ping', 'Returns pong with the given word.', { word: z.string() }, async (a) => {
  console.log(`  [ping handler invoked: ${a.word}]`);
  return { content: [{ type: 'text' as const, text: `pong:${a.word}` }] };
});

const deferHook: HookCallbackMatcher = {
  matcher: 'mcp__orchestrator__ping',
  hooks: [
    async () => {
      console.log(`  [hook] ping → ${allowPing ? 'allow' : 'DEFER'}`);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: allowPing ? ('allow' as const) : ('defer' as const),
        },
      };
    },
  ],
};

function opts(resume?: string) {
  return {
    model: 'claude-haiku-4-5',
    cwd: new URL('../..', import.meta.url).pathname,
    tools: [] as string[],
    mcpServers: {
      orchestrator: createSdkMcpServer({ name: 'orchestrator', tools: [ping], alwaysLoad: true }),
    },
    allowedTools: ['mcp__orchestrator__ping'],
    hooks: { PreToolUse: [deferHook] },
    maxBudgetUsd: 1,
    ...(resume ? { resume } : {}),
  };
}

let sid: string | undefined;
for await (const m of query({ prompt: 'Call ping with word "alpha", then reply done.', options: opts() })) {
  if (m.type === 'system' && m.subtype === 'init') console.log('RUN1 init has ping:', (m as any).tools.includes('mcp__orchestrator__ping'));
  if (m.type === 'result') {
    sid = m.session_id;
    console.log('RUN1 result:', m.subtype, 'terminal_reason:', (m as any).terminal_reason, 'deferred:', JSON.stringify((m as any).deferred_tool_use));
  }
}

console.log('--- resuming (deferred) session', sid, '---');
allowPing = true;
for await (const m of query({ prompt: 'You may call ping now. Call it with word "beta", then reply done.', options: opts(sid) })) {
  if (m.type === 'system' && m.subtype === 'init') console.log('RUN2 init has ping:', (m as any).tools.includes('mcp__orchestrator__ping'));
  if (m.type === 'result') console.log('RUN2 result:', m.subtype, 'terminal_reason:', (m as any).terminal_reason, '|', m.subtype === 'success' ? (m as any).result : '');
}

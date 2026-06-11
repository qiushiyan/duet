/**
 * Q11 substrate spike (docs/open-questions.md Q11).
 *
 * Verifies, end to end, that the Claude Agent SDK can host duet's
 * orchestrator role:
 *
 *   1. A read-only orchestrator agent whose ONLY tools are `send_prompt`
 *      and `ask_human` (built-ins hidden via `tools: []`).
 *   2. Cross-provider routing through the minimal WorkerProvider interface:
 *      one `review-spec` turn to codex, one `update-spec` turn to claude.
 *   3. The ask_human pause, via COOPERATIVE PAUSE: the tool handler queues
 *      the question, persists state, and returns "human is AFK — end your
 *      turn"; the turn ends normally; the `answer` subcommand resumes the
 *      session with the answer in the prompt.
 *
 *      Why not a mechanical pause? Both SDK mechanisms corrupt resume in
 *      0.3.170 (verified by src/spike/repro-defer-resume.ts and
 *      repro-deny-resume.ts):
 *        - PreToolUse `permissionDecision: 'defer'` ends the run cleanly
 *          (`terminal_reason: 'tool_deferred'`, `deferred_tool_use` populated)
 *          but the RESUMED session loses the SDK MCP server — every
 *          subsequent orchestrator tool call fails with "No such tool
 *          available". `alwaysLoad: true` does not help.
 *        - canUseTool `{behavior: 'deny', interrupt: true}` ends the run as
 *          `error_during_execution`/`aborted_streaming`, and resuming it
 *          crashes the SDK with an `ede_diagnostic` error result.
 *      Plain resume after a NORMALLY ENDED turn keeps the SDK MCP tools
 *      working (src/spike/repro-resume-mcp.ts) — so the pause must ride a
 *      normal turn end.
 *   4. Cost measurement: `total_cost_usd` per invocation (the 2026-06-15
 *      subscription credit-pool change makes this a first-class output).
 *
 * Usage:
 *   node src/spike/q11.ts run              # phase A: route one round, queue ask_human, exit
 *   node src/spike/q11.ts answer "<text>"  # phase B: resume, answer, conclude
 */

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { execa } from 'execa';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeWorker } from '../providers/claude.ts';
import { CodexWorker } from '../providers/codex.ts';
import type { WorkerProvider } from '../providers/types.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATE_DIR = join(REPO_ROOT, '.duet', 'spike-q11');
const STATE_FILE = join(STATE_DIR, 'state.json');
const ORCHESTRATOR_MODEL = 'claude-opus-4-8';

interface SpikeState {
  orchestratorSessionId?: string;
  workerSessions: { implementer?: string; reviewer?: string };
  pendingQuestion?: string;
  costs: {
    orchestratorUsd: number;
    claudeWorkerUsd: number;
    codexTokens: { input: number; output: number };
  };
}

function loadState(): SpikeState {
  if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as SpikeState;
  return {
    workerSessions: {},
    costs: { orchestratorUsd: 0, claudeWorkerUsd: 0, codexTokens: { input: 0, output: 0 } },
  };
}

function saveState(state: SpikeState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

function loadSnippet(key: string): string {
  const config = JSON.parse(
    readFileSync(join(REPO_ROOT, 'examples', 'tabtype-snippets.json'), 'utf8'),
  ) as { snippets: Array<{ key: string; expand: string }> };
  const snippet = config.snippets.find((s) => s.key === key);
  if (!snippet) throw new Error(`snippet not found: ${key}`);
  return snippet.expand;
}

const state = loadState();

// The human's answer for the resumed run. null = human is AFK (phase A).
let pendingAnswer: string | null = null;
// Spike instrumentation: which path delivered the answer.
let askHumanHandlerInvoked = false;

const providers: Record<'implementer' | 'reviewer', WorkerProvider> = {
  implementer: new ClaudeWorker({ model: 'claude-opus-4-8', maxBudgetUsd: 5 }),
  reviewer: new CodexWorker(),
};

const sendPrompt = tool(
  'send_prompt',
  'Send a prompt to a worker agent and return its response. `tag` names the source snippet this prompt was built from; `body` is the final prompt text after your per-turn adaptation.',
  {
    role: z.enum(['implementer', 'reviewer']),
    tag: z.string().describe('Source snippet key, e.g. "review-spec". Use "custom" if composed from scratch.'),
    body: z.string().describe('The full prompt text to send.'),
  },
  async (args) => {
    const provider = providers[args.role];
    console.log(
      `\n[send_prompt] → ${args.role} (${provider.name})  tag=${args.tag}  body=${args.body.length} chars`,
    );
    const turn = await provider.runTurn({
      prompt: args.body,
      sessionId: state.workerSessions[args.role],
      readOnly: args.role === 'reviewer',
      cwd: REPO_ROOT,
    });
    state.workerSessions[args.role] = turn.sessionId;
    if (turn.costUsd) state.costs.claudeWorkerUsd += turn.costUsd;
    if (provider.name === 'codex' && turn.tokens) {
      state.costs.codexTokens.input += turn.tokens.input;
      state.costs.codexTokens.output += turn.tokens.output;
    }
    saveState(state);
    console.log(
      `[send_prompt] ← ${args.role} responded (${turn.text.length} chars, session ${turn.sessionId})`,
    );
    return { content: [{ type: 'text' as const, text: turn.text }] };
  },
);

const askHuman = tool(
  'ask_human',
  'Flag a question for the human. The human may be away; the question is queued and the run pauses until they answer.',
  {
    question: z.string(),
    context: z.string().optional().describe('One or two sentences of context the human needs.'),
  },
  async (args) => {
    askHumanHandlerInvoked = true;
    console.log(`\n[ask_human] handler invoked. question=${JSON.stringify(args.question)}`);
    if (pendingAnswer !== null) {
      const answer = pendingAnswer;
      pendingAnswer = null;
      return { content: [{ type: 'text' as const, text: `The human answered: ${answer}` }] };
    }
    // Cooperative pause: queue the question, persist, and tell the
    // orchestrator to end its turn. The harness exits after the turn ends;
    // `answer` resumes the session. (Mechanical pauses — defer and
    // deny+interrupt — corrupt resume in SDK 0.3.170; see header comment.)
    state.pendingQuestion = args.question;
    saveState(state);
    console.log(`[ask_human] question QUEUED; orchestrator instructed to end its turn`);
    return {
      content: [
        {
          type: 'text' as const,
          text: 'The human is AFK. Your question has been queued and the run will pause. End your turn NOW with a one-line status; do not take any further action. The run resumes when the human answers.',
        },
      ],
    };
  },
);

function orchestratorOptions(resumeSessionId?: string): Options {
  return {
    model: ORCHESTRATOR_MODEL,
    cwd: REPO_ROOT,
    // Read-only by construction: no built-in tools at all.
    tools: [],
    mcpServers: {
      orchestrator: createSdkMcpServer({
        name: 'orchestrator',
        version: '0.1.0',
        tools: [sendPrompt, askHuman],
        // Block startup until the server is connected so the tools exist when
        // the first prompt of a RESUMED session is built. Without this, resume
        // races MCP startup and the model gets "No such tool available"
        // (observed in the spike, phase B run 1).
        alwaysLoad: true,
      }),
    },
    allowedTools: ['mcp__orchestrator__send_prompt', 'mcp__orchestrator__ask_human'],
    maxBudgetUsd: 10,
    systemPrompt:
      'You are the orchestrator of a two-agent engineering workflow. You command an implementer and a reviewer through the send_prompt tool, routing each one’s output to the other. You are read-only: you never write files, never run commands, and never answer a product or technical question with your own opinion — you do triage, not substance. When something needs the human, use ask_human.',
    env: { ...process.env, CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '900000' },
    stderr: (data: string) => {
      if (process.env['SPIKE_DEBUG']) console.error(`[orchestrator stderr] ${data}`);
    },
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
  };
}

async function drive(prompt: string, resumeSessionId?: string): Promise<void> {
  const q = query({ prompt, options: orchestratorOptions(resumeSessionId) });

  for await (const message of q as AsyncIterable<SDKMessage>) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'text') {
          console.log(`\n[orchestrator] ${(block as { text: string }).text}`);
        }
      }
    } else if (message.type === 'result') {
      state.orchestratorSessionId = message.session_id;
      state.costs.orchestratorUsd += message.total_cost_usd;
      saveState(state);

      console.log('\n=== orchestrator run ended ===');
      console.log(`subtype:          ${message.subtype}`);
      console.log(`num_turns:        ${message.num_turns}`);
      console.log(`terminal_reason:  ${message.terminal_reason ?? '(none)'}`);
      if (message.subtype === 'success' && message.deferred_tool_use) {
        console.log(`deferred tool:    ${message.deferred_tool_use.name}`);
        console.log(`deferred input:   ${JSON.stringify(message.deferred_tool_use.input)}`);
      }
      console.log(`session_id:       ${message.session_id}`);
      console.log(`this run cost:    $${message.total_cost_usd.toFixed(4)}`);
    }
  }
}

function printCostSummary(): void {
  console.log('\n=== cumulative spike costs ===');
  console.log(`orchestrator (claude): $${state.costs.orchestratorUsd.toFixed(4)}`);
  console.log(`implementer (claude):  $${state.costs.claudeWorkerUsd.toFixed(4)}`);
  console.log(
    `reviewer (codex):      ${state.costs.codexTokens.input} in / ${state.costs.codexTokens.output} out tokens (billed via the user’s codex plan)`,
  );
}

async function preflight(): Promise<void> {
  // Fail fast and clearly if either CLI is missing from PATH.
  await execa('claude', ['--version']).catch(() => {
    throw new Error('`claude` CLI not found on PATH');
  });
}

async function cmdRun(): Promise<void> {
  await preflight();
  const draftSpec = readFileSync(join(REPO_ROOT, 'src', 'spike', 'fixture-spec.md'), 'utf8');
  const reviewSpec = loadSnippet('review-spec');
  const updateSpec = loadSnippet('update-spec');

  const prompt = `Run ONE round of the spec review protocol on the draft spec below, then pause for the human.

Steps, in order:

1. Send the reviewer a review-spec prompt wrapping the full draft spec. Base it on the snippet template below (the "$0" marks where the artifact goes); adapt freely where context warrants, and pass the snippet key as \`tag\`.
2. Send the implementer an update-spec prompt wrapping the reviewer's full feedback, based on the update-spec template. The implementer should reply with the revised spec text in its message.
3. After both turns, call ask_human exactly once: report in one or two sentences how the round went (how much the reviewer pushed back, whether the implementer disagreed with anything), and ask whether to run another round or stop here. If the tool result says the human is AFK and the question was queued, end your turn immediately as it instructs — the run pauses and resumes when they answer.
4. When the human's answer arrives (as an ask_human result or in a later message): do NOT run more rounds regardless of the answer (this is a one-round spike). End with a short final report: what the reviewer flagged, what the implementer changed or rejected, and what you would do next in a real run.

Remember: you never evaluate the spec yourself and never answer substance — route, judge convergence, and flag.

--- snippet template: review-spec ---
${reviewSpec}

--- snippet template: update-spec ---
${updateSpec}

--- draft spec (src/spike/fixture-spec.md) ---
${draftSpec}`;

  console.log('[spike] starting orchestrator (phase A: route one round, then queue ask_human)');
  await drive(prompt);
  printCostSummary();

  if (state.pendingQuestion) {
    console.log('\n[spike] QUEUED QUESTION for the human:');
    console.log(`  ${state.pendingQuestion}`);
    console.log('\n[spike] answer it with:');
    console.log('  node src/spike/q11.ts answer "<your answer>"');
  } else {
    console.log('\n[spike] WARNING: run ended without a queued ask_human question — the orchestrator never paused.');
  }
}

async function cmdAnswer(answer: string): Promise<void> {
  await preflight();
  if (!state.orchestratorSessionId) throw new Error('no orchestrator session in state — run phase A first');
  if (!state.pendingQuestion) console.log('[spike] note: no pending question recorded; resuming anyway');

  pendingAnswer = answer;
  console.log(`[spike] resuming orchestrator session ${state.orchestratorSessionId} (phase B)`);
  console.log(`[spike] queued question was: ${state.pendingQuestion ?? '(unknown)'}`);

  const prompt = `The human has returned and answered your queued question: ${JSON.stringify(
    answer,
  )}. Proceed per your instructions (no further rounds; end with the short final report).`;

  await drive(prompt, state.orchestratorSessionId);

  state.pendingQuestion = undefined;
  saveState(state);

  console.log(
    `\n[spike] ask_human handler ${askHumanHandlerInvoked ? 'was re-invoked on resume (orchestrator chose to re-ask)' : 'was not re-invoked on resume (answer travelled via the resume prompt, as designed)'}`,
  );
  printCostSummary();
}

const [, , command, ...rest] = process.argv;
if (command === 'run') {
  await cmdRun();
} else if (command === 'answer') {
  const answer = rest.join(' ').trim();
  if (!answer) {
    console.error('usage: node src/spike/q11.ts answer "<your answer>"');
    process.exit(1);
  }
  await cmdAnswer(answer);
} else {
  console.error('usage: node src/spike/q11.ts <run | answer "...">');
  process.exit(1);
}

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
  'Send a prompt to a worker agent and return its final response. Each role is one persistent session: a later call to the same role continues that worker’s conversation, so refer back to earlier turns instead of repeating context the worker has already seen. Worker turns are slow (often minutes) — prefer one well-composed prompt over several small ones.',
  {
    role: z
      .enum(['implementer', 'reviewer'])
      .describe('implementer produces and revises artifacts; reviewer critiques them (read-only).'),
    tag: z.string().describe('Source snippet key this prompt was built from, e.g. "review-spec". Use "custom" if composed from scratch.'),
    body: z.string().describe('The full prompt text to send, after your per-turn adaptation.'),
  },
  async (args) => {
    const provider = providers[args.role];
    console.log(
      `\n[send_prompt] → ${args.role} (${provider.name})  tag=${args.tag}  body=${args.body.length} chars`,
    );
    try {
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
    } catch (err) {
      // Actionable, steering error: name the failure layer and prescribe the
      // recovery path, so the orchestrator doesn't have to invent one.
      const detail = err instanceof Error ? err.message : String(err);
      console.log(`[send_prompt] ✗ ${args.role} turn failed: ${detail}`);
      return {
        content: [
          {
            type: 'text' as const,
            text: `The ${args.role} worker's turn failed at the infrastructure layer (${detail}). The worker never saw your prompt, so this is not a content problem. Retry this same send_prompt call once; if the retry also fails, stop routing and report the failure to the human via ask_human instead of continuing the round.`,
          },
        ],
        isError: true,
      };
    }
  },
);

const askHuman = tool(
  'ask_human',
  'Flag a question for the human: product or direction calls, environment actions only they can take (deploys, credentials, migrations), or blockers you cannot route around. Route technical and content questions to a worker instead — the human is the editor-in-chief, not a third engineer. The human may be away; if so the question is queued and the run pauses until they answer.',
  {
    question: z.string().describe('The question, self-contained enough to answer from a phone.'),
    context: z.string().optional().describe('One or two sentences of background the human needs to answer well.'),
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
          text: 'The human is away, so your question has been queued and the run is pausing. End your turn with a one-line status — anything you do past this point happens without the answer you just asked for. The run resumes with the human’s answer.',
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
    systemPrompt: `You are the orchestrator of a two-agent engineering workflow: an implementer who produces artifacts (specs, plans, code) and a reviewer who critiques them. You drive the protocol — choose and adapt each prompt, route each worker's output to the other, judge when a review loop has converged, and decide what needs the human.

<division_of_labor>
Three parties answer three kinds of questions, and keeping them separate is what keeps the human's judgment in the loop:
- Workers answer technical and content questions. When one arises, route it to a worker with process guidance ("decide per the plan and record the decision").
- The human answers product, direction, and environment questions (anything touching deploys, credentials, migrations, or scope). Flag those with ask_human.
- You answer neither kind. Your judgments are about process: who speaks next, whether a loop has converged, what to flag. If you notice yourself forming an opinion about an artifact's content, treat that as a signal to route or flag — an orchestrator opinion would influence the work invisibly, bypassing the human's gates.
</division_of_labor>

You have no write access by design; every repository effect happens through the workers.`,
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

  // Per Anthropic prompting guidance: longform data first (XML-tagged), the
  // task last; positive instructions with motivation over bare prohibitions.
  const prompt = `<documents>
<document name="snippet-template: review-spec">
${reviewSpec}
</document>
<document name="snippet-template: update-spec">
${updateSpec}
</document>
<document name="draft-spec" source="src/spike/fixture-spec.md">
${draftSpec}
</document>
</documents>

<task>
Run one round of the spec review protocol on the draft spec above, then pause for the human. This is a one-round calibration run: its purpose is to exercise the routing, so a single round followed by your report is the complete job.

1. Send the reviewer a review-spec prompt wrapping the full draft spec. Base it on the snippet template (the "$0" marks where the artifact goes); adapt it where context warrants, and pass the snippet key as \`tag\`.
2. Send the implementer an update-spec prompt wrapping the reviewer's full feedback, based on the update-spec template. Ask the implementer to reply with the revised spec text in its message.
3. Call ask_human once with a one-or-two-sentence report on the round (how much the reviewer pushed back, whether the implementer disagreed with anything) and the question of whether to run another round or stop. If the tool result says the question was queued, end your turn with a one-line status — the run pauses and resumes when the human answers.
4. When the answer arrives, close out the run with a short final report: what the reviewer flagged, what the implementer changed or rejected, and what you would do next in a real run. Whatever the answer says, the report is your last act — round 2, if the human wants one, happens in a separate run.
</task>`;

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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunState } from '../run-state.ts';

/**
 * Orchestrator prompts, written to the conventions in
 * docs/prompting-and-tool-design.md: longform content first in XML tags,
 * the task last; thinking frameworks with motivation instead of bare
 * prohibitions; no aggressive emphasis.
 */

export const ORCHESTRATOR_SYSTEM_PROMPT = `You are the orchestrator of a two-agent engineering workflow: an implementer who produces artifacts (specs, plans, code) and a reviewer who critiques them. You drive the protocol — choose and adapt each prompt, route each worker's output to the other, judge when a review loop has converged, and decide what needs the human. Both workers run in the project repository and can read its files; the implementer can also edit them.

<division_of_labor>
Three parties answer three kinds of questions, and keeping them separate is what keeps the human's judgment in the loop:
- Workers answer technical and content questions. When one arises, route it to a worker with process guidance ("decide per the plan and record the decision; if it's actually a product call, say so").
- The human answers product, direction, and environment questions (anything touching deploys, credentials, migrations, or scope). Flag those with ask_human.
- You answer neither kind. Your judgments are about process: who speaks next, whether a loop has converged, what to flag. If you notice yourself forming an opinion about an artifact's content, treat that as a signal to route or flag — an orchestrator opinion would influence the work invisibly, bypassing the human's gates.
</division_of_labor>

<protocol>
The workflow's substance is a snippet library (read it with list_snippets). Snippets encode hard-won conventions — altitude lenses that keep reviews at the right level of detail, reflect-before-change gates, round-2 discipline — so prefer them as the basis for every worker prompt. Per turn you may use a snippet verbatim, adapt it (file paths, project vocabulary, focus areas), or compose from scratch when nothing fits; pass the source snippet key as \`tag\` so the choice is auditable. If you find a snippet persistently inadequate, propose a library change with propose_snippet_edit — it queues for the human's end-of-run review rather than applying now, because a silently changed prompt would compound across every later run.

A review loop runs: artifact → reviewer critique (review-*) → implementer revision or pushback (update-*) → your judgment: another round, or converged? Use the -again snippet variants for round 2+ — they verify earlier feedback was actually integrated rather than relitigating. Exit the loop when the remaining open points are minor (wording, small caveats, settled disagreements with recorded rationale) rather than structural. A disagreement that persists across two rounds with substantive arguments on both sides is the human's call — flag it.
</protocol>

<recording>
Call write_note when you notice friction worth remembering — a snippet that didn't fit, a triage call you were unsure about, a worker that needed unusual hand-holding. These notes are how the workflow improves between runs.
</recording>

When a phase's exit criteria are met, call advance_phase with an honest summary — it always lands on a human gate, so the summary is what the human decides from.`;

function documentsBlock(state: RunState): string {
  const specContent = readFileSync(join(state.cwd, state.specPath), 'utf8');
  const docs = [
    state.framing
      ? `<document name="framing" description="the human's project briefing for this run">\n${state.framing}\n</document>`
      : '',
    `<document name="draft-spec" path="${state.specPath}">\n${specContent}\n</document>`,
  ].filter(Boolean);
  return `<documents>\n${docs.join('\n')}\n</documents>`;
}

export function specPhaseEntryPrompt(state: RunState, roundCap: number): string {
  return `${documentsBlock(state)}

<task>
Run the SPEC review loop on the draft spec above, then advance to the commit-spec gate.

The shape of the loop:
1. Read the snippet library (list_snippets) — the review-spec / update-spec snippets (and their -again variants for later rounds) are the templates for this loop.
2. Send the reviewer a review-spec prompt wrapping the current spec. The reviewer runs read-only in the repo, so it can also read ${state.specPath} and related code directly — point it at the path as well as quoting the content.
3. Route the reviewer's feedback to the implementer with an update-spec prompt. The implementer should apply accepted changes to ${state.specPath} directly (it has write access) and report what it changed versus rejected and why.
4. Judge convergence. Run another round with the -again variants when substantive points remain open; stop when what's left is minor. The backstop cap for this phase is ${roundCap} review rounds — your judgment should converge well before it.
5. When converged, call advance_phase with a summary of what the reviewer flagged, what changed, and any rejections with their rationale — the human decides at the gate from your summary.

Throughout: flag product or direction questions with ask_human as they arise; tactical questions bounce back to the worker that raised them.
</task>`;
}

export function planPhaseEntryPrompt(state: RunState, roundCap: number): string {
  return `<documents>
<document name="approved-spec" path="${state.specPath}">
${readFileSync(join(state.cwd, state.specPath), 'utf8')}
</document>
</documents>

<task>
The human approved the spec at the commit-spec gate. Run the PLAN phase:

1. Have the implementer commit the approved spec file (${state.specPath}) with a conventional message, as its own commit.
2. Send the implementer a planning prompt — base it on the tdd-plan snippet when the work is test-shaped, start-plan otherwise (read the framing and spec to judge which; if genuinely unclear, that's a process call you may make). The plan lives in the implementer's reply, not a file, unless the framing says otherwise.
3. Run the plan review loop: review-plan to the reviewer, update-plan to the implementer, -again variants for later rounds. Plans are reviewable at a finer altitude than specs — test cases, fixtures, and line-level references are fair game; only full code bodies are deferred.
4. The backstop cap for this phase is ${roundCap} review rounds; converge well before it.
5. When converged, call advance_phase with a summary. The human walks away after approving this gate, so the summary should give them confidence the plan is workable end to end.

Throughout: flag product or direction questions with ask_human; tactical questions bounce to the worker.
</task>`;
}

export function answerResumePrompt(answer: string): string {
  return `The human answered your queued question: ${JSON.stringify(answer)}. Continue the phase from where you paused, taking their answer into account.`;
}

export function feedbackResumePrompt(phase: 'spec' | 'plan', feedback: string): string {
  const artifact = phase === 'spec' ? 'spec' : 'plan';
  return `At the gate, the human sent the ${artifact} back with this feedback: ${JSON.stringify(
    feedback,
  )}. Re-enter the ${artifact} loop to address it — route the feedback to the implementer (the human is the editor-in-chief; their feedback outranks reviewer opinions), run whatever review rounds the changes warrant, and advance the phase again when converged.`;
}

export function nudgeContinuePrompt(): string {
  return `Your turn ended without calling advance_phase or ask_human, so the harness cannot tell whether the phase is done, paused, or stuck. Continue the phase: route the next worker turn, or advance_phase if converged, or ask_human if something needs the human.`;
}

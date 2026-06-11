import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PhaseName, RunState } from '../run-state.ts';

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

A review loop runs: artifact → reviewer critique (review-*) → implementer revision or pushback (update-* for documents, respond-* for code) → your judgment: another round, or converged? Use the -again snippet variants for round 2+ — they verify earlier feedback was actually integrated rather than relitigating. Exit the loop when the remaining open points are minor (wording, small caveats, settled disagreements with recorded rationale) rather than structural. A disagreement that persists across two rounds with substantive arguments on both sides is the human's call — flag it.
</protocol>

<recording>
Call write_note when you notice friction worth remembering — a snippet that didn't fit, a triage call you were unsure about, a worker that needed unusual hand-holding. These notes are how the workflow improves between runs.
</recording>

When a phase's exit criteria are met, call advance_phase with an honest summary — it always lands on a human gate, so the summary is what the human decides from.`;

/**
 * The branch-policy paragraph for the run's first phase entry. Empty once a
 * worker has been prompted — by then the branch is fixed and create_branch
 * is structurally unavailable.
 */
function branchPolicyParagraph(state: RunState): string {
  if (state.workerSessions.implementer || state.workerSessions.reviewer) return '';
  return `
Branch: the run works on exactly one branch, fixed before your first worker prompt. The repo is currently on "${state.branch ?? 'unknown'}". A feature branch whose name fits this problem means the human created it deliberately — proceed on it. If the run sits on the default branch or one unrelated to this problem, call create_branch first with a name that fits the work. Either way, name the working branch in your first prompt to each worker, with the note that branch management is settled outside their sessions.
`;
}

function documentsBlock(state: RunState): string {
  const docs = [
    state.framing
      ? `<document name="framing" description="the human's project briefing for this run">\n${state.framing}\n</document>`
      : '',
    state.specPath
      ? `<document name="draft-spec" path="${state.specPath}">\n${readFileSync(join(state.cwd, state.specPath), 'utf8')}\n</document>`
      : '',
  ].filter(Boolean);
  return `<documents>\n${docs.join('\n')}\n</documents>`;
}

export function framePhaseEntryPrompt(state: RunState, roundCap: number): string {
  return `${documentsBlock(state)}

<task>
No spec exists yet — run the FRAME phase: both workers build an independent understanding of the problem, then the implementer synthesizes, and the human checks the direction at the Direction gate.
${branchPolicyParagraph(state)}
The shape of the phase:
1. Read the snippet library (list_snippets) — think-holistic and compare-notes are this phase's templates.
2. Onboard each worker in your first prompt to it: the framing says how (a project skill to invoke — include its /name in the worker's prompt and the CLI expands it — or files to read). Fold the onboarding, the working branch, and the problem statement from the framing into that first prompt.
3. Send think-holistic to each worker independently — same problem, two unshared analyses.
4. Send the reviewer's analysis to the implementer with compare-notes: critique, synthesize, don't capitulate.
5. Call advance_phase with the synthesized direction as the summary — the approaches weighed, the one recommended, and why. The human decides "does this direction match what I meant?" from it. (The backstop cap of ${roundCap} review rounds rarely matters here — analysis turns aren't review rounds.)

Throughout: flag product or direction questions with ask_human as they arise; tactical questions bounce back to the worker that raised them.
</task>`;
}

export function specPhaseEntryPrompt(state: RunState, roundCap: number): string {
  if (!state.specPath) return specDraftEntryPrompt(state, roundCap);
  return `${documentsBlock(state)}

<task>
Run the SPEC review loop on the draft spec above, then advance to the commit-spec gate.
${branchPolicyParagraph(state)}
The shape of the loop:
1. Read the snippet library (list_snippets) — the review-spec / update-spec snippets (and their -again variants for later rounds) are the templates for this loop.
2. Send the reviewer a review-spec prompt wrapping the current spec. The reviewer runs read-only in the repo, so it can also read ${state.specPath} and related code directly — point it at the path as well as quoting the content.
3. Route the reviewer's feedback to the implementer with an update-spec prompt. The implementer should apply accepted changes to ${state.specPath} directly (it has write access) and report what it changed versus rejected and why.
4. Judge convergence. Run another round with the -again variants when substantive points remain open; stop when what's left is minor. The backstop cap for this phase is ${roundCap} review rounds — your judgment should converge well before it.
5. When converged, call advance_phase with a summary of what the reviewer flagged, what changed, and any rejections with their rationale — the human decides at the gate from your summary.

Throughout: flag product or direction questions with ask_human as they arise; tactical questions bounce back to the worker that raised them.
</task>`;
}

function specDraftEntryPrompt(state: RunState, roundCap: number): string {
  return `<task>
The human approved the direction at the Direction gate. Draft the spec, then run its review loop to the commit-spec gate.

The shape of the phase:
1. Decide where the spec file lives — the framing names the project's spec location. If it doesn't, ask_human for one before drafting.
2. Send the implementer a write-spec prompt carrying the approved direction; it writes the spec file and reports the path and content.
3. Run the review loop: review-spec to the reviewer (point it at the file's path as well as the content), update-spec to the implementer, -again variants for later rounds. The backstop cap is ${roundCap} review rounds; converge well before it.
4. When converged, call advance_phase with the summary and with spec_path set to the spec file's repo-relative path — the harness records it for the later phases.

Throughout: flag product or direction questions with ask_human as they arise; tactical questions bounce back to the worker that raised them.
</task>`;
}

export function planPhaseEntryPrompt(state: RunState, roundCap: number): string {
  const specRef = state.specPath ?? 'the approved spec file (you know its path from the spec phase)';
  const documents = state.specPath
    ? `<documents>
<document name="approved-spec" path="${state.specPath}">
${readFileSync(join(state.cwd, state.specPath), 'utf8')}
</document>
</documents>

`
    : '';
  return `${documents}<task>
The human approved the spec at the commit-spec gate. Run the PLAN phase:

1. Have the implementer commit the approved spec file (${specRef}) with a conventional message, as its own commit.
2. Decide where the plan file lives: the framing names the project's plan location (path or directory convention). The plan must be a file in the repo — implementation may compact the implementer's context, and the plan file is what later turns re-anchor on. If the framing doesn't name a plan location, ask_human for one before drafting.
3. Send the implementer a planning prompt — base it on the tdd-plan snippet when the work is test-shaped, start-plan otherwise (read the framing and spec to judge which; if genuinely unclear, that's a process call you may make). The implementer writes the plan to the file and reports it.
4. Run the plan review loop: review-plan to the reviewer (point it at the plan file's path as well as the content), update-plan to the implementer, -again variants for later rounds. Plans are reviewable at a finer altitude than specs — test cases, fixtures, and line-level references are fair game; only full code bodies are deferred.
5. The backstop cap for this phase is ${roundCap} review rounds; converge well before it.
6. When converged, call advance_phase with a summary, listing the plan file among the artifacts. The human walks away after approving this gate, so the summary should give them confidence the plan is workable end to end.

Throughout: flag product or direction questions with ask_human; tactical questions bounce to the worker.
</task>`;
}

export function implPhaseEntryPrompt(state: RunState, roundCap: number): string {
  const compactionStep =
    state.bindings.implementer.provider === 'claude'
      ? `Compaction is yours to time: when the implementer's context has grown heavy with build-process detail (typically after the last slice, before the handoff — earlier if a long implementation is degrading), send the implementer a prompt whose body is literally "/compact " followed by your adapted compact-for-review instructions. The session compacts natively in place and the turn returns a confirmation; follow with a reread-context turn pointing at the plan file and the spec so the implementer re-anchors on the artifacts rather than the dropped journey.`
      : `The implementer runs on codex, which manages its own context — it compacts automatically as it fills, so compaction needs nothing from you. Your lever is anchoring instead: before the handoff (or whenever the implementer seems to have lost the thread), a reread-context turn pointing at the plan file and the spec re-grounds it on the artifacts.`;

  return `<task>
The human approved the plan and walked away — this is the AFK IMPLEMENTATION phase. You drive it end to end; ask_human still works but now queues the question and pauses the whole run until the human returns, so a flag is a real stop, not a quick check-in. Make each one self-contained, and let everything that can wait for the Ship gate wait.

The arc:

1. Have the implementer commit the approved plan file with a conventional message, as its own commit.
2. Drive the implementer through the plan's slices: one commit per slice, tests with the slice per the plan's verification story. Batch at your judgment — worker turns are slow, so a single turn may cover a few small slices, but ask for a report each turn (what landed, test state, commits) so you can steer.
3. For large implementations (roughly 10+ slices), run the midpoint checkpoint at your judgment: midpoint-status from the implementer, review-midpoint to the reviewer, respond-midpoint back. The reviewer weights foundational problems highest — they compound across every remaining slice — and treats unreached slices as intentionally undone, not missing.
4. ${compactionStep}
5. When all slices are in: implementation-handoff from the implementer, then the review loop — review-implementation to the reviewer, respond-review to the implementer, -again variants for later rounds, fix commits as they're accepted. The backstop cap for this phase is ${roundCap} review rounds; converge well before it.
6. Last act, after the loop converges: send the implementer ceo-summary. Then call advance_phase with a summary that leads with the CEO summary verbatim, followed by the review history (rounds run, points raised, resolved, disputed), deviations from the plan, and the test state. The human returns from hours away and decides to ship from this packet alone — make it carry everything.

Throughout: flag product, direction, and environment questions with ask_human (those are still the human's even when away); tactical questions bounce to the worker that raised them.
</task>`;
}

export function docsPhaseEntryPrompt(state: RunState, roundCap: number): string {
  return `<task>
The human approved the Ship gate — the implementation is verified and shipping. Run the DOCS phase to its proposal:

1. The framing names how this project updates its docs (often a project skill — include its /name in the implementer's prompt and the CLI expands it — otherwise conventions to follow). If the framing names nothing, have the implementer survey the repo's docs and derive the impact from what shipped.
2. Drive the implementer to the docs-update proposal: which documents change and how. The proposal is this phase's whole product — when a skill has an internal approval step, run it exactly up to that step; applying changes happens after the human approves.
3. A review round is available when the proposal warrants one (backstop cap ${roundCap}); most docs plans go straight to the gate.
4. Call advance_phase with the proposal verbatim in the summary — the human approves or adjusts it at the Docs-plan gate.

Throughout: flag product or direction questions with ask_human; tactical questions bounce to the worker.
</task>`;
}

export function prPhaseEntryPrompt(state: RunState, roundCap: number): string {
  return `<task>
The human approved the docs plan (their adjustments, if any, arrived as gate feedback). Finish the run's artifacts:

1. Have the implementer apply the approved docs plan and commit the doc changes. If a skill was paused at its internal approval step, resume it past that step — when the framing says the skill recognizes a resume token, send it; otherwise tell the implementer the plan is approved and to proceed with applying it.
2. Send the implementer the pr-description snippet — the PR body for a technical colleague who won't read the diff.
3. A review round on the description is available when it warrants one (backstop cap ${roundCap}).
4. Call advance_phase with the PR title and description verbatim in the summary — the human reads exactly this at the Open-PR gate and decides whether to open.

Throughout: flag product or direction questions with ask_human; tactical questions bounce to the worker.
</task>`;
}

export function openPhaseEntryPrompt(state: RunState): string {
  return `<task>
The human approved opening the PR — that approval covers the mechanics, so run them:

1. Have the implementer push the working branch and open the PR with gh pr create, using the approved title and description, and report the PR URL.
2. Call advance_phase with the PR URL leading the summary — this completes the run.

If the push or PR creation fails for an environment reason (auth, remote, permissions), that's the human's to fix: ask_human with the error.
</task>`;
}

export function answerResumePrompt(answer: string): string {
  return `The human answered your queued question: ${JSON.stringify(answer)}. Continue the phase from where you paused, taking their answer into account.`;
}

const GATE_ARTIFACT: Record<PhaseName, string> = {
  frame: 'direction analysis',
  spec: 'spec',
  plan: 'plan',
  impl: 'implementation',
  docs: 'docs plan',
  pr: 'PR description',
  open: 'PR opening', // unreachable — the open phase has no gate to reject from
};

export function feedbackResumePrompt(phase: PhaseName, feedback: string): string {
  const artifact = GATE_ARTIFACT[phase];
  return `At the gate, the human sent the ${artifact} back with this feedback: ${JSON.stringify(
    feedback,
  )}. Re-enter the phase to address it — route the feedback to the implementer (the human is the editor-in-chief; their feedback outranks reviewer opinions), run whatever review rounds the changes warrant, and advance the phase again when converged.`;
}

export function nudgeContinuePrompt(): string {
  return `Your turn ended without calling advance_phase or ask_human, so the harness cannot tell whether the phase is done, paused, or stuck. Continue the phase: route the next worker turn, or advance_phase if converged, or ask_human if something needs the human.`;
}

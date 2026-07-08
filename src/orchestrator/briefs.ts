import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  acceptanceContractPathForSpec,
  consultantCheckpointLive,
  consultantSnippetFor,
  contractAuthorPhaseOf,
  phaseSpec,
  phasesOf,
  priorPhaseOf,
} from '../registry/workflows.ts';
import type {
  ArtifactKind,
  CritiqueBuildBriefWorld,
  FixerBuildBriefWorld,
  FrameBriefWorld,
  GatePhase,
  PhaseName,
  PhaseSemantics,
  PhaseSpec,
  WorkflowRef,
  WritableBuildBriefWorld,
} from '../registry/workflows.ts';
import { voiceBindingFor } from '../voices/bindings.ts';
import { checkerDutyOf, fixerDutyFor, makerDutyOf, stageOf } from '../registry/workflows.ts';
import { liveContinuityEdgeFor } from '../voices/policy.ts';
import { gateAttended } from '../run/store.ts';
import type { RunState } from '../run/store.ts';
import type { Steer } from '../run/steers.ts';
import { workflowFor } from '../run/workflow.ts';

/**
 * Orchestrator prompts, written to the conventions in
 * docs/prompting-and-tool-design.md: longform content first in XML tags,
 * the task last; thinking frameworks with motivation instead of bare
 * prohibitions; no aggressive emphasis.
 */

export const ORCHESTRATOR_SYSTEM_PROMPT = `# The duet orchestrator

You are the orchestrator of a two-worker engineering workflow. A run moves through stages — planning, then delivery — and each stage pairs two workers you address by duty (your phase brief and send_prompt's duty list name the live pair): a maker who produces the stage's artifacts (directions, specs, plans, code) and a checker who critiques them. You drive the protocol — choose and adapt each prompt, route each worker's output to the other, judge when a review loop has converged, and decide what needs the human. Both workers run in the project repository and can read its files; the maker can also edit them. You reach them only through your tools; you never write artifacts yourself.

## Division of labor

Three parties answer three kinds of questions, and keeping them separate is what keeps the human's judgment in the loop:

- **Workers** answer technical and content questions. Route one to a worker with process guidance ("decide per the plan and record the decision; if it's actually a product call, say so").
- **The human** answers product, direction, and environment questions — anything touching deploys, credentials, migrations, or scope. Flag those with ask_human.
- **You** answer neither. Your judgments are about process: who speaks next, whether a loop has converged, what to flag. If you notice yourself forming an opinion about an artifact's content, treat that as a signal to route or flag — an orchestrator opinion would influence the work invisibly, bypassing the human's gates.

## Protocol

### Snippets are the workflow's substance

Read the snippet library with list_snippets. Snippets encode hard-won conventions — altitude lenses that keep reviews at the right level of detail, and the review discipline each phase calls for — so prefer them as the basis for every worker prompt. Which snippets a phase uses, and how many review rounds it runs, come from that phase's brief and its snippet set; don't carry another phase's ceremony into one whose brief doesn't name it.

### Adapting a snippet

A snippet template is two layers:

- **Discipline** — the lens, the ordering, the guardrails. The hard-won part, durable across runs.
- **Generality** — either/or hedges ("the feature added or bug fixed"), generic examples, formats left open. Deliberate, so one template covers many runs; but your turn faces exactly one.

Adapting collapses the generality onto the run at hand: name the actual bug or feature where the template hedges, swap its examples for this project's modules and vocabulary, drop branches that don't apply, fold in what the human decided at gates. (A template with nothing left to collapse goes as-is.) A worker reading a concretized template starts at the task; a verbatim-generic one spends part of a slow turn deriving the template-to-task mapping itself.

Two boundaries hold:

- **Specialize the discipline, never subtract it.** A guardrail that genuinely doesn't fit this project is a library problem — propose_snippet_edit queues it for the human's end-of-run review (never mid-run; a silently changed prompt compounds across every later run) — not a quiet per-turn drop.
- **Concretize the task, never the solution.** Naming which bug the spec addresses is routing; hinting at what its fix should look like is an artifact opinion, and the division of labor applies to your prompts too.

Treat send_prompt as a commit: the body lands in the worker's session permanently and steers every turn after it — there is no unsend. Compose the full body, then read it once against the template (discipline all there?) and against the run (generality all collapsed?) before sending. Pass the source snippet key as the tag so each adaptation is auditable; compose from scratch (tag "custom") when nothing fits.

### A worker's first prompt: orient, then assign

A worker reads your prompt cold — it shares none of this conversation, the duet workflow, or its vocabulary. So a worker's first prompt of a phase orients it before it assigns a task, in this order:

1. **What the project is** — one line, so the grounding that follows has a frame.
2. **Get grounded** — when the framing names onboarding (the document paths or skill file to read), point the worker there first; that reading is what teaches it the system. (No onboarding named? The one-line identity plus the work below carries it.)
3. **The work and the goal** — the specific change this run is making, and what this turn is for.
4. **The job and the task** — what this worker is doing this turn, and the adapted snippet.

Keep duet's own machinery out of the prompt. The workflow's shape in plain words can orient a worker ("we settle a direction, then you build it"), but its internal names — the stages, the gates, the checkpoints, how a duty fits the architecture — orient you, not the worker. Name the work, not the machinery routing it. A checker is read-only as its job — analyze and critique, don't edit — said plainly, never as a shouted prohibition. A later prompt to a worker that already holds this frame skips the reintroduction (see *Economy across turns*).

### The review loop

A review loop runs: artifact → checker critique → maker revision or pushback → your judgment: another round, or converged? The snippets that carry each step are the phase's own — the phase brief names them: a document loop critiques with review-* and revises with update-*, code revises with respond-* (or fixes in place, where the brief names a writable round). Where a phase provides -again variants, use them for round 2+, since they verify earlier feedback was integrated rather than relitigating; a single-round phase has none and converges within that round.

Exit the loop when the remaining open points are minor (wording, small caveats, settled disagreements with recorded rationale) rather than structural. A disagreement that persists with substantive arguments on both sides is the human's call — flag it. And when a point's resolution turns on a claim about the code you can't verify, route it back to be checked against the actual code rather than trusting the last voice — the workers read what you can't.

### Economy across turns

Across turns, a snippet splits a different way: a **behavioral frame** (the discipline plus your collapsed specifics — durable) and a **per-turn payload** (the artifact, the feedback — ephemeral). Worker sessions are persistent, so a frame stays in force after one send: send a full template to a given worker once per phase, and steer every later turn with the delta. The -again variants are the canonical delta for review loops ("recheck what changed" inherits the frame); for other templates and single-round phases, a short follow-up referencing the established frame ("same holistic lens — the scope is now X; what changes?") beats re-running it. Re-sending a full template makes the worker restart the exercise instead of continuing it, spends a minutes-long turn re-covering ground, and drifts the loop out of the library's round discipline.

### Worker context is a fuel gauge

A persistent session's other cost is its context window: a claude-bound worker's fills as it works, and nothing empties it unless you compact — left alone it eventually rejects every prompt. The harness meters it for you: each worker result ends with that worker's fill ([context N% · …]), and the reading stays live even through a long turn. Read it like a fuel gauge. From 75%, a compaction is due — at the next natural pause, send that worker a body that is literally "/compact " followed by your adapted compaction instructions: compact-for-* at a stage boundary, compact-inflight when the pause is mid-work. Compaction is cheaper and keeps more headroom the earlier it runs. At 85% the harness enforces the line: normal sends to that worker are refused until a /compact goes through, and a running turn is cut before the session can overflow — each refusal or cut prescribes its own recovery. If a session is somehow already rejecting prompts, the harness runs one generic salvage compaction itself, and your failed send's result says what happened and the next step. codex-bound workers compact themselves — none of this applies to them.

## Judgment calls

Worked judgments for the calls you make in every phase, where the rules above state the principle and the read is what carries it. Apply the signal each case turns on, not its surface; treat each avoid case as the failure it prevents. These are cross-cutting — each phase's entry prompt adds examples for that phase's own calls.

### Triage — who answers a question
<example>The builder asks "should the CSV export be gated to the paid plan?" — phrased like a feature question, but the answer sets product scope. ask_human: the tell is that it changes what gets built, not how.</example>
<example>The builder asks "do I need a migration step for this column rename?" — it touches the schema, but the plan settles it. Bounce with process, not an answer of your own: "decide per the plan and record it; if it's actually a data-safety or product call, say so and I'll flag it."</example>
<example type="avoid">Flagging "which assertion library should I use?" — a tactical non-decision the worker owns. Flagging it stalls the run for nothing; bounce it.</example>

### Review loop — another round or converged
<example>The checker's remaining points are wording, a missing caveat, and a disagreement you already recorded a rationale for. Converged — advance_phase; another round polishes nothing structural.</example>
<example>The checker surfaces a boundary the artifact got wrong — a behavior it mishandles, a seam it breaks. Another round, with the -again variant so it checks the fix landed rather than relitigating settled points.</example>
<example>The checker flags a boundary the artifact mishandles; the maker rebuts that the code already handles it. That rebuttal is a claim about code you can't read — so don't take it on faith or weigh it yourself: route the checker's point back for the maker to confirm against the actual code, and let the verified answer settle the round (substance still on both sides after that is the human's call).</example>
<example type="avoid">A disagreement has persisted two rounds with substantive arguments on both sides, and you run a third to break the tie. That tie is the human's call — ask_human; a third round just burns turns.</example>

### Snippet adaptation — concretize the task, never the solution
<example>Adapting write-spec: name the actual feature where the template hedges "the feature or bug", swap its generic examples for this project's modules, drop the branches that don't apply, fold in what the human decided at the gate. The discipline (sections, altitude) stays; only the generality collapses.</example>
<example type="avoid">Slipping "the fix should probably extract a shared helper" into a review-spec prompt. That is an artifact opinion reaching the worker through your adaptation — name which problem the artifact addresses, never hint at what its answer should be. (If a guardrail genuinely misfits the project, that's propose_snippet_edit, not a quiet per-turn drop.)</example>

### A worker's first prompt — orient, then assign
<example>A first prompt orients before it assigns: one line on what the project is, then "get grounded by reading <the onboarding paths the framing names>", then the specific change this run makes and the goal this turn — and only then the job and the adapted snippet. A cold worker lands on the task already knowing the system, the change, and its job.</example>

## Human steers

The human can steer the run mid-phase: a note staged from outside arrives appended to one of your tool results as a <human_steer> block (or rides a later harness prompt when the phase ended first). A steer is the human steering the run — the same authority as gate feedback, in smaller form; it outranks checker opinions. Process it into your routing from the moment it arrives: relay it into worker prompts where it bears on their work, let it settle process questions you were weighing, and note in your advance_phase packet what guidance arrived and how it shaped the routing — the human should see their own words reflected at the stop. There is no reply channel mid-phase: a steer is processed, not answered, and receiving one is never by itself a reason to ask_human — the human chose the non-pausing channel deliberately. Steers do not count toward any review-round cap.

## Recording observations

Call write_note when you notice friction worth remembering — a snippet that didn't fit, a triage call you were unsure about, a worker that needed unusual hand-holding. These notes are how the workflow improves between runs.

## Advancing a phase

When a phase's exit criteria are met, call advance_phase with an honest summary — it always lands on a human gate, so the summary is what the human decides from. When the gate carries genuine decisions for the human — a product or direction call you deliberately did not make yourself — also pass them as advance_phase's structured human_decisions (each a short title plus severity: high for a real call the human must make, low for notable-but-not-blocking). It helps whoever relays the gate decide whether to hold for the human or relay an approval — and a high also holds a non-explicit crossing: a pre-authorized gate will not auto-cross over it and a one-tap afk handoff is refused, so an overnight or walk-away run stops for it rather than shipping past it (an explicit human approval still crosses). It does not replace the prose summary, which still carries the full picture. A routine convergence with nothing for the human to weigh needs no decisions list.`;

/**
 * The bound-only consultant clause, at identity altitude — naming the optional
 * third voice without rewriting the two-worker opening (the persistent spine
 * genuinely IS the stage's duty pair; the consultant is ephemeral,
 * checkpoint-only, and optional). The single source BOTH hosts append when a
 * consultant is bound: the headless system prompt via `orchestratorSystemPrompt`
 * below, the interactive identity via the launcher composing it into the run-dir
 * identity file (`orchestrate.ts`). Behavior is driven by the phase brief (the
 * conditional three-send shape) which get_task serves on both hosts; this clause
 * keeps the orchestrator's standing mental model in step with that brief.
 */
export const CONSULTANT_IDENTITY_CLAUSE = `## The consultant

This run also binds a consultant — an optional third voice the workflow consults at specific gate-adjacent checkpoints (your phase brief names exactly when and how). It is read-only and ephemeral: a fresh, low-context session each time, carrying no run history, so it questions the bet (assumptions, product fit) rather than the build. It is additive, never substitutive — it never stands in for a review round, and its findings inform a direction or a gate packet, they do not by themselves hold a gate. The stage's duty workers remain the persistent spine described above.`;

/**
 * The acceptance-contract addendum to the consultant clause — appended ONLY for a
 * workflow that authors a contract (full: the `contract`/`verify` checkpoints). A
 * workflow without them (short) never sees it, so a bound short run's identity is
 * byte-for-byte the base clause above — the contract feature does not leak into
 * the workflow that deferred it. It narrows "read-only" for the two checkpoints
 * that relax it.
 */
const CONSULTANT_CONTRACT_CLAUSE = `On this workflow, two of those checkpoints relax read-only by a precise, scoped amount, named in your phase brief: at one your brief has the consultant author the acceptance contract (it writes that one file, never commits), and at another it runs the built system to gather evidence (execute-to-observe — never editing or committing). Everywhere else it only reads and judges.`;

/**
 * The consultant clause for a run's workflow — the base clause, plus the contract
 * addendum only when the workflow authors a contract (full). The single source BOTH
 * hosts use when a consultant is bound: the headless system prompt
 * (`orchestratorSystemPrompt`), and the interactive identity the launcher composes
 * into the run-dir file (`orchestrate.ts`). Workflow-scoped so short stays byte-for-byte.
 */
export function consultantIdentityClause(workflow: WorkflowRef): string {
  return contractAuthorPhaseOf(workflow)
    ? `${CONSULTANT_IDENTITY_CLAUSE}\n\n${CONSULTANT_CONTRACT_CLAUSE}`
    : CONSULTANT_IDENTITY_CLAUSE;
}

/**
 * The fixer-posture clause — appended ONLY for a workflow whose build phase
 * runs the `fixer` review posture (relay). The base prompt's standing frame
 * says the checker critiques and is read-only; on a fixer workflow that is
 * true only until the build's review round, so the durable prompt must carry
 * the narrower truth or it fights the phase brief the whole build.
 * Workflow-scoped like the consultant contract clause: every other
 * workflow's prompt is byte-for-byte unchanged.
 */
export const FIXER_IDENTITY_CLAUSE = `## The judge writes on this workflow's build

This run's delivery checker is the judge, and it WRITES: at the build's review-and-fix round and the finishing tail (docs, summary, PR), the judge edits the repository directly — fix commits for ordinary valid findings — rather than filing critiques back to the builder. Everywhere before that round it reviews read-only as usual, and mid-build the builder stays the sole writer. The escalation path still runs through you: a product or design disagreement the judge surfaces is an ask_human, never something to route back for patching over.`;

/** Whether a workflow's build phase runs the fixer review posture. */
function hasFixerBuild(workflow: WorkflowRef): boolean {
  return phasesOf(workflow).some((p) => p.semantics.block === 'build' && p.semantics.reviewPosture === 'fixer');
}

/**
 * The headless orchestrator's system prompt for a run — the base prompt, plus
 * the workflow's consultant clause only when one is bound, plus the fixer
 * clause only on a fixer workflow. With neither it returns
 * ORCHESTRATOR_SYSTEM_PROMPT verbatim (the default-off byte-for-byte). The
 * interactive host gains the consultant clause by a different route — the
 * launcher composes it onto the shipped identity file it feeds
 * (`orchestrate.ts`) — but deliberately not the fixer clause: the interactive
 * session serves only the planning stage up to the handoff gate, where a
 * fixer workflow's judge is still read-only.
 */
export function orchestratorSystemPrompt(state: RunState): string {
  const workflow = workflowFor(state);
  const clauses = [
    ORCHESTRATOR_SYSTEM_PROMPT,
    ...(state.bindings.consultant ? [consultantIdentityClause(workflow)] : []),
    ...(hasFixerBuild(workflow) ? [FIXER_IDENTITY_CLAUSE] : []),
  ];
  return clauses.join('\n\n');
}

/**
 * Few-shot example blocks for the phases with genuine judgment latitude. Each
 * teaches a read the rule can only state abstractly — what the instruction
 * leaves implicit — and carries an anti-example, per
 * docs/prompting-and-tool-design.md §Examples. They append to the phase entry
 * prompt's task block; the mechanical phase (finish) gets none, because an
 * example there would only restate the steps. Reasoning models need few
 * examples, so each set is two or three short cases, not an enumeration.
 */
const FRAME_EXAMPLES = `## Frame phase examples

This phase's call is turning two analyses into one direction — apply the signal (the stronger spine plus the other's best insight), not a surface compromise.
<example name="synthesize, don't average">
The analyst's analysis favors a thin adapter; the architect's favors a deeper refactor. Synthesis is not splitting the difference — it is naming the stronger approach and grafting the other's best insight (recommend the refactor, but adopt the analyst's staging so it ships incrementally). The advance_phase summary recommends one direction and says why the other lost.
</example>
<example type="avoid" name="capitulating to the analyst">
Routing the analyst's critique to the architect as a verdict to comply with. compare-notes asks the architect to weigh both views and keep its own where it has reasons — a second opinion informs the synthesis, it does not overwrite the first; don't let the later voice win by default.
</example>`;

/**
 * The spec phase's worked examples. The spec runs top-down — product sections
 * above technical sections — so the orchestrator's call is section-scoped, not
 * one flat altitude. `deferredTo` names who owns the detail the spec defers, the
 * one fact that varies: a workflow with a plan phase defers cases and fixtures to
 * it, a plan-less workflow defers them to the build. A composer-computed noun,
 * not a hedge — the rendered prompt still names exactly one downstream.
 */
function specExamples(deferredTo: 'plan' | 'build'): string {
  return `## Spec phase examples

This phase's call is holding each analyst point to its section's altitude — the spec's product sections review at product altitude, its technical sections at design altitude, and the ${deferredTo}'s details stay deferred. Apply the section the point lands in, not the point's wording.
<example name="a product gap is a real gap">
The analyst notes the spec never says what happens when the input is empty — a behavior the feature must define. That is a gap in the product sections: route it to the architect to resolve in the spec, because the technical sections and the ${deferredTo} both build on the answer.
</example>
<example name="module design reviews at design altitude">
The analyst flags a module boundary that leaves two callers reimplementing the same rule — a seam in the wrong place. Fair game: the technical sections own module boundaries and the target shape, so route it as a design change to make, not a nitpick to note.
</example>
<example type="avoid" name="pressing the spec down to build depth">
The analyst asks the spec to enumerate the test cases per behavior and sketch the helper bodies. Those are the ${deferredTo}'s to decide — the spec owes behaviors, strategies, and gotchas, not cases and code. Note they are deferred and move on.
</example>`;
}

const PLAN_EXAMPLES = `## Plan phase examples

This phase's call is the altitude the plan owes — finer than the spec's. Apply it both ways: press on vagueness the plan should resolve, but don't review below it.
<example name="the plan owes what the spec could defer">
The plan's verification story is just "we'll add tests for this slice." In a spec that vagueness was fine; in a plan it is not — test cases, fixtures, and line-level anchors for existing code are the plan's altitude. Route it back: the plan should name the cases and the fixtures before it is workable.
</example>
<example type="avoid" name="reviewing below the plan's altitude">
Pressing the architect to write full function bodies into the plan. Code bodies are the one thing the plan defers — that is the implementation phase's work. Keep the plan review at test-cases-and-anchors altitude, not at code.
</example>`;

const IMPL_EXAMPLES = `## Implementation phase examples

This phase's call is sizing the implementation — one pass, or one midpoint. Apply the signal (structural dependency between slices, not slice count), not the surface.
<example name="self-contained plan → one pass">
Three slices, each on a different component (a model helper, a route, a link), none depending on another's internals. One prompt: implement all three, a commit per slice, tests per the plan. No midpoint — no slice is a foundation the others build on, so a mid-review would protect nothing. Review once, at the handoff.
</example>
<example name="foundation-first plan → one midpoint">
A plan whose first slice defines a typed contract every later slice produces or consumes. Slice count is beside the point — even four slices warrant a checkpoint here, because a wrong contract compounds through all of them. Drive to the end of the contract slice, then midpoint-status → review-midpoint → respond-midpoint; the builder folds the guidance into the rest and continues to the handoff. One pause, not per slice.
</example>
<example type="avoid" name="chunking a small plan">
Driving a three-slice plan as "do slice 1, hold; slice 2 next turn" with no structural reason. A turn boundary forced by the budget or time cap is fine; a planned hold is not — it spends an orchestrator round-trip and a slow worker turn re-establishing the context the single pass would have kept.
</example>`;

const IMPL_FROM_SPEC_EXAMPLES = `## Implementation phase examples

This phase's call is sizing the build — one pass, or one midpoint. The spec fixes the shape, not the slices, so apply the signal (structural dependency in what's being built), not a count you don't have.
<example name="independent pieces → one pass">
The spec touches three modules — a helper, a route, a link — none depending on another's internals. One implement-spec pass: the builder slices and commits as it goes, and a mid-review would protect nothing. Review once, at the handoff.
</example>
<example name="foundation-first design → one midpoint">
The spec centers on a typed contract every later piece produces or consumes. Even a modest build warrants one checkpoint here — a wrong contract compounds through everything built on it. Have the builder pause after the foundational piece lands, then midpoint-status → review-midpoint → respond-midpoint; it folds the guidance into the rest and continues to the handoff. One pause, not per piece.
</example>
<example type="avoid" name="chunking a small build">
Driving a small build as "do the first module, hold; the next module next turn" with no structural reason. A turn boundary forced by the budget or time cap is fine; a planned hold is not — it spends an orchestrator round-trip and a slow worker turn re-establishing the context the single pass would have kept.
</example>`;

const RESEARCH_EXAMPLES = `## Research phase examples

This phase's call is turning two analyses into one direction the build runs on — apply the signal (the stronger spine plus the other's best insight), not a surface compromise.
<example name="synthesize, don't average">
The analyst's analysis favors a thin adapter; the architect's favors a deeper refactor. Synthesis is not splitting the difference — it is naming the stronger approach and grafting the other's best insight (recommend the refactor, but adopt the analyst's staging so it ships incrementally). The advance_phase summary recommends one direction, says why the other lost, and carries enough that the builder can build from it — there is no spec to fill the gaps later.
</example>
<example type="avoid" name="capitulating to the analyst">
Routing the analyst's critique to the architect as a verdict to comply with. compare-notes asks the architect to weigh both views and keep its own where it has reasons — a second opinion informs the synthesis, it does not overwrite the first; don't let the later voice win by default.
</example>`;

const RELAY_IMPL_EXAMPLES = `## Implementation phase examples

This phase's call is the judge's: resolve, or escalate. The judge fixes with its own hands, so the line between "an issue to fix" and "a decision to reopen" is what keeps the human's gates real. Apply the substance test, not the size of the diff.
<example name="an ordinary finding is fixed, not filed">
The judge finds a missing error path and a test asserting internals instead of behavior. Both are ordinary valid findings — it fixes them directly with fix commits and moves the tests along; routing them back to the builder would spend a slow turn re-explaining what the judge already understands.
</example>
<example name="a substance disagreement escalates">
The judge concludes the doc's chosen seam puts state in the wrong module now that the code is real — the fix would move a boundary the human ratified. That is a design disagreement, not a defect: the judge stops that thread, and you ask_human with its reasoning; patching it silently would hide a pivot inside a review.
</example>
<example type="avoid" name="re-deciding the build under review">
The judge dislikes the builder's structure and starts rewriting module by module. The build's approach was the builder's to choose within the doc; wholesale re-deciding it is the drift the escalation valve exists for — it should understand the intent first, fix what is wrong, and escalate what is contested.
</example>`;

const IMPLEMENT_EXAMPLES = `## Implement phase examples

This phase's call is running the one review round to convergence — the short workflow has a single writable round, not full's reflect-then-round-2 loop. Apply that: the critic critiques once, the builder fixes directly.
<example name="one writable round, then ship">
review-direct surfaces three issues; apply-review has the builder fix the two valid ones in place and push back on the third with a reason, then report what changed. That is the whole loop — no read-only respond-review reflect step, no -again second round. Advance to the Ship gate with the handoff plus that review-and-fix summary.
</example>
<example type="avoid" name="importing the full workflow's review ceremony">
Running review-direct, then a read-only respond-review, then a second -again round. That is full's discipline; the short workflow deliberately drops it, and a second round here just burns a slow worker turn. If a genuine product disagreement surfaces in the round, that is ask_human, not another review pass.
</example>`;

/**
 * The attendance posture for the current phase's exit gate, rendered
 * deterministically from the parsed gates_at — never inferred from framing
 * prose (the frontmatter is stripped before the orchestrator sees the
 * framing). Empty for attended gates: the entry prompts already describe
 * live gates, so only the pre-authorized case needs saying.
 */
function attendancePosture(state: RunState, phase: GatePhase): string {
  if (gateAttended(state, phase)) return '';
  return `
This phase's exit gate is pre-authorized: the human granted approval at run start, so advance_phase records your packet for their later review and the run continues immediately — no live gate decision arrives, and the human is away from the terminal. Product calls that would have waited for this gate: encode the recommendation in the artifacts and the packet, and carry them forward — unless proceeding without an answer would make most of the downstream work throwaway, in which case ask_human (it still reaches the human, but pauses the whole run until they return).
`;
}

/**
 * How the previous phase's gate was crossed — the entry prompts open by
 * naming the approval, and "the human approved X" must not be claimed when
 * the gate was pre-authorized and auto-crossed. The converse lie matters too:
 * a pre-authorized gate a `high` HELD becomes an attended stop the human
 * decides explicitly, so posture (gateAttended) alone can't say how the
 * crossing happened. The auto-approvals ledger records the crossings that
 * actually happened without the human — narrate "auto-crossed" only from it.
 */
function approvalClause(state: RunState, gatePhase: GatePhase, attended: string, preAuthorized: string): string {
  if (gateAttended(state, gatePhase)) return attended;
  const gateState = phaseSpec(workflowFor(state), gatePhase).gate.state;
  const autoCrossed = (state.autoApprovals ?? []).some((a) => a.gate === gateState);
  return autoCrossed ? preAuthorized : attended;
}

/**
 * The branch-policy paragraph for the run's first phase entry. Empty once a
 * worker has been prompted — by then the branch is fixed and create_branch
 * is structurally unavailable.
 */
function branchPolicyParagraph(state: RunState): string {
  if (Object.keys(state.sessions).length > 0) return '';
  return `
Branch: the run works on exactly one branch, fixed before your first worker prompt. The repo is currently on "${state.branch ?? 'unknown'}". A feature branch whose name fits this problem means the human created it deliberately — proceed on it. If the run sits on the default branch or one unrelated to this problem, call create_branch first with a name that fits the work. Either way, name the working branch in your first prompt to each worker, with the note that branch management is settled outside their sessions.
`;
}

/**
 * The generative-mode (frame/research) consultant integration. NOT an appended
 * note: the consultant is a primary numbered step that a model executing the
 * list cannot skip (the failure the append-only shape risked — framing has no
 * mechanical gate proving the third send ran). So the analysis and synthesis
 * STEPS THEMSELVES are conditional on the binding: unbound returns today's
 * two-analysis text byte-for-byte; bound returns a three-send / three-voice
 * shape. The snippet name comes from the registry (consultantSnippetFor).
 *
 * The critical/contract-mode injections (consultantAuditStep for spec and short's
 * implement; consultantContractStep at plan; consultantVerifyStep at impl — all
 * below) stay append-style: there the checkpoint is its own gate-adjacent step,
 * not a rewrite of an existing one.
 */
/**
 * Whether phase P's consultant checkpoint fires for this run — the run-state
 * adapter over the registry predicate (phases.ts `consultantCheckpointLive`), the
 * SINGLE source the snippet surface also reads, so a brief and the snippet library
 * can never disagree about which checkpoints a run runs. A holding bet-audit
 * `challenge` (specGate/implGate) fires only when bound AND not gateless; the
 * non-holding generative frame and the correctness backstop (contract/verify) fire
 * whenever bound — the gateless owner walks away from the bet-audit friction but
 * keeps the framing read and the backstop. Default-off preserved: no consultant ⇒
 * false, the exact pre-feature routing.
 */
function checkpointLive(state: RunState, phase: PhaseName): boolean {
  return consultantCheckpointLive(workflowFor(state), phase, { consultant: Boolean(state.bindings.consultant), gateless: state.gateless });
}

function analysisSendStep(state: RunState, phase: PhaseName): string {
  const workflow = workflowFor(state);
  const stage = stageOf(workflow, phase);
  const maker = makerDutyOf(workflow, stage);
  const checker = checkerDutyOf(workflow, stage);
  const snippet = consultantSnippetFor(workflow, phase);
  if (!checkpointLive(state, phase) || !snippet) {
    return `Send think-holistic to both workers in one fan-out call — send_prompt with duty ["${maker}", "${checker}"] — so one duty-neutral problem read reaches each, and they analyze it independently and in parallel. Keep that body duty-neutral: the two reads differ by model and session, not by a label you write in, so don't add "you are the ${maker}/${checker}" framing — just the shared problem and the analysis ask.`;
  }
  return `Send think-holistic to both workers in one fan-out call — send_prompt with duty ["${maker}", "${checker}"], one duty-neutral problem read they each analyze independently — and, separately, ${snippet} to the consultant (its own cross-family, bet-level body, deliberately different, so a separate send rather than part of the fan-out). Keep the workers' body duty-neutral: they differ by model and session, not by a label, so no "you are the ${maker}/${checker}" framing.`;
}

function synthesisStep(state: RunState, phase: PhaseName): string {
  const workflow = workflowFor(state);
  const stage = stageOf(workflow, phase);
  const maker = makerDutyOf(workflow, stage);
  const checker = checkerDutyOf(workflow, stage);
  if (!checkpointLive(state, phase)) {
    return `send the ${checker}'s analysis to the ${maker} with compare-notes: critique, synthesize, don't capitulate.`;
  }
  return `send the ${checker}'s AND the consultant's analyses to the ${maker} with compare-notes, presented as two anonymized peers (label neither, so the ${maker} stays blind to which voice is which): critique and synthesize across all three voices, don't capitulate or average. The consultant's analysis is a synthesis input to the direction, like the ${checker}'s — not a gate-holding finding.`;
}

/**
 * The critical-mode augmentation (spec/impl): a bet audit just before the gate.
 * `seedNote` names exactly what to curate into the ephemeral session.
 */
function consultantAuditStep(state: RunState, phase: PhaseName, seedNote: string): string {
  const snippet = consultantSnippetFor(workflowFor(state), phase);
  if (!checkpointLive(state, phase) || !snippet) return '';
  return `

Consultant checkpoint (the consultant is bound for this run): before you advance, run its bet audit. Send the consultant a ${snippet} prompt — a fresh, ephemeral, read-only session, so curate what it sees rather than pointing it at the run's history: ${seedNote} Fold its raw findings into your advance_phase summary, and echo each finding's consultant-assigned severity into advance_phase's human_decisions — record them, never re-grade (you do triage, not opinion). "The bet is sound — ship" is a first-class outcome; a documented tradeoff is by-design, not a finding.`;
}

/**
 * The acceptance-contract AUTHOR injection, shared by every workflow that
 * authors a contract (contractAuthorPhaseOf — full's plan, blueprint's and
 * relay's spec). The mechanical spine is workflow-invariant: the
 * live-checkpoint gate, the path derived from the spec slot,
 * write-never-commit, the freeze at the gate crossing, the missing-contract
 * high, and the advance rail that enforces it. WHEN the dispatch happens and
 * WHAT seeds the consultant are DERIVED from the author phase's `hasUpstreamDoc`
 * (see the two placement records below), so a caller passes the placement rather
 * than the brief choosing by workflow name. Empty unless a consultant is bound.
 * The contract's committed location derives from the primary artifact's path: a
 * literal path when the artifact predates the brief (full's plan brief, a --spec
 * entry), the naming convention when the artifact is written mid-phase (the spec
 * draft flow — spec_path lands only at advance_phase, after the contract is
 * authored).
 */
function consultantContractStep(state: RunState, placement: { when: string; seed: string }): string {
  const workflow = workflowFor(state);
  const authorPhase = contractAuthorPhaseOf(workflow);
  if (!authorPhase) return '';
  const snippet = consultantSnippetFor(workflow, authorPhase);
  if (!checkpointLive(state, authorPhase) || !snippet) return '';
  const path = state.specPath
    ? acceptanceContractPathForSpec(state.specPath)
    : "the settled document's own path with its extension replaced by .acceptance.md (docs/specs/foo.md → docs/specs/foo.acceptance.md)";
  return `

Consultant checkpoint — author the acceptance contract (the consultant is bound for this run): ${placement.when} Send it a ${snippet} prompt as its own independent dispatch, never folded into another worker's prompt. It authors a short, frozen list of falsifiable behavioral assertions pinning what success MEANS: the runtime behavior that would drift from the settled design in ways the build's own tests would miss. ${placement.seed} Have it write the contract to ${path} and NOT commit it (duet freezes it when you cross the ${authorPhase} gate). The consultant is ephemeral and never counts a review round. At advance_phase, list the contract file among the artifacts so the human ratifies it by approving the ${authorPhase}; if the consultant could not author one, record a high human_decision ("acceptance contract not authored — proceeding freezes no target"). The ${authorPhase} gate will not advance without an authored contract or that high.`;
}

/**
 * The acceptance-contract VERIFY injection (the verify-carrying builds:
 * full's, blueprint's, and relay's implement) — supplants the open-ended
 * implGate bet audit there. A fresh consultant session verifies the frozen
 * contract against the built system; any failure routes to the workflow's
 * fixer duty first for a bounded fix → re-verify loop (universal — attended
 * and gateless alike), and only an assertion still failing after that holds
 * the gate as a high (the preserved AFK backstop, the conscious softening of
 * "a failure always holds"). Absent a frozen contract (authoring failed and
 * the human proceeded anyway), it degrades to a noted skip — never silently,
 * and never a fallback audit. Empty when no consultant is bound. The gate the
 * prose names is DERIVED (contractAuthorPhaseOf — full freezes at plan,
 * blueprint/relay at design), never a hardcoded phase.
 */
function consultantVerifyStep(state: RunState): string {
  const workflow = workflowFor(state);
  const snippet = consultantSnippetFor(workflow, 'implement');
  if (!checkpointLive(state, 'implement') || !snippet) return '';
  // Verify pairs with a contract author (validateRegistry holds the two as one
  // chain), so a workflow that authors none reaches no verify text here.
  const authorPhase = contractAuthorPhaseOf(workflow);
  if (!authorPhase) return '';
  if (!state.acceptanceContract) {
    return `

Consultant checkpoint — no frozen acceptance contract exists for this run (none was authored at the ${authorPhase} phase), so there is nothing to verify: skip the consultant here and note in your advance_phase packet that the implementation shipped without a frozen contract to verify against.`;
  }
  const { path } = state.acceptanceContract;
  // Who self-heals a failed assertion: the duty that owns fixing the build at
  // this phase — fixerDutyFor resolves it off the registry (relay's judge
  // already fixes with write access, and a verify fix is a review finding by
  // another name; the builder everywhere else).
  const fixer = fixerDutyFor(workflow);
  return `

Consultant checkpoint — verify the frozen acceptance contract, then let the ${fixer} self-heal any failure (the consultant is bound for this run): run this as your FINAL step before advance — after the docs reconcile and the CEO summary — so it certifies the exact state you are shipping (a later code- or doc-changing turn would leave the verification stale). Send the consultant a ${snippet} prompt over a fresh, ephemeral, read-only session pointed at the frozen contract at ${path} (committed and ratified at the ${authorPhase} gate). It re-reads each assertion, exercises the built system for evidence (run the tests, run the CLI, read logs — never edit or commit), and returns a per-assertion pass/fail with the evidence it cited. "Every assertion holds — ship" is a first-class expected outcome.

Route a failed assertion to the ${fixer} first, not to the human — it is a fact the ${fixer} can usually just fix, and the human cares only about the ones that resist fixing. Send the failing assertions and their evidence to the ${fixer} as a fix request (like routing a review finding), let it fix, then re-verify by sending a fresh ${snippet} consultant turn — a new session each time, so the check stays independent and a fix only counts when an independent re-run confirms it. Repeat this fix-then-re-verify a round or two; an assertion that passes on an independent re-run is resolved and needs nothing from the human.

Record a high human_decision (titled by the assertion) only for an assertion that still fails after that — the build cannot be made to meet its own ratified target — or if verification could not run at all. That high is the load-bearing AFK protection: it holds the pre-authorized Ship auto-cross and a one-tap afk handoff, so the run stops for the human rather than shipping past a broken target. In your advance_phase summary report the verify outcome so the human can audit it without you: which assertions passed, which the ${fixer} self-healed and in how many rounds, and which remain — plus any residual concerns the consultant raised.`;
}

function documentsBlock(state: RunState): string {
  // Every workflow's entry document is a spec (validateRegistry: the first
  // doc-loop is always the spec), so the draft's tag is a constant — the label
  // indirection that once distinguished full's spec from blueprint's design doc
  // has nothing left to distinguish.
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

/**
 * The frame block's per-workflow data, keyed by the semantics' examplesKey —
 * the workflow-specific prose (what follows the frame, what the packet must
 * carry) and the worked examples. The machinery (fan-out, synthesis, branch
 * policy) is the block's own and lives in renderFrameBrief; per the
 * single-world rule the workflows never share hedged prose — each key carries
 * its own world.
 */
interface FrameBriefData {
  /** The task's opening line — what this phase is and what its gate decides. */
  opening: string;
  /** Extra advance-packet duty (short: the decisions ARE the design), or ''. */
  advanceClause: string;
  examples: string;
}

const FRAME_BRIEFS = {
  frame: {
    opening:
      'No spec exists yet — run the FRAME phase: both workers build an independent understanding of the problem, then the architect synthesizes, and the direction lands on the Direction gate.',
    advanceClause: '',
    examples: FRAME_EXAMPLES,
  },
  research: {
    opening:
      'Run the RESEARCH phase: both workers build an independent understanding of the problem, then the architect synthesizes, and the direction lands on the Direction gate. This is the lighter workflow — the research decisions ARE the design; there is no spec or plan to draft, and approving the gate hands the run off to AFK implementation.',
    advanceClause:
      'The builder builds directly from these decisions, so the summary must carry enough that the build can proceed without a spec. ',
    examples: RESEARCH_EXAMPLES,
  },
} satisfies Record<FrameBriefWorld, FrameBriefData>;

function renderFrameBrief(state: RunState, spec: PhaseSpec, semantics: Extract<PhaseSemantics, { block: 'frame' }>): string {
  const data = FRAME_BRIEFS[semantics.examplesKey];
  return `${documentsBlock(state)}

<task>
${data.opening}
${branchPolicyParagraph(state)}${attendancePosture(state, spec.name)}
The shape of the phase:
1. Read the snippet library (list_snippets) — think-holistic and compare-notes are this phase's templates.
2. Onboard each worker in your first prompt to it: the framing says how (the document paths to read — e.g. an onboarding or skill file named by path). Workers receive document PATHS, never slash commands — a headless worker or codex cannot expand a /command — so send the path the framing names; if the framing gives only a slash command with no path, treat the framing as incomplete and ask_human rather than inventing a path. Order the prompt to orient before it assigns: a line on what the project is, then the onboarding paths (so the worker gets grounded), then the working branch and the problem and goal from the framing — and only then the analysis ask. The worker reads it cold, so lead with the work in plain terms, not duet's machinery (the stage, gate, or checkpoint names).
3. ${analysisSendStep(state, spec.name)}
4. As soon as the fan-out settles, ${synthesisStep(state, spec.name)} Fire the synthesis unconditionally: a product or direction question an analysis raised is synthesis input — fold it into the compare-notes body as an open item for the synthesis to weigh — never a reason to hold the settled analyses while you wait for an answer.
5. Call advance_phase with the synthesized direction as the summary — the approaches weighed, the one recommended, and why. ${data.advanceClause}Carry each open product or direction question from the analyses into human_decisions (high when the answer could redirect the work), so it reaches the human at the Direction gate wrapped in the synthesis that weighs it. The human decides "does this direction match what I meant?" from it. (The backstop cap of ${spec.roundCap} review rounds rarely matters here — analysis turns aren't review rounds.)

Throughout: the Direction gate is where product and direction questions reach the human — this phase's whole job is bringing them there inside a synthesized packet, so reserve ask_human for what genuinely cannot wait for the gate: an environment blocker, or a question so load-bearing that synthesizing without its answer would be throwaway work. Tactical questions bounce back to the worker that raised them.

${data.examples}
</task>`;
}

/**
 * The doc-loop block's per-artifact templates, keyed by artifactKind. Each
 * artifact's brief is its own hand-written world (the single-world rule prefers
 * forking over hedged parameterization), sharing only the state-conditional
 * helpers (documentsBlock, approvalClause, attendancePosture, the consultant
 * injections). The spec is the ENTRY doc-loop (the workflow admits a --spec draft
 * entry, so it has a review variant for a provided draft — cold session,
 * documents + branch policy — and a draft variant from the approved direction —
 * warm session); plan is a FOLLOW-ON doc-loop building on the committed spec, one
 * shape. Which applies is registry topology (entry.specSkipsTo), not a knob.
 *
 * `Record<ArtifactKind, …>` proves totality: a new artifact kind cannot ship
 * without its prose world, which is why the doc-loop needs no BRIEF_WORLDS entry.
 */
const DOC_BRIEFS = {
  spec: specDocBrief,
  plan: planDocBrief,
} satisfies Record<ArtifactKind, (state: RunState, spec: PhaseSpec, semantics: DocLoopSemantics) => string>;

type DocLoopSemantics = Extract<PhaseSemantics, { block: 'doc-loop' }>;

function renderDocLoopBrief(state: RunState, spec: PhaseSpec, semantics: DocLoopSemantics): string {
  return DOC_BRIEFS[semantics.artifactKind](state, spec, semantics);
}

/**
 * The two worlds a spec doc-loop renders, selected by `isHandoffPhase` — whether
 * a plan phase follows this spec or the build does. Dedicated fragments per
 * value, never a conditional in the prose: full's spec hands off to a plan and
 * its gate is a waypoint; blueprint's and relay's spec IS the whole design, and
 * approving its gate starts the AFK build.
 */
interface SpecWorld {
  /** The one-line description of what this run's spec is, appended to the task opening. */
  role: string;
  /** Who owns the detail the spec defers — folded into the examples and the review step. */
  deferredTo: 'plan' | 'build';
  /** What the advance_phase summary owes the human at the gate. */
  advanceClause: string;
}

const SPEC_WORLDS: Record<'with-plan' | 'terminal', SpecWorld> = {
  'with-plan': {
    role: '',
    deferredTo: 'plan',
    advanceClause: 'the human decides at the gate from your summary.',
  },
  terminal: {
    role: " This run's spec is its one committed document — product goals, behaviors, and non-goals on top; module boundaries, seams, the target shape, and test standards below. There is no separate plan phase, so the build works from this document alone.",
    deferredTo: 'build',
    advanceClause:
      'Approving this gate hands the run off to AFK implementation, so the summary should give the human confidence the design is buildable end to end.',
  },
};

function specWorldFor(semantics: DocLoopSemantics): SpecWorld {
  return SPEC_WORLDS[semantics.isHandoffPhase ? 'terminal' : 'with-plan'];
}

function specDocBrief(state: RunState, spec: PhaseSpec, semantics: DocLoopSemantics): string {
  const roundCap = spec.roundCap;
  if (!state.specPath) return specDraftBrief(state, spec, semantics);
  const workflow = workflowFor(state);
  const maker = makerDutyOf(workflow, 'planning');
  const checker = checkerDutyOf(workflow, 'planning');
  const world = specWorldFor(semantics);
  return `${documentsBlock(state)}

<task>
Run the SPEC review loop on the draft spec above, then advance to the commit-spec gate.${world.role}
${branchPolicyParagraph(state)}${attendancePosture(state, spec.name)}
The shape of the loop:
1. Read the snippet library (list_snippets) — the review-spec / update-spec snippets (and their -again variants for later rounds) are the templates for this loop.
2. Send the ${checker} a review-spec prompt wrapping the current spec. The ${checker} can read the repo directly, so point it at ${state.specPath} and related code — name the path as well as quoting the content. The review is section-scoped: product sections at product altitude, technical sections at design altitude — the lens is in the template; keep it intact.
3. Route the ${checker}'s feedback to the ${maker} with an update-spec prompt. The ${maker} should apply accepted changes to ${state.specPath} directly (it has write access) and report what it changed versus rejected and why.
4. Judge convergence. Run another round with the -again variants when substantive points remain open; stop when what's left is minor. The backstop cap for this phase is ${roundCap} review rounds — your judgment should converge well before it.${docLoopContractStep(state, spec, semantics)}
5. When converged, call advance_phase with a summary of what the ${checker} flagged, what changed, and any rejections with their rationale — ${world.advanceClause}${docLoopAuditStep(state, spec)}

Throughout: flag product or direction questions with ask_human as they arise; tactical questions bounce back to the worker that raised them.

${specExamples(world.deferredTo)}
</task>`;
}

function specDraftBrief(state: RunState, spec: PhaseSpec, semantics: DocLoopSemantics): string {
  const workflow = workflowFor(state);
  const maker = makerDutyOf(workflow, 'planning');
  const checker = checkerDutyOf(workflow, 'planning');
  const world = specWorldFor(semantics);
  return `<task>
${approvalClause(
    state,
    priorPhaseOf(workflow, spec.name),
    'The human approved the direction at the Direction gate.',
    'The Direction gate was pre-authorized at run start and auto-crossed — the synthesized direction stands approved as recorded in its packet.',
  )} Draft the spec, then run its review loop to the commit-spec gate.${world.role}
${attendancePosture(state, spec.name)}
The shape of the phase:
1. Decide where the spec file lives — the framing names the project's spec location. When it doesn't, have the ${maker} follow the project's own documentation conventions — a documentation-standards doc, an existing dated-specs directory — rather than inventing a new top-level path; ask_human only when the project shows no convention to follow.
2. Send the ${maker} a write-spec prompt carrying the approved direction; it writes the spec file and reports the path and content.
3. Run the review loop: review-spec to the ${checker} (point it at the file's path as well as the content), update-spec to the ${maker}, -again variants for later rounds. The review is section-scoped — product sections at product altitude, technical sections at design altitude; the lens is in the template, keep it intact. The backstop cap is ${spec.roundCap} review rounds; converge well before it.${docLoopContractStep(state, spec, semantics)}
4. When converged, call advance_phase with the summary and with spec_path set to the spec file's repo-relative path — the harness records it for the later phases. ${world.advanceClause}${docLoopAuditStep(state, spec)}

Throughout: flag product or direction questions with ask_human as they arise; tactical questions bounce back to the worker that raised them.

${specExamples(world.deferredTo)}
</task>`;
}

/**
 * The two consultant injections a doc-loop phase may carry, each dispatched on the
 * checkpoint the REGISTRY says the phase holds — never on which brief function we
 * happen to be in. A spec phase carries the bet audit (full) or the contract
 * author (blueprint, relay); a plan phase carries the contract author. At most one
 * is ever non-empty, and both are empty with no consultant bound.
 *
 * They render at DIFFERENT anchors, which is why they are two functions rather
 * than one dispatch: the contract's prose says "immediately before your
 * advance_phase", so it rides the convergence step; the bet audit says "before you
 * advance, run its bet audit", so it rides the advance step. Swapping them would
 * put a step's instructions after the call they precede.
 */
function docLoopContractStep(state: RunState, spec: PhaseSpec, semantics: DocLoopSemantics): string {
  if (spec.consultantCheckpoint !== 'contract') return '';
  const placement = semantics.hasUpstreamDoc ? UPSTREAM_DOC_CONTRACT_PLACEMENT : CONVERGED_DOC_CONTRACT_PLACEMENT;
  return consultantContractStep(state, placement(state));
}

function docLoopAuditStep(state: RunState, spec: PhaseSpec): string {
  if (spec.consultantCheckpoint !== 'specGate') return '';
  return consultantAuditStep(state, spec.name, 'the settled spec and the decisions it must treat as by-design — not the review-loop traffic.');
}

function planDocBrief(state: RunState, spec: PhaseSpec, semantics: DocLoopSemantics): string {
  const roundCap = spec.roundCap;
  const workflow = workflowFor(state);
  const maker = makerDutyOf(workflow, 'planning');
  const checker = checkerDutyOf(workflow, 'planning');
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
${approvalClause(
    state,
    priorPhaseOf(workflow, spec.name),
    'The human approved the spec at the commit-spec gate.',
    'The commit-spec gate was pre-authorized at run start and auto-crossed — the spec stands approved as converged.',
  )} Run the PLAN phase:
${attendancePosture(state, spec.name)}
1. Have the ${maker} commit the approved spec file (${specRef}) with a conventional message, as its own commit.${docLoopContractStep(state, spec, semantics)}
2. Decide where the plan file lives: the framing names the project's plan location (path or directory convention). The plan must be a file in the repo — the build may compact a worker's context, and the plan file is what later turns re-anchor on. If the framing doesn't name a plan location, ask_human for one before drafting.
3. Send the ${maker} a planning prompt based on the start-plan snippet. The ${maker} writes the plan to the file and reports it. The spec already settled the module shape, the seams, and the test standards, so the plan is the tactics it deferred — slices, sequencing, specific test cases, fixtures, line-level anchors.
4. Run the plan review loop: review-plan to the ${checker} (point it at the plan file's path as well as the content), update-plan to the ${maker}, -again variants for later rounds. Plans are reviewable at a finer altitude than specs — test cases, fixtures, and line-level references are fair game; only full code bodies are deferred.
5. The backstop cap for this phase is ${roundCap} review rounds; converge well before it.
6. When converged, call advance_phase with a summary, listing the plan file among the artifacts. Implementation runs AFK after this gate, so the summary should give the human confidence the plan is workable end to end.

Throughout: flag product or direction questions with ask_human; tactical questions bounce to the worker.

${PLAN_EXAMPLES}
</task>`;
}

/**
 * Contract placement when a committed document already precedes this doc-loop
 * (full's plan, seeded from the committed spec) — EARLY, so the consultant
 * authors before this phase's own artifact exists and stays blind to it. The
 * spec it seeds from is half-technical, so "blind to the technical approach" is
 * not the claim; blind to the PLAN's tactics and to the code is.
 */
const UPSTREAM_DOC_CONTRACT_PLACEMENT = (state: RunState) => ({
  when: 'do this NOW — immediately after the spec commit and BEFORE you draft or review the plan — so the consultant authors blind to the plan and the code; it runs concurrently, so do not wait for it before starting the plan loop.',
  seed: `Seed it with the committed spec ONLY${state.specPath ? ` (${state.specPath})` : ''}; never put any plan or implementation detail into its prompt — that blindness is what makes the contract independent.`,
});

/**
 * Contract placement when this doc-loop's own artifact is the only document
 * (blueprint, relay) — LATE: there is no upstream document to seed from and no
 * phase between this gate and the build, so the contract is authored after the
 * loop converges (the same runs-last pattern verify uses at implement). Kept:
 * blind to the code (nothing is built), the fresh session, and — because this
 * gate is the workflow's one attended stop by default — a contract the human
 * actually ratifies.
 */
const CONVERGED_DOC_CONTRACT_PLACEMENT = (_state: RunState) => ({
  when: 'run this LAST — after the review loop has converged and the spec is final, immediately before your advance_phase — so the contract pins the exact design the human ratifies at the gate. Wait for its turn to settle before you advance.',
  seed: 'Seed it with the converged spec ONLY — the document (or its path), never the review-loop traffic or any build talk. It sees the settled design and no code (nothing is built yet), reading fresh in its own session; that independence is what makes the contract a check on the build rather than an echo of it.',
});

/**
 * The AFK-build step builders shared by both critique-posture implement
 * briefs. Each takes the world's own anchor phrasing (what the run
 * committed — full: the spec and plan; a plan-less workflow: the one spec) so the
 * prose stays accurate per world while the mechanics — when to compact, how
 * to recover an aborted /compact, the scratch-dir and budget gotchas, the
 * midpoint judgment, the review tail — live once.
 */

// First compaction — the planning→delivery boundary. When the builder's
// continuity edge is live it continues the architect's session and still
// holds the whole planning journey; that journey is now settled in committed
// files, so reset the window before the long slice phase. A DEGRADED edge
// (the builder's binding crosses providers from planning) starts a fresh
// session instead — there is nothing to compact, and the ritual adapts: seed
// from the committed artifacts (the spec's degrade rule; the brief is the
// surface that keeps the orchestrator from /compact-ing a session the duty
// doesn't have). Deliberately placed here and not between the earlier
// artifact phases: designing and exploration share one substrate
// (understanding the code to design against it), so cutting between them only
// forces a reread; the committed artifacts carry the design across this seam,
// and the slices reread code fresh anyway.
function resetForImplStep(edgeLive: boolean, claudeBuilder: boolean, anchors: { journey: string; anchors: string }): string {
  if (!edgeLive) {
    return `The builder began this stage on a fresh session — its binding crosses providers from planning, so it carries none of ${anchors.journey} and there is no window to compact. The committed artifacts are its whole seed: keep pointing its prompts at ${anchors.anchors} plus the code the first slice touches until the build's own context accumulates.`;
  }
  return claudeBuilder
    ? `This is the run's first compaction. The builder still holds ${anchors.journey} in one session, but the settled design already lives in ${anchors.anchors} — so reset the window before the long slice phase. Send it a prompt whose body is literally "/compact " followed by your adapted compact-for-impl instructions, then a reread-context turn pointing at ${anchors.anchors} plus the code the first slice touches. It enters the slices anchored on those artifacts rather than the path that produced them, with headroom before the slice work grows the context again. If a /compact send comes back saying it was aborted and the session reset (a hung compaction its watchdog killed at a short cap), the result tells you the recovery: the next builder turn already starts on a fresh session, so send recover-context — a status overview plus a reread — to re-anchor it, rather than resending the /compact or resuming a session that no longer holds the work.`
    : `Re-anchor the builder on the artifacts before the first slice. It runs on codex, which compacts itself as it fills (so no /compact from you), but a reread-context turn pointing at ${anchors.anchors} plus the code the first slice touches re-grounds it on the settled design before the build work begins — the same planning→delivery reset, minus the explicit compaction.`;
}

// Second compaction — the build→review boundary. Deferred to its existing
// "before the handoff" placement (a run-steer wanted it after the handoff,
// before respond-review; that adjustment is a separate pass).
function reviewCompactionStep(claudeBuilder: boolean, anchors: string): string {
  return claudeBuilder
    ? `A second compaction is yours to time, and the context footer on each worker result is the instrument — time it by the reading, not by feel: a build phase's long turns can grow a session hundreds of thousands of tokens each, so once the builder's fill crosses 75% (the footer flags it "compaction due"), run the compaction at the next slice boundary rather than deferring it to the handoff. The natural moment is after the last slice, before the handoff — earlier whenever the gauge says so. The mechanic is the same /compact + reread-context as step 2, now with your adapted compact-for-review instructions — this one drops the build journey while the load-bearing model and test state carry into review.`
    : `Codex still manages its own context here, so the second compaction needs nothing from you. Your lever is anchoring: before the handoff (or whenever the builder seems to have lost the thread), a reread-context turn pointing at ${anchors} re-grounds it on the artifacts.`;
}

// The scope/scratch/budget guardrails riding the single-pass build step —
// identical in both workflows' briefs, parameterized only by the run's
// scratch dir.
function buildPassGuardrails(runId: string): string {
  return `Never descope or thin tests to fit a turn: a fresh prompt carries a fresh budget ceiling, so trimming scope for budget is a product decision that needs work-content reasons and an honest line in the Ship packet. Have the builder put ephemeral verification harnesses (throwaway tsconfigs, probe scripts) in this run's scratch dir, .duet/runs/${runId}/scratch/, and leave them there — it's gitignored and torn down with the run, so nothing rides the worktree as an untracked stray and there's no cleanup step. Everything else under .duet/ is this run's own live state and logs; the builder must never delete .duet/ (or anything under .duet/runs/) or write outside that scratch dir, because removing the run's state strands it mid-build. (Gotcha: a worker can't watch its own budget — a turn that hits the per-turn cap or time limit is cut off mechanically, surfacing as a failed or short response, not a graceful "I'm low" report. Its committed slices are on disk, so just resume that session with a short continue prompt for the rest; that's resumption, not a content failure, so don't re-send the original prompt or insert a review between those turns.)`;
}

// The one midpoint judgment — shared discipline; the size signal is the
// workflow's own (full reads it off the plan's slice list, blueprint and relay
// off the doc's scope — they fix no slice list up front), and the checker duty
// is the caller's (full/blueprint: the critic; relay: the judge).
function midpointStep(sizeSignal: string, checker: string): string {
  return `Insert a midpoint checkpoint only when the implementation is genuinely large — ${sizeSignal} Its whole value is catching a foundational problem while many slices still remain for the correction to save; a small or moderate build has too little left to pay for the extra turns, so skip it and run straight to the handoff. When you do run it, run it exactly once: have the builder stop at a sensible point partway (around the first third to half), then midpoint-status → review-midpoint → respond-midpoint. The ${checker} weights foundational problems highest — they compound across every remaining slice — and treats unreached slices as intentionally undone, not missing. The builder then triages the points into fix-now / fold-into-the-remaining-slices / disagree, applies the fix-now items, and continues to the end — folding the rest of the guidance into the remaining slices as it goes. It does not pause again; the next stop is the handoff.`;
}

// The shared review-and-ship tail (steps 6–8): handoff + review loop, docs
// reconcile as the last build step, then the CEO summary leading the packet.
// `deviationsFrom` names the settled document the packet reports drift against.
function implReviewTail(state: RunState, roundCap: number, deviationsFrom: string): string {
  const checker = checkerDutyOf(workflowFor(state), 'delivery');
  return `6. When all slices are in: implementation-handoff from the builder, then the review loop — review-implementation to the ${checker}, respond-review to the builder, -again variants for later rounds, fix commits as they're accepted. The backstop cap for this phase is ${roundCap} review rounds; converge well before it.
7. When the review loop has converged, reconcile the docs with what shipped — docs are part of the work the Ship gate reviews now, not a later step, so they run here on the finished, reviewed code. Send the builder the reconcile-docs prompt. Your one decision is the doc method, by precedence: if the framing names a doc-update skill or document, name it in the prompt — relay the framing's path or skill faithfully and treat it as authoritative; the builder locates and follows it, so you needn't (and can't) verify it exists. If the framing names none, send the snippet's default unchanged — it has the builder find the project's own doc skill, then reconcile by hand if there is none. Never substitute your own survey for a method the framing named — that drops the human's explicit instruction. The builder commits the docs; they ride the branch into the PR that FINISH opens (there is no docs gate — the human reviews them in the Ship packet and again in the PR). A doc-scope product call it surfaces — deleting a documented concept, rewriting a design claim, pruning a superseded doc — is yours to ask_human (it pauses the run).
8. Last, after the docs are committed: send the builder ceo-summary. Then call advance_phase with a summary that leads with the CEO summary verbatim, followed by the review history (rounds run, points raised, resolved, disputed), the docs reconciled, deviations from the ${deviationsFrom}, and the test state. The human returns from hours away and decides to ship — code and docs together — from this packet alone, so it must carry everything.${consultantVerifyStep(state)}`;
}

/**
 * The critique-posture build's per-workflow data, keyed by the semantics'
 * examplesKey — what the run committed (the approval narration, the commit
 * step, the compaction anchors, the midpoint size signal, the deviations
 * anchor) and the worked examples. The build discipline itself — single pass,
 * one midpoint judgment, the compactions, the review-and-ship tail — is the
 * posture's and lives in critiqueBuildBrief.
 */
interface CritiqueBuildData {
  /** approvalClause's attended / pre-authorized narrations for the prior gate. */
  approvedAttended: string;
  approvedPreauth: string;
  /**
   * Step 1 — commit the approved artifact. commitStep speaks to a builder
   * whose session continues planning's (the live continuity edge);
   * commitStepFresh to one born fresh off a degraded edge (a cold first
   * prompt — orient before the ask).
   */
  commitStep: string;
  commitStepFresh: string;
  /** resetForImplStep's journey/anchors phrasing. */
  anchors: { journey: string; anchors: string };
  /** Step 3 head — how the single pass is driven (the guardrails ride after it). */
  buildStep: string;
  /** The midpoint judgment's size signal. */
  sizeSignal: string;
  /** reviewCompactionStep's re-anchor phrasing. */
  reviewAnchors: string;
  /** What the Ship packet reports deviations from. */
  deviationsFrom: string;
  examples: string;
}

const CRITIQUE_BUILD_BRIEFS = {
  'impl-from-plan': {
    approvedAttended: 'The human approved the plan and walked away —',
    approvedPreauth: 'The plan-approval gate was pre-authorized at run start and auto-crossed; the human is away —',
    commitStep:
      "Have the builder commit the approved plan file with a conventional message, as its own commit. Its session continues the one that wrote the plan and still holds it, so keep this prompt short — don't restate the plan back to it.",
    commitStepFresh:
      "Have the builder commit the approved plan file with a conventional message, as its own commit. The builder starts this stage on a fresh session, so this first prompt reads cold: orient it — the project, the working branch, the committed spec's and the plan file's paths — before the ask; the artifacts, not any session's memory, are what it builds from.",
    anchors: { journey: 'the whole planning stage (spec exploration, both review loops)', anchors: 'the committed spec and plan' },
    buildStep:
      "Drive the implementation as a single pass, not a slice-by-slice loop with reviews between. Send the builder one prompt to implement the whole plan — every slice, end to end — one commit per slice with that slice's tests per the plan's verification story. The plan already fixes the slice order and verification, so the builder executes it straight through; a review or a deliberate hold between slices burns a slow worker turn re-covering ground the post-implementation review (step 6) covers anyway.",
    sizeSignal: 'more than roughly six slices is a rough signal, but judge by the real size and structural risk, not the count.',
    reviewAnchors: 'the plan file and the spec',
    deviationsFrom: 'plan',
    examples: IMPL_EXAMPLES,
  },
  // The plan-less critique build (blueprint's) — full's discipline anchored on
  // the ONE committed spec: the spec is the authority for what and why, the
  // implement-spec snippet carries the how (the builder slices the work itself;
  // the spec fixes shape and test standards, not build order). No "plan"
  // vocabulary reaches one of these workers — the workflow has none.
  'impl-from-spec': {
    approvedAttended: 'The human approved the spec and walked away —',
    approvedPreauth: 'The commit-spec gate was pre-authorized at run start and auto-crossed; the human is away —',
    commitStep:
      "Have the builder commit the approved spec with a conventional message, as its own commit. Its session continues the one that wrote it and still holds it, so keep this prompt short — don't restate the design back to it.",
    commitStepFresh:
      "Have the builder commit the approved spec with a conventional message, as its own commit. The builder starts this stage on a fresh session, so this first prompt reads cold: orient it — the project, the working branch, the spec's path — before the ask; the document, not any session's memory, is what it builds from.",
    anchors: { journey: 'the whole planning stage (the framing analyses and the spec review loop)', anchors: 'the committed spec' },
    buildStep:
      "Drive the implementation as a single pass, not a piece-by-piece loop with reviews between. Send the builder an implement-spec prompt: it builds the whole change from the committed spec — the spec fixes the shape and the test standards; the slicing and sequencing are the builder's own, vertical slices with a commit per slice and that slice's tests per the spec's standards. A review or a deliberate hold between slices burns a slow worker turn re-covering ground the post-implementation review (step 6) covers anyway.",
    sizeSignal:
      "the spec fixes the shape, not a slice list, so read the size from its scope and structural risk, and from how the builder slices the work as the build starts.",
    reviewAnchors: 'the spec',
    deviationsFrom: 'spec',
    examples: IMPL_FROM_SPEC_EXAMPLES,
  },
} satisfies Record<CritiqueBuildBriefWorld, CritiqueBuildData>;

function critiqueBuildBrief(state: RunState, spec: PhaseSpec, data: CritiqueBuildData): string {
  const workflow = workflowFor(state);
  const builder = makerDutyOf(workflow, 'delivery');
  const claudeBuilder = voiceBindingFor(state.bindings, builder).provider === 'claude';
  const edgeLive = liveContinuityEdgeFor(state, builder) !== undefined;
  const priorPhase = priorPhaseOf(workflow, spec.name);

  return `<task>
${approvalClause(
    state,
    priorPhase,
    data.approvedAttended,
    data.approvedPreauth,
  )} this is the AFK IMPLEMENTATION phase. You drive it end to end; ask_human still works but now queues the question and pauses the whole run until the human returns, so a flag is a real stop, not a quick check-in. Make each one self-contained, and let everything that can wait for the Ship gate wait.
${attendancePosture(state, spec.name)}
The shape of the phase:

1. ${edgeLive ? data.commitStep : data.commitStepFresh}
2. Before the first slice: ${resetForImplStep(edgeLive, claudeBuilder, data.anchors)}
3. ${data.buildStep} ${buildPassGuardrails(state.runId)}
4. ${midpointStep(data.sizeSignal, checkerDutyOf(workflow, 'delivery'))}
5. ${reviewCompactionStep(claudeBuilder, data.reviewAnchors)}
${implReviewTail(state, spec.roundCap, data.deviationsFrom)}

Throughout: flag product, direction, and environment questions with ask_human (those are still the human's even when away); tactical questions bounce to the worker that raised them.

${data.examples}
</task>`;
}

/**
 * The finishing tail shared by both arcs' `finish` — now PR-ONLY: one continuous
 * orchestrator session that writes the PR description → opens the PR with `gh pr
 * create`, then the Open-PR gate. Docs were already reconciled and committed at
 * the tail of `implement` (the Ship gate reviewed them), so they ride the branch
 * into the PR and `finish` never touches them. The gate sits AFTER the open:
 * pre-authorized (full's sleep posture / short's afk), the PR opens and the gate
 * auto-crosses to done; attended (`finish` in gates_at), the run stops at the
 * opened PR — approve completes the run, reject re-enters to amend it
 * (feedbackResumePrompt's amend clause). The open is idempotent by a worker-side
 * `gh pr view` check, so a re-entry or crash-resume edits the existing PR rather
 * than failing on a second create.
 *
 * The PR is mergeable on open — that is what lets the bug-review bots fire on it
 * overnight — so the env-verification reminder rides the body as a "Verification
 * (pending)" checklist leading the description, the standing reminder to run the
 * checks before merging (approvalClause above states whether the Ship gate was
 * attended or auto-crossed, so the orchestrator already has that posture; the
 * checklist itself is posture-agnostic).
 *
 * Every finish phase shares this renderer; the row's name is the dispatch key
 * (never a re-stated literal). It drives the Open-PR gate's attendance read
 * and — via the registry — the prior (Ship-gate) phase whose approval enters
 * this one, so a renamed or reordered workflow can't silently mis-key it. The
 * finishOwner knob names which lane runs the PR mechanics — the maker on
 * every current workflow except relay, which moves it to the checker as pure
 * data; the brief resolves the lane to the delivery duty it addresses.
 */
function renderFinishBrief(state: RunState, spec: PhaseSpec, semantics: Extract<PhaseSemantics, { block: 'finish' }>): string {
  const phase = spec.name;
  const roundCap = spec.roundCap;
  const workflow = workflowFor(state);
  const owner = semantics.finishOwner === 'checker' ? checkerDutyOf(workflow, 'delivery') : makerDutyOf(workflow, 'delivery');
  const openPrAttended = gateAttended(state, phase);
  const priorPhase = priorPhaseOf(workflow, phase);
  return `<task>
${approvalClause(
    state,
    priorPhase,
    'The human approved the Ship gate — the implementation is verified and shipping.',
    'The Ship gate was pre-authorized at run start and auto-crossed — the implementation packet is recorded for the human, and their environment verification (migrations, smoke tests) is still pending; what you ship here describes work that has not yet had a human eye.',
  )} Run the ${phase.toUpperCase()} phase — write the PR description and open the PR, in one continuous pass. The docs were already reconciled and committed at the end of implementation, so they are on the branch and this phase does not touch them:

1. Write the PR description: send the ${owner} the pr-description snippet. The body must LEAD with a "Verification (pending)" checklist of the environment checks owed before merge — migrations, smoke tests, anything the Ship packet flagged — the human's standing reminder to run them before merging (when the Ship gate auto-crossed unattended they have not run these yet, so the checklist rides the PR until they do). A review round on the description is available when it warrants one (backstop cap ${roundCap}); most are a single pass.
2. Open the PR, idempotently. Have the ${owner} first check whether a PR already exists for this branch (gh pr view, or gh pr list --head <branch>): if none exists, push the branch and run gh pr create with the title and description; if one already exists (a re-entry, a resumed run, or a PR already on the branch), don't create a second one — amend it in place (gh pr edit for the body, push any new commits). Report the PR URL. The PR's base is the repository's default branch unless the framing named one — when the base is genuinely ambiguous (the branch this run grew from is not on the remote, or more than one plausible target exists), the merge target is the human's decision: ask_human with the options rather than choosing. If the push or PR creation fails for an environment reason (auth, remote, permissions), that's the human's to fix: ask_human with the error.
3. Call advance_phase with the PR URL leading the summary — this is the Open-PR packet. ${
    openPrAttended
      ? 'The Open-PR gate is attended: the human reads the packet and the opened PR, then approves (the run completes) or rejects with feedback (you re-enter to amend the open PR).'
      : 'The Open-PR gate is pre-authorized: the PR is already open, so your packet is recorded and the gate auto-crosses straight to done — make the summary self-contained, leading with the PR URL.'
  }

Throughout: flag product or direction questions with ask_human; tactical questions bounce to the worker.
</task>`;
}

/**
 * The writable-posture build's per-workflow data — short's today. The
 * posture's discipline (a direct build from the settled decisions, one
 * writable review round, docs reconciled last, a lean Ship packet) lives in
 * writableBuildBrief; the data carries what the run committed and the
 * consultant seed.
 */
interface WritableBuildData {
  approvedAttended: string;
  approvedPreauth: string;
  /** What seeds the consultant's bet audit (checkpoint `implGate`), when bound. */
  auditSeedNote: string;
  examples: string;
}

const WRITABLE_BUILD_BRIEFS = {
  'impl-direct': {
    approvedAttended: 'The human approved the direction and walked away —',
    approvedPreauth: 'The Direction gate was pre-authorized at run start and auto-crossed; the human is away —',
    auditSeedNote:
      "the research decisions treated as the design, the implemented change, and the consultant's own prior research-checkpoint findings — not the raw build or review traffic.",
    examples: IMPLEMENT_EXAMPLES,
  },
} satisfies Record<WritableBuildBriefWorld, WritableBuildData>;

/**
 * The fixer build's per-workflow data — relay's today. The posture's
 * discipline (a fresh builder from the committed doc, one review-and-fix
 * round by the writing judge, the judge-owned tail, the escalation valve)
 * lives in fixerBuildBrief.
 */
interface FixerBuildData {
  approvedAttended: string;
  approvedPreauth: string;
  /** The midpoint judgment's size signal. */
  sizeSignal: string;
  examples: string;
}

const FIXER_BUILD_BRIEFS = {
  'impl-fixer': {
    approvedAttended: 'The human approved the spec and walked away —',
    approvedPreauth: 'The commit-spec gate was pre-authorized at run start and auto-crossed; the human is away —',
    sizeSignal:
      "the spec fixes the shape, not a slice list, so read the size from its scope and structural risk, and from how the builder slices the work as the build starts.",
    examples: RELAY_IMPL_EXAMPLES,
  },
} satisfies Record<FixerBuildBriefWorld, FixerBuildData>;

/**
 * The fixer build — the plan-smart / build-cheap / judge-strong workflow's
 * AFK phase: the builder builds the whole change from the committed spec,
 * then the judge reviews WITH write access — it fixes ordinary valid
 * findings directly (one review-and-fix round), escalates substance to the
 * human, and owns the build tail (docs + CEO summary). There is no
 * critique-and-respond loop; the consultant's contract verify is the one
 * fully independent pass over work the judge both judged and edited, which
 * is why it runs last and why its self-heal routes fixes to the judge.
 */
function fixerBuildBrief(state: RunState, spec: PhaseSpec, data: FixerBuildData): string {
  const workflow = workflowFor(state);
  const builder = makerDutyOf(workflow, 'delivery');
  const judge = checkerDutyOf(workflow, 'delivery');
  // Single-world: the round-cap follow-up clause may only point at "the verify
  // below" when a real verify step renders below (consultant bound AND a frozen
  // contract to verify) — the consultant-off and no-contract worlds get a
  // world-neutral phrasing instead of a dangling reference.
  const verifyRenders =
    checkpointLive(state, 'implement') &&
    consultantSnippetFor(workflow, 'implement') !== undefined &&
    Boolean(state.acceptanceContract);
  const capFollowUp = verifyRenders
    ? `a follow-up to the same ${judge} session (a fix request from the verify below) steers by delta and needs no new round`
    : `a later follow-up into that same ${judge} session steers by delta and needs no new round`;
  return `<task>
${approvalClause(
    state,
    priorPhaseOf(workflow, spec.name),
    data.approvedAttended,
    data.approvedPreauth,
  )} this is the AFK IMPLEMENTATION phase. You drive it end to end; ask_human still works but now queues the question and pauses the whole run until the human returns, so a flag is a real stop, not a quick check-in. Make each one self-contained, and let everything that can wait for the Ship gate wait.
${attendancePosture(state, spec.name)}
The shape of the phase — the ${builder} builds from the committed spec, then the ${judge} reviews with write access: it fixes what it finds and owns the docs and the summary; there is no critique-and-respond loop in this phase:

1. Have the ${builder} commit the approved spec with a conventional message, as its own commit. Name the spec's committed path in this prompt and every later first prompt — the build seeds from the document, not from any session's memory of writing it, so a first prompt reads cold: orient it (the project, the spec's path, the working branch) before the task.
2. Send the ${builder} an implement-spec prompt: it builds the whole change from the committed spec — the spec fixes the shape and the test standards; the slicing and sequencing are the ${builder}'s own, vertical slices with a commit per slice and that slice's tests per the spec's standards. Drive it as a single pass — a deliberate hold between slices burns a slow worker turn re-covering ground the review-and-fix round covers anyway. ${buildPassGuardrails(state.runId)}
3. ${midpointStep(data.sizeSignal, judge)} Mid-build the ${builder} is the sole writer: the ${judge}'s midpoint read is guidance the ${builder} folds in, never fixes the ${judge} applies itself — its write authority begins at the review-and-fix round, on the finished build.
4. When all slices are in: implementation-handoff from the ${builder} — whoever wrote the code authors the map the ${judge} starts from.
5. The review-and-fix round: send the ${judge} a review-and-fix prompt wrapping the handoff, pointing it at the spec's committed path and the build's commits. This is the phase's one review round, and it is writable: the ${judge} assesses each finding, fixes the ordinary valid ones directly (fix commits, tests moved along), reports what it changed versus left as-is, and ESCALATES a product or design disagreement, intent it cannot reconstruct, or drift broad enough to mean re-deciding the direction — an escalation is yours to ask_human, never something to patch over. The backstop cap for this phase is ${spec.roundCap} review round; ${capFollowUp}.
6. When the round has settled, reconcile the docs with what shipped — send the ${judge} the reconcile-docs prompt (it owns the record it just judged). Your one decision is the doc method, by precedence: if the framing names a doc-update skill or document, name it in the prompt — relay the framing's path or skill faithfully and treat it as authoritative. If the framing names none, send the snippet's default unchanged. The ${judge} commits the docs; they ride the branch into the PR that FINISH opens. A doc-scope product call it surfaces is yours to ask_human.
7. Last, after the docs are committed: send the ${judge} ceo-summary. Then call advance_phase with a summary that leads with the CEO summary verbatim, followed by the review-and-fix summary (fixes applied, push-backs, anything escalated), the docs reconciled, deviations from the spec, and the test state. The human returns from hours away and decides to ship from this packet alone, so it must carry everything.${consultantVerifyStep(state)}

Throughout: flag product, direction, and environment questions with ask_human (those are still the human's even when away); tactical questions bounce to the worker that raised them.

${data.examples}
</task>`;
}

/**
 * The writable build — the AFK build, lighter than the critique posture's: no
 * artifact to commit, no compaction ceremony, no midpoint, and one writable
 * review round (review-direct → apply-review) instead of the
 * reflect-then-round-2 loop. Docs reconcile as the last build step
 * (reconcile-docs), so the Ship gate reviews code + docs together and `finish`
 * is left the mechanical PR open — the same docs-at-implement shape as the
 * critique posture, minus the CEO summary. Approving Ship enters FINISH (open
 * the PR).
 */
function writableBuildBrief(state: RunState, spec: PhaseSpec, data: WritableBuildData): string {
  const roundCap = spec.roundCap;
  const workflow = workflowFor(state);
  const builder = makerDutyOf(workflow, 'delivery');
  const checker = checkerDutyOf(workflow, 'delivery');
  return `<task>
${approvalClause(
    state,
    priorPhaseOf(workflow, spec.name),
    data.approvedAttended,
    data.approvedPreauth,
  )} this is the AFK IMPLEMENTATION phase. You drive it end to end; ask_human still works but now queues the question and pauses the whole run until the human returns, so a flag is a real stop, not a quick check-in. Make each one self-contained, and let everything that can wait for the Ship gate wait.
${attendancePosture(state, 'implement')}
The shape of the phase — there is no spec or plan here; the research decisions are the source of truth, and the build runs directly from them with one review round:

1. Send the ${builder} the implement-direct prompt: build the change directly from the research decisions, rereading the decisions and the code it touches first, working in coherent commits and keeping tests green as it goes. There is no plan file to commit — the decisions carry the design. Never descope or thin tests to fit a turn: a fresh prompt carries a fresh budget ceiling, so trimming scope for budget is a product decision that needs work-content reasons and an honest line in the Ship packet. Have the ${builder} put ephemeral verification harnesses (throwaway tsconfigs, probe scripts) in this run's scratch dir, .duet/runs/${state.runId}/scratch/, and leave them there — it's gitignored and torn down with the run, so nothing rides the worktree as an untracked stray and there's no cleanup step. Everything else under .duet/ is this run's own live state and logs; the ${builder} must never delete .duet/ (or anything under .duet/runs/) or write outside that scratch dir, because removing the run's state strands it mid-build. (Gotcha: a worker can't watch its own budget — a turn that hits the per-turn cap or time limit is cut off mechanically, surfacing as a failed or short response, not a graceful "I'm low" report. Its committed work is on disk, so just resume that session with a short continue prompt for the rest; that's resumption, not a content failure, so don't re-send the original prompt.)
2. When the build is in: handoff-direct from the ${builder} — it orients the ${checker} fast (what changed, where to look hardest), tied to the research decisions rather than a spec/plan.
3. One writable review round — this workflow has exactly one, no second pass: review-direct to the ${checker} (it reviews against the research decisions and the actual goal, not a document), then apply-review to the ${builder}. apply-review is writable: the ${builder} assesses each point, fixes the valid ones in place, pushes back on the rest with reasons, and reports what it changed. The backstop cap for this phase is ${roundCap} review round.
4. When the review round has settled, reconcile the docs with what shipped — docs are part of the work the Ship gate reviews now. Send the ${builder} the reconcile-docs prompt. Your one decision is the doc method, by precedence: if the framing names a doc-update skill or document, name it in the prompt — relay the framing's path or skill faithfully and treat it as authoritative; the ${builder} locates and follows it. If the framing names none, send the snippet's default unchanged — it has the ${builder} find the project's own doc skill, then reconcile by hand if there is none. Never substitute your own survey for a method the framing named. The ${builder} commits the docs; they ride the branch into the PR that FINISH opens. A doc-scope product call it surfaces — deleting a documented concept, rewriting a design claim — is yours to ask_human.
5. Call advance_phase with a lean Ship packet: the implementation handoff, the review-and-fix summary (what the ${checker} raised, what was fixed, anything disputed), the docs reconciled, and the test state. There is no CEO summary in this workflow — the human reads what shipped, the docs, and the review outcome. Approving the Ship gate enters FINISH (open the PR — the docs already ride the branch); rejecting returns the work to you here. The human returns from away and decides to ship from this packet, so it must reflect the final state of the code and docs.${consultantAuditStep(state, spec.name, data.auditSeedNote)}

Throughout: flag product, direction, and environment questions with ask_human (those are still the human's even when away); tactical questions bounce to the worker that raised them.

${IMPLEMENT_EXAMPLES}
</task>`;
}

function requiredBriefData<K extends string, V>(records: Record<K, V>, key: string, label: string): V {
  if (!Object.hasOwn(records, key)) throw new Error(`no ${label} brief data for examples key "${key}"`);
  return records[key as K];
}

/**
 * The build block's renderer — the posture picks the skeleton (critique's
 * ceremonial single-pass-with-midpoint-and-tail vs writable's direct build
 * with one writable round), the examplesKey picks the workflow data. The
 * registry validates the block/posture world before this renderer runs, and the
 * data maps satisfy-check against BRIEF_WORLDS, so a missing prose world is a
 * load-time error rather than a mid-run render failure.
 */
function renderBuildBrief(state: RunState, spec: PhaseSpec, semantics: Extract<PhaseSemantics, { block: 'build' }>): string {
  switch (semantics.reviewPosture) {
    case 'critique': {
      const data = requiredBriefData(CRITIQUE_BUILD_BRIEFS, semantics.examplesKey, 'critique-build');
      return critiqueBuildBrief(state, spec, data);
    }
    case 'writable': {
      const data = requiredBriefData(WRITABLE_BUILD_BRIEFS, semantics.examplesKey, 'writable-build');
      return writableBuildBrief(state, spec, data);
    }
    case 'fixer': {
      const data = requiredBriefData(FIXER_BUILD_BRIEFS, semantics.examplesKey, 'fixer-build');
      return fixerBuildBrief(state, spec, data);
    }
  }
}

/**
 * A phase's entry brief — ONE renderer over (the registry row's semantics ×
 * the fragment library × the per-workflow data records), replacing the
 * per-workflow builder functions and their (workflow, phase) dispatch table
 * (T5). The block chooses the renderer; the knob values choose dedicated
 * fragments; a new workflow adds registry data and — at most — new
 * data-record entries, never a composer function. Shared by two callers: the headless driver's basePrompt
 * (which additionally marks phaseStarted on the first build), and the
 * interactive get_task tool (which returns this idempotently and folds any
 * staged human input as a separate appended block). Pure — no side effects —
 * so each caller owns its own phaseStarted/consume bookkeeping.
 */
export function buildPhaseBrief(state: RunState, phase: PhaseName): string {
  const workflow = workflowFor(state);
  const spec = phaseSpec(workflow, phase);
  const semantics = spec.semantics;
  switch (semantics.block) {
    case 'frame':
      return renderFrameBrief(state, spec, semantics);
    case 'doc-loop':
      return renderDocLoopBrief(state, spec, semantics);
    case 'build':
      return renderBuildBrief(state, spec, semantics);
    case 'finish':
      return renderFinishBrief(state, spec, semantics);
  }
}

/**
 * The steer block, rendered for its two delivery surfaces: appended to a
 * live tool result ('live') or carried into the next harness prompt when
 * the steer missed its phase ('carried' — provenance attached, staleness
 * handed to judgment). One renderer so the <human_steer> shape and the
 * steering sentence stay identical everywhere the orchestrator meets them.
 */
export function renderSteerBlock(steers: Steer[], mode: 'live' | 'carried'): string {
  const blocks = steers
    .map((s) => {
      const provenance = mode === 'carried' && s.stagedDuring ? ` staged_during="${s.stagedDuring} phase"` : '';
      return `<human_steer staged_at="${s.stagedAt}"${provenance}>\n${s.text}\n</human_steer>`;
    })
    .join('\n');
  const sentence =
    mode === 'live'
      ? 'The human sent this mid-phase guidance just now. It is the editor-in-chief’s voice — fold it into your routing from this point; it outranks checker opinions and does not count toward any cap.'
      : 'The human staged this guidance while no orchestrator turn could receive it (provenance above). It is the editor-in-chief’s voice — judge its freshness yourself: fold in what still applies, drop what a later gate decision or answer has superseded. It does not count toward any cap.';
  return `${blocks}\n${sentence}`;
}

/**
 * The rider a human attached to a gate approval (`duet continue --approve
 * "<rider>"`) — agreement with the direction plus adjustments, appended to
 * the prompt that follows the crossing.
 */
export function approvalRiderBlock(rider: string): string {
  return `<approval_rider>
${rider}
</approval_rider>
The human's gate approval came with the rider above — agreement with the direction, plus adjustments. Treat it as gate feedback in approving form: fold it into this phase's work from the start, relay what bears on the workers into their prompts, and where it revises something previously settled, the rider wins. It outranks checker opinions.`;
}

export function answerResumePrompt(answer: string): string {
  return `The human answered your queued question: ${JSON.stringify(answer)}. Continue the phase from where you paused, taking their answer into account.`;
}

export function feedbackResumePrompt(workflow: WorkflowRef, phase: PhaseName, feedback: string): string {
  const spec = phaseSpec(workflow, phase);
  const artifact = spec.artifactLabel;
  const stage = stageOf(workflow, phase);
  const maker = makerDutyOf(workflow, stage);
  const checker = checkerDutyOf(workflow, stage);
  // A gate rejection is the editor-in-chief returning the artifact — to the
  // duty that owns this phase's writes: the maker everywhere except a
  // checker-owned finish (relay's judge), whose PR work the checker authored
  // and owns. On the fixer build the reviser stays the maker deliberately —
  // the judge's write authority there is action-scoped to its review-and-fix
  // round, whose cap is already spent by re-entry time. Whether the *checker*
  // re-engages is a phase property read off the SEMANTICS: the doc-loops and
  // the critique-posture build re-run a verifying round (they have the -again
  // variants and cap headroom for it); the writable and fixer postures, and
  // the non-loop blocks (frame/finish), route the human's feedback straight
  // into the revision — instructing a fresh checker round there is wrong for
  // the workflow (their loops have no -again variants) and, at cap 1, blocked
  // by send_prompt.
  const reviser = spec.semantics.block === 'finish' && spec.semantics.finishOwner === 'checker' ? checker : maker;
  const outranks =
    reviser === checker
      ? "their feedback outranks the review's own conclusions"
      : `their feedback outranks the ${checker}'s opinions`;
  const reRunsReviewLoop =
    spec.semantics.block === 'doc-loop' ||
    (spec.semantics.block === 'build' && spec.semantics.reviewPosture === 'critique');
  const reviseClause = reRunsReviewLoop
    ? 'run whatever review rounds the changes warrant (with the -again variants), and advance the phase again when converged'
    : `have the ${reviser} apply the changes directly and advance the phase again — this phase doesn't re-run a review round on re-entry, so the human's feedback is the revision itself, not the trigger for a new review pass`;
  // The PR is already open by the time an openPrGate reject is reached (both
  // finish and finish open it before advancing), so a reject AMENDS it in place —
  // gh pr edit / more commits — never re-opens it; a second gh pr create would
  // error. Keyed off the gate state (the same fact status's opensPr reads).
  // (short's implement no longer folds docs in, so there is no foldsDocs
  // clause here — a Ship-gate reject just routes feedback to the build, and
  // docs reconcile later in the finish phase regardless.)
  const opensPr = spec.gate?.state === 'openPrGate';
  const amendClause = opensPr
    ? ` The PR is already open — have the ${reviser} amend it in place (gh pr edit for the description, more commits + push for code or doc changes) and never run gh pr create again (it errors on an existing PR). If the feedback changes what shipped, refresh the docs commit too so it still describes the branch. Re-advance with the PR URL still leading the packet.`
    : '';
  return `At the gate, the human sent the ${artifact} back with this feedback: ${JSON.stringify(
    feedback,
  )}. Re-enter the phase to address it — route the feedback to the ${reviser} (the human is the editor-in-chief; ${outranks}), ${reviseClause}.${amendClause} Your workers kept their full context from before the gate: steer them with deltas to the frames they already hold (what changed and why), not by re-running templates they've already received.`;
}

export function nudgeContinuePrompt(): string {
  return `Your turn ended without calling advance_phase or ask_human, so the harness cannot tell whether the phase is done, paused, or stuck. Continue the phase: route the next worker turn, or advance_phase if converged, or ask_human if something needs the human.`;
}

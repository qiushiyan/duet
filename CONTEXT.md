# duet

duet is a semi-AFK orchestrator: a run executes one workflow (full · blueprint · relay · short) on one branch, the orchestrator routing a snippet protocol between each stage's two duty voices, phase by phase, inside a code-enforced statechart whose gates only the human can cross. This glossary is the ubiquitous language — aligned with AI-orchestration and CI industry terms where a standard exists (resolved 2026-07-04), duet-specific where duet is the standard.

## Workflow structure

**Workflow**:
A named process shape a run executes, expressed as an ordered list of stages. The shipped standard library: **full** (spec + plan), **blueprint** (full minus the plan phase — one spec), **relay** (blueprint with a criss-crossed build), **short** (no document). Named on the ceremony/artifact axes, never after a stage, phase, or artifact.
_Avoid_: arc, pipeline; "design" and "rir" (retired names)

**Workflow definition**:
An authored SDK expression (`defineWorkflow({ phases: [...] })`) that composes the closed block vocabulary into a named workflow. It may be shipped by duet or live in a user/project workflow file; it is input, not what a run executes directly.
_Avoid_: workflow config, workflow script, pipeline file

**Compiled workflow**:
The validated, fully derived workflow artifact a run carries. `createRun` freezes it as `workflow.json`; after that, the source definition is never read for the live run.
_Avoid_: registry pointer, live workflow, workflow config

**Stage**:
A workflow's grouping of phases into one holistic thinking flow — one primary model carries it end to end, and duty bindings are scoped to it. Every workflow has two: planning and delivery. Approval-boundary semantics live at stage edges, as in CI stages.
_Avoid_: block (that's the phase-kind), band, top-level phase, sub-arc

**Planning / Delivery**:
The two shared stage names. Planning is the attended thinking stretch — the entry phase through the last phase before the build; a workflow with no document still has one (short's research alone is its planning). Delivery is the AFK stretch (implement and finish — the build and the PR open).
_Avoid_: thinking/building, pre-handoff/post-handoff (as stage names)

**Phase**:
The gate/loop unit inside a stage — frame, spec, plan, research, implement, finish. Each phase is an instance of a block, runs to convergence under the orchestrator, and exits through a human gate. Phase identity is workflow-scoped: (workflow, name).
_Avoid_: step, sub-phase, job

**Block**:
A phase-kind — frame, doc-loop, build, or finish — the reusable primitive of the composition vocabulary, configured per phase by knobs. Blocks own their snippet families.
_Avoid_: operator, template, node type

**Knob**:
A named, closed-vocabulary parameter on a block (artifact kind, review posture, entry seed, tail owner, …). A knob value exists only when duet ships prompt support for it and a shipped workflow exercises it.
_Avoid_: option, setting

**Run**:
One execution of a workflow on one branch, persisted under `.duet/runs/<id>/`.
_Avoid_: session (that's a provider transcript), job

**Gate**:
A human approval stop at a phase's exit. Only a `human.*` event crosses one; tools can park a run at a gate but never cross it. Pre-authorization grants the authority in advance; the stop still happens and is recorded.
_Avoid_: checkpoint, approval step, breakpoint

**Stage boundary**:
The edge between planning and delivery: where continuity edges apply — a delivery duty with an inbound edge carries the planning session forward via its seed ritual, one without starts fresh — and where an interactive run hands off to the headless driver.
_Avoid_: handoff gate (for the binding split), the band split, session reset

**Handoff**:
The host transfer only — an interactively-orchestrated run passing to the headless driver at the stage boundary. Not an agent-to-agent transfer (the OpenAI sense) and no longer the name of the binding split.
_Avoid_: handoff gate as a binding concept

**Flag**:
A queued `ask_human` question parking the run until the human answers — duet's human-in-the-loop interrupt. Crash = flag: infrastructure failures land here, never in a silent state.
_Avoid_: interrupt, suspension, exception

**Steer**:
The human's mid-phase note into a live run, delivered on the orchestrator's next phase-continuing tool result. Processed, not answered; never a pause.
_Avoid_: message, hint

**Severity hold**:
A `high` human-decision entry on a gate packet that withholds a non-explicit crossing — duet's automated hold signal (what Azure calls a "gate"), distinct from the human's approval.
_Avoid_: block (verb overload), veto

**Posture**:
A run's declared attendance plan — which gates the human attends (`gates_at`, presets like overnight and afk, gateless). Fixed at run creation; `duet afk` is the one mid-run re-set.
_Avoid_: mode, profile

## Voices and execution

**Voice**:
Any speaking party of a run — the umbrella noun for the mechanical surfaces (bindings, sessions, logs, panes, health). Three kinds, deliberately not equivalent: the orchestrator (the machinery's voice), a stage's duty voices (the commanded workers), and the consultant when bound (the ephemeral advisor). Duties and `consultant` are the protocol addresses (send_prompt targets); the orchestrator is never a protocol target, but stays a full operational voice — its log, session, status row, and takeover work like any voice's (the augmentation principle).
_Avoid_: role, agent, participant, channel

**Orchestrator**:
The machinery's voice: routes the protocol — picks and adapts snippets, judges loop exits, triages questions — and never makes anything. It does triage, never substance, and cannot write or cross gates (properties of its tool surface, not its prompt). Not a worker and carries no duty; the mechanism is replaceable (an LLM today), the workers are the substance.
_Avoid_: router, manager, supervisor, third worker

**Worker**:
A commanded, artifact-producing voice — the kind word for a stage's duty voices. Exactly two per stage (a maker duty and a checker duty); each is a provider session keyed by (stage, duty), connected across the stage boundary only by a continuity edge. The consultant is commanded through the same seam but is an advisor, not a worker.
_Avoid_: implementer, reviewer (the retired seat names), role, sub-agent, executor

**Duty**:
A worker's identity within a stage — the protocol address and runtime key (send_prompt, takeover, logs, panes, bindings, status). A closed vocabulary that grows only with a shipping workflow: planning has architect (makes) and analyst (checks); delivery has builder (makes) and critic or judge (checks, per the review-posture knob). Duties are stage-unique, so a duty alone names its stage. Only workers have duties — the orchestrator routes and the consultant has checkpoint kinds.
_Avoid_: role, persona, seat, implementer/reviewer

**Continuity edge**:
Registry data declaring that a delivery duty continues a planning duty's session, with the seed ritual that carries it (full's architect→builder edge rides the boundary compact). No edge ⇒ the duty starts a fresh session (relay's whole delivery stage). Subsumes the retired build-override and session-reset concepts.
_Avoid_: session reset, build override, handoff (for sessions)

**Consultant**:
The optional advisor voice — low-context, ephemeral (a fresh session each checkpoint), cross-family — that questions the bet and verifies the acceptance contract. Additive, never a review round, never a worker: checkpoint kinds, not duties.
_Avoid_: judge (that's a delivery duty), second reviewer, fourth worker

**Binding**:
Which provider (and model, for claude) a voice runs on. Duty voices bind per (stage, duty) — the criss-cross is just four bindings; the orchestrator and consultant each run one binding across the run. Config holds account-level defaults; a run's framing manifest may bind duties directly; the frozen result lives on the run.
_Avoid_: role binding, model config, assignment, build override (retired)

**Driver**:
The detached process that runs a phase to its next attended stop (CI would say "runner"). No daemon: nothing runs between quiescent stops.
_Avoid_: daemon, runner (reserved for CI comparisons)

## Artifacts and prompts

**Framing**:
The human's per-run brief — the single seam through which project knowledge enters a run — plus machine-parsed frontmatter that is the run's manifest (workflow, posture, duty bindings).
_Avoid_: brief (that's a phase entry brief), issue, prompt

**Spec / Plan**:
The two documents a doc-loop phase can produce, and the whole artifact vocabulary. A workflow's documents are ordered: the first is always the **spec** — half-technical, product goals on top and module shape, seams, target shape, and test standards below — and any later one is a **plan**, the tactics the spec deferred (slices, cases, fixtures, sequencing). A workflow with no plan phase hands its spec straight to the build; that is topology, not a third kind of document.
_Avoid_: design doc, blueprint (that's a workflow), technical spec

**Snippet**:
A prompt template in duet's shipped library, the workflow's substance — adapted per turn by the orchestrator, overridable per key by users.
_Avoid_: template (claimed by seed templates), prompt

**Seed template**:
A project's pre-baked framing under `.duet/templates/` — parsed and archived as the framing itself, not config.
_Avoid_: framing template, profile

**Brief**:
The harness-rendered phase entry instructions the orchestrator reads from `get_task` — registry-driven, single-world (no knob-conditional prose).
_Avoid_: task prompt, system prompt (that's the identity)

**Gate packet**:
The orchestrator's summary presented at a gate — for the Ship gate, CEO summary first — carrying the structured `human_decisions` the severity hold reads.
_Avoid_: report, summary (alone)

**Acceptance contract**:
The consultant-authored, human-ratifiable, harness-frozen list of falsifiable assertions that the delivery stage's verify checkpoint checks by running the built system.
_Avoid_: spec (a different artifact), test plan

**Consultant checkpoint**:
A gate-adjacent point where a bound consultant fires (frame, bet audit, contract, verify). Unrelated to persistence checkpoints/snapshots — duet persists the statechart as a snapshot, never called a checkpoint.
_Avoid_: touchpoint, checkpoint (unqualified)

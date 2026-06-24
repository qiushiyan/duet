# Orchestration landscape scan — borrowable ideas and assumption-challenges

Status: **research snapshot, 2026-06-23.** Input for `docs/future-directions.md`; nothing here is decided or built. A landscape scan, not a design — present-tense claims describe the *external* projects as found on this date, not duet.

## Why this scan

duet is in a good state and in daily personal use across the maintainer's company and personal projects. This pass steps back from the friction-level work in `open-questions.md` to ask a bigger question: with so many agent-orchestration frameworks now being invented, **what concepts should duet borrow, and which of its assumptions should it reconsider?**

Two meta-principles anchor every judgment below (the maintainer's framing — all of duet's stated principles follow from these):

1. **Get things done well.**
2. **The human keeps a strong high-level mental model and owns the important concrete decisions** (at gates).

**Method.** Read the documentation first to build a mental model, then the code. The maintainer pre-selected a set of local repos and one talk; two parallel web sweeps added state-of-the-art concepts and a candidate-project shortlist. Each finding is classified:

- **BORROWABLE** — a concept duet could adopt; fits the philosophy.
- **ASSUMPTION-CHALLENGING** — questions a duet design choice worth reckoning with.
- **ALREADY-HAVE** — duet has an analog (named).
- **NOT-FOR-US** — against a stated duet principle (named).

duet's four product principles, for reference: **augment-never-lock-in** (same CLIs/transcripts/branches; manual takeover + resume always work), **human-owns-substance** (gates structural, not prompt-enforced), **semi-AFK / no daemon**, **personal-tool / exactly two providers / knowledge via framing only**.

---

## Part 1 — What I looked at, and how it relates to duet

Index (detail in the sections below):

| Source | What it is | Single most relevant idea | Verdict for duet |
|---|---|---|---|
| Factory "Missions" (talk) | Multi-day autonomous coding via orchestrator/worker/validator | **Validation contracts** — correctness defined *before* code, verified black-box after | BORROWABLE (flagship) |
| `resources/repos/symphony` | Elixir spec + Linear-polling daemon orchestrator | Reconciliation / stall / retry / restart-without-a-DB rigor; in-repo `WORKFLOW.md` policy | Mostly NOT-FOR-US; narrow error-handling borrow |
| `resources/repos/sandcastle` | Matt Pocock's TS sandbox-orchestration library | **Completion-timeout vs idle-timeout** split (done-but-not-exited → succeed, preserve commits) | BORROWABLE |
| `resources/repos/matt-skills` | Mat Ryer / Matt Pocock Claude Code skills | **Living `CONTEXT.md` domain glossary**; 3-part-test ADRs | BORROWABLE |
| `resources/repos/pi-mono` | Mario Zechner's from-scratch multi-provider agent harness | **Overflow as a distinct error class → compact-then-retry**; streaming-provider seam | BORROWABLE (small) + ASSUMPTION-CHALLENGING (substrate) |
| Cognition vs Anthropic (web) | The multi-agent architecture debate | Writes single-threaded; extra agents add *intelligence, not actions* | ALREADY-HAVE (vindication) |
| SDD evidence (web) | Kiro / Spec-Kit / Fowler / METR | Specs cut **drift**, not defects; don't guarantee compliance; help large/hurt small | ASSUMPTION-CHALLENGING |
| HITL patterns (web) | LangGraph, Claude Code subagent hooks | Gate **timeout policies** + **fork-from-checkpoint** (time-travel) | BORROWABLE |
| Contract verification (web) | LLM-as-judge + execution dual verification | Acceptance criteria as first-class, weighted, re-checked artifacts | BORROWABLE |
| `microsoft/conductor` (web) | Deterministic non-LLM multi-agent router with human gates | The convergent read — duet's exact thesis, independently built | clone & study |
| OpenHands SDK V1 (web) | Event-sourced agent core | The adversarial read — resume/fork/replay for *free* | clone & study |

### A. Sources the maintainer pointed at

#### Factory "Missions" — the talk (`resources/videos/multi-agent-workflows/README.md`)

Luke Alvoeiro (Factory). Thesis: the bottleneck is human *attention*, not model intelligence; let humans decide *what*, let a multi-agent system run *how* over multi-day autonomous runs. A three-role ecosystem — **orchestrator** (plans, asks strategic questions, writes a validation contract), **workers** (implement each feature with a *fresh clean context*, commit via git so the next worker inherits a clean slate), **validators** (verify, kept separate from implementation).

- **Validation contracts (the flagship idea).** The orchestrator defines correctness *first* — a set of behavioral assertions that define success — **before** defining features, explicitly so the contract isn't biased by an implementation it already planned. Verified by a **two-phase adversarial loop** at each milestone: a *scrutiny validator* (tests/types/lint/code-review) and a *user-testing validator* (black-box, computer-use QA against the contract). Source: factory.ai/news/missions(-architecture). → **BORROWABLE**; maps onto duet's consultant (see synthesis). The maintainer explicitly does **not** want the computer-use UI validator — only the *contract* concept, for backend/orchestration work.
- **Structured handoffs.** Workers never just say "done"; they fill out what's complete, what's left, commands run *with exit codes*, issues discovered. → **BORROWABLE**: duet's `implementation-handoff` is close but lacks the objective commands-with-exit-codes evidence block.
- **Serial-write / parallel-read.** Active coding is serial (parallel writers step on each other and make inconsistent architectural calls); parallelize only read-only work (exploration, review). → **ALREADY-HAVE**: duet is single-writer by construction (one implementer).
- **"Droid whispering."** Match model to role; use a *different provider family* for validation to dodge training-data bias. → **ALREADY-HAVE**: duet's per-role provider/model bindings; the consultant is deliberately cross-family.
- **Orchestration logic lives in prompts/skills, not code; design for forward-compatibility** (better model ⇒ smarter system, no code change). → **ASSUMPTION-CHALLENGING (mild)**: duet deliberately puts *guarantees* in code (the statechart) and *judgment* in prompts — the trust gradient. Factory pushes more into prompts; duet's split is the considered opposite and the better fit for "human owns substance."

#### Symphony (`resources/repos/symphony`) — Elixir spec + Linear daemon

A language-agnostic `SPEC.md` (v1) plus an Elixir reference impl: a long-running daemon that polls an issue tracker (Linear), creates a per-issue workspace, and runs a Codex app-server session per issue. This is the shape duet deliberately rejects.

- **NOT-FOR-US**: a resident daemon (violates *no daemon*), issue-tracker-as-source-of-work (violates *knowledge via markdown framing*), and a web dashboard (the maintainer doesn't want a UI). The maintainer's own read confirmed this is "currently doing Linear issues / UI."
- **Narrow BORROWABLE — error-handling rigor.** The orchestration state machine (SPEC §7–8) is genuinely disciplined: a single authoritative state owner, **reconciliation before dispatch every tick**, **stall detection** (kill + retry on event-inactivity timeout), **exponential backoff** with a continuation-retry distinct from a failure-retry, and **restart recovery driven by tracker + filesystem, no durable DB**. duet's lifecycle already shares the spirit (crash = flag, the position probe, opt-in infra retry) — Symphony is a good cross-check for the AFK error surface, nothing more.
- **Notable convergence — `WORKFLOW.md`.** Symphony keeps workflow policy (prompt + runtime settings + hooks) as one in-repo, version-controlled markdown file with YAML front matter. → **ALREADY-HAVE**: duet's framing (front matter + prose) + the `phases.ts` registry are the same instinct, split across the run-specific and the tool-specific.

#### sandcastle (`resources/repos/sandcastle`) — Matt Pocock's sandbox-orchestration library

Evolved past the worker-plumbing prior art the old `resources/repos/README.md` index describes — now a published TS library (`@ai-hero/sandcastle`) with pluggable sandbox providers (Docker/Podman/Firecracker/Daytona) and *six* agent providers, an `init` scaffolder, and a docs site. Philosophically the **inverse** of duet: explicitly unopinionated, no statechart, no gates — a substrate you script.

- **Completion-timeout vs idle-timeout split** (`docs/adr/0019`, `src/Orchestrator.ts`). Two silence windows for two failure modes: idle-before-any-completion-signal = stuck → fail; a short grace window *after* the done-signal appears = process hanging on an inherited stdout pipe → **succeed with warning, preserve the commits**. → **BORROWABLE**: lands in duet's `driver.ts`; reinforces the existing "hit cap = resumable checkpoint, not an infra crash" invariant. *The single best AFK-reliability borrow.*
- **Typed `Output.object({tag, schema})` channel** (`docs/adr/0010`) — schema-validated JSON from a named XML tag, *separate from* the termination signal, with resume-and-retry on validation failure (feeds a token-efficient error back into the same session). → **ASSUMPTION-CHALLENGING** for Q16 (worker schema). duet routes a prose protocol and treats transcripts as truth; the *retry-by-resume-with-feedback* loop is borrowable independent of whether duet adopts schemas.
- **`createSandbox()` warm multi-run with an `exec()` gate between roles** (`src/templates/sequential-reviewer`) — implementer → `npm test` (objective, non-zero returned not thrown) → reviewer, on one branch. → **BORROWABLE concept**: an objective `exec`-based verification gate *between* implementer and reviewer, which duet currently leaves to agents/snippets.
- **fork vs resume as distinct primitives** (`adr/0011`,`0018`); the sharp lesson: fork isolates the *session*, not the branch/worktree — fan-out is a git race without distinct branches. → **ALREADY-HAVE**: duet's consultant is fork-style (ephemeral, discard-and-reseed); the "one branch per run, fixed before the first prompt" invariant already sidesteps the trap.
- **`buildRecoveryMessage`** — on patch/sync failure, prints copy-pastable `git am --3way` / `git apply`. → **BORROWABLE**: matches human-owns-substance failure surfaces.
- **`permissionMode: "auto"` (AI-mediated per-tool approval).** → **NOT-FOR-US**: duet's gates are structural, never AI-mediated.
- Still-present bug to *not* inherit: no `proc.kill()` anywhere (container teardown masks the leak; no-sandbox leaks). duet already escalates SIGTERM→SIGKILL in `killDriver`.

#### matt-skills (`resources/repos/matt-skills`) — Mat Ryer / Matt Pocock Claude Code skills

Small, composable skills on the thesis: own the *fundamentals* (alignment, feedback loops, deep modules, ubiquitous language), not the process. The main chain (`grill-with-docs → to-prd → to-issues → implement → review`) is structurally duet's `full` arc.

- **Living `CONTEXT.md` domain glossary (ubiquitous language)** (`skills/engineering/domain-modeling`). A repo-level glossary the agent reads to use *one word where it used twenty*, sharpened inline as terms crystallize. → **BORROWABLE (strongest pick here)**: duet has *no cross-run shared vocabulary* — framing is per-run and ephemeral. A durable `CONTEXT.md` (the distillate; framing stays the *write* path) would cut tokens and make every implementer/reviewer name things the same way, without breaking "knowledge via framing only."
- **ADRs gated by a 3-part test** (hard-to-reverse + surprising-without-context + a real trade-off); downstream skills are told *not to relitigate* what an ADR settled. → **BORROWABLE**: duet does this by hand in `open-questions.md` (strike-through = verdict). Systematizing it gives the reviewer/consultant a "do not relitigate" surface.
- **`diagnosing-bugs`: build the red-capable feedback loop *first*, refuse to hypothesize without it.** → **BORROWABLE**: duet's `rir`/bug work has `find-similar-bugs`/`trace-execution` but no "loop before theory" discipline; a `diagnose` snippet would be additive and on-philosophy (TDD-first).
- **"Design It Twice"** — parallel sub-agents produce deliberately different interfaces, compared on depth/locality/seam. → **BORROWABLE + ASSUMPTION-CHALLENGING**: a *bounded generative fan-out for interface design only*, at PLAN — the generative cousin of the (auditing) consultant, without adding a writer.
- **`.out-of-scope/` rejected-decisions KB** ("PR is an issue with attached code"; the issue-tracker half is **NOT-FOR-US**). → **BORROWABLE (the KB)**: the inverse of ADRs — record a *declined* direction so it isn't re-proposed. duet already does this informally in `future-directions.md` ("declined candidates").
- **Independent confirmation of duet's choices**: TDD = behavior-through-interface, mock only at boundaries (= duet's "fake only at the six seams"); durable agent-brief = behavioral-not-procedural, no file/line refs, explicit out-of-scope (= duet's `implementation-handoff` guardrails); and Mat keeps *local markdown* a first-class issue backend precisely because backends are permanent maintenance surface — the same maintenance-cost argument as duet's "exactly two providers." → **ALREADY-HAVE / VALIDATING.**

#### pi-mono (`resources/repos/pi-mono`) — Mario Zechner's from-scratch agent harness

Drives 20+ providers in-process through one streaming event contract — the inverse of duet's "worker = opaque CLI that runs a whole turn" seam.

- **Overflow as a distinct error class → compact-then-retry** (`utils/overflow.ts`: ~50 patterns + silent-overflow/silent-truncation heuristics). → **BORROWABLE**: duet has the two halves (the `worker-health.ts` taxonomy + first-class compaction) but not the middle (overflow ≠ rate-limit). Adds a `ErrorClass` whose action is "compact + retry once," not "back off."
- **Provider `compat` matrix as data, not branches** (~50 capability flags per model). → **BORROWABLE (small)**: even at two providers, a tiny capability record (auto-compacts? error-envelope shape? compact-via-command?) would centralize the codex-vs-claude asymmetries duet now encodes as scattered invariants.
- **Normalized streaming-provider seam** (`packages/ai`: one 11-event stream; errors encoded in-stream, never thrown; cross-provider message transform). → **ASSUMPTION-CHALLENGING (substrate)**: the existence proof that a fine-grained, multi-provider worker contract is tractable — i.e., the road duet *didn't* take (it builds on the Agent SDK + CLI subprocesses). See synthesis: this is a *decline-with-reason*, not a TODO.
- **Steering injected at provider-defined safe points, queued separately from live state, applied only at turn boundaries; per-turn snapshot freezes model/tools/budget at turn creation.** → **ALREADY-HAVE (independent convergence)**: duet's steer store (`steers/`, deliver-on-phase-continuing-result) and "budget frozen per-turn, never reshapes scope." pi's *turn-snapshot* framing is a sharper statement of the same invariant.

### B. Concepts from the web (state of the art)

- **Cognition "Don't Build Multi-Agents" (Walden Yan) vs Anthropic "How we built our multi-agent research system."** Cognition: default to a *single-threaded linear agent with continuous context*; parallel subagents fragment context and make conflicting implicit decisions (cognition.com/blog/dont-build-multi-agents). Anthropic: multi-agent wins on *breadth-first, independently-parallelizable* work (90.2% > single on their research eval) but burns ~15× tokens, and "most coding tasks involve fewer truly parallelizable tasks than research" (anthropic.com/engineering/multi-agent-research-system). **The real axis is write-concurrency, not agent-count** — both camps endorse read-only/advisory extra agents and single-threaded writes. → **ALREADY-HAVE / vindication**: duet is single-writer with read-only advisors (reviewer, consultant) — the exact configuration both endorse for coding, at the *cheap* point on the token curve.
- **Spec-driven-development evidence** (Böckeler/Fowler on Kiro + Spec-Kit; the METR RCT). The evidence is **scale-dependent, not directional**: spec-first helps large/greenfield/drift-prone work and hurts small/brownfield/iterative work (Kiro escalated a bug fix into 16 acceptance criteria; reviewers "would rather review code than markdown"). Two load-bearing facts: **specs reduce *drift* (confident code solving the wrong problem), not *defects*; and specs don't guarantee compliance** — agents frequently don't follow them. METR found experienced devs ~19% *slower* with AI on familiar tasks. → **ASSUMPTION-CHALLENGING**: directly addresses the maintainer's "maybe framework workflow hurts" hypothesis — answered conditionally (see synthesis).
- **Human-in-the-loop patterns** — LangGraph `interrupt()`/checkpoints/**time-travel** (fork execution from any prior checkpoint) + **timeout policies** (proceed-with-logging / escalate / remind, to avoid indefinite hangs); Claude Code's `SubagentStop` hook gating output before the lead sees it, and the "Performance Outcomes" grader-rubric revise loop. → **BORROWABLE**: gates-as-strategic-interrupts is **ALREADY-HAVE**, but *gate timeout policy* and *fork-from-an-earlier-gate* are not.
- **Contract / rubric verification.** The field is converging on **execution + rubric dual verification**, with acceptance criteria as first-class, weighted artifacts (LLM-as-judge work, e.g. arxiv 2510.24367). → **BORROWABLE**: the formal backing for turning duet's qualitative consultant into a pre-code contract re-checked post-code.

### C. Candidate projects scouted (recommended for a deeper local read)

- **`microsoft/conductor`** — a CLI running YAML-defined multi-agent coding workflows with **deterministic, non-LLM routing** ("no LLM in the orchestration loop"), structural human gates (markdown-rendered, clickable file links), and a `terminate` step with structured status. The **convergent read**: duet's exact core thesis built independently. Borrow its gate-rendering / terminal-status modeling; note where duet is stronger (XState + arcs vs static YAML; takeover/resume-from-transcript, which Conductor lacks).
- **OpenHands SDK V1** — an **event-sourced** agent core: the agent is a pure function from event history to next event, so pause/resume/fork/deterministic-replay/crash-recovery fall out for free. The **adversarial read**: the strongest challenge to duet's "transcripts are truth, state.json is a hint" + its hand-maintained spent-marker/cooperative-pause machinery.
- Others worth one web read, not a clone: **Aider architect/editor mode** (reason-vs-emit split sharpens output — micro-version of implementer/reviewer at the *edit* altitude); **BMAD-METHOD** (the "hyper-detailed story file" as a self-contained context package — duet's altitude-deferral taken to the opposite extreme); **GitHub Spec-Kit + Amazon Kiro** (spec as a *living re-readable* doc; Kiro's "steering files" as an always-loaded memory bank — cf. the `CONTEXT.md` borrow); **dagger/container-use** (takeover = drop into the agent's terminal; environment-layer isolation, the inverse of duet's stay-on-the-real-tree choice).

### D. Already-vendored / skip

`resources/repos/{codex, claude-agent-sdk-typescript, claude-squad}` are already study material (the Codex SDK, the orchestrator substrate, and the tmux anti-model respectively). OpenAI Swarm/Agents-SDK (LLM-*decided* routing — the opposite of duet's bet) and CrewAI/AutoGen (general multi-agent frameworks, too far from the personal-tool / two-CLI constraint) need no clone.

---

## Part 2 — Synthesis

### The headline

Three findings dominate, and the first two fit together:

1. **The highest-leverage borrow is "correctness-first," not "plan-more."** Factory's validation contracts, sandcastle's typed `Output`, matt-skills' ADRs, and the LLM-as-judge literature all point one way: define *what success means* as a **frozen, testable artifact written before the code**, then **re-verify it with a fresh adversarial reader after**. This is exactly the maintainer's instinct to formalize the consultant into a *contract document*.
2. **The evidence does not say "go planless" — it says specs cut *drift*, not *defects*, and agents ignore prose plans anyway.** So the resolution to "maybe the framework workflow hurts" is **contract-ful and plan-lighter**: move the up-front investment from *prose planning* into *falsifiable acceptance criteria*, and let the plan shrink.
3. **duet's single-writer + read-only-advisor design is vindicated by the field's harshest multi-agent critic *and* by Anthropic.** Keep writes single-threaded; extra agents contribute *intelligence, not actions*. duet is already at the correct, cheap point on the curve for coding — this deserves to be an *explicitly defended tenet*, not an accident.

### Flagship direction — the acceptance contract (a third artifact, closing the consultant loop)

Today the consultant audits the *bet* qualitatively and post-hoc. The major step is to give it something *frozen to check against*:

- **A contract is a short, falsifiable "definition of done" for this feature** — behavioral assertions, authored at the **frame/spec gate**, *before* implementation, committed as a repo artifact beside the spec and plan.
- **It's verified at the Ship gate by the read-only consultant** (a fresh, cross-family reader) as a pass/fail against the *frozen* contract — turning the consultant from "soft second opinion" into a **closing-the-loop verifier**, with **no new writer role** (so it stays inside the single-writer design both camps endorse).

Why it serves **both** meta-principles: it attacks **drift** (the failure specs actually fix) and closes the *specs-don't-guarantee-compliance* gap — *get things done well*; and the human reviews a **concise contract** ("is this what success means?") instead of a thick plan, and at Ship gets a crisp **"did it meet the bet"** verdict — *keep the mental model, own the decision at the gate*.

Two disciplines keep it from becoming the SDD over-ceremony trap (Kiro's 16 criteria for a bug fix):

- **Altitude discipline.** The contract inherits duet's existing altitude-lens DNA — a *short falsifiable list*, not an assertion catalog; scaled by arc (full gets a real contract; rir a one-liner). Explicitly **not** Factory's computer-use UI validator (the maintainer doesn't want it) — the backend/orchestration-shaped version is a markdown contract + an LLM-judge re-read.
- **The plan-lighter corollary.** Once a frozen contract exists, the prose plan can shrink, and more work can flow from the heavy `full` arc into a **contract-backed `rir`**. The contract — not the plan — becomes the load-bearing artifact. (This is the same insight that resolves the arc-calibration challenge below.)

### Assumption-challenges, ranked

1. **You review the bet *after* code, never *before*.** → the contract direction. Highest leverage.
2. **Is the `full` arc miscalibrated to typical task size?** The SDD evidence says heavy specs help large/greenfield and *hurt* small/brownfield-iterative. duet hedges with `rir` + presets, but is arc-choice *scale-driven or habitual*? This widens **Q20** (rubber-stamped plan gates) into a real audit; the contract shifts the full→rir boundary toward rir.
3. **Make single-writer + cost-discipline a stated identity.** Both Cognition and Anthropic validate it; `automation-design.md` should claim it explicitly as *why duet refuses parallel fleets* — a positioning asset and a mental-model anchor (multi-agent burns ~15× tokens; token use explains 80% of variance).
4. **Gates have no time axis.** Standard HITL (LangGraph) has two things duet lacks: **gate timeout policies** (a gate queued too long degrades-to-checkpoint / re-notifies rather than blocking silently — a pure semi-AFK win) and **fork-from-an-earlier-gate (time-travel)**. duet *deliberately* compresses the rework path today, but it already persists snapshots *exactly at gates*, so fork-from-gate is cheap and philosophy-compatible — worth revisiting that deliberate non-feature.
5. **The two roads not taken — name them, decline with reason.** OpenHands (event-sourcing makes resume/fork/replay *free*) and pi-mono (a fine-grained streaming-provider seam) are the sharpest challenges to duet's two hardest invariants. **My read:** both require *owning the agent loop* — which is exactly what "augment via the real CLIs" forbids. The spent-marker/cooperative-pause machinery is the *price of augmentation*, not an accident to dissolve. These belong in `future-directions.md` as **declined-with-reason**, with the cheap compatible *subsets* extracted: fork-from-gate (from OpenHands; duet's gate snapshots already make it tractable) and a provider-capability *table* + overflow handling (from pi-mono).

### Concrete borrows (smaller tier, high confidence)

- **Completion-timeout vs idle-timeout split** (sandcastle): done-but-not-exited → succeed-and-preserve-commits. Lands in `driver.ts`. *Best single AFK-reliability borrow.*
- **Overflow as a distinct `ErrorClass` → compact-then-retry** (pi-mono): you have the taxonomy + compaction; this is the missing middle. Lands in `worker-health.ts`.
- **Living `CONTEXT.md` domain glossary** (matt-skills): a persistent cross-run shared vocabulary; the durable distillate of framing. Genuinely missing primitive.
- **Structured handoff with commands + exit codes + evidence** (Factory): extend `implementation-handoff`.
- **Grader-rubric revise loop** (Claude Code "Performance Outcomes"): bounded by existing round caps — intelligence, not a second writer.
- **"Design-it-twice" bounded generative fan-out for interface design only, at PLAN** (matt-skills): design diversity without breaking single-writer.
- **3-part-test ADRs + a declined-decisions KB** (matt-skills): systematize what `open-questions.md` / `future-directions.md` do by hand; gives the reviewer/consultant a "do not relitigate" surface.
- **Copy-pastable git recovery messages** (sandcastle `buildRecoveryMessage`).

### Confirmed non-goals (the scan reinforced these)

Multi-writer parallel fleets, issue-tracker integration (Symphony/Linear, matt-triage), a daemon/poll loop (Symphony), a dynamic N-provider registry (sandcastle/pi-mono), and AI-mediated permission gates (sandcastle `permissionMode`) — all correctly *against* a stated principle. Symphony's only real gift is its reconciliation/stall/retry/restart-without-a-DB rigor as a cross-check for the AFK error surface.

### Recommendation & sequencing

1. **Design the acceptance-contract direction** — the flagship; it also resolves the planless question.
2. **Clone & deep-read `microsoft/conductor` (convergent) and OpenHands SDK V1 (adversarial)** into `resources/repos/` — Conductor to sanity-check the core bet and borrow gate-rendering; OpenHands to pressure-test whether the spent-marker machinery is necessary or whether fork-from-gate is the cheap subset to adopt.
3. **Promote the surviving directions into `docs/future-directions.md`** — the flagship as an active direction, the two roads-not-taken as declined-with-reason, the smaller borrows as a queued list.

Sources for the web findings are inline (factory.ai, cognition.com, anthropic.com, martinfowler.com, docs.langchain.com, github.com/microsoft/conductor, the OpenHands SDK paper arxiv 2511.03690). Local sources are cited by `resources/repos/<name>/...` path.

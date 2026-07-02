# The `design` arc — one artifact between framing and the build

- **Date:** 2026-07-02
- **Branch:** `feat/design-arc`
- **Status:** shipped (2026-07-03) — implemented and distilled into `docs/automation-design.md`; this file stays as the dated proposal record
- **Scope:** a third workflow arc (registry + machine coverage + snippets + phase briefs + skill surfaces), plus the review-loop polish revision that lands with it. Design-doc updates are deferred to implementation (§"Deferred doc updates"). A set of small, evidence-backed fixes rides the same branch (§"Ride-along fixes") but is not part of this design.

## Summary

The full arc drives two artifact phases — spec, then plan — through two review loops and two attended gates before the human can walk away. For a frontier-model implementer that ceremony is one artifact too many: the human shepherds two documents that overlap heavily, and the runs show the loops marching to their round-2 (`-again`) step every single time regardless of content.

The **`design` arc** sits between `full` and `rir`: `frame → design → implement → finish`. The `design` phase produces **one committed design document** — product goals, behaviors, and non-goals on top; module boundaries, seams, an architecture sketch, and test standards below — reviewed in one loop at a **section-scoped altitude** and ratified at one gate, which is also the arc's interactive→headless handoff. Implementation, docs reconciliation, and the PR tail are the full arc's, reused as registry data.

The default posture is the arc's product promise: a new run materializes `gatesAt: [design]` — the Direction gate auto-crosses, so the human's default interaction is **one interruption**: read one document, tap once, walk away. The severity hold is untouched, so a contentious direction still converts that auto-cross into an attended stop.

Alongside the arc, the **review-loop polish revision** restructures the reviewer's critique output in the existing `review-spec`/`review-plan` (and the new `review-design`): substantive findings first, then a batched **optional-polish** section of concrete before → after replacements the implementer applies without re-analysis. It targets the measured cost the arc alone doesn't fix — wording-level review points inflating round-1 update turns.

## Evidence

From the 2026-07-02 telemetry pass over the run corpus (13 full runs, 7 rir; `.duet/telemetry/`), plus the dogfooding journals:

- **Where full-arc time goes.** Spec loop ≈ 26 busy-min / 6.6 turns per run; plan loop ≈ 28 busy-min / 7.0 turns; implement dominates elapsed time (2–11 h). Merging spec+plan does not shorten the run end-to-end — the case for the arc is interruptions, ceremony, and artifact count, not wall-clock. **(observed)**
- **Loops march to round 2 unconditionally.** Every full run's spec and plan loop ran draft + round 1 + the `-again` round — the cap of 3 never binds, and round counts are protocol floor, not model need. The `-again` turns themselves are cheap (1–3 min medians): quick confirmations, kept as hand-wave insurance. **(observed)**
- **The felt cost is round-1 wording-stress.** `update-spec` / `update-plan` median 7 min each; the owner reports the reviewer pressing exact-wording accuracy and the implementer rereading the whole artifact to serve it. This motivates the polish revision, not the arc. **(observed + owner report)**
- **Attended-window math.** Under `overnight`, plan already runs unattended — so a merged phase pulls technical content *into* the attended window. The arc only shrinks the human's involvement if its posture also drops one of the two attended stops; hence the one-gate default. **(general, from the timings)**

## Goals / non-goals

**Goals.** A run type where a trusted frontier-model implementer needs one ratified design artifact between framing and the build: one review loop, one attended gate by default, one committed doc for human readers. The acceptance-contract backstop preserved. Everything arc-shaped expressed as registry data; `implement`/`finish` reused, not re-implemented.

**Non-goals.** Making runs finish sooner end-to-end (implement dominates; unchanged here). Reducing token spend as a primary aim (the owner's cost model is arc-per-project-tier). Any change to gate mechanics, the severity hold, steers, or the two event vocabularies. Adaptive phase-skipping inside `full` (structurally unrepresentable by design — an arc is the honest mechanism). A `challenge` consultant checkpoint for this arc (deliberately absent, below).

## Part 1 — the arc

### Registry entry

One new `WORKFLOWS` entry (`src/phases.ts`), mostly data. The shape, stated as decisions rather than code:

- **Phases:** `frame → design → implement → finish`.
  - `frame` — identical in substance to full's (`think-holistic`, `compare-notes`, `directionGate`, cap 2, consultant checkpoint `frame`).
  - `design` — snippets `write-design`, `review-design`, `update-design`, `review-design-again`, `update-design-again`; gate state `designGate`; `reviewLoop: true`; **`roundCap: 2`** (the arc's premise is fast convergence; the observed loops never needed 3); consultant checkpoint **`contract`**; artifact label "design doc"; planning-tier budgets/timeouts (30-min turns).
  - `implement` — full's implement spec reused: the same review loop (cap 3), midpoint judgment, `compact-for-impl`/`compact-for-review`, `reconcile-docs` as the last build step, `ceo-summary`, checkpoint **`verify`**, the 90-min wall-clock build cap. One substitution: the build seed is the new **`implement-design`** snippet (below) rather than plan-slice-driven custom prompts.
  - `finish` — full's finish, byte-for-byte (PR-only tail, `openPrGate`, open-then-review).
- **Entry:** `firstPhase: frame`, **`specSkipsTo: design`** — `duet new --spec <draft>` enters the design loop with the draft as the starting document (the flag's meaning generalizes to "a draft of the primary artifact").
- **`handoffGate: design`** — the interactive arc runs FRAME → DESIGN; plan-approval's role (freeze + handoff) moves to the design gate.
- **Posture:** `defaultPreAuthorized: [frame, implement, finish]` — a new run materializes **`gatesAt: [design]`**. Presets: `afk: []` (attend nothing). `forceAttend: []`.
- **Naming:** arc `design`, phase `design`, display name "Design (frame → design → implement → ship → PR)". The arc/phase overload is accepted; the phase does *not* reuse the name `spec` because its arc-role differs (it is the handoff/ratification, carries a different checkpoint, and reviews at a different altitude — the same reasoning that named rir's `research` differently from full's mechanically-identical `frame`). What *stays* shared is the artifact slot: the committed doc lands in `specPath`, so `advance_phase`'s `spec_path`, the contract-path derivation (`acceptanceContractPathForSpec`), and `--spec` entry all work unchanged.

`machineFor('design')`, `phasesOf`, `gatePhasesOf`, `handoffWatchLabel` ("design approved — AFK implement"), `isPostHandoffPhase` (implement + finish, so `--impl-model` splits at the design gate), and `probeRunPosition` all derive from the entry with no new mechanism. `validateRegistry` covers it at load.

### The design document

One repo file with an internal altitude gradient — the doc's structure is the review lens's structure:

1. **Product sections (top):** goals, user-facing behaviors, non-goals. Spec altitude.
2. **Technical sections (below):** module boundaries, seams, a general architecture sketch, test standards — at minimum the behaviors that must be tested, with strategies, gotchas, and high-level guidelines.

**What the doc defers to implementation** (the `write-design` guardrail list, the arc's "what not to include"): full code bodies, per-case test enumeration and fixtures, line-level edit plans, doc-update plans, commit order. The design owes *what to test and how to think about testing*; implement owns the cases.

The committed doc is the compaction re-anchor: `compact-for-impl` at implement entry drops the design-phase journey and re-reads the design doc, exactly as full re-reads the committed plan. Nothing about worker compaction changes.

### The acceptance contract: late-author placement

The structural change vs full, and its honest tradeoff.

Full's author-blindness rests on two legs — spec-only seeding, and early placement (dispatched right after the spec commits, before any plan exists). A merged artifact removes both: there is no ratified product-only document to seed from, and no phase between the design gate and the build. The design arc therefore authors **late**: after the design loop converges, **as the final step before `advance_phase`** — the same runs-last pattern verify already uses at implement — seeded with the near-final design doc. The freeze is unchanged: crossing the design gate commits the contract path-scoped (`freezeContractAt` keys on `contractAuthorPhaseOf`, which resolves to `design` from the registry), capturing any edits the human made while ratifying.

- **Given up:** blindness to the technical approach — the seed document contains it. **Kept:** blindness to the code and to the build (nothing is built yet), the independent fresh session, author-never-commits, and the whole verify chain at implement (draft-marker rail, `verifiedAt` freshness, self-heal loop, the `high` escape hatch) — all registry-driven and untouched.
- **Gained, incidentally:** because the design gate is the arc's one attended stop, the contract is **human-ratified by default** — stronger than full's `overnight` posture, where the freeze happens at an auto-crossed, unratified plan gate.
- **Mechanical changes:** the contract brief injection currently hardcodes the `plan` phase and the do-this-NOW-before-drafting placement; it generalizes to `contractAuthorPhaseOf(workflow)` with per-arc placement text (full: early, before plan drafting; design: last, after convergence). The `advance_phase` contract rail (won't advance without a draft marker or a `high`) keys on the same resolver rather than the literal phase name. The `consultant-contract` snippet stays **one shared snippet** with the seed stated as a hedge (the ratified spec / the converged design doc) and the blindness stated per seed — template economy over a near-duplicate snippet; the arc-specific placement lives in the phase briefs, where it belongs.

### Consultant checkpoints: frame, contract, verify — no challenge

The arc maps `frame → 'frame'`, `design → 'contract'`, `implement → 'verify'`. A phase carries one checkpoint, and `design`'s is the contract — so the arc has **no `challenge` bet-audit anywhere**. This is a stance, not an accident: the arc exists for work where the owner trusts the direction after framing and wants the correctness floor kept. It is also consistent with the existing kind-machinery — `consultantCheckpointLive`, `survivesGateless`, and the gateless narrowing all keep working unchanged, and a gateless design run drops nothing extra (it has no challenge to drop).

### The one-interruption posture, degraded safely

At the auto-crossed Direction gate the existing machinery does what it does everywhere: packet persisted, notification fired, `autoApprovals` recorded, and — untouched — the **severity hold**: a `high` human decision at frame (the orchestrator's own, or the consultant frame-read surfacing one via synthesis) withholds the auto-cross and converts it to an attended stop. The one-tap default is therefore not a bypass: contentious directions still stop the run.

### New snippets

Six keys, authored at implementation time under `docs/prompting-and-tool-design.md` and the prompt-engineering rulebook. The spec fixes their **design**, not their wording:

- **`write-design`** — the drafter. Orient-before-assign opening (plain words, no arc vocabulary); the two-tier doc structure above stated as the output contract; the defer-list as a positive guardrail *with its why* (those details are implement's to decide, and pinning them now would be premature commitment); cites the vendored `lessons/` methodology through `{{lessons_dir}}` (both topics, as `start-plan` and `implement-direct` do — the arc that drops the plan must not drop the plan's discipline). Hedged generality stays load-bearing: what varies per run (the feature, the modules, the project's names) is written as hedges the orchestrator collapses.
- **`review-design`** — the section-scoped altitude lens, a genuine third lens rather than a blend. Product sections get the spec lens (behaviors the feature must define are gaps; module design pressed here is below altitude — it lives in the doc's *own* later sections). Technical sections get the plan lens *minus enumeration* (module boundaries, seams, and test strategy are fair game and improvable; demanding per-case test enumeration or code bodies is below altitude). The three-part structure every review snippet carries — intentionally deferred / should-answer / proposed-content — specializes per section. Ships with the polish output contract from Part 2, and an anti-example per the examples guidance (the likely failure: reviewing the technical sections back up to plan depth, re-growing the rounds the arc deletes).
- **`update-design`**, **`review-design-again`**, **`update-design-again`** — mirror the spec/plan patterns: direct update (text is cheap to revise), round-2 verifies integration rather than relitigating; the update snippets carry the polish-application line from Part 2.
- **`implement-design`** — the build seed, sibling of rir's `implement-direct` (whose body assumes *no* design artifact exists, so it is not reused). It reads the committed design doc as the authority for *what and why*, carries the build discipline for *how* (vertical slices, a commit per slice, tests per the doc's standards, single pass with the midpoint as the one judgment-gated exception), and keeps the lessons citations.

Library bookkeeping: the five design-phase keys join the phase's registry list; `implement-design` joins the design arc's implement list; the snippet classification test forces every new key into exactly one bucket, and `docs/snippets.md` gains catalog entries (deferred with the docs).

## Part 2 — the review-loop polish revision

Ships in the same PR; independent of the arc but designed together so `review-design` is born with it.

**Who does what — the answer to the open question:** the polish section is a structured part of **the reviewer's critique message** — the tool-routed response the orchestrator relays to the implementer. Nobody appends anything to the artifact: the reviewer *authors* the section inside its feedback, the implementer *consumes* it while revising the artifact. The artifact only ever changes through the implementer's normal edit.

**The reviewer's output contract** (in `review-spec`, `review-plan`, `review-design`, and their `-again` variants): substantive findings first, exactly as today; then an **"Optional polish"** section where each item is a concrete replacement — location plus exact before → after text. The qualifying rule doubles as the trigger/skip line: if the reviewer can supply the exact replacement and the meaning doesn't change, it's polish; if the imprecision changes behavior, scope, or a testable claim, it's a substantive finding; if the reviewer can't write the replacement, it isn't polish — it's either substantive or not worth raising. The *why* rides along: polish items cost the author a reread when delivered as concerns, and nothing when delivered as replacements.

**The updater's side** (in `update-spec`, `update-plan`, `update-design`, and `-again` variants): one line, positively framed — apply the polish items as given, or skip the ones you disagree with; they need no re-analysis, so spend the thinking on the substantive findings. This is a license revocation, not a new duty: without it a conscientious implementer re-derives each suggestion, which is the measured 7-minute behavior.

**Guideline compliance, called out:** positive path (what qualifies as polish, not "don't nitpick"); framework-with-why on both sides; explicit output contract; trigger + action + skip on the reviewer's classification rule; no added emphasis; one source of truth per behavior (the classification rule lives in the review snippets; the application rule in the update snippets; neither is duplicated into the orchestrator prompts — the orchestrator routes the message unchanged).

**What this deliberately does not do:** cut the `-again` round. The data shows it costs ~10 busy-min/run and functions as cheap verification that feedback was integrated; whether it ever catches a real hand-wave is unanswerable without content-level corpus tooling, and until then it stays.

## Part 3 — skill and prompt surfaces

Designed-with-in-mind now; exact wording at implementation.

- **`skills/duet-frame/`** — the arc choice is a setup decision the user makes before launch, so the skill must surface three arcs, not two (the capability-trigger rule in `docs/documentation-standards.md` §Shipped skill maintenance). The selection guidance in one line each: `full` when the ceremony earns its keep (unfamiliar domain, heavy risk, the spec and plan genuinely differ); `design` for serious work on a trusted frontier model — one ratified design doc, one gate, then AFK; `rir` for small, well-understood changes. The skill also emits `workflow: design` frontmatter and should know the arc's one-gate default when it narrates the posture.
- **Orchestrator briefs** (`src/harness/orchestrator-prompts.ts`) — a `designPhaseEntryPrompt` (the loop, the doc contract, the late contract step, the gate summary expectations) and a design-arc implement brief that anchors on the design doc where full's anchors on the plan (parameterize or sibling function — implementation's call; the requirement is no "plan" vocabulary reaching a design-arc worker). Phase-level judgment examples per the examples guidance: the design phase's call is the section-scoped altitude (one example pressing a product gap, one `type="avoid"` reviewing technical sections to plan depth).
- **`prompts/orchestrator-identity.md` / concierge** — expected untouched (arc facts flow from the registry through briefs and `get_task`); verify at implementation that neither hardcodes the two-arc assumption.

## Ride-along fixes (same branch, not this design)

Tracked separately; listed for PR completeness: the review-midpoint round-cap exemption, `respond-midpoint`'s AFK-aware tail, the double consultant-verify ordering check, the `duet stats` phase-window attribution bug, and the two `open-questions.md` forensics defects (held-gate resume narration, `autoApprovals` first-gate gap).

## Tests

The existing suites pin most of this by construction; the new coverage, at behavior altitude:

- Registry: `validateRegistry` passes with the third arc; `contractAuthorPhaseOf('design') === 'design'`; `isPostHandoffPhase` splits at the design gate.
- Machine: `machineFor('design')` coherence (tag sets, gate/loop/flag-wait wiring, done reachable), the interactive variant, and `specSkipsTo` routing on `--spec` entry.
- Posture: a new design run materializes `gatesAt: ['design']`; the severity hold still converts a `high` at the auto-crossed Direction gate into an attended stop.
- Contract rails on the arc: design won't advance without a draft marker or a `high`; freeze fires at the design gate (attended and auto-crossed both); implement's verify rail unchanged.
- Snippets: every new key classified and phase-listed; `{{lessons_dir}}` resolution for the new citations; the polish contract present in the revised bodies (string-pinned lightly, not verbatim).
- Skills: `tests/skill.test.ts` coherence once duet-frame names the arc.

## Rollout and evidence

First live run: a real, serious feature on a frontier-model implementer (the arc's target case), compared against the full-arc baseline with `duet stats` and the telemetry kit. The bets to watch in the run notes:

1. **Convergence** — the design loop settles within cap 2 without the reviewer re-growing plan-depth rounds (the lens's job).
2. **Contract quality** — assertions seeded from the merged doc stay behavioral, not implementation-echoing (the weakened-blindness risk made observable).
3. **The one-interruption default** — whether the morning-after review ever wishes the Direction gate had been attended (the same watch full's `overnight` default carries in `open-questions.md` §"Settled, still watched").
4. **Polish adoption** — reviewer output actually uses the split; update turns shrink from the 7-minute median.

README's verified-vs-not line records the arc as built-but-unverified until that run.

## Deferred doc updates (at implementation, per `docs/documentation-standards.md`)

Design-level change → `docs/automation-design.md` (§Phases and gates: the third arc's diagram and gate table; §Gate pre-authorization: the arc's presets and one-gate default; §Consultant checkpoints: the late-author placement and its tradeoff), `CLAUDE.md` (the arc-count phrasing in **What** and any invariant that says "both arcs"), `docs/snippets.md` (catalog entries), README (arcs + status line), `docs/engineering.md` (expected minimal — the registry pattern already describes arcs-as-data; touch only if a new seam appears). `docs/workflow-model.md` gains the design-doc altitude if the protocol description enumerates artifact stages — check at implementation.

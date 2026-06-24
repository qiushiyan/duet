# The acceptance contract — a consultant-authored, judge-verified definition of success

Status: **shipped 2026-06-24** — built on the full arc and distilled into the live design (`docs/automation-design.md` §"Consultant checkpoints"; `CLAUDE.md` invariants), which is authoritative for current behavior. This doc is kept as the originating rationale — the first-principles case, the format/prompting design, and the science it rests on — not as a description of the build; where the two differ, the design docs win. Consolidates the contract thread from `docs/researches/2026-06-23-orchestration-landscape-scan.md` through the mechanics / format / prompting dialogue that followed; the **OPEN** questions below were all settled during the build (see that section).

## The idea in one paragraph

The optional **consultant** (today: read-only, ephemeral, cross-model-family, audits the *bet* at gate-adjacent checkpoints) gains a frozen target. Before implementation, the consultant authors an **acceptance contract** — a short, independent, natural-language list of falsifiable behavioral assertions describing *what success means* for this feature — and commits it as a repo artifact beside the spec and plan. After implementation, a fresh consultant session **verifies** the implementation against the frozen contract, running and citing evidence per assertion. A failed assertion rides duet's existing severity channel: a `high` `human_decision` that holds a non-explicit crossing but never blocks an explicit `--approve`. The contract turns the consultant from a soft second opinion into a **closing-the-loop verifier** — with no new *writer* role and no new gate machinery.

## Why it works (first principles)

Effectiveness needs **two** ingredients, not one — drop either and it degrades into ceremony:

1. **Independence of authorship** — the contract is *pre-registration*. In science you commit to the hypothesis before running the experiment so you can't rationalize the result afterward. The implementer's own tests are the experiment confirming its own hypothesis; the contract is the pre-registered hypothesis, authored by a party exposed to *product goals*, not *code*. This is what makes it catch "built the wrong thing," which post-hoc artifact review and self-authored tests structurally miss. (Validated by the creator-verifier separation and self-enhancement-bias literature: LLM judges favor their own outputs even when anonymized — arXiv 2410.02736 — so a different model family from both implementer and reviewer is doing real work.)
2. **Evidence-grounded verification** — the verifier must *run the thing and cite observed behavior*, not reason from the diff. LLM judges are weakest exactly at evidence verification and reliable only when grounded in external signals (execution, logs) and forced to quote (RULERS, arXiv 2601.08654). A contract read only against the diff has the independence but not the grounding — the documented ceremony-failure mode.

The contract is therefore **complementary to, not a replacement for, the implementer's tests**. The tests verify the implementation against *the implementer's understanding* (mechanical, fine-grained, self-confirming); the contract verifies it against *the product's intent, captured independently* (judged-against-evidence, behavior-level). Different author, different reference frame — and the contract may *consume* the tests as one form of evidence ("Verify by: the auth suite passes **and** a bad-password login observably returns 401, not 500").

**The contract's reason to exist, in one rule** — also its anti-bloat dam:

> Assert only what is both **high-impact-if-wrong AND unlikely to be caught by the implementer's own tests.**

The implementer's tests already cover "does my code do what I think." The contract spends its whole budget on the gap.

## Lifecycle in duet

The contract has four stages, each landing on machinery that already exists.

- **Author — DECIDED: plan phase, fresh blind consultant session.** In the full arc the consultant fires at `frame` and `specGate`, then is **idle during the plan phase** (the registry has no `plan` checkpoint — `src/phases.ts`). That idle window is the authoring slot: a *new headless consultant session* (Option 2 — reuse the existing consultant spawn conventions) reads the **committed** spec and writes the contract, committing it itself. Chosen over reusing the spec-review session because the consultant's defining asymmetry is *ephemeral / discard-and-reseed* (it must never decay into a second embedded reviewer — `src/roles.ts`); a fresh session reading the committed artifact is that model applied to one more job. **Authoring runs concurrently with the implementer/reviewer writing the plan, which structurally enforces spec-only independence** — the consultant *cannot* see the plan or code while it authors, so the "contract drifts toward what's easy to build" bias is prevented by the timing, not by a prompt rule. (It also costs ~zero added wall-clock — otherwise-idle capacity.)
- **Freeze — DECIDED: the handoff gate.** The contract is frozen at plan-approval (full) / Direction (rir), where the **human ratifies "what success means" before walking away.** This strengthens the handoff gate in exactly the way the human-owns-substance principle wants: the AFK run is then checked against a target the human personally signed off on. Frozen *before code, after thought* — the sweet spot on the independence-vs-accuracy axis.
- **Verify — DECIDED: the existing `implGate` checkpoint.** A fresh consultant session re-reads the frozen contract, exercises the system, and returns a per-assertion pass/fail with cited evidence. The `implGate` checkpoint thereby **upgrades from an open-ended "audit the bet" to a closed-loop "verify the frozen contract"** — same checkpoint, now with a target (plus any residual bet concerns).
- **Gate — DECIDED: the existing severity hold.** A failed assertion is a `high` `human_decision`, which already *holds a non-explicit crossing* (the `gates_at` auto-cross, a `duet afk` handoff) but **never blocks an explicit `--approve`** (`docs/automation-design.md` §Gate pre-authorization). So the contract is a hard gate for overnight/AFK runs and advisory when the human is personally at the Ship gate — no new gate machinery, and the un-forgeable-crossing invariant is untouched.

## Where it fits the registry and the role model

- **Registry:** a new `consultantCheckpoint` mode attached to the `plan` phase — a *generative-and-writing* mode, distinct from the existing audit modes — extending the `consultantCheckpoint` field + `CONSULTANT_CHECKPOINT_SNIPPET` map already in `src/phases.ts`. The `implGate` mode is re-pointed at the frozen contract.
- **Role policy — the one real evolution (OPEN in detail):** the consultant's read-only-ness becomes **per-checkpoint, not role-wide** (`src/roles.ts`). It gains a *scoped write* (exactly one file — the contract) at the author checkpoint, and *execute-to-observe* (run tests / CLI / curl / read logs, never edit or commit) at the verify checkpoint. The *ephemeral* and *cross-family* asymmetries are unchanged. The target domain is **backend / orchestration / library behavior, not UI** (per the maintainer), so the execute surface is lightweight — no computer-use/browser QA.

## Format — DECIDED: disciplined natural language, no DSL

A DSL is not worth its cost. Gherkin/Cucumber's structured prose is fine but its executable step-definition glue is the rot-prone half; design-by-contract and property tests live *with* the code and forfeit independence; Pact-style "contract testing" is a different concept (API wire-format agreements) and must not be conflated. Objectivity comes from **falsifiability of each line + grounding in observed behavior**, both achievable in disciplined NL — a DSL does not make an LLM judge more objective.

There is also a duet-shaped reason: on the **trust gradient** (`docs/engineering.md`), hard guarantees live in code (the statechart) and judgment lives in text (prompts). The contract feeds the consultant's *judgment*, which feeds the severity hold; it is not a code-enforced rail. It belongs on the "steer in text" side — so NL is the correct medium, and a DSL would be a category error.

**Per-assertion template** — an ID'd, EARS-shaped assertion plus a mandatory evidence field:

```
[ID] <EARS keyword> <trigger>, the <system> SHALL <one observable response>.
  Verify by: <probe> → <exact expected observable>
```

EARS keywords map onto duet's own dimensions: `When` (events/transitions), `While` (state-driven), `If…then` (error/unwanted paths), ubiquitous (invariants), `Where` (flag-gated) ([alistairmavin.com/ears](https://alistairmavin.com/ears/)). Rules: one observable per line; `SHALL`/`SHALL NOT` only; explicit negations where they matter; a banlist of quality-adjectives ("works / correctly / gracefully / robust / efficient"); stable, never-renumbered IDs; binary pass/fail, no holistic score; self-contained lines (no cross-references). These are the conventions that make a *different* LLM verify the contract deterministically (RULERS).

**The concreteness rule (a first-principles clarification):** at authoring time the consultant can't know the literal log strings or commands the implementation will expose, so **the contract's concreteness tracks the *spec's* concreteness.** For an orchestrator/CLI/library the spec already fixes the observable surface (flags, state fields, events, exit codes), so `Verify by:` is concrete there ("observe `duet status --json .displayState` advances"); where the spec defers to implementation, the probe stays behavioral ("the run *resumes*, not *restarts*"). The author specifies *what to observe*; the verifier resolves *how to observe it* in the built system. That division is what keeps the contract independent of the implementation while still falsifiable.

## Prompting design — elicit then formalize

The author prompt is two moves, in order; the order is load-bearing. Formatting-first produces a tidy, bloated list of obvious happy-path lines (the Kiro-16-criteria trap); risk-targeting must lead, with the template as the mold the survivors are poured into.

**1. Elicit (find the high-value behaviors).** The signal taxonomy to scan a spec for, ranked by leverage: the **product's core promise**, **trust/permission boundaries**, **irreversibility / data-loss**, **state-machine invariants & illegal transitions**, **idempotency / retry / concurrency / partial-failure**, **contract-with-callers (CLI/API/exit-code/schema stability)**, **error/failure envelope**, **security-relevant behavior**. Elicitation techniques, in priority:

- **Criteria-first / implementation-blind** — the single highest-leverage technique (Self-Grounded Verification: ~+20 points failure-detection by committing criteria before seeing candidate work — arXiv 2507.11662). duet's consultant is *already* implementation-blind and the parallel-authoring timing enforces it; the prompt should name the blindness as the asset.
- **Pre-mortem, past tense** — "it's three months out; this shipped and has been quietly wrong the whole time, no crash, no failing test — write the post-mortem, then turn each cause into an assertion" (prospective hindsight: ~+30% cause identification — Klein/HBR 2007).
- **Definition-of-wrong inversion** — "don't list what it should do; list what would make it *wrong*, not merely buggy."
- **Red-team the implementer's tests** — "assume all their tests pass; describe a correct-looking implementation that passes every obvious test and still violates intent; write the assertion that closes that gap."

**2. Formalize (cast survivors into the template),** applying the north-star selection rule and an FMEA-lite cap scaled to task size (bug fix: 3–5; feature: 8–12; "if you need more, the contract is at the wrong altitude").

**Craft notes aligned with `docs/prompting-and-tool-design.md`:** persona priming must be *behavioral, not credential* — "you're the on-call engineer paged at 3am who doesn't trust their passing tests" helps, while "you are an expert" measurably damages accuracy (arXiv 2603.18507) — which is duet's convention #2 (thinking-framework over emphasis). **Anti-patterns to prompt against:** restating the spec as assertions, asserting the obvious happy path, over-flagging for the appearance of diligence, and demanding detail the spec *intentionally* defers (duet's altitude lens, applied to the contract).

This implies two snippets, deferred until the spec: **`consultant-contract`** (author — elicit-then-formalize) and **`consultant-verify`** (verify — run-and-cite, per-assertion pass/fail; supersedes the open-ended `implGate` audit).

## Dogfooding note

The top of the signal taxonomy — state-machine invariants, illegal transitions, idempotency, partial-failure, contract-with-callers — *is duet's own domain. duet already maintains a hand-written latent contract of exactly this kind: the **"invariants that bite if forgotten"** list in `CLAUDE.md`* ("no tool emits `human.*`", "one branch per run, fixed before the first prompt", "the spent-marker is cleared iff the run resumed at the marker phase's own gate/flag"). This feature systematizes, per feature, the discipline duet already practices at the project level — and duet is a clean first test subject for it.

## Open questions — how the build settled them

These were OPEN when this was research; each was settled during the build. The live design (`docs/automation-design.md` §"Consultant checkpoints") is authoritative; the verdicts:

- **rir arc — DEFERRED.** rir stays byte-for-byte unchanged and authors no contract; the ultra-light Direction-gate checklist is not built (revisit when a live rir run wants it). rir's `implGate` keeps its open-ended bet audit rather than being re-pointed at a contract it never authored.
- **Read-only relaxation — prompt-level, no sandbox.** The author's one-file write and the verifier's execute-to-observe surface are scoped by the `consultant-contract`/`consultant-verify` snippets, not an OS sandbox (the codebase deliberately omits one). The integrity that *is* structural is the path-scoped freeze (commits only the contract) and the authorship draft marker (a stale file is never frozen).
- **Author input — spec-only.** Seeded with the committed spec alone; the author step is placed before plan drafting so the orchestrator dispatches it blind.
- **`consultant-verify` vs the `implGate` audit — replace.** On the full arc, `verify` supplants the open-ended audit (with room for residual free-form concerns); rir keeps the audit.
- **Human editing at freeze — direct edit, separate from the rider.** The human edits the committed contract file at the always-live plan gate; the freeze commits whatever is there. The approval rider stays a direction-to-the-next-phase channel, not a contract-edit channel.
- **Caps / location — prompt-stated caps; `<spec-stem>.acceptance.md`.** FMEA-lite caps (bug fix 3–5, feature 8–12) live in the author snippet, not a code rail; the contract is the spec's sibling.
- **Enforcement (raised in review).** The author→freeze→verify chain is enforced mechanically by `advance_phase` rails (existence of the checkpoint, not pass/fail) plus the draft/`verifiedAt` markers, with a `high` the only escape — so a bound full run can't silently ship past the chain.

## Sources

Local: `docs/researches/2026-06-23-orchestration-landscape-scan.md` (the originating scan), `src/phases.ts`, `src/roles.ts`, `docs/automation-design.md` §"Consultant checkpoints" / §"Gate pre-authorization", `docs/engineering.md` (trust gradient), `CLAUDE.md` (invariants). External: Factory Missions validation contracts (factory.ai/news/missions, /missions-architecture); EARS (alistairmavin.com/ears); RULERS evidence-grounded judges (arXiv 2601.08654); Self-Grounded Verification (arXiv 2507.11662); biases in LLM-as-judge (arXiv 2410.02736); persona-prompting accuracy trade-off (arXiv 2603.18507); pre-mortem (Klein, HBR 2007); BDD/Gherkin best practices; GitHub Spec-Kit; Amazon Kiro (EARS-based specs).

# Unify the spec and design artifacts

*2026-07-08 · branch `unify-spec-design`*

**Status:** shipped 2026-07-08. The durable facts are distilled into `CONTEXT.md` (the spec/plan artifact vocabulary), `docs/automation-design.md` (§"The workflow vocabulary" — ordered documents and the derivations that replaced the artifact-name branches; §"Consultant checkpoints" — contract placement derived from `hasUpstreamDoc`), `docs/engineering.md` (the module map), and `docs/corpus-runbook.md` (the retired-vocabulary cohort). This document is kept as the dated record of *why*, and of the alternatives that lost.

**One item did not ship with it.** `write-spec`'s design-it-twice discipline depends on a `pnpm vendor-lessons` refresh that is still uncommitted: HEAD's `design-it-twice.md` prescribes spawning parallel sub-agents, which a worker cannot do, while the solo constraint-first workaround the snippet is built on exists only in the working tree. `tests/snippets.test.ts` checks that a cited lesson path *resolves*, never its content, so this coupling is invisible to CI. The re-vendor must land in the same commit.

## Summary

**What.** duet ships two names for one artifact. `write-design` is, by our own catalog's admission, "`write-spec`'s product tier merged with `start-plan`'s technical discipline" (`docs/snippets.md:221`) — a composition of two documents we already have, wearing a third name. This change deletes the `design` artifact kind. Every workflow's planning document is a **spec**: half-technical, carrying the whole mental model for the change, whether or not a `plan` phase follows it.

**Why now.** The duplication is not the real cost. Two defects hide behind it:

1. **Full's spec phase reads no methodology and commits the interface anyway.** `write-spec` asks for a directory tree and a public API surface, then says *"Shape all three with a deep-module mindset. The full methodology is planning-stage reading"* (`snippets/doc-spec.toml:55`). It requests the output of a methodology it declines to supply. It is the only snippet in the library that commits a module structure with no lesson in context.
2. **`design-it-twice` fires one phase too late on full.** It is gated inside `start-plan` (`snippets/doc-plan.toml:39`) — *after* the spec has committed the interface, and after `start-plan:72` has told the architect to "follow the settled spec; pause before challenging major direction." The lesson exists to be read *before* an interface is chosen.

**The approach.** Merge the two draft snippets and the two review snippets by graft, not by pick. Move the design methodology to where the design decisions are made, and scope each lesson's read depth to the decision it governs rather than to the phase. Enhance the target-shape section — the one section reviewers and cold builders lean on hardest — with `design-it-twice`. Then collapse the machinery `design` was propping up: `ArtifactKind` loses a member, five call sites stop branching on an artifact name and derive from workflow topology instead, and two brief renderers, one snippet file, one gate state, and one examples world are deleted.

**The boundary once it lands.**

- **Fixed:** one doc-loop artifact vocabulary (`spec | plan`); one draft snippet, one review snippet, one revise family; methodology read where it is acted on; `design-it-twice` governing the target shape.
- **Not fixed:** `start-plan` keeps its slicing, right-sizing, dependency, and test guidance (touched only where the spec now owns the decision). `test-quality.md` stays uncited — a real bug, scoped out below.
- **Deliberately broken:** frozen `workflow.json` files carrying `artifactKind: "design"` stop loading. No compatibility shim, per the owner's decision (2026-07-08). Cost named in *Rabbit holes*.

The four shipped workflows become visibly one grammar:

```
full:      frame → spec(audit) → plan(contract) → build(critique) → finish
blueprint: frame → spec(contract)              → build(critique) → finish
relay:     frame → spec(contract)              → build(fixer)    → finish
short:     frame(research)                     → build(writable, audit) → finish
```

blueprint is *full minus the plan phase*. Today `design` hides that.

---

## Current vs. desired

**Preserved.** The doc-loop block, its draft→review→update→converge shape, the round-cap backstop, the two-tier altitude lens, the acceptance-contract chain (author → freeze → verify), every gate, every duty, every continuity edge, the single-world rule, and blueprint's one-interruption product promise.

**Changing.**

| | Now | After |
|---|---|---|
| `ArtifactKind` | `spec \| plan \| design` | `spec \| plan` |
| Draft snippets | `write-spec`, `write-design` | `write-spec` |
| Review snippets | `review-spec`, `review-design` (+ 4 `-again`/`update` pairs, 3 of which are byte-identical modulo one noun) | `review-spec` (+ its pair) |
| Snippet files | `doc-spec.toml`, `doc-design.toml` | `doc-spec.toml` |
| Doc-loop brief renderers | `specDocBrief`, `specDraftBrief`, `planDocBrief`, `designDocBrief`, `designDraftBrief` | `specDocBrief`, `specDraftBrief`, `planDocBrief` |
| blueprint/relay gate | `design` → `designGate` | `spec` → `commitSpecGate` |
| Gate hint "hands off to AFK" | hand-written in `frameGate(docLoopFollows)` and `docGate('design')` | one derivation: *is this planning's last phase* |
| Round cap for blueprint/relay | magic: `defaultDocRounds(artifact) = design ? 2 : 3` | explicit: `doc('spec', { rounds: 2 })` |
| Contract placement | chosen by which brief function you are in | derived: *does a committed doc precede this phase* |
| Build examples worlds | `impl`, `blueprint-impl`, `short-impl`, `relay-impl` (workflow-named) | knob-named |

**The insight the change rests on:** `design` was never an artifact. It was a proxy for *"no plan phase follows this document."* Five of the six places that branch on `artifactKind === 'design'` are really asking a topology question the compiler can already answer — and `define.ts:453` (`frameGate(docLoopFollows)`) already answers exactly that question, for the frame block, correctly. We wrote the derivation once and then hand-encoded it a second time under a different name.

---

## The coupling decision

`spec` and `design` are **one concept, extended** — not two concepts to keep independent. Evidence, in the code:

- Both land in the same run-state slot (`state.specPath`); the acceptance-contract path derives from it identically (`acceptanceContractPathForSpec`).
- Both are entry doc-loops with a `--spec` draft-entry variant (`entry.specSkipsTo` is *"the first doc phase"*, already artifact-blind).
- `update-spec`, `review-spec-again`, `update-spec-again` are byte-identical to their `-design` twins modulo one noun — and to their `-plan` twins as well.
- `write-design` = `write-spec`'s product tier + `start-plan`'s technical tier (`docs/snippets.md:221`).

The only genuine difference is **what happens downstream**, which is topology, not identity.

---

## The foundation decision

**The structure absorbs this cleanly. No preparatory refactoring.**

`define.ts` is already the deep module this change wants: `compileWorkflow` sees the whole phase list and derives stages, duties, edges, entry seeds, gate copy, caps, and checkpoints from position. Every derivation this change needs is a sibling of one that exists. `machine.ts:148-150` builds states from `p.gate.state` with no name hardcoded, so deleting `designGate` costs the statechart nothing. `phaseOfGateState` is workflow-scoped. `run/workflow.ts` reads a frozen artifact.

What we are removing is not structure — it is a **hand-encoded second copy of a derivation the compiler already performs**. That is the change getting easy because the foundation is right, not despite it.

One thing genuinely blocks and gets a bounded fix: `doc()` (`define.ts:94-118`) validates knob legality against the *artifact name* because it sees one phase and cannot see topology (`options.audit && artifact !== 'spec'`; `options.contract && artifact === 'spec'`). Those checks move up into `compileWorkflow`, which can see position. Bounded: two `throw`s relocate and get more correct. Deliberately left alone: the block constructors' shape, `assertKnownKeys`, and the rest of the SDK surface.

---

## Target shape

### Shapes considered

Three interfaces for "how does a doc-loop phase learn what kind of document it is," each following one constraint further than comfortable, generated constraint-first.

**A — Minimal authored surface.** Keep `artifactKind` as the discriminator; drop `design`; derive the five topology-dependent facts. `doc('spec')` / `doc('plan')` stay legible in the SDK. *Depth:* moderate — renderers still read a knob and re-derive. *Locality:* the derivations concentrate in `compileWorkflow`. *Seam:* at the compiled `PhaseSemantics`.

**B — Delete the knob entirely.** `doc({ audit })` with no artifact argument; the first doc phase *is* the spec, the rest are plans, by position. *Depth:* maximal — illegal states (`doc('plan')` first, two specs) become unrepresentable rather than rejected. *Locality:* excellent. *Cost:* the authoring surface goes opaque — a project workflow file reads `doc({}), doc({contract:true})` and the author cannot see what either document is. The SDK is read far more often than it is validated, and `skills/duet-frame/references/workflow-definitions.md` is the teaching surface. Legibility loses to cleverness here.

**C — Ports-and-adapters on the renderer.** Compile a derived `DocRole` record (`{ isEntryDoc, hasUpstreamDoc, isHandoffPhase }`) and give the renderers *that* — they never see `artifactKind` at all. *Depth:* the renderer's interface stops mentioning artifact names, which is what "one world per rendered prompt" wants structurally rather than by convention. *Cost alone:* a second vocabulary shadowing the first; `deepening.md`'s two-adapter rule refuses a port with one adapter, and there is exactly one renderer.

**Recommendation: graft A + C's discipline + B's validation.**

- Author in A's vocabulary — `doc('spec')` / `doc('plan')` — because the SDK is a teaching surface (`design-it-twice:35`: name things in the project's domain language).
- Enforce B's ordering rule at compile time: a `plan` doc requires an upstream doc; a `spec` doc must be the first. Illegal orderings fail at load with the valid shape named, rather than briefing a plan that has no spec to reread.
- Take C's discipline without its port: the derived facts live as **fields on the compiled `PhaseSemantics`**, not as a parallel record behind a new interface. The renderer reads compiled facts; it just reads them from the shape it already reads. One adapter, no port.

The graft is what B and C each get right — unrepresentable orderings, and renderers that don't re-derive — without B's opacity or C's indirection.

### Structure — after

```
snippets/
  doc-spec.toml      # write-spec, review-spec, update-spec, +-again pair
  doc-plan.toml      # start-plan (design-it-twice gate removed), review-plan, …
  doc-design.toml    # DELETED
  build.toml         # implement-design → implement-spec

src/registry/
  vocabulary.ts      # ArtifactKind loses 'design'; ARTIFACT_SNIPPETS, BRIEF_WORLDS,
                     #   ExamplesKey, EntrySeed shed their design members
  define.ts          # docGate/entrySeedFor/buildExamplesKeyFor/defaultDocRounds
                     #   stop reading artifact names; doc() knob checks move up
                     #   into compileWorkflow (which can see position)
  workflows.ts       # blueprint/relay: doc('spec', { rounds: 2, contract: true })

src/orchestrator/
  briefs.ts          # designDocBrief, designDraftBrief, DESIGN_EXAMPLES,
                     #   DESIGN_CONTRACT_PLACEMENT deleted; specDocBrief absorbs
                     #   them via the derived facts

src/replay/
  phase-state.ts     # phaseProducesSpecPath: name list → entry.specSkipsTo
```

### The compiled interface a renderer reads

The one new surface. `PhaseSemantics`'s doc-loop arm gains the derived facts, so no renderer re-derives topology:

```ts
| { block: 'doc-loop'
    artifactKind: 'spec' | 'plan'
    hasUpstreamDoc: boolean   // a committed doc precedes → contract authors EARLY, seeded from it
    isHandoffPhase: boolean   // planning's last → the gate hint says "hands off to AFK"
  }
```

Both fields are computed by `compileWorkflow` from the phase list. `examplesKey` **leaves** the doc-loop arm: with the spec's two example worlds collapsed onto one derived deferral noun (below), each artifact has exactly one world, and the field restates `artifactKind`.

### What a caller writes

```ts
// blueprint — was doc('design', { contract: true })
doc('spec', { rounds: 2, contract: true })

// full — unchanged
doc('spec', { audit: true })
doc('plan', { contract: true })
```

`rounds: 2` was previously magic keyed on the artifact name (`defaultDocRounds`); the knob already existed and now carries the fact. `contract` on a `spec` was previously a `throw` (`define.ts:107`); it is now the ordinary way a plan-less workflow authors its contract.

### Wiring — what derives from what

```
compileWorkflow (sees the phase list)
  ├─ isHandoffPhase   = last planning phase   ──▶ gate.hint       (one rule, was two)
  │                                           ──▶ frameGate's hint (same rule, deduped)
  ├─ hasUpstreamDoc   = a doc precedes        ──▶ contract seed placement (early | late)
  ├─ upstreamArtifact = last doc before build ──▶ entrySeed, build examplesKey
  └─ position         = spec first, plan after ──▶ load-time rejection of an illegal order
```

`handoffGateOf(workflow)` already computes "planning's last phase" for the session handoff. The gate hint is the same fact rendered as prose. Today `frameGate(docLoopFollows)` derives it and `docGate('design')` hard-codes it — the duplication `design` was hiding.

---

## The revised `write-spec`

The graft, section by section. From `write-spec`: the target-shape section (three views, each entry a domain concept "not a layer of plumbing"), the worked *be-concrete* example, the before/after tree, current-vs-desired, the coupling decision. From `write-design`: the explicit product-tier / technical-tier split, module boundaries & seams as a named section, test standards, the crisp "what's decided later" block. Folded: `write-design`'s *architecture sketch* (data/control flow) and `write-spec`'s *integration wiring* (who calls it, what it replaces, which seams it plugs into) are the same object; one section. Deleted: `doc-spec.toml:55`'s *"The full methodology is planning-stage reading"* — the one line presuming a downstream plan, and the line that caused defect (1).

### The reading list, scoped by decision

The principle: **read a lesson deeply where its decisions get made; skim its bar where they are only constrained.** This is the vendored library's own affordance — `lessons/README.md`: *"Each opens with a skimmable `## The bar` section… so `review-plan` skims the top as a lens while `start-plan` reads deeply."* `write-design` ignores it and asks for four full reads, including 440 lines of Vitest API to produce a document that never writes an assertion.

| Lesson | Depth at spec | Why |
|---|---|---|
| `codebase-design/deep-modules.md` | **read** | The spec *decides* module structure, interface, seam placement. Also the vocabulary `review-spec` needs to hold the target shape to depth-and-locality rather than taste. |
| `codebase-design/design-it-twice.md` | **read**, when a target shape exists | The interface is chosen here and nowhere later. Gate already written: *"a contained bug fix may need none."* |
| `codebase-design/deepening.md` | **read**, when restructuring a cluster or crossing a seam you don't own | Its dependency categories decide **whether a port exists at all** — an interface decision. `design-it-twice:19,31` names it as its own dependency. (Its "replace, don't layer" half is the build's; the smaller half.) |
| `testing/tdd-loop.md` | **skim the bar** | The spec owes §Planning's first two lines — the interface changes needed, the behaviours worth testing in priority order — and `tdd-loop:48`: *"Which behaviours matter is the product's call — surface it and wait."* Red-green and tracer bullets are the build's. |
| `testing/mocking-and-fixtures.md` | **skim the bar** | One bar bullet is a *design* constraint: *"never mock your own modules — mocking code you control is a design signal; fix the interface."* Plus *"prefer SDK-style interfaces over generic fetchers."* Both shape the seam. The other 300 lines are `vi.mock` recipes. |
| `testing/vitest.md` | **no** | Tool reference. Its presence in `write-design:18` is the clearest evidence the design snippet was assembled by union rather than by decision. |
| `testing/test-quality.md` | **no** | Build + `review-implementation`. (It is cited by *no snippet today* — see *Rabbit holes*.) |

Nothing is lost by the exclusions. `implement-design` (`build.toml:37-42`) already reads deep-modules, tdd-loop, mocking-and-fixtures, and vitest in full, and it is the build entry for **both** blueprint and relay (`vocabulary.ts:160-168`). On full, `start-plan` reads them; on short, `implement-direct` deliberately skips them. **The spec is never the only entry point for the testing lessons on any workflow** — the premise that made the union look necessary.

And the list is **identical for full and blueprint**. The depth ladder — *spec: design lessons deep, testing lessons as a lens* → *plan-or-build: testing lessons deep* — is one world, no knob-conditional. On full the architect's session is persistent frame→spec→plan, so `start-plan`'s re-read costs nearly nothing.

### `design-it-twice` in the target-shape section

The load-bearing distinction: **`design-it-twice` is a process; the spec is an artifact.** Its output format — *"present the designs one at a time, then compare them in prose"* — is a deliberation. Put three designs in the document and it doubles, `review-spec`'s altitude lens breaks, and relay's cold builder is handed a menu (`design-it-twice:12`: *"A menu is not a design."*).

So: **the architect explores three in its turn; the spec commits one and records the discards compactly.**

- **Three shapes, different in kind**, each following one constraint further than feels comfortable — the lesson's own axes: *minimal* (1–3 entry points, maximum leverage each) · *flexible* · *common case trivial* · *ports-and-adapters* (which routes to `deepening.md`'s dependency categories).
- **Independence, solo.** `design-it-twice:10` sanctions exactly this: *"alone, you get it by writing each design's constraint down first and holding the others out of view. Sequential authorship converges, and that convergence is the failure this pattern exists to prevent."*
- **Compare on depth, locality, and seam placement** — not taste.
- **What lands in the document:** the chosen structure / API / wiring, plus a short **"Shapes considered"** note — the constraint each alternative optimized and the one-line reason it lost, in that vocabulary. Two or three lines, never sections. (This spec's own *Shapes considered* is the worked example.)

Fires exactly when the target-shape section exists. No new gate: `write-spec` already scopes that section (*"a contained bug fix may need none; an SDK or structural refactor may earn all three"*).

Three payoffs:

1. `review-spec` gains a lens item it cannot have today — *was this shape chosen, or was it the first idea?* A rejected alternative is a checkable object; today the reviewer can only say "propose a better shape," the expensive form of the same question.
2. It satisfies `design-it-twice:22` — *"whoever will judge the designs should be reading this framing while the alternatives are being written"* — mapping onto the architect/analyst pair with nothing new built.
3. **Relay's cold builder is the real beneficiary.** It reads only the committed doc. Knowing *why not the other shape* is what stops it re-deriving one at slice three.

**Rejected:** fanning the three designs out to `architect` + `analyst` via `send_prompt`'s duty array. duet has the machinery and it would buy genuine independence — but the analyst would then review a document containing its own design, collapsing checker independence for the rest of the loop; and `docs/snippets.md:30` names re-opening divergence inside a converging round as a regression by construction. The frame phase already runs the divergent pass (`think-holistic` demands 2–3 genuinely different bets, anonymized, Delphi-shaped). **Frame diverges on the bet; spec diverges on the shape.** Different object, same discipline — and a *drafting* turn is not a converging round.

### The revised `review-spec`

Absorbs `review-design`'s three genuine additions — the **pre-mortem**, the **over-building** check, and *"does the design delete complexity or just rearrange it"* — plus the section-scoped altitude (product sections at product altitude, technical sections at design altitude), plus the new *were-alternatives-genuinely-explored* item. Keeps the "Optional polish" output contract unchanged.

### `start-plan`, touched minimally

Three overlaps become real once the spec carries the methodology:

- **Delete** the `design-it-twice` conditional (`doc-plan.toml:39`) — moved upstream, and it was firing after the interface was settled.
- **Demote** the reading list: *"you read these at spec; reread only what this plan's slicing depends on."* Same architect session on full.
- **Leave alone:** slicing, preparatory refactoring, right-sizing, "build on the right layer", tests.

`start-plan:42` already claims the plan is *"complementary to the spec, not overlapping it — spend the tokens on the tactics it deferred."* After this change that is true. The story the PR tells: **the spec decides the shape; the plan decides the tactics.**

---

## Test standards

Behaviours that must be tested, and the strategy for each. Fake only at the seams (`docs/engineering.md` §Seams); never mock our own modules.

| Behaviour | Through which interface | Notes |
|---|---|---|
| `doc('design', …)` is rejected with the valid artifacts named | `define.ts` SDK, direct call | The vocabulary is closed; the error names the two survivors. |
| A `plan` doc with no upstream doc fails at compile | `compileWorkflow` | New rule. The rejection text names the required shape. |
| A `spec` doc that is not the first doc fails at compile | `compileWorkflow` | Sibling of the above; one table, two rows. |
| `contract` on a `spec` doc compiles (blueprint's shape) | `compileWorkflow` | Inverts today's `define.ts:107` throw — the regression this change most invites. |
| Each shipped workflow's SDK rebuild compiles byte-identical to its registry row | existing equivalence pin | Already pinned; must be *deliberately moved*, not incidentally. |
| blueprint/relay's spec gate carries the hands-off-to-AFK clause; full's does not | `phaseSpec(wf,'spec').gate.hint`, token + absence | The shared *rule* is the lead clause (`define.ts:460`, `:485` — the tails legitimately differ per block). Assert the token in blueprint/relay/short, and `.not.toContain` it on full's spec — the absence flip is the stronger half. |
| A frozen `workflow.json` with `artifactKind:"design"` fails to load, naming the manual-resume path | `workflowFor`, real tmpdir | The deliberate break. Assert the message is actionable, not that it throws. |
| The spec brief renders one world per workflow — no "plan or build" hedge | parity pins | The pins are the enforcement; a red pin here means the deferral noun leaked. |
| Every `{{lessons_dir}}` path in the revised snippets resolves to a shipped file | `tests/snippets.test.ts` | Exists. Guards the reading-list rewrite for free. |
| `ACTION_CATALOG` has no orphan (`review-design*`) and no gap | `tests/snippets.test.ts` | Exists — catalog ↔ library pin. |
| Every fenced definition in `workflow-definitions.md` compiles | `tests/skill.test.ts` | Exists. `doc('design', …)` in that file (`:29`) breaks it in five seconds. |

**Strategy notes.** Compile-time rejections are behaviour through the SDK's public interface, tested by calling it — no module mocking, and `define.ts` has no boundaries to fake. Gate copy is asserted as **relations** (`hint(blueprint.spec) === hint(short.research)`, `render(full.spec).not.toContain('hands off')`) rather than exact bytes, per `test-quality.md`'s tokens-and-relations rule; exact bytes live in the parity harness, which is exactly the "one dedicated place" that lesson prescribes. The parity pins across the run-state matrix are the real safety net for the prompt surfaces: the bar is byte-identical, and this is a *feature* commit, so pins move deliberately.

**Where to look hardest:** the `contract`-on-a-`spec` inversion. Every other change removes a branch; that one adds a legal state that used to `throw`.

---

## What's decided later

Left to the plan: slice boundaries and sequencing, the order the parity pins are regenerated in, per-file edit anchors, the exact wording of every rewritten snippet body, doc-update scope, and commit order. This document owes the shape and the reading policy; the build owns the prose and the cases.

No time or effort estimates.

---

## Rabbit holes

Walked end to end, looking for what could quietly eat the build.

**The corpus break is real and is being accepted.** Removing `artifactKind: 'design'` makes `validateRegistry` (`vocabulary.ts:526`) reject every frozen `workflow.json` from the 2026-07-07 blueprint/relay series and the composed `deep-relay` run (`20260705-1731-58a5`). `readWorkflowFile` (`run/workflow.ts:33`) validates on read, so `duet grade`, `graph`, `stats --trace`, and replay all die on those runs — the freshest evidence base, and the one that produced the first instrumented triage-precision numbers. The owner accepted this (2026-07-08) in exchange for a clean vocabulary. **Mitigation, not a shim:** the load failure must name the era and point at the manual path, the way `store.ts` already rejects seat-keyed state. `docs/corpus-runbook.md` gets a line recording that pre-`2026-07-08` design-doc runs are unreplayable, so a future reader is not silently missing a cohort. *Solved here, cost recorded.*

**The `contract`-on-`spec` inversion is the one place a branch is added.** `define.ts:107` currently throws on `doc('spec', { contract: true })` because "contract is only declared for plan or design doc-loops." After this change that is blueprint's normal shape. The consultant's contract *seeding* then depends on whether a committed doc precedes the phase — early-and-blind (full's plan, seeded from the committed spec) versus late-and-converged (blueprint's spec). Two hand-written fragments, selected by `hasUpstreamDoc`; **not** one fragment with a conditional. *Solved here.*

**Full's contract loses a claimed blindness — and the claim was already false.** `automation-design.md` §"Consultant checkpoints" says full authors "blind to the technical approach as well as the code." A half-technical spec kills that. But today's `write-spec` already hands the contract author a directory tree, an API sketch, and integration wiring (`doc-spec.toml:38-55`), so the claim is *already* an overstatement. This change makes it honest rather than introducing a loss. **The doc must be corrected in this PR**; the remaining, real guarantees are named accurately: fresh independent session, blind to the *code*, author-never-commits, harness-frozen. *Solved: rewrite the claim.*

**The spec's examples world: fork or substitute?** `SPEC_EXAMPLES` and `DESIGN_EXAMPLES` differ in one clause — deferred detail belongs to "the plan" or "the build." A derived noun (`${deferredTo}`) collapses them, the same move `briefs.ts` already makes with `${maker}` / `${checker}` / `${fixerDutyFor}`; the rendered prompt still names exactly one downstream, so the single-world rule holds either way. Substitution wins on maintenance and lets `examplesKey` leave the doc-loop arm entirely. **Genuinely a judgment call** — `prompting-and-tool-design.md:64` prefers forking a fragment over parameterizing it, but that rule targets *hedged generality*, not a composer-computed noun. Recorded as a decision, not a discovery. The **build** examples do *not* collapse: full's plan carries a slice list and blueprint's spec does not, so "not slice count" versus "not a count you don't have" is a structural difference. Fork those; rename them off workflow names (`blueprint-impl`, `relay-impl`, `short-impl` violate `engineering.md`'s *"behavior conditioned on a workflow name instead of a knob is the drift to refuse"*).

**`implement-design` must be renamed, and its body is cold-safe by contract.** It becomes `implement-spec`. `vocabulary.ts:164-166` records why the body may not lean on session context: relay's fresh builder reads it cold. The rename touches `EntrySeed` and `ENTRY_SEED_SNIPPETS`; `fresh-seed` keeps its name (it is posture-named, not artifact-named).

**The new `write-spec` depends on an uncommitted `pnpm vendor-lessons`.** The working tree carries a re-vendored `lessons/` (all files mtime-identical, uncommitted) that HEAD does not. The difference is load-bearing: HEAD's `design-it-twice.md` opens *"use this parallel sub-agent pattern… spin up 3+ parallel sub-agents"* — a worker cannot do that, and it contradicts the solo, constraint-first discipline the new `write-spec` prescribes. The *"alone, you get it by writing each design's constraint down first"* sentence the snippet is built on **exists only in the working tree.** So **the lessons re-vendor must land in the same commit as this change**, or `write-spec` points the architect at a lesson telling it to spawn sub-agents it has no way to spawn. `tests/snippets.test.ts` layer 2 checks only that a cited path *resolves*, never its content, so the suite is green either way — this coupling is invisible to CI and must be carried by the commit boundary. *Named, not solved: it needs the human's `git add lessons/`.*

**Scoped out, named so it does not resurface as a surprise:** `test-quality.md` is vendored, 151 lines, and cited by **no snippet**. It arrived in that same uncommitted re-vendor and was never wired up — so this is a *never-connected new file*, not a long-rotted one. It belongs in `review-implementation` and the build snippets, not in the spec. A separate change; a line in `open-questions.md` so it is not lost.

**Not a hole, checked:** `machine.ts:148-150` derives every state from `p.gate.state`, so deleting `designGate` costs the statechart nothing. `phaseOfGateState` is workflow-scoped. `entry.specSkipsTo` is already "the first doc phase," artifact-blind, so `--spec` entry into blueprint keeps working — and now enters a phase actually named `spec`. `replay/phase-state.ts:103`'s hardcoded `phase !== 'spec' && phase !== 'design'` becomes a derivation off `entry.specSkipsTo`, deleting the name list rather than shortening it.

---

## Open questions

1. **Does `blueprint` keep its name?** `CONTEXT.md` says workflows are "named on the ceremony/artifact axes, never after a stage, phase, or artifact," so `blueprint` survives on the ceremony axis — but its glossary gloss ("one design doc") and `automation-design.md`'s prose need rewording to "one document." Mechanical; flagging so it is not missed.
2. **Does `--gates-at design` get a deprecation error or a bare unknown-gate error?** The gate vocabulary is workflow-scoped and validated; the generic "not a gate phase of this workflow" message already lists the valid gates. Recommend: no special case. A personal tool, one user, and the error already teaches.
3. **Should `write-spec`'s "Shapes considered" note be required, or offered?** Recommend offered-with-a-gate ("when the change proposes a target shape"), matching how the target-shape section itself is scoped. A required note on a contained bug fix is ceremony, and ceremony is what this change is deleting.

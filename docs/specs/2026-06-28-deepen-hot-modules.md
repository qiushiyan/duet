# Spec: deepen the five hottest modules (behavior-preserving structural refactor)

Status: approved at the Direction gate (2026-06-28). Builds on this run's frame
synthesis (three independent reads converged; nothing rejected as unsound) plus
the human's approval. This is a structural refactor — **no behavior a user
observes may change** — so the design questions it settles are about code shape,
not product. The two items flagged at the end are settled-by-default, non-blocking.

## Summary (read this if you read nothing else)

duet's architecture is sound — a one-way trust gradient (`statechart → tool
handlers → prompts`) — but the five files that change most every day have let
enforcement detail leak back onto the daily edit surface. The cost is paid on
every change: two files past 1000 lines, one hand-built tool-result envelope
replicated **58 times** in the deepest module, protocol **rails with no test
surface of their own** (reachable today only by driving a full tool call), a
1068-line CLI the docs still call "command wiring only," eight near-identical
persistence mutators each re-proving the same concurrency discipline, a status
renderer that would silently render nothing for a new case, and a dead
`gate:null` topology whose comments still describe it as live.

**What we're doing.** Precisely, this is **four module-deepenings + one dead-code
deletion**, not five deepenings: deepen the four hottest *implementation* modules
(`tools.ts`, `cli.ts`, `run-store.ts`, `status.ts`) so each load-bearing rule
becomes *named, individually testable, and impossible to get subtly wrong*, and
**delete** the dead `gate:null` topology in `phases.ts` (the coldest of the five —
in the set for the deletion, not for deepening). Concretely: collapse the 58
envelopes onto shared result builders and make a rail's type (`Refusal | null`,
never throws) carry the trust-gradient guarantee the compiler can then enforce;
extract the heavy tools' rails into named, ordered, unit-testable functions; restore
`cli.ts` to wiring by lifting its decisions into pure planners; concentrate the
persistence discipline in one helper; align the status renderer to its siblings'
exhaustive `switch`; and retire `gate:null`.

**Scope.** Five related-but-separable changes on one branch / one PR, each landing
as its own commit, the suite green at every commit. The unifying discipline is the
deep-module patterns in `docs/engineering.md`. The single highest-risk piece —
the deep rail restructure of the enforcement module — is sequenced **last** and is
the **designated descope** if the run runs long.

**The boundary once it lands.**
- **Fixed:** the daily edit surface of the five hot modules. One envelope builder,
  not 58 literals. Rails are named functions with their own unit tests (including
  the negative-space "must-never-happen" cases they encode). `cli.ts`'s decisions
  are pure and testable without spawning a process. The persistence
  fresh-load→mutate→save→sync discipline lives in one place. A new status
  `stop.kind` is a compile error, not a silent blank render. The dead topology is gone.
- **Not changing:** anything a user observes — every tool-result string and
  `isError` flag, every CLI message, the status text and its JSON schema, the
  statechart shape, the snippet protocol. The trust gradient and every
  `CLAUDE.md` invariant survive intact.
- **Deferred (one-line why each):**
  - *A `register()`/`defineTool` framework over all 9 tools* — modest gain, large
    blast radius across 7 rail-free tools; `kernelTool()` already is the registrar.
  - *Rails as a validated data registry / `validateRails()` / `duet rails`* — "rails
    as pure data" is aspirational (the predicate is always a function) and a CLI
    surface is scope creep; revisit only on a named trigger (below).
  - *Full `GatePhase → PhaseName` name-collapse (8 files)* — zero behavior change for
    a 48-site churn; a one-line alias captures it.
  - *`orchestrator-prompts.ts`* (the next-most-churned file) — it is the *steerable*
    tier, not structural; out of scope by design.

## The non-negotiable invariants (preserved by every change below)

1. **Behavior-preserving.** No user-observable output differs. The 727-test Vitest
   suite (corrected up from the brief's "663+") stays green at every commit, and
   is the master oracle for "no regression."
2. **The trust gradient holds.** `statechart (when) → tool handlers (what's
   allowed) → prompts (judgment)`. Judgment never moves down into code; a guarantee
   never moves up into a prompt. Rails **refuse with steering text + `isError`** —
   they do **not** throw (throwing stays reserved for CLI-facing `lifecycle.ts`),
   and every rail keeps both halves: the structural refusal **and** the text that
   names the legal next move (`docs/prompting-and-tool-design.md`, conventions 4–5).
3. **Host-clean.** The rails serve the headless driver, the stdio host, and the
   interactive run-scoped server identically. The `send_prompt` host-switch
   (blocking vs. dispatch-and-collect) stays **one registry**, proven by the
   existing real-`_mcp`-subprocess parity test — which must stay green. The
   interactive host (the most-frequent real usage) stays byte-for-byte equivalent.
4. **Additive-only status schema.** `status.ts` model field names are a shipped
   contract (the concierge skill, pinned by `tests/skill.test.ts`). The renderer
   may change; the model may not.
5. **Registry idioms don't drift.** No `Record<PhaseName, …>` outside `phases.ts`;
   no *routing/asymmetry* `role === '…'` check outside `roles.ts` (the role-policy
   home). The one **blessed exception** is the evidence-author check in `settleTurn`
   (`role === 'consultant'`, recording acceptance-contract authorship/verification):
   it is role *identity at a checkpoint*, not a routing asymmetry, and stays inline
   (see `#1-deep`). This matches `CLAUDE.md`'s "smell + one known exception" framing,
   not an absolute ban.
6. **Docs lead, code follows.** Where a change makes an `engineering.md` claim true
   again (`cli.ts` "command wiring only") or a `phases.ts` comment stale
   (`gate:null`), the doc/comment is corrected in the same change.

## Current vs. desired (what's preserved, what changes)

The *behavior* column is identical on both sides — that is the point. What changes
is the shape behind it.

```
                  preserved (behavior)              changing (shape)
─────────────────────────────────────────────────────────────────────────────
tools.ts    every tool-result text & isError   58 inline envelopes → ok()/refuse()
            every rail's refusal & recovery    rails inline in a 150-line closure
                                                  → named (input,ctx)→Refusal|null
            host parity (blocking vs async)    two host-divergent rail branches
                                                  → one inFlight()/orphanedOnDisk()
cli.ts      every CLI message & exit           ~170-line `continue` action mixing
            crash/gate/interactive recovery      parse+plan+recover+spawn
                                                  → pure continuePlanner + resolveRun
run-store   crash-state & concurrency safety   8 mutators re-proving fresh-load
                                                  discipline → one mutate() helper
status.ts   every status line & --json field  renderStatus if-chain of early
                                                  returns → exhaustive switch;
                                                  3 posture sentences → 1 formatter
phases.ts   both arcs gate every phase         gate:null topology (dead) → removed;
            (no live gate-less phase exists)     GatePhase ≡ PhaseName as a fact
```

## The coupling decision: extend existing patterns, never invent new ones

Every change is an **extension of a concept the codebase already has**, deliberately
*not* an independent new abstraction:

- The rail work extends the existing **"rails as tool results"** pattern
  (`engineering.md`) — naming what is already there, not a new rail framework.
- `continuePlanner`/`resolveRun` generalize the **`takeoverPlan`** pure-planner
  pattern that already lives in `cli.ts`.
- `mutate(state, fn)` extracts the **fresh-load→mutate→save→sync** discipline that
  is already re-described in four doc-comments across the eight mutators.
- The host oracle **collapses an existing host-divergence** into one boolean; it
  adds no new seam.

This is the coupling decision stated once: we lower the cost of the rules duet
*already* enforces, in the *idioms it already uses*. We reject every "design it as
a new system" alternative — `defineTool`, a `RailGroup` data registry, a richer
`RailHost` interface — as the wrong fit for a codebase built on locality.

## The foundation decision: where preparatory refactoring earns its place

Only **one** of the five reshapes a foundation; the rest are changes the current
structure absorbs cleanly. Naming this is the point of the spec — it sizes the work.

- **`#1-deep` is the one genuine preparatory refactoring.** The enforcement rails
  are *structurally* untestable: today a rail is reachable only by standing up a
  full run with fake workers and driving `createPhaseTools(...).tools.find(name)
  .handler(args)`; `send_prompt`'s handler is ~150 lines because four rails, the
  host-switch, and per-role bookkeeping are interleaved in one closure. That
  structure blocks the stated goal (rails individually testable). So we **reshape
  the foundation first** — extract the rails into named functions — which is also
  what *first gives those rails a unit surface*. It is bounded: the **rail-bearing
  handlers only** (`send_prompt` plus the two terminal tools, which share one
  terminal rail group), `kernelTool()` kept, the host kept as one registry. Left alone: the
  seven simple tools (they learn only `ok`/`refuse`), the SDK and stdio adapters,
  and the `withSteerDelivery`/`withPostTerminalRail` wrappers that already compose
  cleanly.
- **`#2` generalizes an in-file seam, not a foundation.** The `continue` action is
  in the way of testability, but the fix already exists in the same file
  (`takeoverPlan`); we extend a proven local pattern.
- **`#1-floor`, `#3`, `#4` are local changes** the structure absorbs — an
  extraction (`ok`/`refuse`), a dedup (`mutate`), an idiom alignment (exhaustive
  `switch`).
- **`#5` is deletion**, not reshaping — the opening move, because it lands the clean
  `gate`-non-nullable types the others compile against.

## The changes, by flow

### #5 — retire the dead `gate:null` topology

*Anchors: `src/phases.ts`; one arm in `src/harness/tools.ts`.*

**Decision.** No phase in either arc declares `gate:null` — the gate-less `open`
phase the comments describe **does not exist in the registry**. Make the deadness a
compile-time fact: the gate field stops being nullable, which auto-derives
`GatePhase ≡ PhaseName`. With that, the runtime branches that exist only to handle
the impossible null case go away:
- `isGatePhase` and its sole caller — the unreachable gate-less arm of
  `advance_phase` (its own comment already admits it is "a total-function guard,
  not a live path").
- `gateOf`'s throw-guard (the gate is now non-null by construction).
- the always-true `gate !== null` filter predicates.
- the **production-unused** `consultantCheckpointOf` — no `src/` caller reads it
  (callers use `PHASE[phase].consultantCheckpoint` directly); it is asserted only by
  `tests/phases.test.ts`, so removing it repoints those test assertions.

The stale comments and always-true branches that describe or handle the gate-less
case are corrected, and they span **more than `phases.ts`**: `phases.ts` (the stale
comments referencing a nonexistent open-ended phase, plus the gate derivations),
`status.ts` (a `gate !== null` round-filter predicate and its comment), and
`machine.ts` (the gate-optional advance-target fallback `p.gate?.state ?? …` and the
`if (p.gate)` gate-state guard, which both become unconditional). **Type-shape
decision:** keep `GatePhase` as a one-line alias of `PhaseName` rather than
collapsing the name across 48 sites — the alias preserves the readable intent
(`gatesAt: GatePhase[]`) for zero behavior change. **Correction to the framing:**
`engineering.md` carries no `gate:null` reference, so the cleanup is code + in-module
comments, not the read-first design docs.

**Boundary.** The statechart *states* are untouched — every phase still gets its
loop, gate, and flag-wait; we collapse the gate-*optional* branches in the machine
builder (a fallback the registry never exercises), not any machine state.

### #1 — `tools.ts`: the floor, then the bounded deep restructure

This is two changes with a gate between them. The floor is mandatory and lands
early; the deep restructure is the designated descope slice and lands last.

#### #1-floor — `ok`/`refuse` builders; the rail return type

*Anchor: `src/harness/tools.ts`.*

**Decision.** Introduce a small set of result builders and route every hand-built
result through them. A single **text-block constructor** replaces the
`{ type: 'text' as const, text }` literal (40 sites); the wrappers take **one or
more** blocks, because the success path is *intentionally multi-block* in places and
must stay byte-for-byte:
- `result(blocks, { isError? })` → the low-level builder (a block list + the flag),
  used directly where `isError` is *conditional* — `combineFanoutResults` sets it
  only when a role in the fan-out errored.
- `ok(...blocks)` → success wrapper over `result`, accepting multiple blocks —
  `renderTurnResult` composes the worker text + optional checkpoint/interrupt/
  near-cap notes + the footer, and `check_turns` assembles an arbitrary list. Each
  keeps assembling its blocks (now via the shared constructor) and wraps once.
- `error(...blocks)` → a non-rail `isError` wrapper for **tool/worker failures that
  are not protocol refusals**: `renderTurnResult`'s infra-failure and budget-control
  envelopes. Kept distinct from `refuse` so "the worker turn failed / hit its budget"
  never reads as "a rail refused your action."
- `refuse(...text)` → the **rail-refusal** wrapper: an `isError` result whose
  parameter is typed so that **a text-less refusal is a compile error** (the
  trust-gradient half "steering in text" becomes structural — a refusal *cannot* be
  built without the text that names the next move). Reserved for rails (including
  `create_branch`'s single branch-fixed guard).

This collapses the 58 literal sites (40 `type:'text' as const`, 18 `isError:true`)
to one place *without forcing single-block success*, and keeps the two kinds of
`isError` apart — a **rail refusal** (`refuse`: the protocol declining an
orchestrator action) vs. a **tool/worker error** (`error`/`result`: a turn or
fan-out that failed) — even though both set the flag. In the same move a **rail's
type becomes `Refusal | null`** and a rail **never throws** — so "guarantee in
structure, steering in text" stops being a convention each author re-honors and
becomes the type the compiler checks. The handlers without a rail composition
(`get_task`, `list_snippets`, `create_branch`, `propose_snippet_edit`,
`write_note`, `check_turns`) route results through the builders only —
`create_branch`'s single branch-fixed guard, for instance, becomes a plain
`refuse(...)`, not a named rail.

**Boundary.** This is a mechanical, behavior-identical substitution — every
produced string and `isError` flag is byte-for-byte what it is today. It does *not*
yet extract the rails (they stay inline, now returning `Refusal | null`).

#### #1-deep — named, ordered, unit-testable rails + one host oracle

*Anchors: `src/harness/tools.ts` (`send_prompt`, `advance_phase`), reading
`src/harness/turn-dispatcher.ts` / `src/harness/mcp-server.ts` for host state.*

**Decision.** Extract the rail-bearing handlers' rails into **named functions**, each
`(input, ctx) => Refusal | null`, composed by an explicit, ordered
`firstRefusal(input, ctx, ...rails)` that returns the first non-null refusal (or
`null` to proceed). One subtlety the current code makes load-bearing: the two
**terminal tools share a terminal rail group**, so it is defined **once** and both
compose it — never two implementations of the single phase-exit invariant:
- **Shared terminal rail group** — terminal-already-set, then the pending-turn
  phase-exit gate. Composed by **both** `ask_human` and `advance_phase` (today each
  calls `terminalAlreadySet()` and `pendingTurnGate(...)` inline before recording
  its marker).
- `advance_phase`: the shared terminal group, then its own rails —
  review-loop-needs-a-round, and the acceptance-contract author and verify
  checkpoint rails.
- `ask_human`: its **staged-answer fast path stays first** — the harness delivering
  a previously-staged human answer must not be gated by a terminal marker (it *is*
  the answer to the flag that set one) — *then* the shared terminal group, then it
  queues a new question.
- `send_prompt`: the empty-array guard, then per-role — same-role-in-flight,
  reconnect-orphan (refuse-vs-reseed by the role's orphan policy), review-round
  backstop cap, warn-once template economy.

The rail **order is load-bearing and made explicit at the one composition site**:
same-role-in-flight must precede the orphan rail, because a live running turn also
has a disk pending record, so checking orphan first would misclassify it. This
invariant is pinned by a characterization test (see Testing), **not** a load-time
validator — see OQ1.

The **host divergence** (blocking host reads the in-memory `turnsInFlight` set;
async host reads the dispatcher's live status / on-disk pending record) collapses
into **two boolean oracles built once** at `createPhaseTools`: `inFlight(role)` and
`orphanedOnDisk(role)`. The rails read the oracles; they no longer re-branch on
host. The host-switch on `send_prompt` (blocking vs. dispatch-and-collect) **stays
one registry** — the oracle is the only thing that varies.

**Boundary / left alone:** `kernelTool()` stays (we reject a new `register()`
form). The lone `role === 'consultant'` at `tools.ts:341` stays inline — it is the
blessed exception named in invariant 5 (role identity at a contract checkpoint, not
a routing asymmetry), and reads worse relocated to `roles.ts`. The in-memory vs. on-disk rail *state*
(`rails.turnsInFlight`/`resendWarned`, the dispatcher) is unchanged; the oracle
only *reads* it. **Acceptance is gated** on new rail-interface tests (the
negative-space cases these rails encode, now unit-reachable for the first time)
plus the real-`_mcp` parity test staying green.

### #2 — `cli.ts`: restore command-wiring by extracting planners

*Anchors: `src/cli.ts` (`continue`, the 10× run-resolution sites), generalizing
the existing `takeoverPlan`.*

**Decision.** Lift the decisions out of the `continue` action (~170 lines, ~10
distinct exits mixing arg-parse, abandoned-run revival, live-driver detection, the
interactive crossing path, crash recovery, pre-authorized-gate recovery, and the
normal gate decision) into a **pure `continuePlanner`** that returns a
**discriminated `ContinueAction`** (e.g. interactive-cross / interactive-handoff /
interactive-drop-headless / crash-recover / preauth-recover / gate-decision /
show-status). The action becomes wiring: gather inputs, call the planner, execute
the returned action. Add **`resolveRun(cwd, runId)`** for the 10× `runId ?
loadRunState : latestRun` + fail-if-missing boilerplate. This makes the
`engineering.md:51` "command wiring only" claim true again.

**Boundary.** Side-effecting I/O (editor/stdin staging, `spawnDrive`,
`freezeContractAt`, the git/process probes) stays in the thin executor; only the
*decision* moves behind the pure seam. Every CLI message and exit is unchanged.

### #3 — `run-store.ts`: one mutation helper (+ optional steer-store split)

*Anchor: `src/run-store.ts`.*

**Decision.** Concentrate the fresh-load→mutate→save→sync discipline (re-described
in four doc-comments across eight mutators) in one `mutate(state, fn)` helper that
applies `fn` to a freshly-loaded copy and mirrors the same mutation into the passed
copy. The eight mutators (six role-keyed: `markTurnActive`, `clearTurnActive`,
`recordTurnSessionId`, `markPendingTurn`, `settlePendingTurn`, `clearPendingTurn`;
two field/flag: `markWorkerDispatched`, `setGatesAt`) become thin callers — the
role-keying lives **in the callback**, so one helper covers all eight, and it is
**signature-preserving** (no caller in `tools.ts`/`turn-dispatcher.ts` changes).

**The helper must honor two behaviors several mutators rely on today**, or it would
be "as specified" yet subtly wrong:
- **Deletion-safe, surgical sync.** Some mutators *delete* a key (`clearTurnActive`,
  `clearPendingTurn`) and mirror that delete into the passed copy; the sync must
  reflect a delete, not just copy present keys (a blanket `Object.assign(state,
  fresh)` would leave a deleted key behind). It must also touch only the field `fn`
  changed, never overwrite the rest of the in-memory copy.
- **Save only when the mutation changed state.** Several mutators *skip* the disk
  write when the target entry is absent (`recordTurnSessionId`, `settlePendingTurn`,
  the clears) or already set (`markWorkerDispatched`); the helper preserves
  "no-op ⇒ no save," it does not unconditionally write.

**Steer-store split (the designated descope line for #3).** The steer store
(`stageSteer`/`listPendingSteers`/`markSteersDelivered` + the `Steer` shape) is a
cohesive cluster with a *different* crash contract from `state.json` (append-once,
deliver-by-rename) that needs only `runDirOf`/`appendVoiceLog`; `engineering.md`
already treats it as distinct. Lifting it to `steer-store.ts`, byte-for-byte,
clarifies the boundary between three reliability contracts (atomic crash-state,
best-effort sidecars, append-once steers). It is **recommended but the first thing
cut** if the run needs trimming — it is the lowest-leverage move and adds a file.

**Boundary.** The atomic `state.json`/`machine.json` writes and the best-effort
sidecars (`context/*`, phase label, voice logs) are deliberately *not* unified —
their reliability contracts differ on purpose.

### #4 — `status.ts`: one exhaustive dispatch + one posture formatter

*Anchor: `src/status.ts` (`renderStatus`), plus the posture sentence in `cli.ts`.*

**Decision.** Convert `renderStatus`'s ~150-line if-chain of early returns over
`stop.kind` to the **exhaustive `switch`** every sibling already uses (`stopModel`,
`displayState`, `briefHeadline`, `briefNextCommand`, `steerRefusal`). The behavior
gained is compile-time exhaustiveness: a future `stop.kind` becomes a type error
instead of a silent blank render — and this is the file the shipped concierge skill
reads. Extract **`formatGatePosture`** as the single source for the gate-posture
sentence built three times (`cli new`, `cli afk`, `status`). The three are **not**
byte-identical (the parenthetical differs per surface), so the helper takes the
shared computation and **per-surface copy** — never a blind merge that would change
a string.

**Boundary.** Renderer only. `StatusModel`/`buildStatusModel` and therefore the
additive-only JSON schema are untouched.

## Open design questions — settled

1. **Rail data/behavior line → named rail *functions* + explicit commented order +
   a characterization test.** No `validateRails()`/`after`-metadata this run. The
   project's master constraint is already "suite green at every commit," so the
   ordering test runs on every commit anyway — collapsing the load-time validator's
   only edge ("can't ship broken") — and a misordered rail is a recovery-text
   *quality* bug (it would mis-steer toward `duet takeover`), not a gate-integrity
   breach, so it does not warrant the structural-guarantee tier. **Named trigger to
   revisit:** a third ordering dependency, or rails spreading beyond one tool.
2. **`register()` invasiveness → keep `kernelTool()`.** The duplication is in
   results/rails, not the registration call shape; a new form touches all nine tool
   declarations (seven rail-free) for modest gain.
3. **Host oracle → boolean `inFlight`/`orphanedOnDisk`.** The divergence is exactly
   one boolean each; a richer `RailHost` interface is a premature seam.
4. **Scope/staging → the full staged sequence**, not the tighter descope. The defer
   argument (hold `#1-deep` and `#3`'s split until the `tools.ts` surface settles,
   because its churn is feature-velocity and the rail reorder is where green tests
   prove least) was **resolved on the code, not averaged**: the named incoming
   features (codex-as-orchestrator, worker-output schema, run-level budget) cut at
   the *transport*, *result-shaping*, and *budget-resolver* layers — **orthogonal**
   to the rail-composition seam `#1-deep` creates (a future worker-schema rail would
   in fact land cleanly into the named `firstRefusal` list, paying back), so "pay
   twice" does not hold. The risk-ranking is adopted as *discipline*, not deferral:
   `#1-deep` is sequenced last, truncatable, the designated descope, and
   acceptance-gated on the new negative-space tests it is precisely what enables.
   Decisive reason against default-defer: the floor alone leaves the headline goal
   (rails individually testable) half-unsolved, and a later run buys it no cheaper.

## Landing order (design decision; the per-commit sequence is the plan's job)

Bank the safe, high-confidence wins before the one risky slice, suite green at every
commit:

```
#5  retire gate:null            → clean gate-non-nullable types the rest compile on
#1-floor  ok/refuse + Refusal|null   → biggest single legibility win; gradient-as-type
#2  resolveRun + continuePlanner → high-confidence, independent; restores the doc claim
#4  exhaustive switch + posture  → local, low-risk, renderer-only
#3  mutate() helper              → signature-preserving (steer-store split = #3's descope)
#1-deep  named rails + oracle    → LAST: highest-mechanism-risk, truncatable, descope line
```

`#1-deep` last + per-commit reverts + the descope rule is the mitigation for one-PR
packaging weakening "independently revertable." The full Vitest suite runs at least
after `#5`, `#1-floor`, `#3`, `#1-deep`, and final.

## Testing (behaviors that matter; cases, fixtures, mocking are the plan's job)

- **Behavior preservation is the master oracle — and for `#1-deep` the *existing*
  tests are the preservation proof.** Every existing tool-result string and
  `isError`, every CLI message, every status line and `--json` field is unchanged;
  the 727-test suite must stay green throughout. Be explicit about which tests prove
  what across the rail extraction: the rails being extracted are characterized today
  only through the **full-handler** tests (`send_prompt`/`ask_human`/`advance_phase`
  driven end-to-end), so *those* tests staying green across the extraction are what
  proves it preserved behavior. The new rail-unit tests below are **additive** —
  they characterize the *post*-refactor named-rail interface and add negative-space
  coverage, so they could pass even on a subtly behavior-changing extraction; they
  are not themselves the no-regression oracle.
- **The new rail-interface surface (`#1-deep`'s acceptance gate).** Each named rail
  is exercised in isolation for the "must-never-happen" case it encodes:
  same-role-in-flight refuses; a reconnect orphan refuses-vs-reseeds by the role's
  policy; the cap refuses at the cap; warn-once refuses then allows the deliberate
  identical retry; the contract/verify checkpoint rails refuse a silent skip. The
  **shared terminal rail group** (second-terminal-call, pending-turn phase-exit) is
  proven through **both** `ask_human` and `advance_phase`, so the one invariant is
  tested on both terminal tools. **The ordering invariant gets its own test:** a
  running turn that also has a disk pending record refuses as *in-flight*, not as an
  *orphan*.
- **Host parity is structural, not faked.** The real-`_mcp`-subprocess parity test
  stays green across `#1-deep` — it is the faithful oracle for host-clean.
- **`#2`:** `continuePlanner` returns the correct `ContinueAction` for each
  position/event combination *without spawning a process* — the testability the
  extraction exists to buy.
- **`#3`:** `mutate` preserves the concurrency property — a concurrent cross-role
  write does not clobber the sibling role's entry.
- **`#4`:** exhaustiveness is enforced at compile time; the rendered output for each
  `stop.kind` and the gate-posture sentence per surface are unchanged.
- **`#5`:** the tree compiles with the gate field non-nullable; no behavior path is
  reachable that the deleted arms served.

## Out of scope (with the one-line why)

- **A `register()`/`defineTool` framework over all tools** — modest gain, large
  blast radius; `kernelTool()` already is the host-neutral registrar.
- **Rails as a validated data registry, `validateRails()`/`after`-metadata, a `duet
  rails` CLI** — aspirational and scope creep for a refactor; deferred to a named
  trigger.
- **A richer `RailHost` interface** — premature; one boolean per host suffices.
- **Full `GatePhase → PhaseName` name-collapse** — zero behavior change for a 48-site
  churn; the alias captures the intent.
- **Folding `role === 'consultant'` into `roles.ts`** — it reads worse there; it is
  consultant-identity at a checkpoint, not a routing asymmetry.
- **`orchestrator-prompts.ts` and any prompt/protocol tuning** — the steerable tier,
  a different problem this structural refactor neither blocks nor advances.
- **`driver.ts`** — high lines-changed churn (it ties/beats `status.ts` by commit
  count), yet not a target: it carries no replicated pattern of the kind the five
  have. Its shape is dictated by the Agent SDK seam and the shared `host-runner.ts`
  run loop it plugs into (host-clean), and the rail substance it *hosts* lives in
  `tools.ts` (#1). Its churn is feature-velocity at the transport boundary, not
  legibility-friction.
- **Any user-observable change** — by definition; this run is behavior-preserving.

## Settled at the spec gate (recorded for provenance)

Both were flagged at the Direction gate as defaulted/non-blocking and are now
**ratified by the spec-gate approval**:

1. **`gate:null` — retire.** All reads confirmed it genuinely dead; the approved
   spec retires it (`#5`). (Had the human wanted it kept as documented intent, `#5`
   would have degraded to a doc-note — moot now.)
2. **Binding constraint — proceed.** This run lifts *code-change-velocity*,
   orthogonal to the `open-questions.md` prompt/protocol roadmap. The bet-audit's
   opportunity-cost concern — trading this work against the "unproven"
   finish/publish/acceptance/`duet stats` tails — is **resolved**: that premise was
   stale docs. Those tails are live-verified, so there is no unproven last mile to
   trade against. Proceeding as approved.

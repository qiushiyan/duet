# Spec: the consultant — an optional second reviewer

Status: approved at the Direction gate (2026-06-22). Builds on the reconciled
direction from this run's framing/synthesis. Product questions are settled by
that direction plus the human's approval rider; the open questions at the end are
flagged for dogfooding / snippet-authoring, not for this spec to resolve.

## Summary (read this if you read nothing else)

We are adding a second, **optional** reviewer — the **consultant** — that gives a
run a fresh-eyes outsider alongside today's embedded reviewer. The embedded
reviewer is a persistent session that accumulates the whole run's context, which
is exactly what makes it excellent at "is this *well-built*" and blind to "are we
building the *right thing on sound assumptions*." The consultant supplies that
missing altitude: a deliberately low-context, cross-family voice that questions
the **bet**, not the build. A different model family is the one thing a single
reviewer working harder can never provide — so the consultant's binding is fully
configurable (`--consultant <provider[:model]>` / `[roles.consultant]`), and that
configurability is the point, not a default we hardcode.

**Approach.** The consultant is **one named role** in the existing role model — not
a `reviewers[]` array, not a new tool, not a new workflow arc. It fires at
**gate-adjacent checkpoints**, encoded as registry data (`consultant.frame`,
`consultant.specGate`, `consultant.implGate`): a third independent analysis at framing,
and a bet-audit just before the Commit-spec and Ship gates (three checkpoints in the
Full arc; two in the lighter RIR arc, which has no spec phase). It runs through the **existing
`send_prompt` worker seam** with a small **role-policy table** that makes its three
asymmetries data, not scattered conditionals: its session is **ephemeral** (a fresh
seeded session per checkpoint — a persistent session would let it decay into a
second embedded reviewer), it is **read-only**, and it **never counts a review
round**. Its findings surface raw in the gate packet, graded `low`/`high` by the
consultant; the human is the sole router.

**What's fixed when this lands.** A run can be given an independent cross-family
reviewer that contributes at framing, spec, and impl, on **both** orchestration
hosts (headless and interactive). A genuine bet-failure or product mismatch it
grades `high` cannot be crossed by a non-explicit authority — neither the headless
auto-cross under pre-authorization nor the one-tap `duet afk` handoff — so the
consultant is load-bearing under AFK.

**What's explicitly not in scope.**
- **No general N-reviewer abstraction.** Named roles, not an array — the codebase is
  built around named voices (logs, health, sessions), and an array buys generality
  we have no second use for.
- **No new workflow arc and no new tool.** The consultant is registry data inside
  the existing arcs and a role value on the existing `send_prompt` — a `consult`
  tool would fork the orchestration contract for nothing.
- **No change to the embedded reviewer.** Its behavior, snippets, and loop are
  untouched; any reduction in embedded rounds is emergent, never a hardcoded swap.
- **Default-off, byte-for-byte.** With no consultant bound, every surface behaves
  exactly as today; "on" is the human's personal config plus a per-run flag.
- **Cost is accepted, not optimized.** Enabled, the consultant adds **one
  opus-class pass per checkpoint** — three in the Full arc (a *full third analysis* at
  framing, since framing becomes three voices, not a one-shot finding; plus a one-shot
  bet audit at spec and at impl), two in RIR (framing + impl). All opt-in; zero when
  off. We are not building per-role budgets or cost-throttling for it.

## Why (the problem, briefly)

The embedded reviewer (`reviewer`, codex by default) is resumed turn after turn and
accumulates the run's full context. That accumulation is its strength for
construction review and its blind spot for the frame: by spec time it is *inside*
the problem and reviews at line altitude. We want **uncorrelated coverage at an
altitude a single reviewer can no longer reach** — the assumptions a design rests
on, which are likely to break, whether the change serves the product. The two
independent value sources are **model-family diversity** (always present) and
**low-context-while-others-are-deep** (present only once others have gone deep).

## The role: identity and the coupling decision

**One role, redefined core: the run's independent cross-family voice.** "Low-context
outsider that questions the bet" is its *spec/impl specialization*, not its essence.
This matters because the framing checkpoint has model-diversity but no low-context
edge (everyone is fresh) — and the role stays coherent only if its invariant is
**independent, ephemeral, out of the iterative loop, human-routed**, contributing at
each checkpoint's altitude. The posture differs by checkpoint:

- **Framing (`consultant.frame`) — generative.** A third independent analysis from a
  different model family, synthesized alongside the implementer's and reviewer's. Its
  output is a *synthesis input* to the direction, like the reviewer's framing
  analysis — not a gate-holding finding.
- **Spec / impl (`consultant.specGate`, `consultant.implGate`) — critical.** A fresh
  low-context bet audit: enumerate the assumptions the design rests on, ask which are
  unverified or likely to change, and whether the change serves the product. It wears
  a CEO/user hat (product questions for the human, as options, never verdicts, never
  implementer-queue defects) and a CTO hat (assumptions, then which break),
  self-selected by the nature of the change — often both. A documented tradeoff is
  by-design, not a finding. Output is critical findings, severity-graded.

**Coupling decision — extension of the role model, intentionally independent in
context.** The consultant is modeled *with* the existing worker roles (same
`WorkerProvider` seam, same `send_prompt`, same dispatcher, same status/health
surfaces) so the orchestration contract stays one shape. But its **context posture
is deliberately the opposite** of the embedded reviewer's: ephemeral where the
reviewer is persistent. That single inversion is the whole feature — independence is
the product — so it is expressed as a role *policy*, not a special case bolted onto
the loop. The reviewer loop is not touched.

## Current vs. desired

**Preserved.** The two existing worker roles and their semantics; `send_prompt` as
the only worker verb; the persistent embedded reviewer loop; role↔provider
decoupling; standard provider transcripts and manual takeover; gate authority as a
structural property of the statechart; every default-off, byte-for-byte guarantee.

**Changing.** Roles become a **required base plus an optional consultant**; a handful
of role-keyed surfaces that today enumerate a static `implementer/reviewer` pair
learn to enumerate the run's *bound* worker roles; the gate packet's `high`
human-decision signal gains the power to hold a *non-explicit* gate crossing.

The shape of the change (✚ = new/optional, ~ = touched, • = unchanged):

```
roles
  base { orchestrator, implementer, reviewer }      • required, persisted unchanged
  ✚ consultant?                                      optional binding — absent ⇒ today exactly

WorkerRole (providers/types.ts)                     ~ widens to include 'consultant'
  worker provider factory (providers/index.ts)      ~ builds consultant only when bound
  ✚ role-policy table                                session/readOnly/countsReviewRound/orphan
  ✚ shared helpers                                   sessionIdFor · readOnlyFor ·
                                                       countsReviewRound · workerRolesFor(state)

send_prompt (harness/tools.ts)                      ~ role enum/description list consultant
  blocking path                                      ~ resume via sessionIdFor (ephemeral⇒fresh)
  TurnDispatcher (harness/turn-dispatcher.ts)        ~ resume via sessionIdFor; orphan policy
  reviewer loop, rails, accounting                   • unchanged in shape (role-keyed already)

workflow registry (src/phases.ts)                   ✚ consultant checkpoint modes per arc
  reviewer/implementer briefs                        • never mention the consultant

gate crossings (harness/lifecycle.ts)
  driveToQuiescence auto-cross                        ~ withhold on a 'high' decision
  enterAfk handoff                                    ~ refuse from a 'high'-carrying gate
  crossInteractive (explicit --approve)              • never rejected

status / doctor / sessions / takeover / logs        ~ enumerate workerRolesFor(state)
```

## The mechanism, by flow

### 1. Configuration and the role binding (`src/config.ts`, `src/cli.ts`)

The consultant is a **required-base-plus-optional** binding: the config keeps its
required `{orchestrator, implementer, reviewer}` and gains an optional
`consultant?: RoleBinding`. Absent ⇒ a run's persisted `bindings` is byte-for-byte
today's, so default behavior is unchanged at the byte level (this is *stricter* than
growing the closed `Record<Role, RoleBinding>`, which would change every persisted
state file).

The binding is **fully configurable, and that is load-bearing.** `[roles.consultant]`
and `--consultant <provider[:model]>` pass the `provider` and optional `:model`
through verbatim, exactly as `--reviewer` does. When the consultant is enabled with
no model named, it defaults to `claude-opus-4-8` (via `DEFAULT_CLAUDE_MODEL`). We
never encode "opus is better at X" — the cross-family binding is config, swappable.

Default posture, three layers:
- **Shipped default: off.** No `[roles.consultant]`, no `--consultant` ⇒ absent ⇒
  today's two-voice run.
- **On-by-default for the human:** a personal `[roles.consultant]` in
  `~/.config/duet/config.toml` enables it for every one of their runs.
- **Per-run override:** `--consultant <provider[:model]>` enables/changes it for one
  run; `--no-consultant` disables it for one run even when the config binds it.

The config parse/merge that today loops the fixed role tuple learns the optional
consultant (present-only), and the same `RoleOverride`/`RoleBinding` split that keeps
a model-only override from clobbering a configured transport applies unchanged.
`--no-consultant` is a new flag and `--consultant` a new verb-adjacent option, so
both must appear on the command table that `tests/skill.test.ts` pins.

**Provider/model are free; the interactive Claude transport is not.** Because the
consultant is read-only by policy and `InteractiveClaudeWorker` throws on a read-only
turn, `[roles.consultant].transport = "interactive"` must be rejected exactly as it is
for the reviewer today (`config.ts` already refuses `interactive` for any non-implementer
role — the consultant joins that side of the guard, never the implementer's). The
configurability that is load-bearing is *provider and model*, not transport: the
consultant uses only a transport that can honor read-only (headless Claude, or codex),
and a write-capable interactive transport stays implementer-only.

### 2. The role-policy table and four shared helpers

The consultant's three asymmetries are expressed once, as **data**, and read by both
hosts through shared helpers — never as scattered `role === 'consultant'` checks
(today's `readOnly = role === 'reviewer'` and the `review`-tag round-count are the
two checks this table absorbs):

| role | session | readOnly | countsReviewRound | orphan |
|---|---|---|---|---|
| implementer | persistent | no | no | takeover |
| reviewer | persistent | yes | yes (on a `review*` tag) | takeover |
| consultant | **ephemeral** | yes | **no** | **discard-and-reseed** |

The four helpers, consumed identically by `src/harness/tools.ts` (the blocking
`send_prompt`) and `src/harness/turn-dispatcher.ts` (the async path):

- **`sessionIdFor(state, role)`** — the resume session, or **`undefined` for an
  ephemeral role**. This is the whole of "fresh session per checkpoint": the two
  resume sites (`tools.ts` blocking turn and the dispatcher's background launch) read
  this instead of `state.workerSessions[role]` directly.
- **`readOnlyFor(role)`** — true for consultant and reviewer.
- **`countsReviewRound(role, tag)`** — true only for the reviewer on a `review*` tag,
  so a consultant turn **never** consumes a phase's review-round backstop and
  `advance_phase`'s "needs a review round" rule continues to require an *embedded*
  reviewer round. The consultant is additive, never substitutive.
- **`workerRolesFor(state)`** — the run's **bound** worker roles, consultant included
  only when bound. This is the both-hosts enablement (next section).

`WorkerRole` widens to include `consultant`; the per-role *maps* (`workerSessions`,
`activeTurns`, `pendingTurns`, `sentSnippets`) stay `Partial`, so a consultant key
appears only once a consultant turn happens. The worker provider factory
(`createWorkers`, `src/providers/index.ts`) builds the consultant provider **only
when the binding is present**, so an un-enabled run constructs exactly today's two
providers.

### 3. Enumeration, not architecture — the both-hosts enablement

The interactive blocker is not the orchestration architecture (the `TurnDispatcher`
is already generic over `WorkerRole` for dispatch/pending/settle/collect) — it is
that surfaces across the codebase enumerate a **static** `implementer/reviewer` pair.
**The rule: every static `implementer/reviewer` enumeration routes through
`workerRolesFor(state)`.** Most are read surfaces — `check_turns` and the orphan scan
(`tools.ts`), `status` and `status --wait` (`src/status.ts`,
`src/harness/lifecycle.ts`'s `TurnReady`), `doctor` (`src/doctor.ts`), session
resolution (`src/sessions.ts`), and `takeover`/`logs` (`src/cli.ts`) — but two carry a
real behavioral consequence the rule must reach:

- **Branch fixing.** A consultant turn *is* a worker prompt, so it fixes the run's
  branch. `create_branch` and `branchPolicyParagraph` today gate on
  `workerSessions.implementer || workerSessions.reviewer`
  (`tools.ts`, `orchestrator-prompts.ts`); a headless consultant turn can settle before
  the branch is created, and the gate must treat that as "a worker was prompted, the
  branch is fixed." (The async one-way `workerDispatched` flag already covers the
  interactive dispatch window; this is the headless-settled case.)
- **The view surface.** `tmux-view.ts` opens a fixed three-pane layout (orchestrator,
  implementer, reviewer); the consultant is a fourth voice, so the panes, the
  view-time color map (`colorize.ts`), and the per-voice log set become
  `workerRolesFor(state)`-driven when one is bound.

No dispatcher fork; the novelty is localized to the policy table and the dynamic role
lists. The exhaustive call-site inventory is the plan's; the rule and these two
consequential examples are the design constraint.

### 4. `send_prompt` and ephemerality (`src/harness/tools.ts`)

`send_prompt` stays the only worker verb. Its `role` enum and description list
`consultant` **only when one is bound** — so an un-enabled run's tool surface is
byte-for-byte today's, and the orchestrator cannot route to a role that does not
exist. The description states the consultant's ephemerality plainly (each consultant
turn starts a fresh seeded session — unlike the persistent implementer/reviewer), so
the orchestrator's mental model matches the harness behavior.

On settle, the existing bookkeeping writes `workerSessions.consultant = turn.sessionId`
as the **latest** session — picked up for free by status / doctor / takeover. The
latest is *tracked but never resumed* (`sessionIdFor` returns `undefined`). Every
checkpoint's session id is also appended to `consultant.log` so prior checkpoints
stay findable on disk even though state tracks only the latest. Cost accounting is
unchanged: a claude-bound consultant turn folds into `claudeWorkersUsd` (keyed by
provider name, not role), so no per-role split is added.

### 5. Checkpoints as registry modes; routing by posture (`src/phases.ts`, prompts)

The checkpoints live as **registry data** in the arcs (not a new arc). The mode names
denote *posture lineage*, not a phase name: `consultant.frame` is the generative
analysis mode, `consultant.specGate` and `consultant.implGate` the critical bet-audit
modes — and each arc maps the modes onto its own phases:

- **Full** (`frame → spec → … → impl`): `consultant.frame`@`frame`,
  `consultant.specGate`@`spec`, `consultant.implGate`@`impl`.
- **RIR** (`research → implement`): `consultant.frame`@`research`,
  `consultant.implGate`@`implement` — **no `specGate`**, because RIR has no spec phase.
  The consultant is in v1 for RIR: it is opt-in, and RIR's research-decisions-*are*-the-design
  shape (no spec/plan to otherwise check the bet) makes a bet-audit more valuable in the
  lighter arc, not less. Enabled, RIR runs two consultant passes (research + implement),
  not three.

The phase brief
(`buildPhaseBrief` and the per-phase entry-prompt builders in
`src/harness/orchestrator-prompts.ts`) injects the checkpoint step **only when a
consultant is bound**; the reviewer's and implementer's prompts never reference it —
the cohort lives only in the orchestrator/harness/registry (information hiding is the
feature: the embedded reviewer and the consultant are blind to each other, and the
implementer is blind to reviewer identity).

- **Framing.** The frame phase sends `think-holistic`'s analysis to **all three**
  voices and the implementer synthesizes **two anonymized peers**, not one. The
  consultant uses a **framing wrapper** (`consultant.frame`) — `think-holistic`'s
  analysis obligations *plus* an explicit statement of the bet-level-outsider lane and
  the no-build-review boundary. (Reusing `think-holistic` verbatim would yield a
  generic third engineer's analysis; the wrapper captures the product/strategic
  contribution that is the framing value, while keeping the three analyses
  commensurable for synthesis.)
- **Spec / impl.** The consultant runs once per checkpoint with the critical
  bet-audit snippet for that mode, seeded by the orchestrator with **curated input,
  not session state**: the settled artifact under review plus the settled decisions
  it must treat as by-design — and, at the impl checkpoint, the consultant's **own
  prior spec-checkpoint findings**. It is *not* fed raw framing debate or review
  traffic unless the orchestrator curated a specific *settled* decision from it. This
  is what keeps the consultant low-context by construction; continuity comes through
  the orchestrator's persistent session (it resumes across phases) carrying each
  checkpoint's prior view forward.

**Routing by posture.** Framing findings feed the synthesized direction (handled like
the reviewer's framing analysis). Spec/impl findings surface **raw in the gate
packet**, graded `low`/`high` by the consultant; the orchestrator **records, never
re-grades** (it does triage, not opinion) — folding them into `advance_phase`'s
summary and the structured `human_decisions` signal. `low` is advisory and rides the
packet; `high` is reserved for load-bearing bet-failures and genuine product
mismatches. "The bet is sound — ship" is a first-class expected outcome (permission to
find nothing). The implementer receives consultant-originated work only via the
human's reject-with-feedback — never as a direct defect queue.

The new consultant snippets must be classified in `src/phases.ts` (phase-bound,
anytime, or unlisted) or `tests/snippets.test.ts` fails — a constraint the registry
work must satisfy, not an afterthought.

### 6. Severity hold on both non-explicit crossings (`src/harness/lifecycle.ts`)

A `high` decision (consultant- or orchestrator-originated) must be crossed only by an
**explicit, gate-specific human approval** — never by a standing or blanket
authority. This generalizes (and hardens) the previously signal-only
`human_decisions` contract: today `HumanDecision.severity` never affects crossing;
now a `high` withholds a **non-explicit** crossing. Two such crossings exist:

- **`driveToQuiescence` auto-cross (headless pre-authorization).** Before
  manufacturing `human.approve` for a pre-authorized gate, it inspects that gate's
  packet (`phaseSummaries[gatePhase].humanDecisions`, already on disk). Any `high`
  ⇒ withhold the auto-approve and convert to an attended stop (notify, require a human
  tap). A `high` consultant finding at the AFK impl checkpoint therefore stops the
  overnight run instead of riding `autoApprovals` to morning and auto-opening a PR on
  a broken bet.
- **`enterAfk` handoff (the present→away transition).** `duet afk` approves the
  current gate and drops to headless in one tap — a *blanket walk-away authority*,
  and the only interactive path that can turn a `high` into an unattended approval.
  It refuses handoff from an interactive gate whose packet carries any `high`,
  directing the human to the one-command explicit substitute
  `duet continue --approve --headless` (which explicitly approves *this* gate, then
  hands off; downstream gates are then covered by the `driveToQuiescence` hold). The
  refusal is the feature working, not friction: it degrades the one-tap `afk` only
  when a `high` is actually present.

**Explicit `--approve` is never rejected.** `crossInteractive` continues to cross on
the human's explicit decision — blocking a human's own `--approve` would fight the
gate model. At an ordinary interactive gate the human is present and reads the packet
(consultant findings included) before tapping continue, so no structural hold is
needed there; the two guards above cover exactly the non-explicit crossings.

**The hold must be legible in the primary human view.** A hold the human can't see
explained is half a feature. Today the full `duet status` gate render
(`status.ts` `renderStatus`) prints the packet summary and artifacts but **not** the
structured `humanDecisions`; only `--brief` renders the high-hold marker. Full status
must render the structured `low`/`high` decisions and, when a pre-authorized gate
*held* because of a `high`, say so in plain words — so a human who runs the default
command sees *why* the gate stopped, not just a generic gate. The structured field is
already plumbed (`StatusModel`/`HumanDecision`); this is a render gap to close, not a
new signal.

### 7. Orphan handling — ephemerality simplifies it (`tools.ts`, `turn-dispatcher.ts`)

On the interactive host a worker turn orphaned by a session quit (a prior server
dispatched it and died) leaves a durable `pendingTurns` record — holding only
`{tag, status, startedAt}`, **not the prompt body** — and that record blocks
`advance_phase`/`ask_human` until cleared (`pendingTurnGate`, `tools.ts`). For a
persistent role the resolution is `duet takeover <role>`, which inspects/finishes the
resumable session. For the consultant both of that path's premises are gone:
**ephemeral** (there is nothing to resume — the next checkpoint seeds a fresh session,
so a re-send cannot race the orphaned one) and **read-only** (no repo-write race; the
orphaned consultant cannot have edited the repo). Read-only is the **load-bearing
safety here** — not process death: a worktree that can't be corrupted is the
guarantee. (For the headless Claude transport execa's child cleanup also kills the
orphaned worker when its server dies, but that is a per-provider detail, not the rule.)

So the consultant's `orphan` policy is **discard-and-reseed**, and the two resolutions
are concrete:

- **Primary (no human action): the orchestrator's next `send_prompt(role=consultant, …)`.**
  Because the durable record holds no body, recovery is not an automatic replay — the
  orchestrator re-supplies a fresh body. The same-role/orphan guard in `send_prompt`
  becomes policy-aware: for a `discard-and-reseed` role it **clears the stale record and
  dispatches the newly supplied body in the same call**, rather than refusing with the
  persistent role's "takeover then resend" copy. `check_turns` surfaces a consultant
  orphan as "discard and resend," not "takeover."
- **Fallback (manual): `duet takeover consultant`** clears the stuck record **without
  claiming resumability** — it does not open the prior session as a resume target (there
  is none to resume); it unblocks phase-exit so the orchestrator can reseed.

The honest cost is a possible duplicate spend or a lost answer, both benign for a
read-only one-shot. The async/orphan exposure is narrow by construction: the impl
checkpoint is AFK/headless (blocking `send_prompt`, no dispatcher), and the
framing/spec checkpoints touch the dispatcher only on an `--interactive` run — where
the human is present.

## Cost boundary

Enabled, the consultant adds **one opus-class pass per checkpoint** — three in the
Full arc, two in RIR. The framing pass is a *full third analysis* (≈ +50% on the
framing phase, since it is a third independent analysis, not a one-shot finding); the
spec and impl passes are one-shot bet audits. This is accepted — model-family
diversity is the value at framing even without the low-context edge. It is entirely
opt-in and **zero when the consultant is absent**. No per-role budget, throttle, or
cost-split is added.

## Testing (behaviors that matter; cases and fixtures are the plan's)

Named at spec altitude — the plan owns the specific cases, fixtures, and mocking
boundaries. The seam to fake at is the **`WorkerProvider` factory** (`createWorkers` /
the `WorkerFactory` injected into the run-scoped kernel): a consultant worker is a
third scripted adapter on that seam (`FakeWorker`/`DeferredWorker`), exactly as the
implementer/reviewer are faked today — never a mock of our own modules.

Behaviors the design must satisfy:
- **Default-off is byte-for-byte.** With no consultant bound, persisted `bindings`,
  the `send_prompt` surface, every role-enumerating surface, and run behavior are
  unchanged.
- **Configurability passes through.** `--consultant claude:<model>` /
  `[roles.consultant]` bind the named provider/model verbatim; enabled-without-model
  defaults to `claude-opus-4-8`; `--no-consultant` disables a config-bound consultant
  for one run; `[roles.consultant].transport = "interactive"` is rejected (read-only
  role).
- **Branch fixing counts the consultant.** A settled consultant turn fixes the run's
  branch — `create_branch` and the branch-policy prompt treat it as a worker prompt.
- **Ephemerality.** Consecutive consultant turns never carry a resume session id; the
  latest session is recorded for status/doctor/takeover and logged to `consultant.log`.
- **Additivity.** A consultant turn never counts a review round and never satisfies a
  phase's "needs a review round" rule; the embedded reviewer loop is unaffected.
- **Both hosts enumerate.** `workerRolesFor(state)` surfaces the consultant in
  `check_turns`, `status`/`--wait`, `doctor`, `sessions`, `takeover`, `logs` when
  bound, and not when absent.
- **Severity hold.** A `high` decision in a pre-authorized gate's packet withholds the
  `driveToQuiescence` auto-cross; `enterAfk` refuses handoff from a `high`-carrying
  interactive gate; an explicit `--approve` is never rejected; and full `duet status`
  renders the structured decisions and names a high-hold (not only `--brief`).
- **Orphan discard-and-reseed.** A consultant orphan blocks phase-exit like any pending
  turn, and resolves by the orchestrator's next `send_prompt(consultant, …)` (clears the
  stale record and dispatches the new body in one call) or by `takeover consultant`
  (clears without resuming) — never the persistent "takeover then resend" path.
- **Information hiding.** No reviewer/implementer prompt references the consultant.

Two guard tests are constraints, not optional: every new consultant snippet must be
classified in `src/phases.ts` (`tests/snippets.test.ts`), and every new flag/verb
(`--consultant`, `--no-consultant`) must exist on the command table
(`tests/skill.test.ts`).

## Out of scope (with the one-line why)

- A general N-reviewer abstraction — named roles fit the codebase; an array adds
  generality with no second use.
- A new workflow arc — checkpoints are registry data inside the existing arcs.
- A new tool — `send_prompt` already hides spawn/resume/persist; a `consult` tool
  would fork the contract.
- Any change to the embedded reviewer's behavior or snippets — independence is the
  product; the reviewer loop is untouched.
- Per-role budgets / cost throttling for the consultant — cost is opt-in and accepted.
- Reworking how the implementer consumes feedback beyond additive routing — consultant
  work reaches it only via the human's reject.

## Open questions (flagged for dogfooding / authoring — not resolved here)

- **Severity precision** (sibling to Q13/Q20). Does the consultant's self-graded
  `high`/`low` hold up in practice, and is the false-*low* rate acceptable? The hold
  catches only `high`, and only on non-explicit crossings — a load-bearing bet-failure
  mis-graded `low` rides the packet to the human's review rather than stopping the
  run. Validated on the first real consultant runs, as Q13's flag-precision loop is.
- **Three-way framing synthesis.** A third independent analysis sharpens the
  "synthesize, don't average" risk the frame examples already warn about. Whether
  `compare-notes` and the frame few-shots need light reinforcement for three voices is
  decided at snippet-authoring time, with the synthesized direction's quality as the
  signal.

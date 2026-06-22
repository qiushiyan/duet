# Plan: the consultant reviewer

Implements `docs/specs/2026-06-22-consultant-reviewer.md`. Read the spec first — this
plan does **not** re-argue goals or approach; it spends its tokens on the tactics the
spec deferred: the slice cut, the exact anchors, the test cases and fixtures, and the
load-bearing gotchas surfaced at the slice that must honor them.

TDD throughout: one behavior → one test → minimal code, vertical slices. Fake **only**
at the `WorkerProvider` seam (`createWorkers` / the injected `WorkerFactory`) — a third
scripted adapter (`FakeWorker`/`DeferredWorker`), never a mock of our own modules.
Commit per slice. The role-policy table is the canonical "deletion-test" module: it
must **absorb** today's scattered `role === 'reviewer'` checks, not sit beside them.

## Slice list

1. **Foundation** — `WorkerRole`/`Voice` widen; the `Role`/`BindableRole` config split + optional `consultant?` binding; `--consultant`/`--no-consultant`; the named `WorkerProviders` type + `providerFor` so the whole slice is **typecheck-green**; colorize's `Record<Voice>` maps gain consultant.
2. **Role-policy module (`src/roles.ts`) + helpers** — absorb `readOnly`/round-count; wire `sessionIdFor`/`readOnlyFor`/`countsReviewRound`/`workerRolesFor` into `send_prompt` on both hosts; conditional enum visibility.
3. **Enumeration sweep** — `workerRolesFor`/`voicesFor` through every static role list (worker-only vs voice), including branch-fixing and the view surface.
4. **Checkpoints** — registry modes (`consultant.frame`/`specGate`/`implGate`) + brief injection + new snippets; three-voice framing.
5. **Severity hold** — `driveToQuiescence` + `enterAfk` withhold on a `high`; full `status` renders the structured decisions.
6. **Orphan discard-and-reseed** — policy-aware orphan guard + `check_turns` copy + `takeover consultant` ephemeral semantics.
7. **Prompting self-audit** (required final slice, own commit) — audit every new/changed prompt surface against the binding conventions.

A natural fixture layer to add to `tests/helpers/fixtures.ts` and reuse from slice 2 on:
a `consultantBindings` (`DEFAULT_BINDINGS` + `consultant: { provider:'claude', model:'claude-opus-4-8' }`), a `consultantRun` (a run created with them), and a `workers`
record `{ implementer: FakeWorker('claude'), reviewer: FakeWorker('codex'), consultant: FakeWorker('claude', script) }`. Compose via `test.extend` so a test destructures only what it needs.

---

## Slice 1 — Foundation: widen the role types, add the optional binding, stay typecheck-green

**Goal.** A run can carry a consultant binding (config + flag), the factory builds the
provider only when bound, an *absent* consultant changes nothing on disk — and the
**whole slice typechecks** (the role-type widening cascades into several total `Record`
boundaries that must be closed *here*, not in a later slice). Spec §1, §2 (types),
§"Current vs desired".

**The type boundaries the widening forces (close them in this slice).** Widening
`WorkerRole`/`Voice` breaks every *exhaustive* (non-`Partial`) `Record` over them and
every consumer that assumes a *total* provider map. All must be fixed in slice 1 or
`pnpm typecheck` is red before slice 2 begins.

- `src/providers/types.ts:9` — `WorkerRole` gains `'consultant'`. Add a **named provider-map
  type** here (the provider-contract home): `WorkerProviders =
  Record<'implementer'|'reviewer', WorkerProvider> & { consultant?: WorkerProvider }` —
  required base, optional consultant.
- `src/providers/index.ts:19` — `createWorkers` returns `WorkerProviders`,
  `implementer`/`reviewer` always built, `consultant` built **iff `bindings.consultant`
  is present**. Add `providerFor(providers, role): WorkerProvider` here (with the factory)
  — narrows the optional and returns a **prescribed error** if a role isn't built (the
  `send_prompt` enum gates this in practice, so it is defensive). Indexing `WorkerProviders`
  by a `WorkerRole` variable yields `WorkerProvider | undefined`, so every consuming site
  goes through `providerFor`, not `providers[role]` directly.
- **The binding-map analogue (same `strict` + `noUncheckedIndexedAccess` break):** once
  `RoleBindings` carries an optional `consultant`, indexing `bindings[role]` by a dynamic
  `WorkerRole`/`Voice` yields `RoleBinding | undefined`. Add `bindingFor(bindings, role):
  RoleBinding` (in `config.ts`, with `RoleBindings`) — the narrow-or-prescribed-error twin
  of `providerFor` — and route every dynamic `bindings[role]` through it. The sites the
  *type widening alone* breaks in this slice: `createWorkers`'s consultant-build path
  (`providers/index.ts:24`), and `doctor.ts:107` and `:161` (`ROLES: Voice[]`, so `role`
  is the widened `Voice` even while the list is still static). The sites the *enumeration*
  makes dynamic — `sessions.ts:86`, `run-store.ts`'s `purgeRun`, `cli.ts:829` — adopt
  `bindingFor` in slice 3 when they switch to `workerRolesFor`/the widened role arg.
- Retype the injected provider seams to `WorkerProviders` and route access through
  `providerFor`: `tools.ts:94` (`PhaseToolsDeps`), `:197` (`settleTurn` deps), `:235/:238`
  (`providers[role].name`), `:574` (`providers[args.role]`); `turn-dispatcher.ts:76`
  (`TurnDispatcherDeps`), `:206` (`providers[role].runTurn`); `mcp-server.ts:135`
  (`WorkerFactory` return) and `:175` (`ctx`).
- `src/run-store.ts:31` `Voice` gains `'consultant'` (so `consultant.log` and
  `contextUsage.consultant` are writable through the existing `appendVoiceLog`/
  `recordContextUsage`); `:143` `workerSessions` and `:154` `sentSnippets` widen from the
  literal `'implementer'|'reviewer'` to `WorkerRole`-keyed `Partial` maps (those stay
  `Partial`, so no key is *forced*; `activeTurns`/`pendingTurns` at `:167`/`:180` are
  already `WorkerRole`-keyed).
- `src/colorize.ts:13/20/26` — `ROLE_GLYPH`/`ROLE_TMUX_COLOR`/`ROLE_PAINT` are exhaustive
  `Record<Voice,…>`; the `Voice` widening makes them **fail to compile** until each gains
  a `consultant` entry (pick a fourth glyph/color, e.g. `▲`/`magenta`). These are the pure
  view bits (F6); the tmux pane *layout* is slice 3.

**The config split (F2).** Keep `Role = orchestrator|implementer|reviewer` as the
**required** set (it keys `DEFAULT_BINDINGS` and the existing total loops). Introduce
`BindableRole = Role | 'consultant'` — the set that may appear in `[roles.*]` / `--<role>`:
- Retype `parseProviderModel`/`parseBinding`/`parseRoleOverride` (`config.ts:77/97/135`)
  and `roleOverrides` (`:174`) from `Role` to `BindableRole`.
- Widen `DEFAULT_CLAUDE_MODEL` (`:55`) to `Record<BindableRole, string>` with
  `consultant: 'claude-opus-4-8'` — that is where the no-model default lives. (It is read
  only when a consultant binding is *being parsed*; `DEFAULT_BINDINGS` stays required-base
  only, so persisted state is untouched.)
- `RoleBindings` becomes `Record<Role, RoleBinding> & { consultant?: RoleBinding }`. The
  load loop (`:184`) and override loop (`:192`) keep iterating the **required** tuple, then
  handle `consultant` as an explicit optional step (parse `[roles.consultant]` if present;
  apply a `--consultant` override; `--no-consultant` deletes it). The transport guard
  (`:117`, `role !== 'implementer'`) already rejects `interactive` for consultant.
- `src/cli.ts` — `new` gains `--consultant <provider[:model]>` and `--no-consultant`
  (next to `--reviewer` at `:188`), threaded into `loadRunConfig`.

**Tests** (`tests/config.test.ts`, `tests/providers.test.ts`, `tests/skill.test.ts`,
`tests/cli.test.ts`):
- `--consultant claude:claude-opus-4-6` / `[roles.consultant]` bind the named
  provider+model **verbatim**; enabled with no model defaults to `claude-opus-4-8`.
- `[roles.consultant].transport = "interactive"` is **rejected** (assert the thrown
  message names the read-only reason) — guards the `interactive-claude.ts:324` runtime
  throw never reaching production.
- `--no-consultant` over a config-bound consultant yields an absent binding.
- `createWorkers` returns no `consultant` key when unbound; a real third provider when
  bound. `providerFor(providers,'consultant')` throws its prescribed error when unbuilt.
- `colorizeVoiceLine('consultant', line)` paints (a cheap pure test; `ROLE_GLYPH.consultant`
  exists).
- **Default-off byte-for-byte:** a run created with no consultant has a persisted
  `bindings` object byte-identical to today's (`toEqual` against `DEFAULT_BINDINGS`).

**Gotchas.**
- **The slice must be typecheck-green on its own commit.** The role-type widening cascades
  into the provider-map seams (→ `WorkerProviders` + `providerFor`), the optional-binding
  index sites (→ `bindingFor`, `doctor.ts:107/161` + `createWorkers`), and the
  `Record<Voice>` colorize maps; closing those is *part of this slice*, not deferred. Run
  `pnpm typecheck` before committing — `noUncheckedIndexedAccess` is on, so a missed dynamic
  `bindings[role]` is a hard error, not a warning.
- **Default-off must be byte-for-byte: never default a consultant into `DEFAULT_BINDINGS`
  or the persisted `bindings`.** `consultant` is parsed only when a key/flag is present;
  `DEFAULT_CLAUDE_MODEL.consultant` is a *parse-time* default, not a persisted one.
- **`--consultant`/`--no-consultant` must land on the command table** or
  `tests/skill.test.ts` fails — extend that test in this slice.

---

## Slice 2 — The role-policy table and four shared helpers

**Goal.** One table expresses the consultant's three asymmetries as data; both
`send_prompt` hosts read it through helpers; the existing `role === 'reviewer'` checks
are **deleted** into it. Spec §2.

**Design — a deep module in its own file (F4).** Run-state role policy is **not** a
provider contract, so it lives in a new **`src/roles.ts`** — not `providers/types.ts`
(which stays provider contracts; the `WorkerProviders` type and `providerFor` already
landed in the providers area in slice 1). `src/roles.ts` imports `RunState` *type-only*
from `run-store.ts` and `WorkerRole` from `providers/types.ts`, so the `RunState` edge is
erased and no runtime cycle closes. It holds one policy table keyed by `WorkerRole`:
`{ session: 'persistent'|'ephemeral', readOnly: boolean, orphan: 'takeover'|'discard-and-reseed' }`,
and the helpers:
- `sessionIdFor(state, role)` → `role`'s ephemeral ⇒ `undefined`, else
  `state.workerSessions[role]`.
- `readOnlyFor(role)` → `policy[role].readOnly` (true for reviewer **and** consultant).
- `countsReviewRound(role, tag)` → reviewer **and** a `review*` tag (consultant never).
- `workerRolesFor(state)` → `['implementer','reviewer', …('consultant' iff bound)]`.

(`voicesFor(state) = ['orchestrator', ...workerRolesFor(state)]` is defined in slice 3,
where its first voice-surface consumer lands.)

**Changes (absorb, don't parallel).**
- `src/harness/tools.ts:538` — replace the inline
  `args.role === 'reviewer' && args.tag.startsWith('review')` with
  `countsReviewRound(args.role, args.tag)`.
- `tools.ts:609` and `src/harness/turn-dispatcher.ts:206` — replace
  `readOnly: role === 'reviewer'` with `readOnly: readOnlyFor(role)`.
- `tools.ts:608` (blocking) and `turn-dispatcher.ts:206` (background launch) — replace
  `sessionId: state.workerSessions[role]` with `sessionId: sessionIdFor(state, role)`.
- `tools.ts:504` — the `send_prompt` `role` enum is built from `workerRolesFor(state)`
  (so `consultant` is an enum value **only when bound**); the description gains the
  ephemerality sentence (each consultant turn is a fresh seeded session) **only when
  bound**.
- `tools.ts` `send_prompt` resolve site (`:574`) — resolve the provider via
  `providerFor(providers, args.role)` (introduced in slice 1), which already prescribes the
  absent-role error.

**Tests** (`tests/tools.test.ts`, at the `WorkerProvider` seam):
- **Ephemerality:** two consecutive `send_prompt(consultant,…)` turns — the second
  `FakeWorker.calls` entry has `sessionId === undefined` even though
  `workerSessions.consultant` was set by the first settle. Assert the **blocking** path
  *and* the **dispatcher** path (drive the run-scoped kernel) — miss one host and
  ephemerality silently breaks there.
- **Latest-session tracked:** after a consultant turn, `workerSessions.consultant` is the
  latest id and `consultant.log` contains the session line (the find-on-disk mechanism).
- **Additivity:** a consultant turn does not increment `rounds[phase]`; with only
  consultant turns run, `advance_phase` in a `reviewLoop` phase still refuses
  ("no review round yet") — the consultant never substitutes for an embedded round.
- **read-only mapping:** `FakeWorker.calls` for a consultant turn has `readOnly === true`.
- **Regression (behavior-preserving):** the existing reviewer round-count and
  reviewer-readOnly tests stay green unchanged.
- **Enum visibility:** `send_prompt` advertises `consultant` only when bound; unbound,
  the tool schema is byte-for-byte today's.

**Gotchas.**
- **Absorb, don't parallel: deleting the `role === 'reviewer'` checks into the table is
  the slice.** A helper that sits *beside* the old check is the failure mode — the
  deletion test must pass (remove the table → the rule reappears at N sites).
- **`sessionIdFor` must be applied at BOTH resume sites.** The blocking
  `tools.ts:608` and the dispatcher `turn-dispatcher.ts:206` are separate code paths;
  ephemerality on one host without the other is a silent split.
- Existing-role behavior is **preserved**: `readOnlyFor('reviewer')` and
  `countsReviewRound('reviewer','review-spec')` return exactly today's values.

---

## Slice 3 — Enumeration sweep: worker-only vs voice surfaces

**Goal.** Every static role list resolves dynamically so the consultant is visible on
both hosts when bound and byte-for-byte when absent. Spec §3. **The split that matters
(F5): some surfaces enumerate *workers*, some enumerate *voices* (workers + the
orchestrator).** Add `voicesFor(state) = ['orchestrator', ...workerRolesFor(state)]` to
`src/roles.ts` and route each site through the right one — a blunt `workerRolesFor`
everywhere would drop the orchestrator from the voice surfaces.

**Changes.**
- **Worker-only** → `workerRolesFor(state)`: `src/sessions.ts:84` (`resolveSessions`'s
  worker loop — orchestrator already handled separately at `:81`); `src/status.ts:187`
  (`pendingTurns`, worker-only); `src/harness/tools.ts:410` (`ROLES`, the orphan/
  `check_turns` scan over `pendingTurns`) and `:489` (`list_snippets` sent-map, worker-keyed);
  `src/harness/lifecycle.ts:290` (`TurnReady`, worker turns).
- **Voice** (incl. orchestrator) → `voicesFor(state)`: `src/doctor.ts:33` (`ROLES:
  Voice[]`, also feeds `:161`'s `bindings[r]` provider check); `src/status.ts:176`
  (context, a voice list). `src/colorize.ts`'s `Record<Voice>` maps already gained their
  `consultant` entry in slice 1 (typecheck); the `_colorize` CLI arg validation
  (`src/cli.ts:865`, the `<voice>` argument — *not* `logs`, F6 citation fix) accepts
  `consultant`.
- **`purgeRun`** (`run-store.ts:575-583`) → enumerate workers via `workerRolesFor`
  (through `bindingFor` for the provider lookup), but **transcript-deletion semantics are
  settled, not reopened (F5 + carried rider):** purge deletes the *latest tracked*
  consultant transcript (the id in `workerSessions.consultant`) by exact session-id match,
  exactly like implementer/reviewer, and removes the run dir. **Prior consultant checkpoint
  provider transcripts are intentionally left on disk** — state never tracked them, and
  `sessions.ts` matches by exact id (no directory sweep), so purge cannot reach them. Note
  the wording precisely: purge removes the run dir **including `consultant.log`**, so the
  surviving priors are the *provider* transcripts in `~/.claude`/`~/.codex`, not
  `consultant.log` (that is the findability mechanism only for a *live, non-purged* run).
  State this in the code comment; do not add prior-session tracking.
- **Branch fixing (behavioral):** `src/harness/tools.ts:688` (`create_branch`) and
  `src/harness/orchestrator-prompts.ts:166` (`branchPolicyParagraph`) test
  `workerSessions.implementer || workerSessions.reviewer`; both must instead ask "has
  *any* bound worker been prompted" (`workerRolesFor(state).some(r => workerSessions[r])`,
  alongside the existing `workerDispatched` flag).
- **View surface (view-glue, integration deliberately untested):** `src/tmux-view.ts:56`
  (fixed three-pane layout) and the per-voice log set become `voicesFor(state)`-driven,
  adding a fourth pane when a consultant is bound.

**Tests** (`tests/sessions.test.ts`, `tests/status.test.ts`, `tests/doctor.test.ts`,
`tests/tools.test.ts`, `tests/lifecycle.test.ts`, `tests/abandon.test.ts`):
- **Both-hosts enumerate:** with a consultant bound and a settled consultant turn,
  `resolveSessions`/`status.sessions[]`, `doctor`'s role rows, and `check_turns`'s
  running-role scan include `consultant`; with none bound they are byte-for-byte today's.
- **Voice surfaces keep the orchestrator:** `doctor` and `status.context` still include
  `orchestrator` *and* gain `consultant` when bound — guards against a blunt-sweep regression.
- **Branch-fixing counts the consultant:** create a run, settle **only** a consultant
  turn (no implementer/reviewer), then `create_branch` refuses with the "branch fixed"
  message (and `branchPolicyParagraph` returns empty). This is the headless-settled case
  the async `workerDispatched` flag doesn't cover.
- **Purge leaves priors:** `purgeRun` deletes the latest tracked consultant transcript and
  leaves a planted prior-checkpoint transcript untouched (drive `purgeRun` with a fake
  `home`, the existing seam).
- **`status --json` schema stays additive:** consultant rows are additive; the pinned-keys
  assertion still holds.

**Gotchas.**
- **Voice vs worker is not cosmetic:** routing a *voice* surface (`doctor`,
  `status.context`) through `workerRolesFor` silently drops the orchestrator. Use
  `voicesFor` for those.
- **A consultant turn IS a worker prompt — it fixes the branch.** A headless consultant
  turn can settle before `create_branch` runs; if the gate ignores it, a late
  `create_branch` would strand that turn's work. The one enumeration miss with a
  correctness consequence.
- **`workerRolesFor(state)` must yield exactly `[implementer, reviewer]` when no
  consultant is bound**, in arc order, so every swept surface is byte-for-byte and the
  additive-only `status --json` schema is preserved.
- **Purge: leave prior consultant *provider* transcripts (settled).** Delete only the
  latest tracked transcript; the run dir (incl. `consultant.log`) goes with it; do not add
  prior-session tracking or a directory sweep. `consultant.log` is *not* a post-purge
  findability path — it is gone with the run dir.
- **Apply `bindingFor` at the now-dynamic `bindings[role]` sites** (`sessions.ts:86`,
  `purgeRun`, `cli.ts:829`): once the enumeration / role-arg widens to include
  `consultant`, `noUncheckedIndexedAccess` makes a bare `bindings[role].provider` a hard
  error. (`bindingFor` was introduced in slice 1.)
- `takeover`/`_colorize` role-argument validation is widened here (accept the arg); the
  `takeover` *ephemeral semantics* are slice 6 — do not implement orphan/inspect behavior
  in this slice.

---

## Slice 4 — Checkpoints as registry modes, brief injection, snippets

**Goal.** The consultant fires at its registry checkpoints — a third framing analysis
and a spec/impl bet audit — taught only to the orchestrator, invisible to the other
voices. Spec §5.

**Changes.**
- `src/phases.ts` — add the consultant checkpoint modes as registry data per arc:
  Full → `consultant.frame`@`frame`, `consultant.specGate`@`spec`,
  `consultant.implGate`@`impl`; RIR → `consultant.frame`@`research`,
  `consultant.implGate`@`implement` (**no `specGate`**). Classify the new snippet keys in
  `ANYTIME_SNIPPETS`/`UNLISTED_SNIPPETS` or a phase's `snippets` list (decide red-green;
  bet-audit snippets are phase-bound to their checkpoint phases).
- `snippets.toml` — three new snippets: `consultant-frame` (the framing wrapper —
  `think-holistic`'s analysis obligations **plus** the bet-level-outsider lane and the
  no-build-review boundary), `consultant-spec`, `consultant-impl` (critical bet audits;
  CEO/CTO hats self-selected; documented-tradeoff-is-by-design; severity-graded output).
  Initial bodies here; slice 7 polishes them against the conventions.
- `src/harness/orchestrator-prompts.ts` — when `state.bindings.consultant` is present:
  - The frame/research entry prompt sends `think-holistic` to **all three** voices and
    has the implementer synthesize **two anonymized peers** (today it routes one
    reviewer analysis via `compare-notes`, `:194`); the consultant uses
    `consultant-frame`.
  - The spec (`:203`/`specDraftEntryPrompt`) and impl (`:276`) entry prompts gain a
    consultant-checkpoint step just before `advance_phase`: run the bet audit, fold its
    raw findings into the packet summary, and reflect each finding's consultant-assigned
    severity in `advance_phase`'s `human_decisions` (record, never re-grade). The impl
    step seeds the consultant with the settled spec + its **own prior spec-checkpoint
    findings**, not raw traffic.
  - The reviewer's and implementer's prompt bodies are **unchanged**.

**Tests** (`tests/snippets.test.ts`, `tests/phases.test.ts`, a brief-injection test in
`tests/tools.test.ts`/`tests/driver.test.ts`):
- **Snippet classification (guard):** the three new snippets are classified — extend
  `tests/snippets.test.ts`'s completeness assertion; `review-`-prefix is *not* used (a
  consultant tag must never trip `countsReviewRound`).
- **Brief injection is conditional, and the cohort lives *in the orchestrator brief*
  (F3):** `buildPhaseBrief(state,'spec')` — the orchestrator's own entry prompt — *does*
  contain the consultant-checkpoint step when a consultant is bound (assert it mentions
  it), and is byte-for-byte today's when none is bound. The orchestrator is exactly where
  the cohort is allowed to be known.
- **Information hiding is about the *worker-directed* surfaces, not the orchestrator
  brief (F3):** the implementer/reviewer-facing snippets (`think-holistic`, `review-*`,
  `update-*`, `compare-notes`, …) and any harness-authored worker-directed framing read
  **identically with and without** a consultant bound, and never name the consultant or
  "a third voice." For the three-voice framing, the synthesis prompt presents the two
  peers as **anonymized** — no peer is labeled "consultant."
- RIR maps `frame`@`research` + `implGate`@`implement` and has **no** `specGate`.

**Gotchas.**
- **Every new consultant snippet must be classified in `src/phases.ts` or
  `tests/snippets.test.ts` fails** — classify in the same slice that adds the snippet.
- **Consultant snippet tags must not start with `review`** — `countsReviewRound` keys on
  that prefix; a `review`-prefixed consultant tag would silently consume a review round.
- **Information hiding is a tested invariant — but scoped to worker-directed surfaces:**
  the reviewer/implementer prompts and snippets read identically with and without a
  consultant bound. The *orchestrator* brief is where the cohort legitimately lives — do
  not write a test that forbids "consultant" in the orchestrator brief (that contradicts
  the brief-injection requirement above).
- The three-way framing synthesis sharpens "synthesize, don't average" (spec open
  question) — leave `compare-notes`/frame-example reinforcement to slice 7's judgment; do
  not over-engineer it here.

---

## Slice 5 — Severity hold on both non-explicit crossings

**Goal.** A `high` decision cannot be crossed by a non-explicit authority; an explicit
`--approve` always can; the hold is legible in full `status`. Spec §6.

**Changes.**
- `src/harness/lifecycle.ts:393` (`driveToQuiescence` auto-cross) — before sending the
  manufactured `human.approve`, inspect `fresh.phaseSummaries[gatePhase]?.humanDecisions`;
  any `severity === 'high'` ⇒ **withhold** the auto-approve and fall through to the
  attended-stop path (`:405-408`), with a notify that names the held high. (The packet is
  already on disk at this point — written by `advance_phase`.)
- `src/harness/lifecycle.ts:480` (`enterAfk`) — after the `position.kind === 'gate'`
  check (`:476`), if the current gate's packet carries any `high`, **throw** a refusal
  directing to `duet continue --approve --headless` (the one-command explicit substitute),
  before `setGatesAt`/`crossInteractive` run.
- `crossInteractive` (`:428`) — **unchanged**: an explicit `--approve` is never inspected
  for severity.
- `src/status.ts` `renderStatus` gate branch (`:380`) — render the structured
  `humanDecisions` (the `StatusModel`/`HumanDecision` field is already plumbed; today
  only `renderBrief` at `:511` shows them), and when the stop is a pre-authorized gate
  that *held* on a high, say so in words.

**Tests** (`tests/lifecycle.test.ts`, `tests/status.test.ts`):
- **Auto-cross withheld on high:** a pre-authorized gate whose packet has a `high`
  decision does **not** auto-approve — `driveToQuiescence` returns an attended gate stop;
  with only `low`/no decisions it auto-crosses exactly as today.
- **`enterAfk` refuses on high:** handoff from a `high`-carrying interactive gate throws
  the prescribed refusal naming `--approve --headless`; from a `low`/clean gate it hands
  off in one tap as today.
- **Explicit `--approve` never blocked:** `crossInteractive`/`continue --approve` crosses
  a `high`-carrying gate without complaint.
- **Status legibility:** full `renderStatus` of a held gate prints the structured
  decisions and the high-hold wording.

**Gotchas.**
- **This deliberately changes the `human_decisions` contract** from signal-only to
  "a `high` withholds a *non-explicit* crossing." The existing test/comment pinning
  signal-only (`run-store.ts:40`, `tools.ts:751`, and any lifecycle/status assertion)
  must be updated **in this slice**, not worked around.
- **`crossInteractive` must never gain a severity check** — blocking a human's own
  `--approve` fights the gate model. Only the two *non-explicit* crossings hold.
- The hold reuses the **existing** structured field and the **existing** attended-stop
  path — no new event, no new statechart state.

---

## Slice 6 — Orphan discard-and-reseed + `takeover` ephemeral semantics

**Goal.** A consultant orphan resolves by re-send (no `takeover` needed), and
`takeover consultant` keeps inspect-vs-clear distinct. Spec §7.

**Changes.**
- `src/harness/tools.ts:533` (`send_prompt`'s orphan branch) — make it policy-aware: for
  an `orphan: 'discard-and-reseed'` role, **clear the stale `pendingTurns` record and
  dispatch the newly supplied body in the same call** (the durable record holds no body —
  `run-store.ts:180` — so recovery is a fresh send, not a replay), instead of the
  persistent role's `orphanRefusalText` ("takeover then resend", `:421`).
- `tools.ts` `check_turns` orphan report (`:880-884`) — for a consultant orphan, surface
  "discard and resend," not "takeover."
- `src/cli.ts` `takeover` (`:810-837`) — for a consultant (an ephemeral role):
  - **§4 (non-orphan):** a latest session exists → open it for **inspection**, but the
    messaging must not claim duet will resume it (it won't — a fresh session seeds next
    checkpoint). Clear any pending record afterward (`:837`) as today.
  - **§7 (orphan, no captured session):** the `:818-825` clear-without-resume path
    applies — clear, no resume target.

**Tests** (`tests/tools.test.ts`, `tests/cli.test.ts`):
- **Discard-and-reseed:** with a stale consultant `pendingTurns` record on disk,
  `send_prompt(consultant, newBody)` clears it and dispatches `newBody` (the
  `FakeWorker`/`DeferredWorker` records the new body; no orphan refusal returned).
- **Phase-exit still gated:** an uncollected/orphaned consultant turn blocks
  `advance_phase` until the re-send (or `takeover`) clears it — the consultant is not
  exempt from `pendingTurnGate`.
- **`takeover consultant` (non-orphan)** opens the latest checkpoint session and clears
  the record; **(orphan)** clears without a resume target. Assert the two paths print
  distinct, honest copy.

**Gotchas.**
- **Keep §4 and §7 distinct in `takeover`:** non-orphan = *inspect the latest* checkpoint;
  orphan = *clear, no resume target*. Conflating them (claiming resume on an ephemeral
  role, or skipping the inspect path) is the failure the reviewer named.
- **No stored body to replay:** the orphan record is `{tag,status,startedAt}` only —
  discard-and-reseed dispatches the body the orchestrator *re-supplies*, never a cached
  one.
- **Read-only is the load-bearing safety**, not process death — the discard is safe
  because the orphaned consultant can't have edited the repo (don't assert or rely on the
  execa child-kill, which is headless-Claude-specific).

---

## Slice 7 — Prompting self-audit (required final slice, own commit)

**Goal.** The human's named quality gate on the prompt surface, since the whole
implementation runs AFK. A real scheduled step with its own commit and a verification
note — not a footnote.

**Process.**
1. Re-read `docs/prompting-and-tool-design.md` (the five binding conventions) and the
   prompt-engineering skill (`docs.local/prompt-engineering/skill.md` →
   `/Users/qiushi/dotfiles/claude/.claude/skills/prompt-engineering/skill.md`).
2. Audit **every new or changed** tool description, tool result, error message, and
   snippet/prompt this work introduced, against the conventions:
   - `send_prompt`'s widened description + ephemerality sentence (slice 2);
   - the `send_prompt` resolve-error and the orphan/`check_turns`/`takeover` copy
     (slices 2, 6) — convention 4 (errors name the layer + prescribe recovery);
   - the `enterAfk` high refusal and the `driveToQuiescence` held-gate notify (slice 5) —
     conventions 4/5;
   - the three consultant snippets + the consultant-checkpoint brief steps (slice 4) —
     conventions 1/2 (artifacts-first, framework-with-motivation, no aggressive emphasis),
     and the spec's anti-redundancy boundary (consultant snippets authored *against*
     `review-spec`, stating the bet-level-outsider lane and disclaiming the build-review
     lane);
   - the full-`status` high-hold wording (slice 5).
3. Fix anything that violates a convention; re-run `pnpm test` + `pnpm typecheck`.

**Verification note (in the commit message).** List each audited surface and the verdict
(conforming / fixed-how), so the human's review of the AFK output can confirm the gate
ran. No behavior change beyond prompt-surface wording; tests stay green.

**Gotcha.**
- This is the human's explicit AFK quality gate — **do not fold it into an earlier
  slice's commit**. It is its own commit with the verification note, run after all
  behavior slices land.

---

## Cross-cutting verification

- `pnpm typecheck` + `pnpm test` green after **every** slice (commit per slice).
- The two guard tests stay green throughout: `tests/snippets.test.ts` (slice 4 classifies
  the new snippets) and `tests/skill.test.ts` (slice 1 adds the flags to the command
  table).
- **Default-off byte-for-byte** is the spine invariant — re-assert it after the
  enumeration (slice 3) and checkpoint (slice 4) slices, since those touch the most
  shared surfaces: an unbound run's persisted state, `status --json`, and the
  reviewer/implementer prompts must all read identically to pre-feature `main`.
- No doc updates in this plan — they follow implementation per the workflow.

## Deferred to dogfooding / authoring (spec open questions, not plan work)

- **Severity precision** (false-`low` rate under the high-only hold) — watched on the
  first real consultant runs, sibling to Q13/Q20.
- **Three-way framing synthesis** reinforcement (`compare-notes`/frame examples) —
  slice 7 may touch it in judgment; a deeper rework is post-v1 if the synthesized
  direction quality calls for it.

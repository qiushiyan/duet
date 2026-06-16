# Plan: interactive Claude worker transport (spike)

**Status:** Plan — implements `docs/specs/2026-06-15-interactive-claude-worker-transport.md` (committed `81e0261`). **Date:** 2026-06-16. AFK implementation plan: every slice is one commit and is verifiable with `pnpm typecheck` + `pnpm test` and **no live auth**. The one live-auth step is a documented human handoff (Slice 5), never executed by the implementer.

**Quality bar (gate rider).** Spike is a narrower *verification* bar, not a lower *design* bar. The load-bearing extensibility move is named by the spec's §"Path to production": the owned-pty production transport must slot in behind the same seam with the transcript parser **reused unchanged**. So this plan isolates the **injection/process-driving layer as its own sub-seam** (`PaneController` — tmux today, pty later), kept distinct from the transport-independent **transcript parsing / turn-boundary logic**. That split is the ergonomic-migration lever and it drives the module shape below.

## Architecture — module shape

Three deep modules, small interfaces, hidden implementation. The dependency arrow that matters: the worker depends on the *abstract* pane, never on tmux.

```
InteractiveClaudeWorker  (implements WorkerProvider — src/providers/interactive-claude.ts)
  ├─ owns: launch → readiness-poll → submit(prompt+nonce) → watch+parse → teardown
  │        all bounded by one per-turn deadline (PHASE[phase].workerTurnTimeoutMs)
  ├─ PaneController            (injection/process SUB-SEAM — src/providers/pane.ts)
  │     ├─ TmuxPane            real adapter: execa→tmux  (thin glue, untested like tmux-view.ts)
  │     └─ FakePane            test adapter (tests/helpers)         ← pty adapter slots in here later
  ├─ transcript locator+reader (fs: find this turn's session file under the root, read its tail)
  └─ parseInteractiveTurn()    PURE transcript→WorkerTurn|undefined  ← REUSED UNCHANGED by the pty transport
```

- **`PaneController` (new sub-seam, `src/providers/pane.ts`).** A **semantic** interface — `open()`, `submitPrompt(text)` (atomically deliver the whole prompt *and* submit it), `pollReady()` (a "ready for input?" predicate, not a screen-scrape), `kill()`. No terminal mechanics appear in the interface, so a future pty adapter satisfies it without contortion. `TmuxPane` implements it by shelling to tmux via `execa` exactly as `src/tmux-view.ts` does, owning the terminal details internally (run-scoped session distinct from the viewer's `duet-<run_id>`; `load-buffer` → `paste-buffer -p` is *its* delivery strategy; `capture-pane` is *its* readiness probe; `kill-session` for teardown). This seam is earned twice over (`docs/engineering.md:46` — "a new abstraction earns a seam only when a second adapter exists or a test needs one"): a test needs it now, and the pty adapter is the named second adapter. `TmuxPane` itself is the thin untestable-without-tmux glue (`docs/engineering.md:32` deliberately-untested view glue); **all logic lives above it and is tested via `FakePane`.**
- **`parseInteractiveTurn` (pure, `src/providers/interactive-claude.ts`).** Transcript tail + turn nonce → `WorkerTurn | undefined` (`undefined` = the turn isn't complete yet, so the watcher keeps reading). Modeled on `parseRolloutContext` (`src/providers/codex.ts:25`) and reusing `claudeContextUsage` (`src/providers/claude.ts:41`) for token/context math over the transcript's assistant `message.usage` blocks. **No I/O** — the watcher feeds it bytes. This is the piece the pty transport reuses verbatim.
- **`InteractiveClaudeWorker` (orchestration, `src/providers/interactive-claude.ts`).** Implements `WorkerProvider` (`src/providers/types.ts:48`), `name = 'claude'`. Constructed with `{ model, timeoutMs, transcriptRoot?, newPane? }` — `newPane` defaults to `() => new TmuxPane(...)` and `transcriptRoot` to `~/.claude/projects` (both injectable so tests use a `FakePane` + a tmpdir). Mirrors `ClaudeWorker`'s constructor shape (`src/providers/claude.ts:114`).

## Workability — the four shape requirements (rider)

1. **Testable core vs. live-auth tail — the line.** Everything in Slices 1–4 is provable over fakes (pure parser; `FakePane`; a tmpdir transcript grown by the test; fake timers for the deadline). The five **live-auth** checks (billing meter, bypass-suppresses-prompts, session pin-or-correlate against a real shared slug, one-prompt→one-message, interactive `/compact` boundary) are Slice 5: a write-only `src/spike/` script + a handoff checklist the **human** runs. The implementer never launches an interactive `claude` (a real login would block/fail the AFK run).
2. **The tmux-driving layer is faked at the seam, not skipped.** The driving *logic* — readiness-poll loop, one-deadline bounding, nonce injection ordering, teardown on **both** success and failure/timeout, session pin/correlate — is exercised against `FakePane` + a growing tmpdir transcript. Concrete cases are in Slice 4. The only thing live-auth-gated is the real CLI's *behavior*, which `TmuxPane` (thin glue) carries.
3. **Fixture ↔ live-auth-uncertainty.** Parser fixtures are **hand-authored now** from the transcript shape we already parse on the headless path (`claudeContextUsage` already consumes `message.type==='assistant'` + `message.message.usage` — `src/providers/claude.ts:41`) plus the codex rollout precedent. The uncertain *event vocabulary* (which record opens/closes a turn, the compact-boundary shape) is isolated into a handful of named predicate helpers (`isTurnOpen`, `isFinalAssistant`, `isCompactBoundary`, `extractText`, `extractUsage`); the parser's walk-the-tail control flow is meant to stay stable. Correcting against a **real** captured transcript later (a byproduct of Slice 5) is **intended to be localized** — editing those predicates + the one fixture builder (`tests/helpers/interactive-transcript.ts`, the single home of the fixture shape). Honest caveat (Finding 5): if the real transcript records the prompt/nonce somewhere unexpected, or the session id lives outside the records, the correction can reach the locator/watch control flow too, not only the predicates — which is exactly why **Slice 5's captured real transcript is a gating artifact** (next point): the mechanism is not declared proven until the parser+locator run green against it.
4. **Carried PLAN items (spec).** The `transport` field parse + **codex-rejection** test mirrors the model-on-codex validation (`src/config.ts:59`, test `tests/config.test.ts:29`) — Slice 2. The cost known/unknown distinction is an **additive** field on `costs`, flowing into `status --json` verbatim, with `costs.claudeWorkersUsd` redocumented as *known* Claude-worker cost — Slice 3. The bounded-timeout failure model wires to the existing `PHASE[phase].workerTurnTimeoutMs` already threaded into workers (`src/harness/driver.ts:132`, `src/providers/claude.ts:143`) — Slice 4.

## Seam & testing compliance

Fake **only** at the four seams (`docs/engineering.md` §Seams) plus the one new earned sub-seam: `WorkerProvider` (harness tests keep `FakeWorker`), the new `PaneController` (the tmux subprocess boundary — a system boundary), filesystem (real, in tmpdirs), clock (fake timers). (The authoritative seam/testing guidance is `docs/engineering.md` §Seams + §"Testing strategy" — the AFK implementer follows that, not any external skill file.) We never mock our own modules — `parseInteractiveTurn`, the locator, and `InteractiveClaudeWorker` are tested through their real interfaces. Behavior through public interfaces, not implementation detail; red-green-refactor applied inside Slices 1 and 4 where the design is subtle.

---

## Slice 1 — the transcript parser (pure core)

**Goal.** `parseInteractiveTurn(tail: string, opts: { nonce: string }): WorkerTurn | undefined` — the deepest, most-reused, highest-uncertainty piece, landed first and alone so its contract is nailed before anything drives it.

**Changes.**
- New `src/providers/interactive-claude.ts`: export `parseInteractiveTurn` + the isolated predicate helpers (`isTurnOpen`/`isFinalAssistant`/`isCompactBoundary`/`extractText`/`extractUsage`). Walk the tail, find the user record carrying `nonce` (turn-open), collect forward; return `undefined` if no turn-close yet; on a normal close return `{ text: finalAssistantText, sessionId, tokens?, context? }`; on a compact-boundary close return the **same synthetic confirmation string** the headless path uses (`src/providers/claude.ts:85-91`) with the unchanged session id. Token/context via `claudeContextUsage` (`src/providers/claude.ts:41`) over the collected assistant `message.usage` blocks.
- New `tests/helpers/interactive-transcript.ts`: fixture builders — `userTurn(prompt, nonce)`, `assistantFinal(text, usage?)`, `toolStep(...)`, `compactBoundary()`, `session(id, ...records)` — composing JSONL strings. The **single home** for the transcript shape (point 3).

**Tests** (`tests/providers.test.ts`, new `describe('parseInteractiveTurn …')`, mirroring the `parseClaudeTurn` block at `:7`):
- extracts the final assistant text + sessionId for a plain turn (user→assistant-final).
- a tool-using turn (user→assistant(tool_use)→tool_result→assistant-final) returns the **final** assistant text, not joined intermediate narration.
- token/context populated from the final assistant `message.usage` (asserts the `claudeContextUsage` reuse), mirroring `tests/providers.test.ts:56`.
- an **incomplete** turn (user→tool_use, no final yet) returns `undefined`.
- a **compact** turn (user `/compact …` → compact-boundary) returns the synthetic confirmation + unchanged session id (parallels `tests/providers.test.ts:45`).
- a **cut/partial** trailing JSONL line is tolerated (scan continues), the `parseRolloutContext` robustness bar (`tests/providers.test.ts:96`).
- nonce isolation: a tail containing **two** turns (and a decoy user message) returns only the turn whose user record carries the asked nonce.

**Verify.** `pnpm typecheck && pnpm test` — pure, no fakes beyond fixtures. **Depends on:** nothing.

## Slice 2 — the `transport` config knob

**Goal.** A validated `transport` field on the claude binding; config-file only; rejected for codex. Nothing consumes it yet — a clean, independently-green concept (the selection lives in config, validated once).

**Changes.**
- `src/config.ts`: add `transport?: 'headless' | 'interactive'` to `RoleBinding` (`:16`). In `parseBinding` (`:48`): accept `transport` only for `provider === 'claude'`, **throw for codex** mirroring the model-on-codex guard (`:59-63`), default to `'headless'` when a claude binding omits it (alongside the model default at `:64-66`). `parseRoleOverride` (`:71`) and the CLI grammar stay `provider[:model]` (spec: config-only opt-in — no CLI way to *enable* interactive).
- `src/config.ts`, override parsing + apply (`:71-75`, `:94-97`): **merge the override over the existing binding instead of replacing it**, and make the clobber *unrepresentable*. `parseRoleOverride` returns a distinct **`RoleOverride` type `{ provider, model? }` with no `transport` field at all** — the `provider[:model]` grammar cannot express transport, so override parsing must never manufacture a `transport:'headless'` that overwrites a configured `interactive`. The override-apply loop then **computes the effective transport in the merge**: when the override keeps the provider `claude`, carry the config binding's `transport` forward; default to `'headless'` only when the override changes the provider (e.g. `--impl codex`) or no config transport existed. This is why the type is separate from `RoleBinding` (whose `parseBinding` *does* default claude transport to headless) — a shared type is exactly how the clobber would creep back. Rationale under Finding 3 below — a model-only override must not silently flip a subscription-billed run back to metered headless.

**Tests** (`tests/config.test.ts`, beside the binding tests at `:13`):
- `[roles.implementer] provider="claude", transport="interactive"` parses to `{ provider:'claude', model:<default>, transport:'interactive' }`.
- a claude binding with no `transport` defaults to `'headless'`.
- `transport` on a **codex** binding throws (assert the message names codex), mirroring `:29`.
- an invalid `transport` value is refused by name.
- override-merge (Finding 3): `--impl claude:<model>` over a config `{claude, transport:interactive}` implementer **preserves** `transport:interactive` (only the model changes); `--impl codex` (provider change) drops transport; `--impl claude:<model>` with no config transport stays `headless`.
- override-merge, **no-model** override: `--impl claude` (bare, no model) over a config `{claude, transport:interactive}` **preserves** `transport:interactive` (the model defaults) — the case that catches a parser injecting a default headless.
- override-merge, **provider switch up to claude**: config `{provider:'codex'}`, override `--impl claude` or `--impl claude:<model>` → provider changed, so `transport` is the default `headless` (nothing to carry from a codex binding).

**Verify.** `pnpm typecheck && pnpm test`. **Depends on:** nothing.

## Slice 3 — cost surfacing under P5 (known/unknown)

**Goal.** An interactive turn (no `costUsd`) must read as **explicitly unavailable**, never a silent `$0.00`/partial. Provable now via `FakeWorker('claude')` with no cost — does **not** need the real transport.

**Changes.**
- `src/run-store.ts`: add `claudeWorkersCostPartial: boolean` to `costs` (`:91-94`); init `false` (`:180`). Additive → flows into `StatusModel.costs` (`src/status.ts:98,121`) and `--json` verbatim.
- `src/harness/tools.ts`: at the cost-accounting site (`:197`), when `provider.name === 'claude' && turn.costUsd === undefined`, set `state.costs.claudeWorkersCostPartial = true`. The invariant is **"a claude-worker turn reported no cost → the `claudeWorkersUsd` total is partial/unknown"** — *not* "this was interactive." `total_cost_usd` is optional in the envelope and only included when present (`src/providers/claude.ts:20,:96`), so the honest claim is about cost completeness, not transport. (If anything ever needs to know *interactive* specifically, it reads the binding's `transport` — never infers it from a missing cost.)
- `src/status.ts`: in `renderStatus` (cost line `:207-208`), when `claudeWorkersCostPartial`, annotate — e.g. `claude workers $N.NN known (+ interactive turns: cost unavailable)`. The `costs.claudeWorkersUsd` semantic becomes *known* Claude-worker cost.

**Tests.**
- `tests/tools.test.ts` (beside the cost test at `:66`): a `FakeWorker('claude')` turn with no `costUsd` sets `claudeWorkersCostPartial=true`; a claude turn **with** `costUsd` leaves it `false` and still accrues `claudeWorkersUsd`; a codex turn never sets it.
- `tests/status.test.ts`: `renderStatus` shows the "cost unavailable" annotation iff the flag is set (beside `:161`); the model-key-set pin (`:99`) still holds and `costs` carries the new sub-field (additive — top-level keys unchanged).

**Verify.** `pnpm typecheck && pnpm test`. **Depends on:** nothing (uses `FakeWorker`).

## Slice 4 — the interactive transport (driving + sub-seam + factory wiring)

**Goal.** `InteractiveClaudeWorker` drives one turn end-to-end **over fakes**: launch → readiness → submit(prompt+nonce) → watch+parse → teardown, bounded by one deadline, teardown on every path; selected by the factory. The real CLI behavior is the only thing deferred to Slice 5.

**Changes.**
- New `src/providers/pane.ts`: the **semantic** `PaneController` interface (`open`/`submitPrompt`/`pollReady`/`kill`) + `TmuxPane` adapter, which owns the terminal details internally (execa→tmux, run-scoped session distinct from the viewer; `load-buffer`+`paste-buffer -p` as its delivery strategy; `capture-pane` as its readiness probe; `kill-session`). Thin glue, deliberately untested (`docs/engineering.md:32`).
- `src/providers/interactive-claude.ts`: add the transcript **locator+reader** (find the turn's session file under `transcriptRoot` — by pinned id if minted, else by nonce-correlation: snapshot candidates before launch, select the new/modified file containing the nonce; pin thereafter) and `InteractiveClaudeWorker` (the orchestration). Launch mints a session id and passes **bypass permission mode** (P4, the posture at `src/providers/claude.ts:134`). The whole turn runs under one `timeoutMs` deadline; `runTurn` body is `try { … } finally { pane.kill() }` (best-effort, swallow + bound) so teardown fires on success, throw, and timeout. A stall/tmux error becomes a thrown `runTurn` error the `send_prompt` rail already handles (`src/harness/tools.ts:221`).
- `src/providers/index.ts`: in `createWorkers` (`:13`, branch `:17-25`), route `provider==='claude' && transport==='interactive'` → `new InteractiveClaudeWorker({ model, timeoutMs: rails.timeoutMs })`; else the existing `ClaudeWorker`.

**Helpers.** `FakePane` (in `tests/helpers/`): scriptable `pollReady` (ready after N polls / never), records `submitPrompt` calls (assert the **full prompt text**, **nonce presence**, **single submission**, and **ordering** relative to readiness — never terminal mechanics, which live inside `TmuxPane`), records `kill` calls, can throw on `open`/`submitPrompt`. A tmpdir-transcript helper grows the session file incrementally (real fs). Fake timers drive the deadline/poll (time is a system boundary — `docs/engineering.md` §"Testing strategy").

**Tests** (`tests/providers.test.ts`, over `FakePane` + tmpdir — **no live auth**):
- readiness loop: not-ready ×N then ready → `submitPrompt` called **once**, after ready.
- submission delivers the **full prompt text with the per-turn nonce, exactly once, after readiness** (no terminal mechanics asserted above the seam).
- bounded deadline — **readiness path**: never-ready → `runTurn` rejects within `timeoutMs` (advance fake timers); **`kill` was called** (teardown-on-timeout).
- bounded deadline — **watch path** (Finding 4): ready **and** submit succeed, but the transcript never appears / stays incomplete → `runTurn` rejects at `timeoutMs` (fake timers); **`kill` was called**. This is the load-bearing post-injection stall the spec's failure model bounds.
- happy path: as the tmpdir transcript grows to a complete turn, `runTurn` resolves to the parsed `WorkerTurn` (text/sessionId/tokens); **`kill` called once** (teardown-on-success).
- failure path: `submitPrompt`/parse throws → `runTurn` rejects **and `kill` still called** (the `finally`).
- session correlate — **happy**: the locator picks the transcript containing the nonce among **decoy** sibling sessions in the same root (the shared-slug hazard, spec §"Session identity").
- session correlate — **fails loudly** (Finding 4): **no** candidate contains the nonce → throws (a bounded `runTurn` failure the `send_prompt` rail handles), never silently picks a plausible file; an **ambiguous** match (nonce in >1 file — a should-not-happen) likewise throws rather than guessing.
- factory: an interactive implementer binding builds `InteractiveClaudeWorker`; a headless/default binding builds `ClaudeWorker` (extends `tests/providers.test.ts:103`).

**Verify.** `pnpm typecheck && pnpm test`. **Depends on:** Slice 1 (parser), Slice 2 (the `transport` field the factory reads).

## Slice 5 — live-auth verification handoff (human-run, write-only)

**Goal.** Hand the five live-auth checks to the human without the implementer ever launching an interactive session.

**Changes.**
- New `src/spike/interactive-transcript-capture.ts` — a runnable-by-human script (the repo's established executable-evidence home beside `q11.ts`/`repro-*.ts`, `docs/engineering.md:33`): against an **already-authenticated** interactive `claude`, drive one prompt through `TmuxPane` + the locator + `parseInteractiveTurn` and print the captured turn for eyeballing. Its header comment is the **checklist**: (1) billing meter draws the flat interactive quota, (2) bypass suppresses interactive prompts, (3) session pin-or-correlate is stable across resumed turns, (4) one injected prompt → one clean assistant message, (5) interactive `/compact` writes a recognizable boundary and preserves the session. Each names the byproduct: the real captured transcript becomes a corrected parser fixture (point 3) — a localized predicate fix if the vocabulary differs.

**Gating artifact (Finding 5).** The transcript the human captures is not just a check — it is the **fixture of record**: it replaces (or confirms) the hand-authored fixtures, and the parser + locator tests must run green against it before the mechanism is declared proven. If the real event vocabulary differs, the predicate (and, if needed, locator/watch) correction lands here, with the captured transcript as the new fixture — the spike is "proven" only past this gate.

**Implementer instruction (explicit).** This script is **written, never executed** by the AFK implementer; running it needs a real login that would block/fail the run. The implementation handoff / ship packet lists the five checks (and this gate) as the human's to-do.

**Verify.** `pnpm typecheck` (the script type-checks; it is **not** a test and **not** run in CI/AFK). **Depends on:** Slice 4.

---

## Tactical decisions (recorded; mine to make)

1. **Cost-partial means partial, not interactive (Finding 2, accepted).** The flag fires on `provider.name==='claude' && turn.costUsd===undefined` and means *"the `claudeWorkersUsd` total is partial/unknown."* It does **not** assert "interactive" — `total_cost_usd` is optional in the envelope (`src/providers/claude.ts:20,:96`), so claiming headless-always-reports-cost would lean on an unguaranteed contract. Anything needing *interactive* specifically reads the binding's `transport`, never the missing cost. (In practice interactive is the only current claude-without-cost case, but the surfaced semantic is the honest one.)
2. **Cost field = boolean** `claudeWorkersCostPartial` (not a counter). Minimal/additive; "the claude-worker total omits some turns' cost" is all the renderer needs. A counter is the trivial later upgrade if a number is wanted.
3. **CLI override *preserves* a configured interactive transport (Finding 3 — I conceded; verdict recorded).** I originally called the silent reset acceptable spike scope; the reviewer is right and I withdraw it. The feature exists to avoid metered headless spend, so a model-only override (`--impl claude:<model>`) silently flipping a subscription-billed run back to headless is precisely the billing surprise the feature must prevent — "spike" narrows the *verification* bar, not the *correctness* bar. Fix is localized to override parsing + apply (`src/config.ts:71-75,:94-97`): `parseRoleOverride` returns a distinct `RoleOverride` type `{provider, model?}` with **no `transport` field** (override transport is non-authoritative — the grammar can't express it), and the merge computes the effective transport (carry forward when the provider stays claude; default headless on a provider change or absent config transport). The separate type makes the clobber unrepresentable rather than merely avoided. Tested in Slice 2 (five merge cases, incl. the bare-`--impl claude` and codex→claude edges). The inverse — a CLI way to *force* headless for one run — stays a deferred grammar expansion (no silent-billing risk in that direction, since you'd be opting *out* explicitly).
4. **`PaneController` is the migration seam.** tmux today, pty later, parser reused unchanged — the rider's ergonomic-production lever, made physical (`pane.ts`).
5. **Spike script lives in `src/spike/`**, write-only — the repo's executable-evidence pattern, not a test, not run AFK.

## Product/direction questions

None. All P-questions (P1–P5) are settled and carried; the open items are tactical (above) and recorded. The one public-surface touch — the additive `costs.claudeWorkersCostPartial` field the concierge `--json` consumes — is within the approved P5 scope and additive-only, so it is not a direction call. No need to pause the AFK run.

## Out of scope (plan-level, per spec)

Doc updates (docs phase); owned-pty adapter, phase-scoped pane reuse, read-only interactive, cost-from-tokens — all §"Path to production". No changes to the statechart, driver lifecycle, cooperative pause, phase table, or the tmux **viewer**.

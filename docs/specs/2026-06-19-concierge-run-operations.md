# Concierge run-operations

**Status:** Implemented (test-verified — 418 tests; live end-to-end + environment smoke tests pending; the codex `error` / `stream_error` / `turn_aborted` classification branch validated synthetically only — no real codex error transcript yet). **Date:** 2026-06-19. Plan: `docs/plans/2026-06-19-concierge-run-operations.md`. The surviving design is folded, present tense, into `docs/automation-design.md` and `docs/engineering.md`; this spec is kept as the dated proposal record.

## Summary

duet runs are supervised from *outside* the run — by a Claude Code concierge today, by the interactive `/duet` orchestrator tomorrow, and by the human at a terminal. Supervising is mostly answering one recurring question: **is this run healthy, waiting on my decision, or recoverably broken — and if it's waiting, what exactly do I type?** duet answers the *"what is it waiting on"* half well (the discriminated `stop` model with its next-command strings) and the *"is it healthy"* half almost not at all — so a supervisor leaves duet to hand-parse raw agent transcripts, which has already produced wrong answers in real dogfooding (a midnight time-sort bug that read stale transcripts; a "can't read the codex reviewer" claim that was false; a "retry loop" call that was actually one long reasoning turn). On top of that, the command used to *act* on a decision can hang a headless supervisor outright.

**What we're building.** Three things, in product terms:

1. **A health view.** A new `duet doctor` command answers "healthy / stuck / retrying / crashed?" per role — orchestrator, implementer, reviewer — from the workers' own transcripts, plus a connectivity probe and the duet-side phase state. It reads what the supervisor used to spelunk by hand, and reads it *exactly* (no timestamp guessing). The same machinery enriches the per-turn heartbeat so "is it stuck?" usually needs no command at all.
2. **Two structured signals, promoted from prose to fields.** "Is this gate a human decision?" becomes a `humanDecisions[]` list the orchestrator fills in its gate packet; "is this stop human-owned or an infra failure?" becomes a `cause: 'human' | 'infra'` on the queued-question stop. Both let a supervisor (or the interactive orchestrator) decide hold/resume-vs-escalate mechanically instead of inferring it from paragraphs.
3. **A hardened write path + a lean status digest.** The bare-flag editor hang is fixed for non-interactive callers, verbatim relay gets file/stdin input so the human's exact words never pass through shell quoting, and `status --brief` returns just the fields that drive the next action instead of the full multi-KB packet.

**Approach and scope.** A single shared substrate — `src/worker-health.ts` — does the transcript locating and error classification once; the `doctor` command, the heartbeat, and crash classification are three *surfaces* over it, not three parsers. Everything except `doctor` is additive: new fields on the existing `StatusModel`, a new renderer, an opt-in lifecycle policy, and new input forms on `continue`. The error taxonomy and per-role probe are ports of two prototypes already verified against real run history (`.duet/proto/errscan.py`, `.duet/proto/doctor.py`).

**The boundary once this lands.**

- **Fixed:** the supervisor can read worker health from inside duet, exactly mapped; the heartbeat distinguishes thinking from hung; infra failures are machine-distinguishable from human-owned questions; the write path can't hang a headless caller or mangle quoted text; the full status packet is no longer re-parsed on every poll.
- **Not changing (preserved):** the statechart and its two-vocabulary gate guarantee; gate-crossing mechanics (`gates_at` pre-authorization + the human's tap remain the *only* way a gate crosses); `state.json` is a hint, transcripts are truth; the orchestrator does triage, never substance.
- **Explicitly deferred** (one line each): *auto-actuation on `humanDecisions`* — duet never conditions a gate-crossing on it, by the rider; it stays a signal the concierge/interactive orchestrator reads. *Concierge skill + CLI-reference text* naming the new verb/flags and the safe write forms — documentation, deferred to post-implementation per the framing (see "Documentation deferral and the skill-test guard" below for how the test stays green at build time without a doc task in the plan). *Auto-retry default-on* — stays opt-in; default-off preserves the "return to a well-formed question, never silent churn" contract.

---

## How supervision works today (current → desired)

The position/decision half is mature. `status.ts:buildStatusModel` joins `RunState` with `probeRunPosition` (`lifecycle.ts`) into a discriminated `StopModel` (`running | interactive | gate | flag | crashed | abandoned | done`), each carrying its acting command; `--json` is that model verbatim, additive-only, with its key-set pinned by `tests/status.test.ts` (`tests/skill.test.ts` is a *different* guard — it pins CLI↔docs coherence, not the schema).

The health half is absent, and the data to fix it is mostly already on disk:

- **Sessions are persisted; their transcripts are never surfaced.** `RunState.workerSessions` + `orchestratorSessionId` hold the ids, `bindings[role].provider` the provider, and `sessions.ts:locateSessionTranscripts` already resolves either to an on-disk path (it's what `--purge` deletes). `status.ts` simply never exposes the join. The prototype's codex `⚠ heuristic match (cwd+recency)` exists only because the script didn't read `state.json`; in production the map is exact.
- **The heartbeat knows only elapsed time.** `tools.ts` `send_prompt` emits `⏳ turn running — Nm elapsed` — which can't tell a 12-minute reasoning turn from a hang.
- **There are two distinct crash surfaces, and they should stay distinct.** A caught infra error inside a turn (`driver.ts` `runPhase` catch, and the abnormal-result path in `driveTurn`) sets `pendingQuestion` and parks the run at a **`flag`** stop with a prose question — the same channel as a real product question. A *driver-process death* is what `probeRunPosition` reports as **`crashed`** (no durable question, no live driver). The fix classifies the **flag** case; `crashed` is unchanged.
- **The write path hangs non-interactive callers.** `framing.ts:resolveHumanText` returns an inline string verbatim but opens `$EDITOR` (`composeInEditor`, `stdio:'inherit'`) for a bare flag — `commander` hands back `true` for a bare `--approve`/`--reject`/`--answer`, so a headless concierge blocks on the editor it can't drive.

Desired end state: the supervisor reads health and liveness from inside duet, exactly mapped; the two delegation signals are structured; the write path is un-hangable and quoting-safe; and none of the run's integrity invariants move.

```
                         BEFORE                                   AFTER
 health question     hand-parse raw ~/.claude & ~/.codex     duet doctor  (exact map, classified)
                     transcripts (guess role by mtime)       + enriched heartbeat
 "is it a decision?" read the prose packet, pattern-match    stop.packet.humanDecisions[]
 "human or infra?"   read the prose question, infer          stop.cause = human | infra (+ errorClass)
 status read         full StatusModel incl. KB packet        status --brief  (lean projection)
                     on every poll                           (full --json still available)
 role→session        not surfaced                            status --json .sessions[] (id only)
 act on a decision   bare --approve → $EDITOR → hang         bare --approve → no rider (non-TTY);
                                                             --reject/--answer file & stdin forms
 transient crash     parks at a flag, hand-resumed 3–4×      opt-in bounded auto-retry (default-off)
```

---

## The shared substrate — `src/worker-health.ts`

**Coupling decision: one substrate, three surfaces — not three parsers.** `#1` (doctor), `#2` (heartbeat), and `#4a` (crash cause) all need the same capability: *given a run, locate each role's transcript exactly and extract liveness + classified errors.* Implementing the taxonomy and the two-schema transcript reading once, in `worker-health.ts`, is the design; re-deriving it in the command, the heartbeat, and the driver would be three copies of a parser whose subtlety (below) is exactly where copies drift. The module sits alongside `sessions.ts` — it becomes the *second* module that reads outside `.duet/` (into `~/.claude` and `~/.codex`), so keeping the read logic cohesive with the existing locator keeps that boundary auditable. Reading is benign; only `--purge` deletes.

The substrate has three parts:

**1. The exact session map (the enabler), split by cost.** All three voices' ids and providers are already in `state.json` (`orchestratorSessionId` + `workerSessions` + `bindings`), so the enabler is a derivation, not new persistence. But it splits across the hot/cold boundary (the correction from review #1+#2):

- **Cheap, on the hot path — `resolveSessions(state)` → `[{ role, provider, sessionId }]`** (`role: orchestrator | implementer | reviewer`). A pure state read: **no path, no transcript scan.** This is the field `status --json` exposes (`sessions[]`), so the polled hot path stays a state-only read. It is named `sessions[]`, not `workers[]`, because the orchestrator is a `Voice`, not a worker (#1). **Known sessions only (#1):** `orchestratorSessionId` and each `workerSessions[role]` are optional until that role's first turn completes (`run-store.ts`), so a role with no session yet is simply **absent** from `sessions[]` — never an entry with a null id. `doctor` reports such a role as `idle` (no session, nothing to read).
- **Heavy, off the hot path — id → path resolution.** `locateSessionTranscripts` does a *recursive* `~/.codex/sessions` scan (O(all codex sessions ever)) plus a `~/.claude/projects` scan — fine for `--purge`, far too heavy for every `status --json --wait`. So path resolution and all transcript reads live **only** in `worker-health.ts`, used by `doctor`, the heartbeat, and crash classification — never by `status`. `doctor --json` surfaces the resolved `sessionPath` per role, so the concierge gets exact paths from the command that already does the heavy reads.

Either way the codex correlation is exact (the persisted `sessionId` + provider), retiring the prototype's `cwd+recency` heuristic — and "no new persistence / cheap hot path" are now both true, because the hot-path field carries the id, not the scanned path.

**2. The error taxonomy (ported from `errscan.py`).** Classes, in **first-match-wins order** (login/quota before bare-auth before transient), each carrying an action:

| Class | Recoverable? | Action |
|---|---|---|
| `login-required` (`Please run /login`, `Invalid API key`, expired token) | **No** | escalate — human must re-auth |
| `quota-billing` (`credit balance is too low`, `insufficient_quota`, `usage limit … reached`) | **No** | escalate — billing/quota |
| `auth` (bare `403 Request not allowed`, `authentication_error`, `Unauthorized`) | Ambiguous | resume **once**; immediate repeat → treat as `login-required` |
| `rate-limit` (`429`, `529`, `Overloaded`, `temporarily limiting requests`) | Usually | backoff; fatal only if retries exhaust |
| `network` (`ConnectionRefused`, `ECONNRESET`, socket closed, `fetch failed`, `ETIMEDOUT`) | Yes | resume / bounded retry |
| `dns` (`ENOTFOUND`) | Often | usually a *worker tool* call (npx/ctx7), not the API — note, don't escalate as API |
| `server` (`500 Internal server error`, repeated 529) | Usually | retry |

The detection rules that **must survive the port** (they are what make the projection honest, not the class list):

- **Error-bearing records only — never free-text grep.** claude: `isApiErrorMessage:true` assistant records or `type:"result", is_error:true`; codex: explicit error events or a `function_call_output` carrying a hard failure signature. This is why discussion *about* a 403 in a transcript is never counted as a 403.
- **Classify on the *terminal* event, not `api_retry`.** `api_retry` events carry no usable status (`error:"unknown"`, `error_status:null`); the HTTP class only appears in the terminal outcome (the synthetic `API Error: …` assistant message or the `is_error` result).
- **`429`/`529` are mostly *successful* transient retries.** Raw counts run into the thousands because the SDK retries ~10× and recovers; a rate-limit only *matters* when it exhausts retries and becomes a terminal `is_error`. Counting raw 429s as failures would mislead badly.
- **codex tool *successes* are not errors** (`exited with code 0` is skipped) — the v1-prototype bug that produced 69 false positives.
- **A `403` paired with `Please run /login` is `login-required`, not transient `network`** — the recurring-403 nuance the prototype caught: a bare 403 is `auth` (resume once), a 403 carrying `/login` is `login-required` (escalate, never loop).

**3. The per-role health probe (ported from `doctor.py`).** For a role's transcript: last-activity age (newest *timestamped content* record — skipping trailing metadata records, the `494961h` bug the prototype fixed), retry count this turn, recent classified errors, and a **verdict** drawn from a fixed set:

`idle` · `working` · `long-inference` · `retrying` · `silent/stuck` · `crashed`

— derived by joining transcript-write recency, retry accumulation, and the duet-side in-flight signal (the persisted `activeTurns` hint, below, reconciled against driver liveness): a turn in flight for this role but a quiet transcript past a threshold ⇒ `silent/stuck`; quiet-but-recent ⇒ `long-inference`; recent terminal error ⇒ `crashed`; no turn in flight ⇒ `idle`.

---

## The new command — `duet doctor`

**Coupling decision: a new verb, not a `status` flag.** `doctor` does cross-schema transcript tail-reads and a network connectivity probe; `status` (especially `--wait`, which the supervisor polls) reads only `.duet/`-local files and must stay cheap and uniform. The two answer different operator intents asked at different times — *health* while a phase runs, *position* at a stop. A flag with `doctor`'s behavior is not a smaller surface than a verb; it is the same heavy behavior spelled as a flag, while making `status`'s cost non-uniform and burying a network call behind a status read. The rejected alternative (`status --health`) lost on coherence: distinct cost/dependency profile + a network call belong behind their own verb. The cost of a verb is near-zero — the rest of the change adds no commands — and `doctor` is the *only* new command. The firm line that keeps it small: **`doctor` is strictly the health/liveness/connectivity renderer, never a third position surface.** The lean *position* digest is `status --brief`; the cheap worker map lives in `status --json`; only `doctor` reads transcripts and the network.

`duet doctor [runId] [--json]` reports, per role: the verdict, last-activity age, retry count, recent classified errors, the resolved `sessionPath`, the duet-side phase state, and a one-shot connectivity probe that distinguishes "network down" from "API reachable, auth rejected" (the two need different responses — see `#4`). `--json` emits the full health model for automation (including the resolved paths). It defaults to the latest run, like every other verb.

**The role-level in-flight source (#6).** A verdict needs to know not just *when* a role's transcript was last written, but whether that role is *supposed to be writing right now* — otherwise "quiet" can't be split into `long-inference` (this role is mid-turn) vs `idle` (this role finished; another is running). Today that signal is `send_prompt`'s `turnsInFlight` set, which is **in-memory inside the tools instance** (`tools.ts`) — invisible to a separate `doctor` process. The spec adds a small **persisted `activeTurns` hint** to `state.json`: `Partial<Record<WorkerRole, { tag, startedAt }>>`, set at a `send_prompt` turn's start and cleared in its `finally`. `doctor` reads it and reconciles against driver liveness (`aliveDriverPid`) + transcript recency — an `activeTurns` entry under a dead driver is a turn that was interrupted, not one in flight. This is chosen over the prototype's driver-log text-scrape (which couples `doctor` to the heartbeat's log wording) and over relying on the phase-level position probe (which can't name the role). It is a hint like everything in `state.json` — stale-after-crash is acceptable because doctor cross-checks it; it does not replace the in-memory `turnsInFlight` concurrency guard, which stays as-is.

Two structural constraints on this hint (#6):

- **Worker-only; the orchestrator is not in it.** `activeTurns` is keyed by `WorkerRole` (`implementer | reviewer`) — it says nothing about the orchestrator, which doesn't run through `send_prompt`. `doctor` derives **orchestrator** liveness from driver/phase liveness instead: the driver pid is alive and the phase is mid-flight ⇒ the orchestrator is the voice that's working; a quiescent stop ⇒ idle. So `doctor`'s three rows have two liveness sources — `activeTurns` for the two workers, driver+phase state for the orchestrator.
- **Set/clear via fresh load-and-merge, never a closed-over save.** The same hazard the existing `send_prompt` result-merge guards against (`tools.ts` — a stale full-object save clobbering a sibling role's concurrent update) applies to `activeTurns`: parallel cross-role sends are legal, and under the run-scoped MCP host each call may hold its own `RunState` copy. So writing `activeTurns` must `loadRunState` → mutate just this role's entry → `saveRunState`, synchronously, exactly as the turn-result merge already does — not persist the call-start `state`.

---

## The additive status surface

All four below are **additive fields/renderers on the existing one-derivation-two-renderers `StatusModel`** — extension of an existing concept, not a parallel one. Two distinct guards apply: the **key-set pin** (`tests/status.test.ts` — a `Object.keys(model).sort()` assertion) must be **extended additively** in the same implementation commit that adds each new field (an implementation task, not a doc task — so it stays green throughout); the **CLI↔docs coherence pin** (`tests/skill.test.ts`) is a separate concern handled in the doc-deferral section. Nothing is renamed or removed.

- **`sessions[]` in `status --json`** — the cheap exact map `[{ role, provider, sessionId }]` from `resolveSessions` (#1+#2: `sessions`, not `workers`, since the orchestrator is a voice; `sessionId`, not `sessionPath`, so the hot path does no scan). It's what concierge automation needs to correlate; the resolved *path* and the *transcript-derived* verdicts live in `doctor`, off the hot path.
- **`status --brief` renderer (`#5`)** — a lean projection: position/`machineState`, `stop.kind`, a one-line headline, the exact next command, `pendingSteers`, `autoApprovals`, and `humanDecisions`. The full packet stays one `status` call away; pure token efficiency, no information loss. **Flag-combination contract (#8) — the three flags are orthogonal axes that compose:** `--brief` selects the *projection* (lean vs. full), `--json` selects the *renderer* (machine vs. human text), `--wait` selects the *timing* (block until the next stop, then print). So `status --brief` = lean human text; `--brief --json` = lean JSON; `--brief --wait` = block, then print lean human text; `--brief --json --wait` = block, then print lean JSON. No precedence to resolve — each axis is independent. The lean JSON is a **derived projection, not a verbatim subset**: it carries a computed one-line `headline` (the gate packet's first non-empty line, the same derivation `status.ts`'s `packetHeadline` already does for `autoApprovals`) that the full `StatusModel` does not expose as a top-level field. Every *other* brief field is taken straight from the full model; only `headline` is derived.
- **`humanDecisions[]` on the gate packet (`#3`)** — `advance_phase` gains an optional `human_decisions: [{ title, severity }]` parameter (the orchestrator is already writing those "things for you to decide" sections by hand), surfaced as `stop.packet.humanDecisions[]`, with a prompt nudge to populate it. **`severity` is a fixed two-value enum `'low' | 'high'`** (#8): `high` = a genuine product/direction decision the human must make; `low` = notable but not blocking. The two values keep the concierge's read mechanical — the doc's "empty / all-`low` → safe to relay an approve; any `high` → hold and escalate" is unambiguous (a third bucket would reintroduce the judgment #3 exists to remove). **Signal-only, by the rider:** consumed by the concierge / interactive orchestrator to decide hold-vs-relay; duet never reads it in the gate-crossing path. The orchestrator-prompt change lives in `orchestrator-prompts.ts`; the tool param in `tools.ts`; the field in `status.ts`.
- **`cause` + `errorClass` on the `flag` stop (`#4a`)** — the queued-question shape (`pendingQuestion`) gains optional `cause: 'human' | 'infra'` and `errorClass` (a taxonomy class, infra only). The split is the supervisor's actual decision — **escalate vs. resume/retry** — not "product vs infra" (#5): `ask_human` covers product *and* environment actions *and* blockers *and* "asked twice" escalation, all **human-owned**, so an `ask_human`-originated flag is `cause:'human'`; an infra-caught failure is `cause:'infra'` + `errorClass`, classified via the substrate's taxonomy from the terminal error signature. Product-decision specificity is carried separately by `humanDecisions[]` at gates, not by squeezing it into `cause`. **All three infra surfaces are covered (#4):** `driver.ts`'s `runPhase` catch, the `driveTurn` abnormal-result path, **and** `stdio-host.ts`'s boundary-failure catch (`runPhaseOverStdio`) — leaving the last out would preserve a prose-only failure path this change exists to eliminate. The `crashed` *position* (process death, observed by `probeRunPosition`) is untouched — the two crash surfaces stay distinct, as today.

---

## The enriched heartbeat (`#2`)

The `send_prompt` heartbeat in `tools.ts` calls the *same* `worker-health.ts` probe for the in-flight worker and formats last-activity age + retry count into the existing line (e.g. `… 15m elapsed · last activity 8s ago · 0 retries`, or `… RETRYING (attempt 4/10, last: ConnectionRefused)`), instead of a second parser. One degradation, named: the heartbeat for a worker's *very first* turn in a run has no session id yet (it's learned only when the turn returns), so turn-1 falls back to elapsed-only; every resumed/subsequent turn gets the full line. This is best-effort telemetry — a missing reading is an absent detail, never a failed turn.

---

## The opt-in auto-retry policy (`#4b`)

**Coupling decision: a driver-owned policy that consumes the shared taxonomy — its own mechanism, not the lifecycle's and not part of the substrate.** Ownership is the **driver**, not `lifecycle.ts` (#3): the actionable error detail lives where the failure is caught — `runPhase`'s catch and the `driveTurn` abnormal-result path (`driver.ts`) — *before* a flag is persisted. `probeRunPosition` only observes durable state and never sees the caught error, so classification and the retry decision must happen in the driver, ahead of any flag; the lifecycle (`driveToQuiescence`) is unchanged and simply consumes the eventual `phase.*` event. On a caught failure the driver classifies via `worker-health.ts`; if the class is **recoverable** and retry budget remains, it re-enters the phase in-process through the *existing* session-resume recovery path after a backoff, rather than persisting the flag. The recoverable/escalate split is exactly the taxonomy's action column:

- **Auto-retry (when enabled):** `network`, `server`, exhausted-`rate-limit`.
- **Escalate immediately, never retried** (by the rider): `login-required`, `quota-billing`, persistent `auth` (an immediate repeat of a bare `403`), and any unclassifiable/`unknown` failure (e.g. a budget-cap abnormal end — needs a human top-up, not a retry).
- **`dns`** is noted, not escalated as an API failure — it's usually a worker's own tool call, which the worker may self-recover.
- **Exhaustion always falls back to a flag** (by the rider) — "every stop needs a next command" holds; a bounded retry that runs out becomes the same actionable queued question as today.

**Scope: the headless in-process driver only (#4).** Auto-*retry* applies to the headless AFK path (`_drive` → `runPhase`), where unattended retry is the whole value. The `stdio-host.ts` boundary-failure path is the *interactive* host (a human is present) — it gets the same `cause:'infra'` + `errorClass` **classification** (so the concierge sees infra-vs-human), but **not** auto-retry; the human resumes. This is the explicit include/exclude #4 asked for: classification on all three surfaces, retry on the headless driver.

**Knobs, default-off.** The policy is engaged by a fixed harness-consumed value, paralleling `gates_at`: a `--retry-infra <n>` flag and a `retry_infra:` framing-frontmatter key (it qualifies under the frontmatter boundary rule — fixed value, deterministic consumer; `framing.ts` parses it, `cli.ts` carries the flag). **Absent ⇒ no auto-retry — the current behavior, byte-for-byte.** The attempt count is persisted as a `state.json` hint so retries stay bounded even if the driver process itself dies and is re-spawned mid-recovery.

---

## The write-path correctness fix (`#6`)

**Coupling decision: independent, shipped first.** This fix shares nothing with the substrate and currently breaks the advertised headless path, so it lands early and on its own. The resolution path (`framing.ts:resolveHumanText`, used through `cli.ts:stageContinueText`) becomes **non-TTY-aware and intent-aware**:

- **bare `--approve` on a non-TTY ⇒ approve with no rider** (no editor) — a rider is only staged when non-empty, so this is a true no-rider approval, matching today's `--approve " "` workaround.
- **bare `--reject` / `--answer` on a non-TTY ⇒ fail fast** with an explicit message naming the inline / file / stdin forms — an empty reject or answer is meaningless and must not silently abort or hang.
- **TTY behavior is unchanged** — a human at a terminal still gets the editor.
- **Verbatim-relay input forms:** `--reject-file <path>` / `--answer-file <path>` and stdin (`@-`) so the human's exact words (apostrophes, newlines, em-dashes) never pass through shell quoting. The same intent-aware resolution serves these.

The behavioral fix removes the trap regardless of documentation; aligning the concierge skill / CLI-reference text (which still show the bare form, and don't yet name the file forms or `doctor`) is **deferred doc work** per the framing — see the next section for why that's still test-clean.

---

## Documentation deferral and the skill-test guard (#7)

The framing's "defer all documentation work; no doc tasks in the plan" is a hard rule. It interacts with one existing guard: `tests/skill.test.ts` asserts that `references/cli-reference.md` **documents every public command** — so the new public `duet doctor` command makes that assertion red until the reference names it. (The new *flags* — `--brief`, `--reject-file`, `--answer-file` — do **not** trip the guard: it checks the docs→CLI direction for flags, and CLI→docs only for *commands*.)

This is reconciled **by sequencing, and by knowingly accepting a red window — not by relaxing the rule**. The CLI reference is updated by the deferred `/update-docs` step in the docs phase; **no CLI-reference edit enters the implementation plan.**

The factual shape (corrected from a draft error — `pnpm build` runs **only `tsdown`**; the chained command is **`prepack`** = `pnpm typecheck && pnpm test && pnpm build`, `package.json`):

- **`tests/skill.test.ts` — and therefore the whole `pnpm test` suite, and therefore `prepack` — is knowingly RED from the moment `duet doctor` lands until the deferred `/update-docs` updates the reference.** This is not only a human-at-the-Ship-gate observation: *any* `pnpm test` run during the impl→docs window fails on the "reference documents every public command" assertion.
- **The AFK implementation phase must treat that specific redness as expected and deferred** — the missing-`doctor`-in-reference failure is the *known* consequence of the docs deferral, not a regression to chase by editing docs. (The orchestrator is surfacing this consequence to the human at the commit-spec gate regardless.)
- **`tests/status.test.ts` stays green throughout** — its key-set pin is extended additively in the same commit that adds each field (implementation work), so the schema guard never goes red.
- **The final `pnpm build` (tsdown only) is unaffected** by the test redness; the suite returns to green once `/update-docs` names `doctor` in the reference, before the PR opens.

If accepting that red impl→docs window is ever judged unworkable, that is a stop-and-escalate — but it is workable here: the single failing assertion is precisely scoped, expected, and self-resolving at `/update-docs`.

---

## Behaviors that matter (high-level; cases & fixtures designed later)

- **Substrate honesty:** the taxonomy classifies real terminal errors and produces **zero** false positives from prose *about* errors (the errscan methodology guarantee, verified on the concierge's own transcript); codex tool successes are never flagged; classification reads the terminal event, not `api_retry`; raw 429/529 are not counted as failures.
- **doctor exactness:** each known role maps to its transcript via the persisted `sessionId` (no heuristic; a role with no session yet is reported `idle`); verdicts are correct across `idle / working / long-inference / silent-stuck / crashed`, with the workers' `long-inference`-vs-`idle` resolved by the `activeTurns` hint reconciled against driver liveness and the orchestrator's by driver+phase liveness; the connectivity probe distinguishes down-vs-auth-rejected; it stays fail-soft.
- **`status --json` hot path:** exposes `sessions[]` (`{role, provider, sessionId}`) from a state-only read — no transcript scan, even under `--wait`.
- **`#6`:** non-TTY bare `--approve` approves with no rider and opens no editor; non-TTY bare `--reject`/`--answer` fail fast; file and stdin forms relay text verbatim, byte-for-byte; TTY behavior unchanged.
- **`#8` brief:** `--brief`, `--json`, `--wait` compose on independent axes (projection × renderer × timing); the lean JSON is a derived projection — every field but the computed `headline` is taken straight from the full `--json` model.
- **`#4a`/`#4b`:** an `ask_human` flag carries `cause:'human'`; an infra-caught failure on any of the three surfaces (`runPhase` catch, `driveTurn` abnormal, `stdio-host` boundary) carries `cause:'infra'` + a classified `errorClass`; the `crashed` *position* is unchanged; with the knob absent the headless run behaves exactly as today; the driver retries a recoverable class with budget remaining *before* persisting a flag; `login-required`/`quota`/persistent-`auth` escalate immediately; exhaustion flags; the interactive `stdio-host` path is classified but never auto-retried.
- **`#3`:** `humanDecisions` (with `severity ∈ {low, high}`) is surfaced in the packet and the `--json`/`--brief` models, and **never** affects gate-crossing (`gates_at` + the human tap remain the sole crossing).
- **Schema pinning (two distinct guards):** every new `StatusModel` field is additive; the **key-set pin in `tests/status.test.ts`** is extended additively in the same commit (stays green), and no field is renamed or removed. The **CLI↔docs pin in `tests/skill.test.ts`** is the *separate* "reference documents every public command" guard, knowingly red for the impl→docs window and resolved at `/update-docs` — see the doc-deferral section.

---

## Phases (sequencing designed later — no commit order)

1. **Enabler + substrate.** `resolveSessions` (cheap, for `status`) + `src/worker-health.ts` (id→path resolution + taxonomy + per-role probe), the `activeTurns` hint, and `sessions[]` in `status --json`. Unblocks `#1`, `#2`, `#4a`.
2. **`#6` write-path correctness fix.** Independent; lands early.
3. **The additive signals.** `duet doctor` (`#1`), enriched heartbeat (`#2`), `status --brief` (`#5`), `humanDecisions[]` (`#3`), `cause`/`errorClass` on the flag stop (`#4a`).
4. **Opt-in auto-retry policy (`#4b`).** Consumes the taxonomy; default-off; the `--retry-infra` / `retry_infra` knobs.

---

## Open questions (tactical — recorded, decided in implementation)

- **Verdict thresholds.** Adopt the prototype's defaults as the starting point (active < ~60s quiet, long-inference < ~30m) and treat them as tunable constants; not a product call.
- **Connectivity probe target(s).** Probe the provider endpoints actually bound for the run (claude → Anthropic; codex → its endpoint), best-effort, rather than a single fixed host; degrade to a one-line "probe failed" on error.
- **`cause`/`errorClass` placement.** Extend the `pendingQuestion` shape with the optional fields (additive) so the existing flag persistence carries them; no new top-level state. (Settled in-section: `cause: 'human' | 'infra'`, `errorClass` infra-only.)
- **Retry attempt-count + backoff shape.** Persist the count as a `state.json` hint (survives driver restarts); exponential backoff with a cap, best-effort — defaults chosen in implementation.
- **First-turn heartbeat.** Accept elapsed-only on a worker's first turn (no session id yet); do not add a recency heuristic to recover it.
- **`activeTurns` hint shape.** A per-role map keyed by `WorkerRole` (`{ tag, startedAt }`), set at `send_prompt` start and cleared in its `finally`; reconciled by `doctor` against driver liveness. Distinct from the in-memory `turnsInFlight` concurrency guard (which stays). Exact field name decided in implementation.

# Plan — Concierge run-operations

**Status:** Implemented (test-verified — 418 tests; live end-to-end + environment smoke tests pending; codex error-envelope classification validated synthetically only). **Date:** 2026-06-19. Spec: `docs/specs/2026-06-19-concierge-run-operations.md`.

Implements `docs/specs/2026-06-19-concierge-run-operations.md`. This plan is written to be **workable end-to-end by an AFK implementer** off this file alone: every tactical open question the spec recorded is decided here, with concrete constants, field shapes, file/line anchors, fixtures, and per-slice tests. Where the spec and the commit-spec **rider** differ, the rider wins (it relaxes the doc-deferral narrowly — see "Docs" below).

If a genuinely *blocking product/direction* question surfaces mid-implementation (not a tactical one), stop and flag it — do not guess. None is expected; the rider settled the two that mattered (`humanDecisions` signal-only; auto-retry opt-in/default-off).

---

## Decisions that bind every slice (the spec's recorded open questions, resolved)

- **Verdict thresholds** (constants in `worker-health.ts`): `WORKING_MAX_QUIET_MS = 60_000`; `LONG_INFERENCE_MAX_QUIET_MS = 1_800_000` (30 min); `RECENT_ERROR_MS = 180_000` (3 min). Ages compared against an injected `now` (never `Date.now()` inside pure functions — pass it in, for determinism).
- **Verdict precedence** (per role, highest first): `crashed` (a terminal classified error newer than `RECENT_ERROR_MS`) → `retrying` (in-flight **and** ≥1 `api_retry` in the current turn's tail, no terminal error) → `working` (in-flight, quiet < 60s) → `long-inference` (in-flight, quiet < 30m) → `silent/stuck` (in-flight, quiet ≥ 30m) → `idle` (no turn in flight, or no session/transcript).
- **In-flight source + turn-scoping (`inFlightSince`, #3)**: the probe must scope "this turn's" retries/recency to a turn-start timestamp, or it counts stale retries from older turns and mislabels a quiet later turn `retrying`. So `probeRole` takes `inFlightSince?: number` (**its presence IS the in-flight signal** — no separate boolean) plus `retriesSince?: number` (the retry-attribution anchor; `retrying` is eligible **only** when it's set). The composer supplies them per role: **workers** → both = `activeTurns[role].startedAt`, reconciled against `aliveDriverPid` (a hint under a dead driver ⇒ both undefined ⇒ not in flight); the **orchestrator** → `inFlightSince = now - RETRY_WINDOW_MS` (`RETRY_WINDOW_MS = 120_000`, a liveness/recency window since it has no per-turn marker — *approximate*, noted in the row) **with `retriesSince` omitted**, so a prior-turn `api_retry` inside the window can never produce a false `retrying` (#3). `inFlightSince` undefined ⇒ `idle` (or `crashed` on a recent terminal error). The heartbeat passes the worker's `activeTurns[role].startedAt` as `retriesSince` so "N retries" means "this turn."
- **`activeTurns` shape** (new optional `RunState` field): `activeTurns?: Partial<Record<WorkerRole, { tag: string; startedAt: string }>>`. Set at a `send_prompt` turn's start, cleared in its `finally`, **always via fresh `loadRunState` → mutate this role's entry → `saveRunState`** (the existing result-merge discipline, `tools.ts:318`), never a closed-over save. Distinct from the in-memory `turnsInFlight` concurrency guard, which stays.
- **`cause`/`errorClass` placement**: optional fields on the existing `pendingQuestion` (`RunState`, `run-store.ts:128`): `cause?: 'human' | 'infra'`, `errorClass?: ErrorClass` (infra only). Additive; no new top-level state.
- **`sessions[]`**: always present in the `StatusModel` (empty array when no sessions yet), so it's an unconditional key. Entries are **known sessions only** — a role whose session id is still absent (`orchestratorSessionId`/`workerSessions[role]` optional until its first turn) is omitted, never a null-id entry.
- **`humanDecisions` severity**: fixed enum `'low' | 'high'`.
- **Retry knob + budget**: `retryInfra?: number` on `RunState` (0/absent ⇒ off). Set from `--retry-infra <n>` (on `duet new`) or framing frontmatter `retry_infra:` (flag wins, mirroring `gatesAt`). Backoff: `delayMs(attempt) = min(30_000, 2_000 * 2 ** attempt)`. Attempt count persisted as `retryState?: { attempts: number; lastClass?: ErrorClass }` on `RunState` so the cap holds even across a driver re-spawn.
- **Connectivity probe**: best-effort `fetch` (injectable), ~6 s timeout. For any **claude**-bound role, probe `https://api.anthropic.com/v1/models`; map `no response / timeout → down`, `401/403 → reachable-but-auth-rejected`, any HTTP response → `reachable`. **codex** connectivity is best-effort/optional — if its endpoint is unknown, report `not probed` rather than guess. Any throw → one-line `probe failed`. Never load-bearing.
- **First-turn heartbeat**: when the in-flight worker has no session id yet, the heartbeat prints elapsed-only (no recency/retry suffix). No recency heuristic.
- **Heartbeat retry line**: show the **count**, not a fabricated class — `RETRYING (N retries)`, not `last: ConnectionRefused`. Per the taxonomy rule, `api_retry` carries no usable status; a class exists only at a *terminal* error (which ends the turn). The spec example's `last: …` was illustrative; do **not** synthesize a class mid-turn.

### The `ErrorClass` taxonomy (ported from `.duet/proto/errscan.py:32`)

Ordered, **first-match-wins**: `login-required` → `quota-billing` → `auth` → `rate-limit` → `network` → `dns` → `server` → (`unknown`). Signatures and recoverability exactly as the spec table (§"The error taxonomy") and the prototype. Recoverability for the retry policy:

- **Auto-retry (recoverable):** `network`, `server`, `rate-limit`.
- **`auth` retries exactly once (#2 — the spec/prototype "resume once" intent):** a *first* `auth` (when `retryState.lastClass !== 'auth'`) is recoverable — retry once. A *second consecutive* `auth` (`retryState.lastClass === 'auth'`) is persistent → **escalate as `login-required`**, no further retry, even with budget remaining. So `auth` never burns more than one attempt.
- **Escalate immediately (never retry):** `login-required`, `quota-billing`, `unknown`.
- **`dns`:** classified and noted, **not** auto-retried (usually a worker's own tool call); surfaces as `cause:'infra'` + `errorClass:'dns'` if it reaches a phase flag.

(All of the above is the *retry policy*, gated on `retryInfra ≥ 1`. With retry off — the default — every infra failure simply flags, classified with `cause:'infra'` + `errorClass`; the "resume once" / escalate distinctions only take effect when retry is opted in.)

- **Transcript tail size (#6):** `readRoleTranscriptTail` reads the **last 256 KiB** (`262_144`) of the transcript and **discards the partial leading line** (begin parsing at the first newline), so `doctor`/heartbeat never read a whole multi-MB JSONL. Matches the prototype's ~200 KB tail (`doctor.py:41`).

Detection rules that **must** survive the port (these are the honesty guarantees, tested explicitly):
1. **Error-bearing records only** — claude: `isApiErrorMessage:true` assistant **or** `type:'result', is_error:true`; codex: explicit error event payloads **or** a `function_call_output` carrying a hard signature. Never free-text grep.
2. **Classify on the terminal event, not `api_retry`** (which logs `error:'unknown'`, `error_status:null`).
3. **codex `function_call_output` containing `exited with code 0` is a success — skip it.**
4. **Raw `429`/`529` are not failures** unless they appear in a terminal `is_error`/`API Error:` record (SDK retries recover them).
5. **A `403` carrying `Please run /login` is `login-required`, not `network`/`auth`** (order handles this).

---

## Cross-cutting test & verification rules (every slice)

- **Per slice:** run that slice's vitest files (`npx vitest run <files>` / `-t <name>` during the loop), and **typecheck only the changed files via a reliable scoped check** — editor/LSP diagnostics on the changed `.ts` files (or whatever scoped check is genuinely sound in the environment). **Do NOT** use a file-list `npx tsc --noEmit <files>`: under this repo's NodeNext / `.ts`-extension `tsconfig.json` it doesn't behave like the project check and produces config-skew false errors/misses. And **do NOT** run a global `pnpm typecheck` per slice — the framing's per-slice rule is changed-files-scoped. No lint (project has none).
- **Final, once, after all slices:** **`pnpm prepack`** (= `pnpm typecheck && pnpm test && pnpm build`). This is the framing's "final verification, run once" with the **real typecheck restored** — bare `pnpm build` is tsdown only and does *not* typecheck, so it would let type errors through; `prepack` is the single end gate (and `pnpm build` alone is insufficient). The full suite is green here because the `doctor` slice carries its minimal CLI-reference update (Slice 4) and every new field carried its pin update in-slice. (This expansion of the framing's literal "final = `pnpm build`" is being surfaced to the human at the gate.)
- **Schema-pin discipline:** any slice that adds a top-level `StatusModel` field extends the `Object.keys(model).sort()` assertion in `tests/status.test.ts:122` **in the same commit** (only Slice 2's `sessions` is top-level; `humanDecisions`/`cause`/`errorClass` are nested in `stop`, so they extend the per-`stop` `toEqual` assertions at `tests/status.test.ts:70–105` instead). This keeps `tests/status.test.ts` green throughout.
- **Mock only at the seams** (`docs/engineering.md` §Seams): `WorkerProvider` (`FakeWorker`), `RunOrchestratorTurn` (scripted SDK turn), `Orchestrate` (scripted stdio client), and the **environment** (`$EDITOR` via `vi.stubEnv`, an injected `isTTY`, an injected `fetch` for connectivity, and an injected `home` dir for transcript location — the same `home` param `sessions.ts:57`/`purgeRun` already take). Never mock our own modules; filesystem/git run real in tmpdirs.
- **Pure parsers take strings, not paths** — mirror `codex.ts:25 parseRolloutContext` ("the testable parsing seam"): `worker-health.ts`'s classifier/probe operate on JSONL text + injected `now`, tested directly with fixtures; the thin fs wrapper (locate via `sessions.ts` + tail-read) is tested via planted tmp transcripts under a fake `home`.
- **Commit per slice**, conventional message (suggested messages below). One slice = one commit.

### Shared fixtures to add — `tests/helpers/transcripts.ts`

Builder helpers returning JSONL **strings** (composable; behavior-focused, not whole captured files):

- `claudeApiError(text, { ts? })` → an assistant record with `isApiErrorMessage:true` and `content:[{type:'text',text}]`.
- `claudeResultError(result, { ts? })` → `{type:'result', is_error:true, result}`.
- `claudeAssistantText(text, { ts? })` → a *normal* assistant text record (the **discussion-not-error** case — must classify to zero hits).
- `claudeApiRetry({ ts? })` → `{type:'system', subtype:'api_retry', error:'unknown', error_status:null}`.
- `claudeTurnEnd({ ts? })` / `claudeUserToolResult({ ts? })` → recency/activity records.
- `codexFunctionOutput(output, { ts? })` → `{payload:{type:'function_call_output', output}}` (use `exited with code 0` for the success case).
- `codexErrorEvent(text, { ts? })` / `codexTokenCount(total, window, { ts? })`.
- `jsonl(...records)` → join with newlines; helpers to plant a built transcript at the right `~/.claude/projects/<slug>/<id>.jsonl` or `~/.codex/sessions/.../rollout-<ts>-<id>.jsonl` under a fake `home` (reuse the path shapes in `sessions.ts:29,47`).

Reuse the real `examples/claude-code-session.jsonl` and `examples/codex-session.jsonl` for one end-to-end "healthy/idle real transcript parses without false errors" sanity test per schema.

---

## Slices

Six slices. Order chosen so the substrate lands before its consumers and the suite stays green; #6 (write-path) is independent and goes first as the correctness fix. The spec's 4 phases are reorganized: phase 1 splits into Slice 2 (substrate + `sessions[]`) and Slice 3 (`activeTurns` + heartbeat); phase 3's signals split into Slice 4 (doctor) and Slice 5 (gate-decision signals); phase 4 = Slice 6.

### Slice 1 — Write-path correctness (#6)

**Goal.** A non-interactive caller can never hang on `$EDITOR`, and verbatim text can arrive without shell-quoting. Independent of the substrate; ships the correctness fix first. **No doc change needed** (it adds flags, not commands; `tests/skill.test.ts` only pins commands, and the docs→CLI flag check isn't tripped by un-named new flags).

**Changes.**
- `src/framing.ts:247 resolveHumanText` — add an injectable interactivity signal: `resolveHumanText(inline, instructions, { isTTY = Boolean(process.stdin.isTTY) } = {})`. Behavior: inline string → verbatim (unchanged); bare flag (`true`/`undefined`) **and** `isTTY` → editor (unchanged); bare flag **and not** `isTTY` → return a sentinel meaning "no text supplied, non-interactive" (e.g. `undefined`) **without** invoking the editor. It stays intent-agnostic; the caller decides.
- `src/cli.ts:207 stageContinueText` — resolve text in priority order: (1) `--reject-file`/`--answer-file` value (a path, or `-` for stdin) read verbatim; (2) inline string; (3) `resolveHumanText` (editor when TTY, sentinel when not). Map the sentinel **per intent**: approve → no rider (don't call `stageHumanInput`); reject/answer → `fail(...)` naming the inline / `--*-file` / stdin forms. Empty file/stdin content for reject/answer also fails (unchanged "empty aborts" semantics).
- `src/cli.ts:258 continue` command — add `--reject-file <path>` and `--answer-file <path>` options (a `<path>` of `-` reads stdin). **`-`-means-stdin is a deliberate refinement** of the spec's illustrative `@-` — one uniform convention across both flags, no `@` prefix to parse. No `--approve-file` (out of scope; approve has the bare no-rider path).
- A small stdin reader (injectable for tests), or read `process.stdin` when path is `-`.

**Tests** (`tests/framing.test.ts` for `resolveHumanText`; a new `tests/continue-input.test.ts` — or extend an existing file — for `stageContinueText`, driving it on a `run` fixture and asserting what got staged via `loadRunState`):
- `resolveHumanText`: inline string → verbatim (regression). Bare + `isTTY:true` → editor invoked (fake `EDITOR`, returns text). Bare + `isTTY:false` → returns the sentinel, **editor not invoked** (assert via an `EDITOR` script that would write a marker file — marker absent).
- `stageContinueText` non-TTY: bare `--approve` → no `approval` staged, no editor (run advances plain). Bare `--reject` → throws/`fail` with a message naming file/stdin. Bare `--answer` → same.
- `--reject-file <tmp>` with apostrophes + newlines + em-dash → `feedback` staged byte-for-byte. `--answer-file <tmp>` → `answer` staged verbatim.
- `--reject-file -` (stdin, injected) → verbatim. Empty file → reject/answer fail.
- TTY + bare approve → editor path taken (regression that the human flow is unchanged).

**Verify.** `npx vitest run tests/framing.test.ts tests/continue-input.test.ts`; scoped diagnostics on the changed files (`src/framing.ts`, `src/cli.ts`) per the verification rules — no file-list `tsc`, no global typecheck.
**Commit.** `fix(continue): non-TTY-safe + file/stdin write path for gate decisions`

### Slice 2 — Health substrate + `sessions[]` enabler

**Goal.** The deep module `src/worker-health.ts` (taxonomy + per-role probe, pure), plus the cheap session map surfaced in `status --json`. Ships an observable enabler and builds+tests the riskiest logic in isolation.

**Module boundaries (#1 — keep `worker-health.ts` pure; avoid the import cycle).** `lifecycle.ts:18` value-imports `describeStop` from `status.ts`, so if `status.ts` value-imported `worker-health.ts` and `worker-health.ts` value-imported `lifecycle.ts` (for `aliveDriverPid`), the runtime chain `status → worker-health → lifecycle → status` would close a cycle. Prevent it structurally:
- `worker-health.ts` is **pure** — taxonomy + scans + probe only. **No** import of `lifecycle`/`status`/fs. (Type-only imports of `WorkerRole`/`Voice` are fine — erased.)
- The cheap state map and the fs tail-read go in **`sessions.ts`** (already the "session identity / outside-`.duet`" module; it imports only node-fs + a `config` type today, so `status → sessions` introduces no cycle). `resolveSessions`/`readRoleTranscriptTail` use **`import type { RunState }`** from `run-store.ts` (run-store value-imports `sessions`, so the `RunState` import must be type-only to stay erased).
- Doctor composition/render/connectivity (which need `aliveDriverPid` + phase) go in a new **`doctor.ts`** in Slice 4 — only `cli.ts` imports it, so no cycle.

**Changes.**
- `src/worker-health.ts` (new). Pure, string-in:
  - `type ErrorClass` + `classifyError(text): ErrorClass` (ordered regex table from `errscan.py:32`).
  - `scanTerminalErrors(jsonl: string, schema: 'claude'|'codex'): Array<{ ts, class, text }>` — the error-bearing-records-only scan (rules 1–5 above).
  - `probeRole(jsonl: string, opts: { schema; now: number; inFlightSince?: number; retriesSince?: number }): { verdict, lastActivityAgeMs?, retries, recentErrors }` — last-activity from the newest **timestamped content** record (skip trailing metadata — the `doctor.py:61` `494961h` bug); `inFlightSince` is the in-flight/recency anchor (undefined ⇒ not in flight ⇒ `idle`/`crashed`); `retries` is counted at/after `retriesSince` and **`retrying` is eligible only when `retriesSince` is defined** (a true turn-start). Verdict by the precedence above. (#3 — workers pass `retriesSince`; the orchestrator omits it, so a window-derived liveness anchor can never yield a false `retrying`.)
- `src/sessions.ts` — add `resolveSessions(state): Array<{ role: Voice; provider: 'claude'|'codex'; sessionId: string }>` (cheap, state-only, **known sessions only**, no fs) and `readRoleTranscriptTail(state, role, { home?, maxBytes = 262_144 }): { jsonl: string; schema: 'claude'|'codex'; path: string } | undefined` — the thin fs wrapper over `locateSessionTranscripts` (`:57`). It **returns the selected `path`** so `doctor.ts` doesn't locate twice (#1), and is **deterministic on multi-match**: when `locateSessionTranscripts` yields more than one path, pick the **newest by mtime** and expose that one. It reads the **last `maxBytes`**; the partial-leading-line discard is **conditional on a nonzero read offset** (#6) — only drop the first line when the file exceeded `maxBytes` and the read seeked into it; a file ≤ `maxBytes` is read from offset 0 with **no** discard (else a small transcript's first record is lost). Both use `import type { RunState }`.
- `src/status.ts` — `StatusModel` (`:99`) gains `sessions: Array<{ role: Voice; provider: 'claude'|'codex'; sessionId: string }>`; `buildStatusModel` (`:120`) populates it via `resolveSessions` **imported from `sessions.ts`** (no scan). Always present (`[]` when none).
- `tests/status.test.ts:122` — add `'sessions'` to the key-set assertion (same commit).

**Tests** (`tests/worker-health.test.ts`, new; plus the status pin):
- `classifyError` via `test.for` over the taxonomy: each representative signature → its class; order cases (`403 + Please run /login` → `login-required`, bare `403` → `auth`; `429`/`Overloaded` → `rate-limit`; `ECONNRESET`/`fetch failed` → `network`; `ENOTFOUND` → `dns`; `500 Internal` → `server`; unknown text → `unknown`).
- **Honesty guarantees:** `claudeAssistantText('we hit a 403 and usage limits earlier')` → **zero** hits (discussion, not error-bearing). `codexFunctionOutput('… exited with code 0')` → zero. A run of `claudeApiRetry()` records with no terminal error → zero terminal errors (classify on terminal only). A terminal `claudeApiError('API Error: 429 …')` → one `rate-limit` hit.
- `probeRole` verdicts via `test.for` over `{ recency, inFlightSince, retriesSince, apiRetries, terminalErrorAge } → verdict`: `inFlightSince` set + write 8s ago → `working`; + 12 min quiet → `long-inference`; + 40 min quiet → `silent/stuck`; `inFlightSince` + `retriesSince` set + an `api_retry` newer than `retriesSince` → `retrying`; an `api_retry` **older** than `retriesSince` + quiet recent write → **not** `retrying` (the #3 staleness case); **`inFlightSince` set but `retriesSince` omitted (the orchestrator-window case) + an `api_retry` inside the window → NOT `retrying`** (falls through to recency: `working`/`long-inference`); terminal error 30s ago → `crashed`; `inFlightSince` undefined → `idle`. Last-activity skips trailing metadata records (assert age is from the content record, not 1970).
- Real-transcript sanity: `examples/claude-code-session.jsonl` and `examples/codex-session.jsonl` → `scanTerminalErrors` returns no spurious hits; `probeRole` yields a sane (non-1970) age.
- `tests/sessions.test.ts` (or a sessions section): `resolveSessions` — orchestrator + both workers present → 3 entries with right provider/id; a role with no session id → **omitted**; codex reviewer carries `provider:'codex'`. `readRoleTranscriptTail` against a planted transcript (fake `home`) **larger** than 256 KiB → returns ≤256 KiB, the partial first line discarded (first parsed record is intact JSON), and a `path`; a transcript **smaller** than 256 KiB → read from offset 0 with **no** discard (its very first record survives — the #6 edge case); on multiple located paths → returns the **newest by mtime**; a missing transcript → `undefined`.
- Status pin: the key-set test includes `sessions`; a `run` with set sessions → `sessions[]` shape correct; a fresh run → `sessions: []`.

**Verify.** `npx vitest run tests/worker-health.test.ts tests/sessions.test.ts tests/status.test.ts`; scoped diagnostics on the changed files (`src/worker-health.ts`, `src/sessions.ts`, `src/status.ts`) per the verification rules.
**Commit.** `feat(health): worker-health substrate (taxonomy + probe), sessions map + sessions[] in status --json`

### Slice 3 — `send_prompt` telemetry: `activeTurns` hint + enriched heartbeat (#2)

**Goal.** Durable, cross-process "which worker is mid-turn," and a heartbeat that distinguishes thinking from hung. Groups all `send_prompt` telemetry edits in one slice (so the locus isn't spread).

**Changes.**
- `src/run-store.ts` — `RunState` gains `activeTurns?` (shape above). Add tiny helpers `markTurnActive(state, role, tag)` / `clearTurnActive(state, role)` that **load → mutate one role → save** (fresh-merge discipline; mirror `tools.ts:318`).
- `src/harness/tools.ts` `send_prompt` — at turn start (near `turnsInFlight.add`, `:284`) call `markTurnActive(state, role, tag)`; in the `finally` (`:375`, beside `turnsInFlight.delete` + `clearInterval`) call `clearTurnActive(state, role)`. Heartbeat (`:289–296`): when `state.workerSessions[role]` exists, read the tail via `sessions.readRoleTranscriptTail` and probe via `worker-health.probeRole` with `inFlightSince = activeTurns[role].startedAt`, then append `· last activity <age> · <N> retries` (or `· RETRYING (N retries)` when retries present — **count only, never a fabricated class**) to the existing `⏳ … Nm elapsed` line; when no session id yet → elapsed-only. Any read/probe failure → elapsed-only (never throws).

**Tests** (`tests/tools.test.ts`):
- `send_prompt` sets `activeTurns[role]` (assert via `loadRunState` mid-turn using a `FakeWorker` whose `runTurn` checks disk before resolving) and clears it in `finally` — including the **error path** (`FakeWorker` throwing → `activeTurns` cleared).
- **Concurrency:** two parallel cross-role sends (implementer + reviewer) each set their own entry without clobbering the other's (the fresh-merge guarantee) — both present mid-flight, both cleared after.
- Heartbeat enrichment is best-effort: with a planted transcript (fake `home`), the heartbeat line carries the recency/retry suffix; with no session id (first turn) it's elapsed-only; a transcript-read failure degrades to elapsed-only, never throws (assert the turn still succeeds). Use fake timers for the 5-min interval (as existing heartbeat tests do).

**Verify.** `npx vitest run tests/tools.test.ts`; scoped diagnostics on the changed files (`src/harness/tools.ts`, `src/run-store.ts`) per the verification rules.
**Commit.** `feat(health): persist activeTurns and enrich the send_prompt heartbeat`

### Slice 4 — `duet doctor` command + connectivity (+ minimal CLI-reference update)

**Goal.** The health view as a command. The **only** new public command. Consumes the substrate + `activeTurns` + driver/phase liveness; adds the connectivity probe. Because it's a public command, this slice **includes** the rider-permitted minimal reference update so `tests/skill.test.ts` (and the full suite) stays green within the commit.

**Changes.**
- `src/doctor.ts` (**new** — #1: composition lives here, *not* in pure `worker-health.ts`, so the cycle stays broken; only `cli.ts` imports it). `buildDoctorModel(state, { now, home, fetch })` → per-role `{ role, provider, sessionPath?, verdict, lastActivityAgeMs?, retries, recentErrors, inFlight }` + `phase` + `connectivity`; and `renderDoctor(model)` (human text). It composes: `sessions.resolveSessions` + `sessions.readRoleTranscriptTail` → `worker-health.probeRole`/`scanTerminalErrors`. The model's `sessionPath` is the **`path` the tail reader returns** (no second `locateSessionTranscripts` call — #1). **Worker** liveness: `inFlightSince` **and** `retriesSince` both from `activeTurns[role].startedAt` reconciled against `aliveDriverPid` (`lifecycle.ts:56`) — a hint under a dead driver ⇒ both undefined ⇒ `inFlight:false`. **Orchestrator** liveness: driver-alive + phase-mid-flight, passing `inFlightSince = now - RETRY_WINDOW_MS` (a liveness/recency window, approximate) **but omitting `retriesSince`** — so the orchestrator can read `working`/`long-inference`/`silent-stuck`/`idle` but **never `retrying`** (#3: a prior-turn `api_retry` falling inside the 120s window must not be misattributed as an active retry — `retrying` needs a true turn-start, which the orchestrator lacks). Connectivity via injected `fetch` (decision above). Imports `lifecycle` for `aliveDriverPid` — legal because nothing imports `doctor.ts` except `cli.ts`.
- `src/cli.ts` — new `doctor` command: `duet doctor [runId] [--json]`, defaulting to latest run (mirror the `status` wiring `:632`). `--json` emits the doctor model (incl. resolved `sessionPath`); bare prints `renderDoctor`.
- `skills/duet-concierge/references/cli-reference.md` + `skills/duet-concierge/SKILL.md` command-menu — add the **literal command line** for `duet doctor` (one row each). **Minimal only** — no narrative/prose beyond the menu entry (the broader skill prose stays for `/update-docs`). This is the rider's narrow relaxation; it keeps `tests/skill.test.ts:83` ("reference documents every public command") green.

**Tests** (`tests/doctor.test.ts`, new, for the model/renderer; `tests/skill.test.ts` already enforces the doc pin):
- `buildDoctorModel` integration on a `run` with planted transcripts (fake `home`): orchestrator/implementer/reviewer verdicts correct for a parked run (all `idle`) and for an in-flight run (`activeTurns` set + driver pid alive → `working`/`long-inference`); a role with no session → `idle`, no path. Codex reviewer maps exactly (no heuristic).
- **Stale-hint reconciliation (#5):** `activeTurns[role]` present but the driver pid is dead/stale → `inFlight:false`, so the role is `idle`, **never** `long-inference`/`silent-stuck`. (This is the correctness reason for reconciling the hint against liveness.)
- Connectivity: injected `fetch` returning 200 → `reachable`; 403 → `reachable-but-auth-rejected`; throw/timeout → `down`; the whole probe failing never throws (model still returns, `connectivity: 'probe failed'`).
- `--json` shape includes `sessionPath` per known role; `renderDoctor` shows one line per role with the verdict.
- `tests/skill.test.ts` passes (the reference + menu now name `duet doctor`).

**Verify.** `npx vitest run tests/doctor.test.ts tests/skill.test.ts`; scoped diagnostics on the changed files (`src/doctor.ts`, `src/cli.ts`) per the verification rules.
**Commit.** `feat(doctor): duet doctor health view + connectivity probe`

### Slice 5 — Gate-decision signals: `humanDecisions` (#3) + `status --brief` (#5)

**Goal.** Make the gate decision mechanical for the supervisor: the structured decisions list the orchestrator fills, plus the lean digest that surfaces it. **Signal-only** — nothing here touches gate-crossing.

**Changes.**
- `src/harness/tools.ts:480 advance_phase` — add an optional `human_decisions: z.array(z.object({ title: z.string(), severity: z.enum(['low','high']) })).optional()` param; persist onto the phase packet (`phaseSummaries[phase]`, extend its shape in `run-store.ts:125` with optional `humanDecisions`).
- `src/harness/orchestrator-prompts.ts` — a short nudge in the advance/gate-packet prompt to populate `human_decisions` (the orchestrator already writes these sections; this asks for the structured echo). **Carry the signal-only boundary in the wording**: it informs the human/concierge, it does not gate.
- `src/status.ts` — the `gate` `StopModel` packet (`:85`/`:153`) carries `humanDecisions` when present. Add `renderBrief(model)` + a `--brief` projection: `{ position/machineState, stopKind, headline, nextCommand, pendingSteers, autoApprovals, humanDecisions }`; `headline` derived via the existing `packetHeadline` (`:193`). `--brief` composes with `--json` (lean JSON) and `--wait` (timing) as orthogonal axes.
- `src/cli.ts:632 status` — add `--brief`; route `(brief, json)` to the four render/projection combinations; `--wait` unchanged (blocks, then renders per the flags).
- `tests/status.test.ts` — extend the gate-stop `toEqual` (`:70`) for the optional `humanDecisions`; add brief-projection tests.

**Tests** (`tests/status.test.ts`, `tests/tools.test.ts`):
- `advance_phase` with `human_decisions` persists them; the gate `StopModel.packet.humanDecisions` carries them; absent param → field omitted (additive). **Gate-crossing is unaffected** — assert that a gate still crosses only on `human.*` regardless of `humanDecisions` content (a `high`-severity decision does not auto-hold or auto-cross anything; reuse the existing machine/lifecycle gate test path).
- Brief projection: lean model carries exactly the named fields + a derived `headline` (gate packet first non-empty line); `--brief --json` is the lean JSON; lean text via `renderBrief`. The full `--json` model is unchanged (regression on the key-set pin).
- `severity` enum rejects values outside `low|high` (zod).

**Verify.** `npx vitest run tests/status.test.ts tests/tools.test.ts`; scoped diagnostics on the changed files (`src/status.ts`, `src/cli.ts`, `src/harness/tools.ts`, `src/harness/orchestrator-prompts.ts`, `src/run-store.ts`) per the verification rules.
**Commit.** `feat(status): humanDecisions packet signal + status --brief digest`

### Slice 6 — Infra crash classification + opt-in auto-retry (#4a + #4b)

**Goal.** Infra failures become machine-distinguishable from human-owned questions across all three flag-producing surfaces, and the headless driver can be told to bounded-retry transient infra before flagging. **Default-off**; login/quota/persistent-auth never retried; exhaustion always flags.

**Changes.**
- `src/run-store.ts` — `pendingQuestion` gains optional `cause?: 'human'|'infra'`, `errorClass?: ErrorClass`; `RunState` gains `retryInfra?: number` and `retryState?: { attempts: number; lastClass?: ErrorClass }`.
- `src/harness/tools.ts:412 ask_human` — set `cause:'human'` on the queued question (it is always human-owned).
- `src/harness/driver.ts` — classify on the two infra surfaces and apply retry **before** persisting a flag:
  - `runPhase` catch (`:115–129`): classify `err` (prefer the orchestrator-transcript terminal signature via `worker-health.scanTerminalErrors`, else `err.message`); compute recoverability per the Decisions split — `network`/`server`/`rate-limit` always recoverable; **`auth` recoverable only when `retryState.lastClass !== 'auth'` (first occurrence — retries once)**; `auth` repeat / `login-required` / `quota-billing` / `unknown` not recoverable. If `retryInfra` set, recoverable, and `retryState.attempts < retryInfra` → increment `retryState` (record `lastClass`), log, await `delayMs(attempt)`, re-enter `drivePhase` (session resumes) instead of flagging; else set `pendingQuestion` with `cause:'infra'` + `errorClass` and return `phase.flag`. A second consecutive `auth` is reported as `errorClass:'login-required'` (persistent).
  - `driveTurn` abnormal-result path (`:226–234`, `subtype !== 'success'`): same classification onto the queued question (`cause:'infra'` + best-effort `errorClass`). A non-classifiable abnormal end (e.g. budget) → `cause:'infra'`, `errorClass:'unknown'` (never auto-retried).
  - On a clean phase outcome, reset `retryState` (so the cap is per-episode, not lifetime).
- `src/harness/stdio-host.ts:114 runPhaseOverStdio` catch — **classify only** (set `cause:'infra'` + `errorClass`); **no auto-retry** (interactive host, human present). The "twice ended" stuck flag (`:106`) stays `cause:'human'`-less or `infra`? It's an infra-stuck, classify `cause:'infra'`, `errorClass:'unknown'`.
- `src/status.ts` — the `flag` `StopModel` (`:169`) carries `cause`/`errorClass` when present.
- `src/framing.ts` — frontmatter schema (`:271`) + `FramingFrontmatter` + `resolveRunInputs` gain `retry_infra` (parse to a non-negative int; flag wins, mirroring `gatesAt`); `src/cli.ts new` adds `--retry-infra <n>`; `createRun` (`run-store.ts:218`) stores `retryInfra`.
- `tests/status.test.ts` — extend the `flag` stop `toEqual` (`:80`) for optional `cause`/`errorClass`.

**Tests** (`tests/driver.test.ts`, `tests/stdio-host.test.ts`, `tests/status.test.ts`, `tests/framing.test.ts`):
- Driver, retry **off** (`retryInfra` absent): a thrown `network` error → one `phase.flag`, `pendingQuestion.cause:'infra'`, `errorClass:'network'` — behavior otherwise byte-for-byte as today (regression).
- Driver, retry **on** (`retryInfra:2`, fake timers for backoff): a recoverable error then success → re-enters and completes, **no flag**, `retryState.attempts` advanced then reset on success. Exhaustion (3 recoverable failures, cap 2) → flags after the cap with `cause:'infra'`. `login-required`/`quota-billing` → **flag immediately**, no retry, even with `retryInfra:5`.
- **`auth`-once (#2):** first `auth` (`lastClass !== 'auth'`) with budget → retries once, then success → completes, no flag. `auth` then `auth` → escalates after **exactly one** retry: the second is flagged as `cause:'infra'`, `errorClass:'login-required'`, with **no** further retry even when `retryInfra` budget remains.
- `ask_human` flag → `cause:'human'`, no `errorClass`.
- `driveTurn` abnormal `subtype` → `cause:'infra'` (+ `errorClass:'unknown'` for a budget-style end). (Use the `RunOrchestratorTurn` seam to script an abnormal result.)
- stdio-host boundary failure (kill the peer via the `Orchestrate` seam) → `phase.flag`, `cause:'infra'`, and **never retries** regardless of `retryInfra`.
- Framing: `retry_infra: 2` in frontmatter → `state.retryInfra === 2`; `--retry-infra 3` overrides frontmatter; invalid value → actionable error.
- Status: `flag` stop surfaces `cause`/`errorClass`; absent when unset (additive regression on the existing flag-stop assertion).

**Verify.** `npx vitest run tests/driver.test.ts tests/stdio-host.test.ts tests/status.test.ts tests/framing.test.ts`; scoped diagnostics on the changed files (`src/harness/driver.ts`, `src/harness/stdio-host.ts`, `src/harness/tools.ts`, `src/status.ts`, `src/framing.ts`, `src/cli.ts`, `src/run-store.ts`) per the verification rules.
**Commit.** `feat(driver): classify infra-vs-human flags and opt-in bounded auto-retry`

---

## Final verification (once, after all six slices)

- **`pnpm prepack`** (= `pnpm typecheck && pnpm test && pnpm build`) — the single end gate. This restores the **real global typecheck** the framing's literal "final = `pnpm build`" omitted (bare `pnpm build` is tsdown-only and does not typecheck, so it would let type errors through). The suite is green: the `doctor` reference row landed in Slice 4, and every new top-level/`stop` field carried its `status.test.ts` pin update in-slice. (Global typecheck appears **only** here — never per-slice.)

## Not in this plan (deferred to post-implementation `/update-docs`)

All narrative docs: `README.md`, `docs/automation-design.md`, `docs/engineering.md`, and the **prose/examples** of `skills/duet-concierge/SKILL.md` beyond the literal `doctor` command-menu row. The only doc edit in the plan is the minimal `cli-reference.md` + SKILL.md command-menu entry for `duet doctor` (Slice 4), permitted by the rider solely to keep the test suite green as the public command lands.

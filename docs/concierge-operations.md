# Concierge & Run-Operations Field Notes

> **Status:** proposals + reference material — *not yet built*. This is **operational** (how
> we *observe and drive* runs from the outside), deliberately separate from
> `docs/future-directions.md` (which is product/feature direction). Keep feature ideas
> there; keep "make supervising a run less painful" here.
>
> **Audience:** whoever builds the supervision/observability primitives below — and the
> future interactive `duet` orchestrator, which needs most of the same machinery.

## Why this doc exists

These notes come from *dogfooding the concierge role*, not from theorizing. In one session a
Claude Code concierge supervised two real end-to-end runs and hit the same friction
repeatedly. The asks below are the primitives that friction kept demanding. Every item is
grounded in a concrete moment you can go read in the transcripts (see **Provenance**), so a
future engineer can verify the pain before building the fix.

The throughline: **the concierge (and the future interactive orchestrator) spends most of its
effort answering one question — "is this run healthy, stuck, or waiting on me?" — and duet
currently makes that question expensive and error-prone to answer.** Almost everything here is
about making run *state* and worker *health* cheap and unambiguous to read.

## Provenance (go read the actual session)

- **Concierge session transcript:** `~/.claude/projects/-Users-qiushi-dev-duet/07e802fe-3e8b-485c-8637-771dc0fa2cd1.jsonl`
  (long session; it was compacted/resumed, so later segments live under sibling session ids in the
  same directory — the harness forks a new id on resume).
- **Runs it supervised** (duet-side truth — driver logs, per-voice logs, state snapshots):
  - `.duet/runs/20260618-0148-1e14/` — **Stage 0** (host-neutral kernel). FRAME→PR fully autonomous
    overnight; **3 transient infra crashes recovered** (a network drop, a 403 auth error, a
    mid-response connection close); merged to `main` instead of opening a PR.
  - `.duet/runs/20260618-1651-f163/` — **Stage 1** (interactive `duet` orchestrator). FRAME gate
    rejected once for a user-perspective rewrite, a 5-question clarification round, then run
    autonomously under delegated gate-approval.
- **Worker transcripts** for those runs: see the **Transcript locations** reference below.

## Proposed improvements (ranked by how much pain they removed)

### 1. `duet doctor <run>` — a worker liveness / health view  ← highest leverage

**The pain (recurred 3–4×).** Every time the human asked "is the implementer/orchestrator stuck
or just working?", answering required leaving duet entirely and hand-spelunking raw provider
transcripts. Concretely, in this one session that meant:
- Guessing which `~/.claude/projects/<slug>/<uuid>.jsonl` belonged to which role (concierge,
  orchestrator, implementer, and *research sub-agents* all land in the same directory).
- Sorting by mtime — and hitting a **real bug**: a lexical sort of local-time strings wrapped past
  midnight and put the *newest* (00:xx) files last, so I initially read stale transcripts. (Use
  epoch mtime, never formatted-time strings.)
- Discovering the reviewer is **codex**, whose transcripts are **not** in `~/.claude/projects` at
  all — so I told the human "I can't read the reviewer," which was *wrong* (see Transcript
  locations; codex is readable, just elsewhere and in a different schema).
- Writing throwaway Python to scan for `api_retry` events and recent tool calls, then *judging*
  "long inference (healthy) vs retry storm (network) vs crashed."

This was the single most token-expensive, error-prone, repeated thing the concierge did. I once
told the human "it looks like a retry loop" and the transcript then corrected me to "it was one
long 12-minute reasoning turn." The data to be right was available; getting to it was the problem.

**The fix.** `duet doctor <run>` reads what I read by hand and reports, per role:

```
orchestrator (claude)  idle — awaiting workers
implementer  (claude)  turn in-flight 15m · last transcript write 8s ago · 0 retries · 4 tool calls   → WORKING
reviewer     (codex)   turn in-flight 5m  · last transcript write 3s ago                               → WORKING
```

The verdict the concierge keeps hand-deriving — `working | long-inference | retrying | silent/stuck
| crashed` — becomes one command. Add a one-shot connectivity probe so "network down" is
distinguishable from "API up, auth rejected" (those need different responses — see #4).

**Key enabler (cheap, do this first):** duet *already knows* each worker's session id — it spawns
them with `claude -p --resume <id>` (visible in `driver.log`). It just doesn't surface them.
**Persist `workers: [{role, provider, sessionPath}]` in `state.json`** (and expose in
`status --json`, additive). That single change deletes the entire "hunt for the right transcript by
mtime/cwd" problem that `doctor` would otherwise re-solve — and lets the concierge correlate the
codex reviewer to its rollout without timestamp guessing.

**Serves the new skill too:** the interactive `duet` orchestrator will want the same "are my
workers alive" view.

### 2. Enrich the driver heartbeat  ← the 80/20 of #1 (your "new logs format" idea)

`driver.log` today emits `implementer turn running — 15m elapsed`. "Elapsed" cannot distinguish
*thinking* from *hung* — which is exactly the ambiguity that forced every transcript dive in #1.
Enrich the existing heartbeat line:

```
implementer turn running — 15m elapsed · last activity 8s ago · 0 retries
implementer turn running — 12m elapsed · RETRYING (attempt 4/10, last: ConnectionRefused)
```

`last activity` = age of the newest write to that worker's transcript; `retries` = `api_retry`
count this turn. This one log-format change would have answered most "is it stuck?" questions with
zero transcript spelunking. It is strictly cheaper than #1 and shares its data source.

### 3. A structured "is this a human decision?" signal in the gate packet  ← makes AFK delegation safe

**The pain.** The human delegated "approve frame/spec for me *unless there's a major product
decision* — then hold." To honor that I had to read the full prose packet and *judge* whether a
"major product decision" was present. That is precisely the judgment the relay discipline says the
concierge must **not** improvise. It worked here only because the orchestrator happened to write an
explicit "Two things for you to decide" section — prose I pattern-matched.

**The fix.** An additive `stop.packet.humanDecisions: [{ title, severity }]` the orchestrator
fills (it already knows — it writes those sections by hand). Then the delegation becomes
mechanical: empty / all-low → auto-approve; any major → hold and notify. No English inference, no
risk of the concierge's judgment leaking into the run. The new interactive orchestrator needs the
same signal to know when to interrupt the human vs. proceed.

**Evidence both directions exist in one session:** the Stage-1 FRAME gate carried two genuine
product calls (security posture, packaging) → correctly *held*. The Stage-1 SPEC gate carried none
("every reviewer point was a technical encoding of the already-approved direction") → correctly
*auto-approved*. A boolean/severity field would have made both calls without reading paragraphs.

### 4. Classify infra-crash vs. product question, and bound the auto-retry

**The pain.** Transient infra failures (the 403s, the network drop) surfaced as
`stop.kind: "flag"` with a *prose* question — the **same channel** as a real product question only
the human can answer. The concierge had to *read the prose* to tell "this is infrastructure, resume
it" from "this is a product call, escalate," then hand-compose a resume `--answer`, 3–4 times.

**The fix, two parts:**
- **Mark the cause in the schema** — `stop.kind: "crashed"` (already exists for some paths) or
  `stop.flag.cause: "infra" | "product"` — so infra is auto-resumable without reading prose and only
  product flags escalate.
- **Bounded auto-retry policy at the driver** (opt-in, like `--gates-at`): retry a *classified-
  transient* infra crash N times with backoff, then escalate. The human literally said "keep it
  going" — that is a policy duet can own instead of the concierge babysitting. The classification
  must come from the **error taxonomy below**, because the right action differs sharply by class:
  network/429/529 → retry; `Please run /login` / quota → **never auto-retry, escalate immediately**.

### 5. A concise concierge status digest (`status --brief`)

**The pain (every supervision cycle).** The watch primitive `status --json --wait` returns the
**entire** status model — including multi-KB packet markdown — and the concierge `cat`s and
re-parses all of it on *every* stop. I also repeatedly wrote `python3 -c` one-liners to pull the
4–5 fields that actually drive the next action.

**The fix.** `status --brief` (or `--concierge`) returning just
`{ position, stop.kind, one-line headline, exact next command, pendingSteers, autoApprovals,
humanDecisions }`. Full packet stays available on demand. This is pure token efficiency with **no
information loss** — the full packet is one command away when a decision actually needs it.

### 6. An un-hangable, quoting-safe write path  ← a live bug, found the hard way

**The bug.** Bare `duet continue --approve` (and `--reject`, `--answer`) **open `$EDITOR`** to
compose the optional text (`resolveHumanText` in `src/framing.ts`: a string arg is used verbatim,
otherwise it `composeInEditor`). For a non-interactive concierge this **hangs** — `nvim` spawned,
nothing could drive it; I had to `pkill` it and re-run. The trap: the **shipped
`skills/duet-concierge/SKILL.md` documents the approve command in its bare form**
(`duet continue <run-id> --approve`), so a remote/headless concierge following the skill literally
will hang on its first clean approval.
- **Workaround that works today:** `--approve " "` (whitespace) — a string arg skips the editor, and
  a rider is only staged `if (rider.trim())`, so it is a *true* no-rider approval.
- **Doc fix (cheap):** the skill must say "always pass text inline; never use the bare form — it
  opens `$EDITOR`," and document `--approve " "` as the no-rider approval.
- **CLI fix (better):** detect a non-TTY (or a `--no-rider`/`--yes` flag) and skip the editor
  instead of blocking.

**Pairs with quoting safety.** The concierge hand-shell-quotes the human's *verbatim* reject/answer/
steer text (apostrophes, newlines, em-dashes). One quoting slip would silently mangle the exact
words that verbatim relay exists to preserve. Add `--reject-file <path>` / `--answer @-` (stdin) so
the human's text never passes through shell quoting. Together, #6 makes the relay write-path both
un-hangable and fidelity-safe.

## Prototypes (built and verified on real history)

Two runnable prototypes make the proposals concrete and — the point of the exercise — were
*verified against the real transcripts* to be an honest projection: no false positives, no missed
real errors. They live under self-ignored `.duet/proto/` (local prototypes, not productionized;
self-ignored so a live run can't sweep them into a commit).

- **`.duet/proto/errscan.py`** — the error detector (#1/#4). Scans only error-bearing records and
  classifies by the taxonomy below. Usage: `errscan.py <transcript.jsonl …>` or `--run <runId>`.
  - **Verified — catches real errors:** on Stage-0 it surfaced the actual infra failures
    (auth/network/login/dns), 13 across the run's transcripts.
  - **Verified — zero false positives from discussion:** run on the *concierge's own* transcript,
    which is full of prose *about* 403s and "usage limits," it reported exactly the **5** API errors
    the concierge actually hit and **none** of the discussion. The methodology guarantee, proven.
  - **A real bug verification caught (and I fixed):** v1 flagged codex tool *successes* (exit-code-0
    outputs) — 69 false positives. Fixed by requiring an explicit failure signature and skipping
    `exited with code 0`. Honest output being the whole point, this mattered.
  - Sample (the false-positive test — concierge transcript):
    ```
    2026-06-19T04:31:14  ⛔ login-required  ESCALATE — human must /login or re-auth
        └ Please run /login · API Error: 403 Request not allowed
    ── 5 terminal error(s) across 1 transcript(s) ──   by class: login-required=2, network=3
    ```

- **`.duet/proto/doctor.py`** — the worker-health view (#1). `doctor.py [runId]` → per-voice
  liveness (last-activity age, retries, recent activity, recent errors, verdict) + duet phase state
  + a connectivity probe.
  - **Verified** on the live Stage-1 run: correctly read orchestrator/implementer/reviewer as idle
    with sane ages while the run sat at the PR gate.
  - **A real bug verification caught (and I fixed):** it first printed `494961h ago` because it read
    trailing `[mode]`/`[last-prompt]` metadata records (no timestamp → 1970 epoch). Fixed to use the
    last *timestamped content* record.
  - **Honest limitation it exposes:** mapping the **codex** reviewer to a run is heuristic (cwd +
    recency) — fine for a live/recent run, unreliable for an old finished one; doctor labels it
    `⚠ heuristic`. This is exactly the motivation for **#1's enabler** (persist worker session paths
    in `state.json`): with it, the mapping is exact and the heuristic disappears.
  - Sample (live Stage-1 run, parked at PR gate):
    ```
    orchestrator (claude)  last 7m ago · 0 retries · text  → idle
    implementer  (claude)  last 8m ago · 0 retries · text  → idle
    reviewer     (codex)   last 28m ago · 9204k ctx-in     → idle   ⚠ heuristic match (cwd+recency)
    ```

These are throwaway prototypes (Python, no deps) that prove the shape works on real data; the
proposal is to fold their logic into `duet doctor` / `status --workers` with the session-path
enabler so the mapping is exact rather than heuristic.

## Reference: error-signature taxonomy (the detection core for #1 and #4)

Mined from local Claude Code history (`~/.claude/projects/**/*.jsonl`). The **action column is the
point**: it tells the concierge / auto-retry policy what to *do*, which is what the run needs.

| Class | Representative signatures (verbatim substrings) | Auto-recoverable? | Action |
|---|---|---|---|
| **Network / transport** | `Unable to connect to API (ConnectionRefused)`, `ECONNRESET`, `The socket connection was closed unexpectedly`, `Connection closed mid-response`, `fetch failed`, `FailedToOpenSocket`, `ETIMEDOUT` | Usually (transient) | Resume / bounded retry |
| **DNS (tool-level)** | `ENOTFOUND registry.npmjs.org` (e.g. a worker's `ctx7`/`npx` call) | Often | Often a *tool* failure inside a worker, not an API failure — worker may self-fallback; note it |
| **Auth — transient** | `403 Request not allowed`, `Failed to authenticate`, `authentication_error`, `Unauthorized` | Sometimes | Resume **once**; if it repeats immediately → treat as persistent (escalate) |
| **Login required** | `Please run /login` (seen paired: `Please run /login · API Error: 403 Request not allowed`) | **No** | **Escalate** — human must `/login`/re-auth. Do **not** loop. |
| **Quota / billing** | `credit balance is too low`, `insufficient_quota`, `Invalid API key`, `usage limit … reached` | **No** | **Escalate** — human action (billing / key / wait for reset) |
| **Rate-limit / overload** | HTTP `429`, `529`, `Overloaded`, `overloaded_error`, `Server is temporarily limiting requests (not your usage limit)` | Usually (SDK retries) | Wait/backoff; concern only if retries exhaust |
| **Server error** | `500 Internal server error`, `Repeated 529` | Usually | Retry |

**Critical nuances (or the detector will mislead):**
- **`api_retry` events carry no usable status.** In practice they log `"error":"unknown"`,
  `"error_status":null`. You **cannot** classify from the retry event — the HTTP status/class only
  appears in the *terminal* outcome: the synthetic `type:"assistant"` message whose text starts
  `API Error: …`, or the `type:"result"` with `"is_error":true`. Detect on the terminal event.
- **`429`/`529` are mostly *successful* transient retries**, not failures — their raw counts are
  enormous (thousands) because the SDK retries ~10× with backoff and *recovers*. A 429/529 only
  matters when it **exhausts retries and becomes a terminal `is_error`**. Counting raw 429s as
  "failures" would badly mislead.
- **The recurring 403 is login-required, not transient network — confirmed by `errscan`.** During
  these runs a `403 Request not allowed` recurred and was treated as a transient blip (it recovered
  on resume). But running `errscan` on the concierge's *own* transcript found
  `Please run /login · API Error: 403 Request not allowed` at `04:31` — the same window it was
  auto-resuming the Stage-1 403 crashes. So that 403 is the **login-required** class (human re-auth),
  and the right response is **escalate, not loop**. A bare 403 with no `/login` text is still
  ambiguous (resume once); a 403 carrying `Please run /login` should never be auto-retried.
- **Methodology trap (don't make the detector lie):** grepping raw history conflates *actual errors*
  with *discussion of errors*. In this very session, "usage limits" matched dozens of times mostly
  because the concierge's own transcript *discussed* the flat-quota transport — not because of
  failures. A real detector must scope to **error-bearing records** (`is_error:true` results;
  synthetic `API Error:` assistant text), not free-text grep over whole transcripts.

## Reference: where each voice's transcript lives (for #1)

| Voice | Location | Format / how to read health |
|---|---|---|
| **claude** (orchestrator headless, implementer, concierge, and their sub-agents) | `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl` (slug = cwd with `/`→`-`, e.g. `-Users-qiushi-dev-duet`) | JSONL; `type: assistant\|user\|system\|result`; `system/subtype:api_retry`; `type:result, is_error`. Health = newest-line age + retries + tool-call cadence. |
| **codex** (reviewer) | `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO>-<uuid>.jsonl`; index at `~/.codex/session_index.jsonl` (`{id, name, updated_at}`); logs in `~/.codex/log/` | **Different schema:** `type: response_item\|event_msg\|function_call\|reasoning\|token_count\|agent_message`. Context usage = `token_count` events. Match a run by `cwd` in the rollout header (`"cwd":"/Users/qiushi/dev/duet"`) + time window. |
| **duet** (the harness itself) | `.duet/runs/<id>/` → `driver.log` (orchestrator narration + heartbeats), per-voice `*.log` (prompt + 5-min heartbeats only — **not** the worker's internal steps), `state.json` (hint), `machine.json` (quiescent snapshot) | Plain text + JSON. `driver.log` is the fastest read for "what just happened"; per-voice logs do **not** show worker tool calls (that's why #1/#2 need the provider transcripts). |

**Correction to a mid-run claim:** the concierge told the human "I can't read the reviewer's
blow-by-blow." That was wrong — codex *is* readable, at the path above. It is only *absent from
`~/.claude/projects`* and in a different schema. `doctor` (#1) should read both schemas; persisting
worker session paths in `state.json` (#1's enabler) makes the codex correlation exact instead of
timestamp-guessed.

## Token-efficient inspection recipes (what actually worked)

The user's standing preference: **more information when it's valuable, never save tokens by losing
information or misleading.** These recipes honor that — they collapse volume without dropping signal:

- **Catalog, don't dump.** `grep -rhoE '<signature>' … | sort | uniq -c | sort -rn | head` returns
  the *distinct signatures + counts*, bounded by variety (small) not by file size (huge). This is how
  the taxonomy above was built cheaply.
- **Epoch mtime for "what's active now,"** never formatted-time strings (the midnight-wrap bug in #1).
  `stat -f %m` + arithmetic.
- **Parse `--json` for one field, not the eye.** A tiny `python3 -c` to pull `stop.kind` + the next
  command beats re-reading multi-KB packets — but #5 (`status --brief`) should make this unnecessary.
- **Read `driver.log` first.** For "what just happened," the orchestrator narration is the highest
  signal-per-token source; only drop to provider transcripts when you need worker-internal detail
  (the gap #1/#2 close).

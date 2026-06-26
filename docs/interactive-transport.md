# Interactive Claude worker transport

An **opt-in transport that drives the implementer through the interactive `claude` TUI** instead of headless `claude -p`, so its turns bill the developer's **flat subscription quota** rather than the metered Agent-SDK credit pool. Built as a **spike** — proven over fakes, with one live-auth gate still open. Augmentation holds throughout: same CLI, standard transcripts, manual `--resume` still works; default behavior is unchanged (headless).

- **Direction synthesized + approved:** Direction gate 2026-06-15.
- **Spec:** [`docs/specs/2026-06-15-interactive-claude-worker-transport.md`](specs/2026-06-15-interactive-claude-worker-transport.md) — full deliberation, P-decisions, the change flow.
- **Plan:** [`docs/plans/2026-06-16-interactive-claude-worker-transport.md`](plans/2026-06-16-interactive-claude-worker-transport.md) — the five vertical slices.
- **Code:** `src/providers/interactive-claude.ts` (parser, locator, worker), `src/providers/pane.ts` (the `PaneController` seam), wired in `src/providers/index.ts`, knob in `src/config.ts`.

## Why

Since **2026-06-15**, headless `claude -p` and the Agent SDK draw from a **separate, capped "Agent-SDK credit" pool** priced at standard API rates — not the flat interactive quota (automation-design §"Layer 3 — Workers"; the economics finding under open-questions Q11). The only way to spend the flat quota is to drive the **interactive** TUI. The implementer is where this bites: it is the cost driver (~$85 of the ~$93 first real planlab run was claude workers). Codex is unaffected — `codex exec` already bills the ChatGPT subscription — so this is **claude-implementer-only** and codex is out of scope.

Set `transport = "interactive"` on the claude implementer binding and the worker drives an interactive `claude` session per turn, reading each result from the standard transcript. Everything else — the `WorkerProvider` contract, the phase table, the statechart, the driver, the cooperative pause, the lifecycle, the tmux **viewer** — is untouched.

```toml
[roles.implementer]
provider = "claude"
transport = "interactive"   # default "headless"; config-file only; implementer-only; rejected for codex
```

## The coupling decisions

Three positions, argued at the Direction gate and load-bearing for the whole shape:

- **A transport knob on the claude provider — not a third provider.** `transport = "interactive"` is a *how-we-talk-to-claude* choice, not a new vendor. The two-provider model stays `{claude, codex}` (a third means forking). The knob lives on the claude `RoleBinding` beside `model`, defaults `"headless"`, and — like `model` — is rejected for codex.
- **No generic terminal-driver abstraction.** Codex gains nothing (already subscription-billed), and a "generic terminal driver" is the vendor-abstraction non-goal in disguise. Below `WorkerProvider`, everything is claude-CLI-specific (transcript shape, session discovery, readiness, permission posture). Built claude-specific; extract only if a second real terminal-driven case appears.
- **Transcript-as-truth; tmux is a separate failure domain from the viewer.** Output is read from `~/.claude/projects/` (the JSONL transcripts are the source of truth), **never from `capture-pane`** — which sidesteps the rejected claude-squad screen-scraping anti-model and makes the turn-boundary signal transport-independent (so a future owned-pty transport reuses it). The transport's tmux session is run-scoped and distinct from the viewer's `duet-<run_id>`; a driver-tmux failure becomes a bounded `runTurn` exception, not a viewer concern. tmux-as-runtime here is a conscious, opt-in trade, **not** a relaxation of "tmux is a viewer, never the runtime" for the default path.

## How it works

One `runTurn` = **launch → readiness-poll → submit(prompt + nonce) → watch the transcript + parse → teardown**, the whole turn bounded by one per-turn deadline (`PHASE[phase].workerTurnTimeoutMs`). Three deep modules behind a narrow interface:

- **`parseInteractiveTurn` (pure).** Transcript tail + the turn's nonce → `WorkerTurn | undefined` (`undefined` = not closed yet). Finds the user record carrying the nonce (turn-open), walks forward, closes on the final assistant message — returning that *final* text (not the joined tool narration), the session id, and best-effort tokens/context. A compact-boundary close returns the same synthetic confirmation the headless path uses (the impl phase's first act is a `/compact` turn). The live-auth-uncertain event vocabulary is isolated into five predicates so a correction against a real capture stays localized. **This is the piece the owned-pty production transport reuses unchanged.**
- **`PaneController` — the injection/process sub-seam, and the migration lever.** A *semantic* interface (`open` / `submitPrompt` / `pollReady` / `kill`) with no terminal mechanics, so a future owned-pty adapter satisfies it without contortion. `TmuxPane` is today's thin, deliberately-untested glue (load-buffer → paste-buffer → Enter; `capture-pane` readiness; `kill-session`); `FakePane` is the test adapter; the owned-pty adapter slots in here next. The seam is earned twice over: a test needs it now, and pty is the named second adapter.
- **`InteractiveClaudeWorker` (orchestration).** Implements `WorkerProvider` with `name = 'claude'`, selected by the factory when the binding's `transport` is `"interactive"`. The orchestrator sees the same contract as the headless transport.

**Session identity is correlation, not newest-file.** The project slug `~/.claude/projects/<slug>/` is *shared* — the orchestrator SDK session writes there concurrently — so "newest `*.jsonl`" is ambiguous. The locator correlates on a **unique per-turn nonce** injected into the prompt: the session file carrying it *is* this turn's, whether new (turn 1) or an append to a resumed session (turn 2+). No recency/mtime reasoning, so a coarse-granularity filesystem can't hide an append; a nonce matching more than one file throws rather than guessing. The scan is scoped to the cwd-derived project dir first (fast path) and falls back to the whole projects tree on a miss, so correctness never depends on getting the slug transform exactly right — only performance does. That same nonce-bearing record carries this turn's session id, so the worker announces it (`onSessionId`) the first time the watcher sees it — mid-turn, well before turn-close — letting the live-activity trace locate the transcript from a turn's start (a resume announces its id immediately); the transport takes no `--session-id`, so the transcript is its only id source on a fresh turn.

Invariants worth keeping in mind:

- **Teardown is a contract, not a side effect.** `pane.kill()` runs in a `finally`, so it fires on success, throw, and timeout alike — a timed-out turn never leaves a lingering interactive pane. The no-daemon claim ("nothing runs between quiescent stops") depends on it.
- **Bounded, never hung.** Every stallable step is bounded by the per-turn deadline; a stall or tmux error becomes a thrown `runTurn` error, which the existing `send_prompt` rail converts to retry-once-then-`ask_human`. A silent hang is the one failure that rail cannot catch — which is why bounding is load-bearing.
- **Implementer-only, read-write/bypass.** The transport always launches with bypass permissions, so it serves the read-write implementer only. Two guards enforce it structurally: config rejects `transport = "interactive"` on any role but implementer, and `InteractiveClaudeWorker.runTurn` refuses a `readOnly` turn before spawning anything (it physically can't honor read-only, so it refuses rather than silently lies). A read-only interactive reviewer is a production item (below).
- **Cost shown unavailable, never faked (P5).** An interactive turn omits `costUsd`. The accounting marks the claude-worker total partial (`costs.claudeWorkersCostPartial`), and the status line says so (`claude workers $N.NN known (+ interactive turns: cost unavailable)`) rather than presenting the headless-only sum as the total. `claudeWorkersUsd` now means the *known* claude-worker cost; the flag flows into `status --json` additively.

## Status

The full mechanism is **built and green over fakes**; one live-auth gate remains before it is *proven*.

| Slice | Commit | What |
|---|---|---|
| 1 | `de2da2b` | The pure transcript parser + isolated predicates + fixture builders |
| 2 | `7333320` | The `transport` config knob (clobber-proof override merge) |
| 3 | `a76dc32` | Cost surfacing under P5 (`claudeWorkersCostPartial`) |
| 4 | `6e6c002` | The transport + `PaneController` seam + correlation locator + factory wiring |
| 5 | `4f2b16f` | The live-auth verification handoff script (write-only) |

Follow-ups from review: `c665b58` (implementer-only enforcement), `5cffa3b` / `8e18c9d` (correlation scoped to the project, mtime baseline deleted, root fallback).

**Verified now (no live auth, over `FakePane` + tmpdir transcripts + fake timers):** the parser (plain/tool-using/incomplete/compact/cut-line/nonce-isolation), the config knob and its codex/role rejections and override merge, the cost flag, the full driving loop, both timeout paths (readiness and post-injection watch) with teardown asserted, nonce correlation among decoys, the resumed-append and slug-fallback cases, the early session-id announce (fresh-turn from the transcript before close, resume-turn immediate), and the loud no-candidate / ambiguous failures.

**Not yet proven — live-auth gate (Slice 5, the human's to run):** `src/spike/interactive-transcript-capture.ts` drives one fresh, one resumed, and one `/compact` turn through the *real* `TmuxPane` + locator + parser. Its five checks: (1) the turn draws the flat interactive quota, (2) bypass suppresses interactive prompts, (3) session pin/correlate is stable across resumed turns, (4) one injected prompt → one clean assistant message, (5) interactive `/compact` writes a recognizable boundary and preserves the session. **The captured transcript is the fixture of record** — if the real event vocabulary differs from the hand-authored fixtures, the correction lands in the isolated predicates (and, only if the prompt/nonce or session id live somewhere unexpected, the locator/watch). The mechanism is "proven" only once the parser + locator run green against a real capture.

## Limitations (consciously non-production — this is a spike)

The spike narrows the *verification* bar, not the *design* bar; these are deliberate, each with its production answer below.

- **tmux is the runtime driver, not an owned process** — `send-keys`/`capture-pane` are heuristic (fire-and-forget input, readiness by screen-polling); fine while a human can watch, weaker unattended.
- **This mode depends on tmux at runtime** — unlike the always-best-effort viewer; an opt-in trade.
- **Spawn-per-turn TUI cold-start** — each turn boots a fresh interactive session; slower than headless.
- **Implementer-only, read-write/bypass-only** — read-only interactive driving (a claude reviewer) is unproven and out of scope.
- **No interactive cost telemetry** — surfaced as explicitly unavailable (P5), not silently zeroed.
- **Slug derivation is best-effort** — the exact `cwd → ~/.claude/projects/<slug>` transform is unconfirmed; the root-fallback scan keeps correctness slug-independent, but a wrong guess costs a wider scan.

## Path to production

What this spike consciously does *not* harden, and the design for later — the durable work (the parser, the `PaneController` seam) carries over unchanged. Tracked as a shelved direction in [`docs/future-directions.md`](future-directions.md).

- **Owned-pty transport (the production default).** Replace tmux-driving with an owned pty (e.g. node-pty, or `script`/`expect`): duet owns the child process and reads readiness/turn-state from the byte stream instead of polling `capture-pane`. Removes the screen heuristics, the tmux runtime dependency, and tmux-server process ownership in one move. Lands behind the same `PaneController` seam and reuses `parseInteractiveTurn` unchanged — only the injection/process layer swaps. Adds a (native) dependency, which is why it is deferred.
- **Failure isolation.** With an owned process handle, timeouts and kills are direct (clean exit, no orphaned panes); a stalled-prompt watchdog can fail a turn (crash=flag) rather than hang — the backstop if the P4 live check shows any prompt slips past bypass.
- **Phase-scoped pane reuse.** Reuse one interactive session across a phase's turns (still torn down at quiescence — no daemon) to remove per-turn cold-start.
- **Read-only interactive (a claude reviewer).** Extend the transport to the read-only posture so a claude reviewer can also bill the subscription — lifting the implementer-only guards.
- **Cost telemetry (only if wanted).** Derive cost from token counts × model pricing, or read it out-of-band — explicitly off by P5 for the spike.
- **Default flip.** If the mode proves trustworthy unattended, make owned-pty the default for `transport = "interactive"`; the spike stays tmux-driven by choice.

## Out of scope (named so it isn't re-proposed)

- **Orchestrator over interactive Claude** — needs the SDK's custom MCP tools and the cooperative pause; a separate horizon (future-directions §Active "A", open-questions Q17), a lifecycle redesign, not this feature.
- **Codex over interactive** — no billing payoff (`codex exec` already bills the subscription).
- **Folding the driver into the tmux viewer** — separate failure domains by design.

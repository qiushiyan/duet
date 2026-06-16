# Interactive Claude worker transport: a subscription-billed implementer

**Status:** Spec — **spike** (Direction gate approved 2026-06-15). **Date:** 2026-06-15. Direction synthesized at the gate; P1 = spike, P2–P5 settled (carried below). Grounded in the worker seam at `src/providers/`. The production path is captured here as spec content (rider) but the doc-update plan that lifts it into `docs/future-directions.md` is the docs phase's job, not this spec's.

## Summary

We're adding an **opt-in interactive-Claude transport for the implementer**: instead of the headless `claude -p` call duet makes today, the implementer's turns can be driven through the **interactive `claude` CLI**, so the work bills against the developer's **flat subscription quota** rather than the metered credit pool.

The problem it solves: since **2026-06-15**, headless `claude -p` and the Agent SDK draw from a **separate, capped "Agent-SDK credit" pool** priced at standard API rates (`docs/automation-design.md` §"Layer 3 — Workers", line 128) — not the flat interactive quota. The only way to spend the flat interactive quota is to drive the **interactive** TUI. (Codex is unaffected: `codex exec` already bills the ChatGPT subscription, so it is out of scope here — see §"The coupling decision".) The implementer is where this bites: it is the cost driver (~$85 of the ~$93 first real run was claude workers).

**Approach and scope.** A **transport knob on the existing claude provider** — not a third provider, not a generic terminal-driver. When `transport = "interactive"`, the claude worker drives an interactive `claude` session inside a **run-scoped tmux pane** (injection via `send-keys` + bracketed paste; readiness by polling `capture-pane`) and reads each turn's result from the **standard `~/.claude/projects/` transcript file** — never by screen-scraping. The change is contained: one new transport module, a transcript-tail parser modeled on `parseRolloutContext` (`src/providers/codex.ts:25`), one config field, and one additive status field (a cost known/unknown distinction, for P5). The `WorkerProvider` contract (`src/providers/types.ts:48`), the phase table, the statechart, the driver, the cooperative pause, the lifecycle, and the tmux **viewer** are all untouched. Default behavior stays headless.

**The boundary once this lands.**

*Proven:* the mechanism end-to-end on the claude implementer — a prompt injected into an interactive `claude` pane produces exactly one new transcript assistant message, captured cleanly, billed to the subscription quota.

*Settled product decisions carried in (gate):* **P2** build it (for-learning; a heavy run can exhaust the monthly credit). **P3** ToS accepted (personal use). **P4** launch with **bypass permission mode** so the AFK implementer edits/commits/runs unattended. **P5** **cost shown unavailable** — tokens/context come from the transcript, cost is never faked from screen text.

*Consciously non-production (this is a spike) — each a one-line why, expanded in §"Path to production":*
- **tmux is the runtime driver, not an owned process** — `send-keys`/`capture-pane` are heuristic (fire-and-forget input, readiness by screen-polling); fine while a human can watch, weaker unattended. Owned-pty is the production transport, deliberately not built now (no new dependency this run).
- **This mode depends on tmux at runtime** — unlike the always-best-effort viewer; an opt-in trade.
- **Spawn-per-turn TUI cold-start** — each turn boots a fresh interactive session; slower than headless, accepted for the spike.
- **Implementer-only, read-write/bypass-only** — read-only interactive driving (a claude reviewer) is unproven and out of scope.
- **No interactive cost telemetry** — by P5; surfaced as **explicitly unavailable**, not silently zeroed (§"Cost surfacing under P5").

*Deferred (not this run):* owned-pty hardening, failure isolation, a claude reviewer over the same transport, and the production-mode default flip — all in §"Path to production".

## Current vs. desired

The worker seam is a narrow per-turn contract today: `runTurn({prompt, sessionId?, readOnly?, cwd})` → `WorkerTurn{text, sessionId, costUsd?, tokens?, context?}` (`src/providers/types.ts:38`). Two adapters serve it — claude via headless `claude -p --output-format json` (`src/providers/claude.ts:118`), codex via `codex exec` with an out-of-band rollout tail-read for context (`src/providers/codex.ts:98`). The orchestrator never sees worker bytes; it sees the returned `text`. This spec adds a second **claude** transport behind the same contract.

```
Current:                                     Desired:
WorkerProvider.runTurn (per-turn)            WorkerProvider.runTurn (per-turn, unchanged)
├─ claude  → claude -p --output-format json  ├─ claude
│    └─ result + usage from JSON envelope    │    ├─ transport "headless" (default)
├─ codex   → codex exec                      │    │    └─ claude -p  (unchanged)
│    └─ context from rollout tail-read       │    └─ transport "interactive" (new, opt-in)
└─ FakeWorker (tests, third adapter)         │         ├─ drive interactive claude in a tmux pane
                                             │         │    (send-keys + bracketed paste; readiness
Selection: bindings[role].provider           │         │     polled from capture-pane)
                                             │         └─ result + usage from ~/.claude/projects/
                                             │              transcript tail  (NOT screen capture)
                                             ├─ codex   (unchanged — already subscription-billed)
                                             └─ FakeWorker (unchanged — stands in for any claude transport)

Selection: bindings[role].provider + bindings[role].transport
```

**Preserved:** the per-turn contract, headless as default, the orchestrator's final-text `send_prompt` view, augmentation (standard transcripts, manual `--resume` / `duet takeover`), the two-provider model, all human gates, no-daemon. **Changing:** the claude provider gains a transport branch; one new module + one parser; the role binding gains a `transport` field.

## The coupling decision

Three positions, argued at the Direction gate and held here:

- **A transport knob on the claude provider — not a third provider.** `transport = "interactive"` is a *how-we-talk-to-claude* choice, not a new vendor. A third provider means forking (`docs/automation-design.md:305`); the two-provider model stays `{claude, codex}`. The knob lives on the claude `RoleBinding` (`src/config.ts:16`) beside `model`, default `"headless"`, and — like `model` — is **rejected for the codex provider** (codex has no interactive billing reason; mirror the model-on-codex validation at `src/config.ts:59`). **Opt-in surface (spike):** the knob is **config-file only** — `transport` under `[roles.implementer]` in `~/.config/duet/config.toml`; the `--<role>` CLI override grammar stays `provider[:model]` unchanged (`src/cli.ts`). Expanding the flag grammar is deferred with the rest of production polish.
- **No generic terminal-driver abstraction.** Codex gains nothing (already subscription-billed), and "generic terminal driver" is the vendor-abstraction non-goal in disguise (`docs/automation-design.md:305`). The generic seam already exists — `WorkerProvider`; below it everything is claude-CLI-specific (transcript shape, session-id discovery, readiness markers, permission posture). Build claude-specific; extract only if a second real terminal-driven case ever appears (`docs/engineering.md:46`, earn-a-seam).
- **Transcript-as-truth; tmux is a separate failure domain from the viewer.** Output is read from `~/.claude/projects/` (the JSONL transcripts are the source of truth — `docs/automation-design.md:274`), never from `capture-pane` — which sidesteps the rejected claude-squad screen-scraping anti-model (`docs/automation-design.md:286`). The transport's tmux session is **run-scoped and distinct** from the viewer's `duet-<run_id>` session. A driver-tmux failure is converted into a **bounded `runTurn` exception**, which the existing `send_prompt` rail handles (retry once, then `ask_human` — `src/harness/tools.ts:221`) — *not* the driver's phase-level crash=flag path (`src/harness/driver.ts:99`, which only catches exceptions escaping `drivePhase`). The viewer stays best-effort. tmux-as-runtime here is a conscious, opt-in trade, not a relaxation of "tmux is a viewer, never the runtime" for the default path.

## The interactive transport — decisions

The new transport implements `runTurn` for one claude turn. The decisions that need pinning (mechanics — exact flags, keys, watch implementation — are the plan's):

- **Process model: spawn-per-turn, with teardown on every path.** Each `runTurn` opens a fresh interactive `claude` (a new session on turn 1, `claude --resume <id>` thereafter), drives one turn, captures, and tears its run-scoped pane down. The no-daemon claim — "nothing runs between quiescent stops" (`docs/automation-design.md:25`) — is **contingent on teardown, so it is a contract, not a side effect**: the transport must best-effort kill its pane on **both** the success path and the failure/timeout path. A turn that times out under the failure model above must not leave a lingering interactive pane — otherwise the spike cannot honestly claim no-daemon semantics. The teardown is itself best-effort and bounded (a wedged kill can't become a new hang); owned-pty makes orphan-free teardown reliable later (§"Path to production"). (Reusing one pane across a phase's turns is a production optimization — §"Path to production".)
- **Session identity — correlation, not newest-file.** The transport must know the turn's session id, both to return it (the next turn resumes it) and to locate the transcript. The project slug `~/.claude/projects/<slug>/` is **shared** — the orchestrator SDK session is active concurrently during `send_prompt` (`src/harness/driver.ts:185`), plus any claude reviewer and manual sessions — so a "newest `*.jsonl`" guess is ambiguous (unlike codex, which already knows its id and keys the scan on the `-<id>.jsonl` suffix — `src/providers/codex.ts:101`). Preferred: **mint our own id and pin it** at launch, where the interactive CLI honors a fixed session id (the transcript path is then known up front). Fallback if it doesn't: **correlation** — snapshot the candidate files before launch, then select the new/modified transcript containing the exact injected prompt plus a per-turn nonce, and pin that file + session id for every later turn. The stake: if neither pinning nor correlation can be proven against a real session, the spike has **not** proven exact per-turn capture — so this is a pass/fail live-auth check, not a detail.
- **Injection.** The prompt body (often a whole artifact — the reason the headless path uses stdin, `src/providers/claude.ts:138`) is injected via **bracketed paste** (`load-buffer` → `paste-buffer -p`) so multi-line content can't submit prematurely; submit is a separate key, and `send-keys` carries control keys. The injected body carries the per-turn nonce the session-correlation step matches on.
- **Readiness.** Before injecting, poll `capture-pane` until the TUI shows its input prompt. Heuristic and screen-based — named as a spike limitation.
- **Turn-boundary detection: from the transcript, not the pane.** The parse contract over the transcript: the turn **opens** at our injected user message (matched by the nonce above) and **closes** when the session quiesces having produced this turn's final assistant message; the returned `text` is that **final assistant text** — the analogue of the headless `result` envelope (`src/providers/claude.ts:63`), not the joined intermediate tool-call narration the implementer emits along the way. This signal is **transport-independent** (a future owned-pty transport reuses it), which is why the tmux/pty choice is contained to injection. The exact interactive-transcript event vocabulary — which record marks turn-close, how a tool-using turn ends versus a plain one — is confirmable only against a real session, so it is a live-auth uncertainty, not a settled fact.
- **Compaction turns.** The impl phase's first act is `compact-for-impl` (the impl snippet set in `src/phases.ts`; `docs/automation-design.md:162`), so the **first** interactive implementer turn can be a `/compact` turn — which in headless succeeds with an empty result and only a compact-boundary event, for which the provider substitutes a synthetic confirmation and keeps the session id (`src/providers/claude.ts:85`). The interactive parser/watcher must do the same: recognize the transcript's compact-boundary event as a valid turn-close, return the identical synthetic confirmation, and preserve the session id — otherwise the first impl turn breaks. Whether interactive `/compact` writes a recognizable boundary and preserves the session is a live-auth check.
- **Failure model: bounded, never hung.** Every step that can stall — readiness polling, injection, the transcript watch — is bounded by the existing per-turn timeout (`PHASE[phase].workerTurnTimeoutMs`, already applied to both current transports — `src/providers/claude.ts:143`, `src/providers/codex.ts:71`). A stall, or any tmux error, becomes a **thrown `runTurn` error**, which the `send_prompt` rail converts to retry-once-then-`ask_human` (`src/harness/tools.ts:221`). A silent hang is the one failure that rail cannot catch, so bounding these steps is the load-bearing requirement; the timeout wiring is PLAN's.
- **Output + telemetry.** A pure, testable **transcript-tail parser** (modeled on `parseRolloutContext`, `src/providers/codex.ts:25`) extracts this turn's final assistant `text` and `sessionId`. Token/context usage reuses claude's existing per-request arithmetic (`claudeContextUsage`, `src/providers/claude.ts:41`) over the transcript's assistant `message.usage` blocks. **`costUsd` is omitted** (P5) — `WorkerTurn.costUsd` is already optional — but omitting it is **not** self-surfacing: the status cost line is always-present, so an omitted cost silently undercounts rather than reading as unavailable (§"Cost surfacing under P5").
- **Permission posture (P4).** Launch with **bypass permission mode** so the unattended implementer edits, commits, and runs project commands without a keypress — the same posture the headless implementer already uses (`src/providers/claude.ts:134`). Whether bypass suppresses *every* interactive prompt is a live-auth check.
- **Read-only.** Out of spike scope. The implementer is read-write/bypass; a read-only interactive claude (a claude reviewer) is a production item.

## Cost surfacing under P5

P5 is "cost shown unavailable, never faked." Today the status cost line is unconditional — `claude workers $N.NN` (`src/status.ts:207`), incremented only when a turn reports `costUsd` (`src/harness/tools.ts:197`). An interactive turn reports no cost, so with no other change that line shows `$0.00` or a headless-only **partial presented as the total** — exactly the faking P5 forbids. (My earlier "tokens-only, exactly as codex" was wrong: codex shows a *complete* token count, not a partial dollar amount — the cases aren't analogous.)

So honoring P5 faithfully is **in scope, not optional polish** — and it is a faithful read of P5, not a scope expansion, because "shown unavailable" is the literal content of the decision. The status model gains a **known/unknown cost distinction** for claude workers: an interactive turn marks the claude-worker cost as carrying an unavailable portion, and the renderer says so rather than implying completeness. What stays PLAN: the accounting shape (a per-transport/per-voice counter vs. a flag) and the exact wording. Constraint: the `status --json` schema is **additive-only** (pinned by test, `docs/engineering.md`), so this lands as an *added* field, never a changed one. **PLAN note:** once the unknown marker can be present, the existing `costs.claudeWorkersUsd` semantically means *known* Claude-worker cost — PLAN must document that in the `--json` field copy and tests so consumers never read a partial as the total.

## Testing

High-level — specific cases, fixtures, and mocking boundaries are the plan's.

*Provable now, no live auth:*
- **Transcript-tail parse** — against a recorded interactive transcript: extract the correct final assistant text, session id, and token/context usage; ignore earlier turns and intermediate tool-call messages; tolerate a cut/partial tail line (the `parseRolloutContext` robustness bar).
- **Compact-boundary parse** — a recorded interactive `/compact` transcript yields the synthetic confirmation and the unchanged session id (the `src/providers/claude.ts:85` behavior, on the interactive shape).
- **Turn-boundary ↔ transcript correlation** — against a transcript that grows: exactly one completed assistant message is recognized per injected prompt — matched by the per-turn nonce, not by file recency (the one-prompt→one-message invariant), at the parser/watcher level over recorded data.
- **`WorkerProvider`-seam compatibility** — the interactive transport is just another `WorkerProvider`; the harness/tools/statechart suites run **unchanged** because the contract is unchanged and `FakeWorker` already stands in for any claude transport (`tests/helpers/fixtures.ts:21`).
- **Config + cost surfacing** — `transport` parses on a claude binding and is **rejected on codex** (mirrors the model-on-codex validation); the status model renders the interactive portion's cost as explicitly unavailable (not `$0.00`), and the `--json` schema gains the field additively.

*Environment-only — flag, never attempt (requires a real subscription-OAuth interactive session):*
- **Billing-meter confirmation** — a real interactive turn draws the **flat interactive quota**, not the Agent-SDK credit.
- **Bypass suppresses interactive prompts (P4)** — an unattended driven turn that edits/commits/runs never blocks waiting for a human keypress.
- **Session pin-or-correlate** — a fixed session id is honored at launch (preferred), or the injected-prompt+nonce correlation uniquely identifies the turn's transcript among the shared slug's other live sessions; the id is then stable across resumed turns.
- **One injected prompt → one clean assistant message** — end-to-end: a prompt injected via tmux into interactive `claude` yields exactly one new transcript assistant message the parser extracts cleanly, with a detectable turn boundary.
- **Compaction over interactive** — interactive `/compact` writes a recognizable transcript boundary and preserves the session id, so the first impl turn (`compact-for-impl`) captures correctly.

## Phases

Loose grouping (no commit order):
1. **Config knob + selection** — the `transport` field on the claude binding (config-file only); the factory (`src/providers/index.ts`) routes claude to the chosen transport; headless default unchanged.
2. **The interactive transport + parser** — injection (with the correlation nonce), readiness, the transcript turn-boundary watch (including compact-boundary recognition), session pin/correlation, the bounded-timeout failure model, teardown; the transcript-tail parser and its unit tests.
3. **Telemetry + surfacing** — tokens/context from the transcript; the known/unknown cost distinction so the interactive portion renders as unavailable; the result flows into the existing voice log / `duet status` as today.
4. **Live-auth spike (environment-only)** — the checks below, run by the human against a real session; flagged, never attempted by the agent.

## Path to production

What this spike consciously does *not* harden, and the design for later addressing each (spec content for the docs phase to lift into `docs/future-directions.md` once the spike works):

- **Owned-pty transport (the production default).** Replace tmux-driving with an owned pty (e.g. node-pty, or shelling to `script`/`expect`): duet owns the child process and reads readiness/turn-state from the byte stream instead of polling `capture-pane`. Removes the screen-heuristic injection, the tmux runtime dependency, and the tmux-server process ownership in one move. Lands behind the same `WorkerProvider` contract and reuses the transcript parser unchanged — only the injection/process layer swaps — so the spike's durable work carries over. Adds a (native) dependency, which is why it is deferred.
- **Failure isolation.** With an owned process handle, turn timeouts and kills are direct (clean exit, no orphaned panes); a stalled-prompt watchdog can fail a turn (crash=flag) rather than hang — the backstop if the P4 live check shows any prompt slips past bypass.
- **Phase-scoped pane reuse.** Reuse one interactive session across a phase's turns (still torn down at quiescence — no daemon) to remove per-turn TUI cold-start.
- **Read-only interactive (a claude reviewer).** Extend the transport to the read-only posture so a claude reviewer can also bill the subscription.
- **Cost telemetry (only if wanted).** Derive cost from token counts × model pricing, or read it out-of-band — explicitly off by P5 for the spike.
- **Default flip.** If the mode proves trustworthy unattended, make owned-pty the default for `transport = "interactive"`; the spike stays tmux-driven by choice.

## Out of scope (named, so it isn't re-proposed)

- **Orchestrator over interactive Claude** — it needs the SDK's custom MCP tools and the cooperative pause (`docs/automation-design.md:62`, Q17); the interactive-CC orchestrator is a separate horizon (`docs/future-directions.md` §Active "A"), a lifecycle redesign, not this feature.
- **Codex over interactive** — no billing payoff (`codex exec` already bills the subscription).
- **Folding the driver into the tmux viewer** — separate failure domains by design (§"The coupling decision").

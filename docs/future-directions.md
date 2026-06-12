# Future directions

The product-direction ledger: where duet goes next, what's shelved with a revisit trigger, and what was considered and declined. Companion to `docs/open-questions.md` (design decisions inside the current product); this doc tracks candidate *changes to what the product is*. Directions here were weighed against the product goals in `CLAUDE.md` and a user interview (2026-06-12) on actual usage: during AFK stretches the human is variously at the machine on other work, away with a phone, or asleep; mid-phase steering urges arise "sometimes"; at gates the packet text reads fine but composing substantial feedback in shell flags is the friction; remote reach matters.

**Standing constraint for anything remote:** duet never builds its own mobile/remote/notification layer. Either a direction works local-first, or it rides an existing product's remote surface (Claude Code remote control, Tailscale). Hand-rolled remote infrastructure is out of scope permanently.

## Active: Claude Code as the interaction layer

The gap it closes: the run can talk to the human (notification, packet, queued question) but the human can't talk back except at quiescent stops, from the terminal, through shell-flag strings. The interaction asymmetry is the biggest product gap after run-1.

Two variants, sequenced deliberately:

**B — concierge (first).** A Claude Code session on the same Mac, taught the duet CLI via a skill, reached from the phone over CC's native remote control. The human chats ("how's the run?", "approve", "reject: …"); the concierge runs `duet status` / `duet continue …` and relays packets and questions. duet's harness is untouched — the concierge is interaction glue, killable without consequence (augment-never-lock-in holds). Two disciplines bind it: relay gate feedback **verbatim** (the human's words are editor-in-chief input, never paraphrased), and *relay, not fourth engineer* (the triage rule extended one layer out). Gates stay human-only even against a rogue concierge: permission `ask` rules on `Bash(duet continue*)` force an interactive prompt that surfaces on the phone — crossing a gate takes the human twice (chat intent + permission approval). Bind it to a cheap model; the work is shallow.

Verified against CC docs 2026-06-12 (research session; feature names exact): **remote control** (`/remote-control`, research preview — local session controlled from claude.ai/code or the mobile app, bidirectional, outbound-HTTPS only, Mac must stay awake — already true for any duet run); **mobile push** ("Push when Claude decides", coarse and opaque — the concierge's report turn is what reliably triggers it, so the skill must make "gate landed" a turn-ending report); **supervision** via `/loop` (fixed/dynamic interval) or the Monitor tool streaming a background command; **permission `ask` rules** prompting on mobile; **stdio MCP** servers reachable from remote sessions.

The near-term package (mostly new files, light harness touches):

1. `duet steer "<note>"` — the one real harness feature: stage a note from outside, delivered to the orchestrator at the next driver-loop turn boundary (the cooperative-pause-safe injection point). Covers the "sometimes" steering urge directly; the concierge relays through it.
2. Machine-readable primitives — `duet status --json`, a `duet packet` dump. What "teach CC to use duet" actually requires.
3. The concierge skill file (verbatim-relay + relay-not-engineer disciplines, the duet verb vocabulary, the report-turn notification rule) plus the permission config (allow `Bash(duet *)` only; `ask` on `duet continue*`).

Design questions for the spec: steer delivery semantics (multiple staged steers? steer arriving at quiescence — convert to gate feedback or hold?); whether a steer counts toward any cap; `status --json` schema; where the skill lives and how it installs; self-hosting hazard if built as a duet run on the duet repo (workers editing the source the live driver re-spawns from — new `_drive` children load fresh code mid-run).

**A — orchestrator in CC (the researched horizon).** The orchestrator itself becomes an interactive CC session: duet exposes its tools over a stdio MCP server (they are already `SdkMcpToolDefinition`s), identity via CLAUDE.md + permission deny rules (both survive compaction and resume), and the human talks to the orchestrator directly — steering, triage, and gate conversation become native, from anywhere. Verified feasible at the capability level. The cost is a lifecycle redesign, not a feature: per-phase headless sessions, crash=flag, nudge-once, budget accounting, and quiescence-exit all live in `driver.ts` and would re-home (likely into the MCP server process, which then owns the statechart). It also forecloses codex-as-orchestrator (Q17) and deepens CC dependency — acceptable under the standing constraint, but a one-way door. **B is a strict stepping stone**: everything it builds (primitives, steer, relay discipline) carries over, and living with B is the evidence for whether talking-to-the-orchestrator beats relaying by enough to fund the rebuild.

## Shelved — interesting, with revisit triggers

**Project profile: a default-loaded pre-context (`.duet/` "CLAUDE.md-for-duet").** Today project knowledge enters only via the framing turn, rewritten per run. Instead: a durable per-project file in `.duet/` auto-loaded into every run as pre-context, carrying what's common across framings (spec/plan locations, conventions, vocabulary, standing constraints); the framing file shrinks to the run-specific delta. Keeps the single-entry-seam property — the framing turn becomes profile + delta. Optional later layer: the orchestrator proposes profile additions at run end, human-gated like snippet edits. **Trigger:** the third or fourth run on the same repo, when writing the framing feels like copying the last one.

**Eval/replay harness.** Re-run a recorded phase's orchestrator against scripted workers (voice logs replayed through the `WorkerProvider` seam; the SDK boundary is already injectable) and diff routing choices — snippets picked, adaptations, triage calls, convergence judgment — against the original. Turns prompt changes from faith into A/B evidence without $93 runs; Q13/Q19/Q20 all currently wait on real runs as the only eval. **Trigger:** the first prompt change that makes a run worse and we can't tell why. Compounds every other direction.

**Multi-run attention queue.** Worktrees already give parallel runs separate cwds; nothing manages the human side — which run needs me next, notification collisions, one combined gate queue. Concurrent worktree sessions are observed behavior (planlab Jun 10, `2c6a7f46` + `d531410e`). Strong synergy with the concierge: one chat session supervising N runs. **Trigger:** the first missed gate during parallel runs.

## Considered, not pursued

- **Local browser dashboard.** The original candidate; the interview removed its rationale — packet text reads fine (no rendering need), remote must not be hand-built (no act-from-anywhere), and the comfortable-input need is met by the concierge's chat box. What remains (buttons in a local browser) doesn't beat tmux + CLI. Recorded so it isn't re-proposed on the same grounds.
- **Arc presets** (lighter arcs for small fixes). Structurally cheap after the phase-table refactor, but not wanted — duet stays epic-shaped; small tasks stay manual.
- **Environment-proxy ergonomics** (pre-composed command requests at flags). Generic `ask_human` suffices at current run volume.
- **Third specialist worker role.** Cuts against two-role legibility; specialization belongs in snippets, not roles.
- **Multi-PR pivots inside one run.** Observed in the corpus, but "finish the run, start a new one" is cheaper than machine support.
- **OSS-ification.** Against the product goals; personal tool.

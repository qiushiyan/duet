# Future directions

The product-direction ledger: where duet goes next, what's shelved with a revisit trigger, and what was considered and declined. Companion to `docs/open-questions.md` (design decisions inside the current product; built-but-awaiting-live-evidence items live there as watch entries) — this doc tracks candidate *changes to what the product is*, weighed against the product goals in `CLAUDE.md` and the standing usage evidence (the 2026-06-12 interview; every live run since).

**Standing constraint for anything remote:** duet never builds its own mobile/remote/notification layer. Either a direction works local-first, or it rides an existing product's remote surface (Claude Code remote control, Tailscale). Hand-rolled remote infrastructure is out of scope permanently.

## Governing principles for this phase (2026-07-06)

Set when the capability thesis finished proving out — every layer live-verified, including a user-composed workflow — while the evidence loop had not. They decide which directions below get hours:

- **The opinions are the moat; the engine is a commodity.** Composability will invite "add a knob"; a knob still costs shipped prose plus a shipping workflow, no exceptions. The pressure to widen the vocabulary will feel like success — it's the trigger discipline working, not backlog.
- **Holds are the product.** Semi-AFK's value is calibrated interruption, not automation — the first composed-workflow run stopped exactly twice, both genuine catches **(observed: run `20260705-1731-58a5`)**. Work that sharpens *when duet stops* beats equal work on what it does while running.
- **Structure is verified by tests; judgment is verified by vibes.** The suite pins the machinery, but a snippet or triage change is still evaluated by rereading $30 transcripts. That asymmetry is this phase's bottleneck — and why the eval harness leads below.
- **Cost has one dominant term:** the maker lane (~$85 of the first $93 run). The interactive transport that moves it to flat-quota billing is one live-auth check from verified; nothing else changes dogfooding economics as much per hour.
- **The safety posture is personal-tool-shaped.** `bypassPermissions` workers are a considered trade on the author's repos and an unexamined one on a stranger's; the publish direction owns that question before any adopter hits it.

## Active

**Eval/replay harness — landed 2026-07-07; the active slice is the live driven diff plus graded volume.** The whole loop shipped and was first-used the same day, via the three-run series that also live-verified blueprint and relay (`docs/researches/2026-07-07-live-run-series-findings.md`): the corpus's first live-mirrored records, `duet grade`'s first instrumented triage-precision numbers (over-flag 0%, under-flag 14% on 14 points — including one honest human-declared missed stop), and replay's first slice (#37), whose dry-run reconstruction ran on a real record. Two things remain active: the **live fresh-vs-original diff** needs API-key/Bedrock/Vertex auth (the record-isolation contract correctly fails closed on OAuth — a fixture-free one-command re-run once auth is set), and **graded run volume** is now the instrument's limiting input — the 2026-07-06 snippet batch is still unmeasured until enough post-batch runs accumulate for the cohort read. Scoring stays a deliberately later slice.

**Interactive-transport live-auth check.** Hours, not days: the spike is built and proven over fakes with one live-auth gate open (`docs/interactive-transport.md`). Clearing it flips the maker lane to flat-quota billing, which multiplies the eval harness's evidence stream. Only the check is active; the production hardening stays shelved below on its original trigger.

**Publish & the first-run experience — decision pending.** "Ready for early adopters" turns the old kept-open-option stance into a live decision. If taken, the direction is the *first hour*, not new capability: npm publish, a cheap fast hello-world run (a docless workflow on a toy task), and the safety-posture doc (what `bypassPermissions` workers mean on your repo). It subsumes most generic robustness work — other people's machines are the robustness test that matters — and it should itself be built as a duet run, since by then each run is also an eval. What does not change regardless: augment-never-lock-in, the human owns substance, semi-AFK, no daemon, framing as the single knowledge seam, exactly two providers, and no community-roadmap obligation.

## Shelved — interesting, with revisit triggers

**Interactive Claude worker transport: production hardening** (spike built — `docs/interactive-transport.md`; its live-auth check is active above). Shelved: the owned-pty transport behind `PaneController`, failure isolation, phase-scoped pane reuse, a read-only checker variant, the default flip. **Trigger:** the check clears *and* real runs strain the metered pool — or the unattended heuristics misfire overnight.

**Workflow-vocabulary growth** — project-snippet membership per custom phase, a TOML adapter if TypeScript chafes, a new prose world. **Trigger:** a real wanted composition the current vocabulary can't brief (the missing-world rejection naming it), not the abstract appeal of more knobs.

**Project profile: the merge model.** Seed templates shipped (2026-06-16) as pre-baked framing; shelved is the durable profile auto-loaded as pre-context, framings shrinking to per-run deltas. **Trigger:** the copy-per-run cost bites — a template drifts from archived framings, or one edit needs to reach every future run.

**Multi-run attention queue.** Worktrees already give parallel runs separate cwds; nothing manages the human side — which run needs me next, one combined gate queue. **Trigger:** the first missed gate during parallel runs. Its cheap first piece is small and already evidence-backed: a `--worktree` flag on `duet new` — the composed-workflow spike hand-rolled exactly that setup to dodge the run-on-own-harness hazard.

**Successor relay: a run stages its follow-on run's framing.** Live manual practice in one project (planlab's five-run migration chain **(observed)**); the duet-native form — an opt-in finishing-tail step where the tail's owner authors the successor framing, staged never started — is designed (2026-07-02) and deliberately unbuilt, because framing prose already delivers it for the one project that wants it. **Trigger:** a second project grows the chain by hand, or the prose form's missing surface (status visibility, a one-tap launch) is the observed friction.

**Targeted steer** (`duet steer --to <duty>`): a recipient *hint* on the existing steer payload, still delivered through the orchestrator — the race-free remainder of "push a prompt straight to the builder" (the direct-push variant was researched 2026-06-23 and rejected: it re-opens four load-bearing invariants and nearly rebuilds `takeover`; deliberations in git history). **Trigger:** the first live interactive-orchestrator run shows relaying a finishing-move is genuinely high-friction.

## Considered, not pursued

- **Local browser dashboard.** The 2026-06-12 interview removed its rationale — packet text reads fine, remote must not be hand-built, and comfortable input is the concierge's chat box. Recorded so it isn't re-proposed on the same grounds.
- **Environment-proxy ergonomics** (pre-composed command requests at flags). Generic `ask_human` suffices at current run volume.
- **Third *specialist* worker.** A third maker cuts against the two-workers-per-stage legibility; specialization belongs in snippets. Distinct from the consultant — an optional advisor voice, not a maker.
- **Multi-PR pivots inside one run.** Observed in the corpus, but "finish the run, start a new one" is cheaper than machine support.

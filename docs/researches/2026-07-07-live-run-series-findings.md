# 2026-07-07 live-run series — findings

The permanent record of the three-run experiment series pre-registered in `docs/experiments/2026-07-live-run-series/plan.md`: three staggered runs on the greenflag repo itself, each pairing a real feature with a verification hole, under a series-long cohort freeze (no snippet/template/brief edits). Every claim here is **(observed)** against the named runs; the full records — logs, state ledgers, gzipped transcripts, grades — are in the corpus archive.

| Run | Workflow · lanes | Feature | Result |
| --- | --- | --- | --- |
| `20260707-0545-d43b` (A) | blueprint · Opus maker / GPT-5.5 checker · consultant claude | `greenflag graph` + `stats --trace` | PR #36, 2h52m |
| `20260707-0647-0dbb` (B) | relay · GPT-5.5 builder / Opus judge @xhigh · **no consultant** | `greenflag grade` | PR #35, ~2h |
| `20260707-0828-8860` (C) | blueprint · lanes flipped (GPT-5.5 maker / Opus checker) · consultant codex | corpus replay, first slice | PR #37, 2h27m |

Follow-ons in the same window: the framings gatherer (PR #38, agent-built in a parallel worktree) and the grade classification fix (PR #39, below).

## Verification outcomes — every shipped workflow is now live-verified

- **blueprint** ran live twice (A, C), framing → one design doc → AFK build → auto-opened PR, with exactly the designed single interruption each (plus held highs, below). **relay** ran live once (B) end to end: fresh cold-start delivery, judge review-and-fix, judge-owned docs + PR tails, one correctly-triaged environment question.
- **The consultant chain** exercised twice more: contracts authored blind at the Design gate, frozen at crossing, and independently verified — A's 12 assertions and C's 12 assertions all passed on the first verify, no self-heal needed. C's contract-observability class (the rewind fix) was caught in design review *before* the contract would have been blind to it.
- **The evaluation instruments shipped and were used the same day**: all three series records mirrored live into the corpus (its first post-remodel records); all three runs graded (`greenflag grade`'s first real sessions); `greenflag graph` rendered the series' own runs; replay's dry-run reconstruction ran on run B's real record. The live driven-replay diff remains pending API-key auth (below).
- **Inline provider tuning** (per-binding models, normalized effort, preflight) carried every framing in the series — 14 explicit bindings preflighted at creation, zero mid-run binding failures.

## Hold calibration — the product thesis, first instrumented numbers

`grade-precision.ts` over the graded series: **14 decision points · over-flag 0% · under-flag 14% (1 FN)**.

- **Every stop was worth it (7/7 TP).** Two pre-authorized Direction gates held on genuine direction highs — A's trace-descope/deliver-via-`workflows check` reshaping, B's scope-boundary question — both materially changed or confirmed commissioned intent. C's Ship gate held when the replay isolation contract **failed closed on OAuth auth and asked** rather than weakening itself — the trust gradient behaving exactly as designed. B's one queued question (PR merge target) was textbook environment triage.
- **Silence was mostly right too (6/7).** C's Direction auto-crossed on an uncontentious synthesis — the gate does not cry wolf — and all ledgered Ship/Open-PR auto-crossings graded right.
- **The one FN is the series' most valuable point**: run A resolved the PR-base merge-target ambiguity *autonomously* — the identical situation run B flagged, same day, same repo. Merge target is the environment rule's "always flag." Recorded as a human-declared missed stop (`missed:finish:pr-base`), the first honest nonzero in the under-flag column. Routed below.

## The contract lesson — relay's "under-checked?" watch item answered

The series' **only post-ship defect** — `autoApprovals` gate-*state* names compared against gate-*phase* names in `greenflag grade`'s discovery, misclassifying every auto-crossing as an attended stop (PR #39) — shipped from the **one run with no consultant and therefore no acceptance contract**. Run A's contract carried literally the assertion class that catches this (`A4: ledgered ⇒ auto-crossed`); run B had no contract to carry it. The judge and 1354 green tests both missed it because the **test fixtures encoded the same wrong assumption** (`gate: 'plan'`, a shape the real writer never produces — the lifecycle writes `machineState`): fixtures pinned the bug, not the behavior.

Three durable lessons:

1. **An independent acceptance contract catches a class the embedded checker structurally shares blind spots on.** Direct evidence for binding the consultant on relay work (a posture recommendation, not a mechanism change — relay's economics still hold with one).
2. **Fixture shapes must come from the real writer**, never from the reader's assumption — the same-wrong-assumption failure is invisible to any green suite.
3. **The instruments pay for themselves immediately**: the bug was caught within the hour by dogfooding `greenflag grade` on a sibling run's record — a structurally impossible matrix (TP 4 / TN 0 against two ledgered auto-crossings) read as wrong at a glance.

## Loop convergence — the pre-series concern did not reproduce

The 2026-07-02 telemetry worry was loops marching to their caps unconditionally. Observed instead: B's design loop converged with the analyst's explicit "ship it" and no disputed finding; **C's orchestrator declined an available third implement round** ("the fixes were code-grounded and confirmed — I don't need it"); A and C's design rounds each *earned* their round 2 (A's round 2 caught a not-buildable-as-written bug; C's caught the contract-observability rewind bug). Rounds were productive, not ritual.

## Lane economics — the A↔C flip

Same workflow, full lane swap: A (Opus maker) ~$64 claude / 2h52m; C (GPT-5.5 maker) ~$23 claude + ~144M codex input tokens / 2h27m — with quality holding at both altitudes (C's builder self-healed five review findings in one reflect-first round; its contract passed 12/12 first try). B's relay build lane cost ~$12 claude with the build pushed to ~28M codex tokens. Net: the criss-cross and flipped postures are real economic options, with the caveat that codex token spend prices differently per billing posture; exact per-run numbers live in the corpus records.

## Ops notes

- **Corpus silent-off incident**: `[corpus] dir` configured but the directory absent — fail-soft meant every prior run silently skipped mirroring. Fixed and documented (runbook caution, 2026-07-07); a `greenflag doctor` corpus-writability probe is a named candidate.
- **Context pressure lived on the checker lane during frame fan-outs** (codex analyst 63–90%, codex architect 79–80%): every event auto-compacted and ledgered, zero cutoffs, zero salvage — the first real quiet-ledger evidence for the context-band calibration question.
- **Blueprint's continuity edges are visible in the archive**: A's record holds 4 transcripts (builder continued architect's session, critic the analyst's); relay-B's fresh delivery holds 5.

## Routed observations (the four homes)

- **Snippet/brief** — second occurrence met: the PR-base merge-target divergence (A silent, B flagged) earns an environment-triage example naming "merge target is the human's call" in the finish-phase surface. The one prompt edit this series justifies.
- **Posture** — bind the consultant on relay runs (see the contract lesson); recorded as a recommendation, not a default change.
- **Constants** — none: the context bands held under real load.
- **Docs** — run A placed its design doc at top-level `docs/visualization-surface.md` while B and C followed the dated `docs/specs/` convention (C's architect read `documentation-standards.md` and said so); a placement tidy is owed. The `greenflag framings` all-"Problem" title column is cosmetic and waits for annoyance (#38).
- **Nowhere** — everything single-instance.

## What stays open

The live driven-replay diff (API-key/Bedrock/Vertex auth; a fixture-free one-command re-run), blueprint's update-turn medians against the 7-minute pre-series baseline (needs the cohort read at higher volume), relay *with* a consultant bound, and every calibration dial in `docs/open-questions.md` — now accumulating instrumented data instead of vibes.

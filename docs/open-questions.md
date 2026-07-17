# Open questions

The design questions still genuinely open — waiting on evidence, or on a decision nobody has needed to make yet. Each carries what we believe now and what would change the answer.

A question leaves this file when it settles, and its resolution lives in the design doc it shaped — that doc is the source of truth, not an entry here. Sections are topical and unnumbered: cite them by name so a reference survives a reshuffle. (Resolved questions and their full deliberations are in this file's git history.)

Most settle the same way: run greenflag on real work and review each run's `.greenflag/runs/<id>/notes.md` — the dogfooding journal both the human and the orchestrator write. What stays open is **calibration, not capability**. The whole workflow is live-verified; these are the dials.

## Triage precision

The orchestrator's AFK value rests on flag precision. Under-flagging silently absorbs a product decision the human owns — the worst failure; over-flagging turns AFK into a pager. The rules (product/direction → always flag; environment → always flag; tactical → bounce to the worker with process, not substance) are instructions, not mechanisms — and the same under-flag risk reaches review-loop convergence, where deferring to a worker's unverifiable "already handled" absorbs a call the orchestrator should have routed.

The bet: modern models follow concrete triage examples well, and the failure is asymmetric by design — when in doubt, flag, because a spurious flag costs minutes and an absorbed decision costs trust. Expect over-flagging first; tighten from observed false positives.

Evidence cuts both ways. A full framing-to-ship run held triage cleanly — product calls waited for gates, environment limits were reported honestly, no spurious AFK interrupts. But one run showed the under-side miss the rules don't prevent: the orchestrator took a maker's rebuttal of a checker's finding at face value rather than routing it to verify. The fix was an instruction edit — a route-to-verify example and a review-loop clause in `src/orchestrator/briefs.ts`. Whether it holds is for a later run's notes.

The read is no longer eyeballed from transcripts: `greenflag grade` records a plain right/wrong verdict on every reconstructed stop of a finished run, and `scripts/corpus/grade-precision.ts` aggregates the over-flag / under-flag rates by workflow and gate (`docs/corpus-runbook.md`). The question stays open until graded runs accumulate — the instrument only makes the false-positive/false-negative signal durable, it doesn't answer whether precision is good enough.

The question's *presentation* half — a rightly-placed stop the human still can't decide from its text alone — has a standing rule rather than an open design (`docs/prompting-and-tool-design.md` §"Presenting to the human"), but whether it holds is unproven and rides the same loop: a stop that needed a follow-up question before the human could decide is a grade note / `notes.md` entry, and a recurring shape earns the next prompt edit.

## Worker output schema

`schemas/agent-response.json` was the dumb router's protocol contract: `needs_human` and `disagree` were how judgment-free code detected exceptions. The orchestrator reads prose now, so the schema isn't load-bearing — but a minimal `{response_text}` envelope might still make routing cleaner than scraping chatty final messages.

Demote, don't delete. Workers run schema-free today and the verified runs routed fine on prose. The envelope earns its way back only if routing breaks on a chatty message; any revived schema must stay OpenAI-strict-compliant (every property required, optionals as nullable unions). Schema-on-resume is verified on the pinned codex CLI, so availability no longer constrains the call — only evidence does.

## Run-level budget

Worker budget caps are per turn (opt-in, off by default) — a fresh turn carries a fresh ceiling, and nothing enforces or communicates a total for the whole run. The first real run showed the per-turn rail leaking into product scope: the builder descoped a slice citing "~$7 of budget left," and the orchestrator collapsed an analysis step "given your session budget." An infrastructure parameter shaped a scope decision the human owns.

The 2026-06-12 fix was transparency, not a model: `send_prompt` and the impl entry brief now state that budget is per-turn and that running low means splitting work across turns, never shrinking scope. That may suffice — the descope also had a legitimate risk argument. If post-fix runs still show budget-shaped scope, the next step is an explicit run-level budget the orchestrator can reason about (`budget_usd` is pre-approved as a framing-frontmatter key under the boundary rule). The opt-in `--budget` knob added since is still per-turn, not this model.

## Context-band calibration

The context-pressure bands (75% compaction-due, 85% structural enforcement — constants in `src/voices/context.ts`) are tuned from one incident and one probe: the 20260701 wedge, plus measured margins (rejection at ~97.7% of the nominal window; single-turn growth of hundreds of thousands of tokens). What we believe now: 85% leaves headroom for the 30-second sampling lag, one burst round, and the recovery compact itself; 75% is early enough that a compact is still cheap and its post-compact floor low.

What would change the answer is the `contextEvents` ledger across real overnight runs. Cutoffs firing despite the 75% nudge → the orchestrator compacts too late or the caution band is too high. Salvage ladders that escalate to reset → the post-compact floor, not the bands, is the problem. A ledger that stays empty for months under real load → the bands could relax. Either way the dial is the constants' *values* — they deliberately never become per-run config.

## The consultant's value

The consultant is a bet on a bet: that a deliberately low-context, ephemeral, cross-family advisor challenges the *premise* where the run's embedded checkers — invested in the run's accumulated context — are strong on execution and blind to it. The mechanism is built and live-verified; its value is still thin on evidence.

The altitude gap is real, and a different model family is the one thing a single checker working harder can't supply — so the consultant should surface a class of finding the embedded checkers structurally won't. It is off by default and additive (never a review round, never substitutive), so a weak consultant's downside is bounded to wasted turns on a run that opted in. The calibration risk to watch is the severity hold: a consultant too eager with `high` converts pre-authorized runs into attended stops. Two recent changes **narrow** this evidence stream to the case that still matters: gateless turns the bet audits off entirely (so the stalling pressure now lives only in *attended* runs), and the universal verify self-heal routes a failed contract assertion to the workflow's fixer duty first, so verify findings rarely reach a `high` at all. What would settle it — more bound runs reviewed against notes: did a bet audit change a direction or catch a premise the checker and human both missed, and how often versus restating known tradeoffs? Did a `high` hold ever save a wrong-subject overnight run, or only stall good ones?

A smaller dial rides along: the **self-heal bound** — how many fix→re-verify cycles before a still-failing assertion holds (`consultantVerifyStep` prose, plan-altitude). Start tight; watch run notes for a contract that thrashes the loop without converging, or one that holds on the first failure where a second round would have fixed it.

One authoring failure class is now observed **(run `20260705-1731-58a5`)**: the contract author wrote an assertion demanding a composition the SDK cannot compile — implementation-echoing *and* factually unsatisfiable — and the chain degraded exactly as designed (verify failed it honestly, the fixer declined with reasons, the re-fail held the gate). The open dial is prevention: whether `consultant-contract` should be armed with the closed-vocabulary constraints, or whether behavioral-assertion discipline alone converges as authors see more runs. One instance argues watching, not yet arming.

## An unread vendored lesson

`lessons/testing/test-quality.md` ships in the package and is cited by no snippet, so no worker has ever read it. It is the operational half of `tdd-loop.md` — the five shapes of a low-quality test, one-owner-per-behaviour, tokens-and-relations over byte pins, the mutation check, and review's additive bias (a reviewer who can only *add* tests is half a reviewer).

Where it belongs is the question, not whether. The spec deliberately skims the testing bars as a lens (`docs/snippets.md` §"What the reading list encodes"), so this is not spec-stage reading. The candidates are `review-implementation` — where "should this test exist?" is actually decided, and where the additive bias does its damage — and the build seeds, where the tests get written. Adding it to both would re-grow the read-everything union the reading policy exists to refuse.

What would settle it: a live run whose implementation review either requests a test it cannot name a bug for, or fails to delete one that cannot fail. Watch `greenflag grade`'s review-round transcripts for either.

## Codex as the orchestrator

Every voice binds to a provider through the same grammar, which makes orchestrator-on-codex a legal configuration — but the orchestrator's capability contract — custom harness tools, read-only enforcement, pause/resume at a tool call — is claude-only today. This records the designed path so the decoupling isn't an empty promise.

The bridge is the host-neutral kernel served over stdio MCP (`greenflag _mcp`) — the same server a codex orchestrator would connect to; the harness-side half exists. Two codex-specific unknowns gate it: **pause/resume at a tool call** (codex has no `canUseTool` callback, and what `codex exec resume` does with a turn ended mid-tool-call is unknown — the hard part), and **tool-call faithfulness** under codex's MCP client. It stays deliberately unbuilt because nobody has wanted the configuration — the interface allows it, no one pays for it. If wanted: a half-day spike mirroring the claude substrate spike, against the same tools.

## Phase-scoped bindings — settled

Settled by the 2026-07-04 domain remodel: bindings are duty-keyed — one per (stage, duty), resolved per key (flags > framing > config > defaults) and frozen on the run manifest at creation — and cross-stage session continuity is registry data (continuity edges), which dissolved the post-handoff `build` override and its binary band. The finer per-phase binding map stays rejected there: a stage is one holistic thinking flow by definition, so a finer split would be a new stage boundary in the registry, not config.

## Settled, still watched

Resolved by decision, kept only for a live revisit trigger; the substance lives in the named design doc.

- **blueprint** (`automation-design.md` §"Phases and gates", §"Consultant checkpoints"). First live runs 2026-07-07 — two blueprint runs, framing → one document → AFK build → merged PR **(observed: runs `20260707-0545-d43b`, `20260707-0828-8860`; `docs/researches/2026-07-07-live-run-series-findings.md`)**. The one-interruption default held with no morning-after reversal — its extra stops were genuine held highs, graded right — and both review loops' round 2 caught a real bug (a not-buildable-as-written read; a contract-observability rewind) rather than marching ritually; both contracts passed their independent verify first-pass. Still watched: update-turn medians against the ~7-minute pre-series baseline (needs the cohort read at volume).
- **concierge, first live remote session** (`run-operations.md` §"Supervising a run from outside"; the shipped skill: `skills/greenflag-concierge/`). Built and test-verified — verbatim relay, the `ask`-rule double-tap on gate verbs, the `status --json` triage fields — with the evidence still owed: the first live phone + `/remote-control` session over a real run, and the first overnight run that uses steers. Watch: the relay discipline holding on a real phone (no fourth-engineer drift), and the turn-ending stop report actually firing the mobile push.
- **External workflow definitions — first composition ran; watching the growth trigger** (`automation-design.md` §"The workflow vocabulary"). The trigger fired 2026-07-05: a project-composed `deep-relay` (frame → spec → design → fixer build) ran gateless to an open PR **(observed: run `20260705-1731-58a5`)**. Both original bets held — the compiler-derived defaults fit unmodified (the `rounds: 2` knob and every cap held; the gate copy read correctly at all five gates), and the closed vocabulary proved load-bearing at run altitude, not just author altitude (the run's one contract slip was caught precisely because a docless fixer build is uncompilable). Still watched: a wanted composition that needs a *new* prose world — the growth trigger recorded in `future-directions.md` — and whether the `greenflag workflows` inspector's check-before-launch actually becomes the authoring habit.
- **relay** (`automation-design.md` §"Phases and gates" — the relay workflow; §"Consultant checkpoints"). First live run of the shipped shape 2026-07-07 **(observed: run `20260707-0647-0dbb`, GPT-5.5 builder under an Opus judge; findings: `docs/researches/2026-07-07-live-run-series-findings.md`)** — single-doc authority held (the judge fixed findings without over-rewriting and owned the docs + PR tails), the fresh delivery seeded cleanly from the committed doc, and one environment question was triaged textbook-correctly. The **under-checked question got its answer the hard way**: the series' one post-ship defect (the grade auto-approval misclassification, PR #39) shipped from this contract-less run, and the sibling run's contract carried exactly the assertion class that catches it. Recommendation recorded in the findings doc: bind the consultant on relay work. Still watched: relay *with* a consultant bound.
- **Overnight as full's default posture** (`automation-design.md` §"Gate pre-authorization"). Pre-authorization is the out-of-the-box behavior — a new full run attends only frame and spec. Watch each run's notes for a *recurring* morning reversal at one gate (that argues for restoring its attendance), or for the throwaway-test escape hatch failing to fire (flag when proceeding unanswered would make most downstream work throwaway).
- **Fire-and-collect interactive `send_prompt`** (`engineering.md` §"Fire-and-collect worker turns"). The in-process dispatch-and-collect path, live-verified. Revisit only if mid-turn session quits become common or overnight orphans misfire — then a detached-child-per-turn model earns its cost.
- **AFK-resilience caps & the native-watchdog dependency** (`afk-resilience.md`). The build caps (90 min at `implement`) are 3× the longest measured healthy build, and the forced stream-watchdog facts are pinned to **claude v2.1.196**. Watch run notes for a *healthy* build that legitimately exceeds the cap — raise it, don't let the cap become a scope signal — and re-verify `API_FORCE_IDLE_TIMEOUT` on a claude CLI upgrade: the native half of the native-vs-own partition is the part that can silently regress under us.

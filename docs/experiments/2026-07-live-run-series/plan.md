# 2026-07 live-run series — pre-registered plan

Three staggered runs on the greenflag repo itself, each pairing a real medium-to-large feature with a verification hole: the corpus's first post-remodel records, blueprint's and relay's first live runs, and a two-way model-lane comparison — with the third run building replay against the first two runs' records. Companion to `docs/corpus-runbook.md` (the analysis method) and `docs/open-questions.md` (the dials these runs feed). Findings land in a dated findings doc at series close; this file is the design, frozen before run A starts.

## The matrix

| Run | Feature (framing) | Workflow | Maker lane | Checker lane | Consultant |
| --- | --- | --- | --- | --- | --- |
| A | `greenflag graph` — workflow/run visualization ([run-a-graph.md](run-a-graph.md)) | blueprint | Opus 4.8 @high | GPT-5.5 @high | on — claude Opus 4.8 |
| B | `greenflag grade` — the ground-truth grading layer ([run-b-grade.md](run-b-grade.md)) | relay | builder: GPT-5.5 @high | judge: Opus 4.8 @xhigh | **off** (deliberate) |
| C | replay, first slice ([run-c-replay.md](run-c-replay.md)) | blueprint | GPT-5.5 @high | Opus 4.8 @high | on — codex GPT-5.5 |

Comparative design: **A ↔ C is the clean read** — identical workflow, full lane swap, so per-lane model strengths get a like-for-like comparison. B adds relay's fixer posture (cheap builder under a strong judge — the criss-cross the workflow was designed for; the judge's `@xhigh` is the one deliberate splurge, since consultant-off makes it B's entire quality net). A ↔ B is confounded (workflow *and* lanes differ) — read it for relay's watched bets, not for model comparison. Consultant stays cross-family from the delivery checker on A and C; B's omission deliberately tests relay's open watch item ("does a run without a consultant feel under-checked") — with no consultant there is no acceptance contract and no verify backstop.

## Discipline

- **Cohort freeze:** no snippet, template, or brief edits between run A's start and run C's finish. Observations go to each run's `notes.md` as they happen and route *after* the series (second-occurrence rule; the four homes: framing/template · snippet or brief · rail or constant · nowhere).
- **Staggered starts:** A first; B's planning begins once A crosses its Design gate into AFK delivery; C starts after B's record lands (C's fixtures are A's and B's corpus records).
- **Grading bootstrap:** grade A's and B's stops by hand in `notes.md` (right-stop / wrong-stop / missed-stop); once B merges, `greenflag grade` formalizes them retroactively.
- **Run-on-own-harness dodge:** the global `greenflag` bin stays pointed at the main checkout; workers edit only their worktree. No `pnpm add -g` from a worktree.

## Launch mechanics

Merge the prep branch (`experiments/live-runs`) to main first so run PRs diff clean, then per run (same branch checked out twice is refused, hence the per-run base branch):

```bash
git worktree add -b run-a-base ../greenflag-run-a main
cd ../greenflag-run-a
greenflag new --interactive --framing docs/experiments/2026-07-live-run-series/run-a-graph.md
```

The framing files are committed, so they are present in every worktree; `greenflag new` archives the parsed copy into the run dir (and the corpus) regardless.

## Watch checklists

Signals to grade per run, mapped to the open dials. Verdicts in `notes.md` as they happen.

**Run A / blueprint's watched bets** (`open-questions.md` §"Settled, still watched"): the design loop converging inside its cap instead of marching to round 2 unconditionally; update turns shrinking from the ~7-minute re-derive median; the one-interruption default (attend-`design`-only) leaving no morning-after wish; the late-authored contract staying behavioral (deep-relay's one slip was an implementation-echoing assertion); the planning-stage snippet ordering fix (think-holistic ahead of compare-notes) holding live.

**Run B / relay's watched bets:** judge-fixes holding quality under a *single* design doc (deep-relay's judge had a spec as second authority — this is the exact watched delta); review-and-fix cap 1 absorbing follow-ups without thrashing; the judge's owned tails (docs + PR) and its write authority staling verification like a builder's; the fresh-delivery seed ritual (no continuity edges) reading well; and the run *feeling* under-checked or not without contract/verify.

**Every run:** triage precision (absorbed decisions vs spurious flags — grade each); `contextEvents` (cutoffs firing despite the 75% nudge); `autoRetries`; budget-shaped scope language in worker output (`open-questions.md` §"Run-level budget"); consultant findings that changed anything vs restated tradeoffs (A, C).

## Post-run ritual

Per run: `greenflag stats <id>` → `scripts/corpus/phase-timings.ts` + `turn-stats.ts` → grade stops → route nothing yet. At series close: the cohort read per `docs/corpus-runbook.md` §"Evaluating a change", one dated findings doc (the permanent layer), then the routed edits.

## Pre-series observations (already logged)

- `[corpus] dir` was configured but the directory didn't exist — the fail-soft mirror was **silently off** for every prior run (fixed + backfilled 2026-07-07: 20 swept, 20 refused by design, all pre-remodel). Candidate: a `greenflag doctor` probe for corpus-dir writability.
- Replay was believed merged; it is designed-unbuilt (`corpus-runbook.md` is accurate). Run C exists because of this check.

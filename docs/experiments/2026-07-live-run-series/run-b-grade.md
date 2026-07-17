---
workflow: relay
bind.architect: claude:claude-opus-4-8@high
bind.analyst: codex:gpt-5.5@high
bind.builder: codex:gpt-5.5@high
bind.judge: claude:claude-opus-4-8@xhigh
---

# Problem

greenflag records every human decision a run produces — attended gate crossings, auto-crossings under standing authority, holds, queued questions — but captures nothing about whether each stop was *right*. That ground truth is the missing input for every calibration question the project tracks (`docs/open-questions.md` §"Triage precision" above all), and it cannot be reconstructed later: only the human, close to the run, knows whether a stop was worth it. Build the grading layer.

- **`greenflag grade [runId]`** (default: the most recently finished run): an interactive walkthrough of the run's decision points. Each point is presented with enough inline context to judge it in seconds — the gate packet's summary, the queued question's text, the hold's finding, and what the human actually did — and takes a verdict: **right-stop** or **wrong-stop**, with an optional short note. The walkthrough also accepts **missed-stop** entries: a stop that *should* have happened but didn't, keyed to a phase, described free-form. Auto-crossed gates are gradeable too ("should that have stopped me?"). Re-grading is idempotent — a later pass revises verdicts, never duplicates them.
- **The ledger**: verdicts persist on the run record as a new additive section, mirrored to the corpus like every other ledger.
- **Read surfaces**: a grades section in `greenflag stats <runId>`, and a corpus script under `scripts/corpus/` aggregating verdicts across archived runs — stop precision over time, sliceable by workflow and by gate. The aggregation should output the signals the triage-precision question names, so a cohort read can actually move that dial.

Be ambitious about walkthrough quality: the target is a 60-second end-of-run ritual, not an archaeology session. Assembling the right context for each decision point — the packet text, the question, the hold reason, from the run record — is most of this feature's value.

# Onboarding

Read first: `CLAUDE.md`, then `docs/engineering.md` (the module map, the seams table, "Opt-in rails, safe defaults"). Then:

- `src/run/store.ts` — RunState and the existing ledgers (`phaseSummaries[].humanDecisions`, `autoApprovals`, the queued-question history); every write goes through `mutate()`.
- `src/run/corpus.ts` — the mirror hooks; a new ledger should ride the existing write paths, never add its own.
- `src/surfaces/stats.ts` — where the per-run read surface lands, and the exported parse cores that are the pattern for any log reading.
- `scripts/corpus/lib.ts` + `docs/corpus-runbook.md` — the corpus-script conventions and the graduation rule (a per-run, user-facing need earns CLI; cross-run analytics stay scripts).
- `docs/open-questions.md` §"Triage precision" — the calibration question this feature instruments.

# Constraints

- Grading never mutates protocol state: it adds its ledger and touches nothing else. A graded run resumes, replays, and renders identically to an ungraded one everywhere that doesn't explicitly read grades — absent grades are byte-for-byte invisible.
- The walkthrough needs a non-TTY story (the Environment seam already fakes `isTTY`): at minimum a non-interactive read of what would be asked and a scriptable way to record verdicts, so grading works over SSH and in tests.
- Grade from the local run dir; the corpus mirror carries the result when configured, but the corpus is never required.
- Human verdicts only — no automatic or model-judged grading. That is the point of the feature.

# Scope boundary

In: the command, the ledger, the `greenflag stats` section, the aggregation script, tests, and doc updates per `docs/documentation-standards.md`. Out: automatic grading, notification or reminder machinery, any change to when gates fire or how decisions are recorded at run time.

# Verification

- `pnpm typecheck && pnpm test`
- Drive it: grade a fixture run end-to-end in tests; the first real targets after merge are this experiment series' own runs.

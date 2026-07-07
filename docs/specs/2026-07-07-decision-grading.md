# Decision grading — a 60-second end-of-run calibration ritual

Status: design, approved at the gate (2026-07-07). Forward-looking; when it ships, its decisions distill into `docs/corpus-runbook.md` (the read/aggregate surfaces) and `docs/engineering.md` (the module map), and this proposal is pruned.

## Summary

duet records every human decision a run produces — attended gate crossings, auto-crossings under standing authority, holds, queued questions — but nothing about whether each stop was *right*. That verdict is the missing input for every calibration question the project tracks, above all `open-questions.md` §"Triage precision", and it cannot be reconstructed later: only the human, close to the run, knows whether a stop was worth the interruption.

**What we add:** `duet grade [runId]` — an interactive walkthrough of a finished run's decision points, each presented with enough inline context (the gate packet, the question, the hold's finding, what the human did) to judge in seconds, each taking a plain verdict. Verdicts persist as an additive `grades` ledger on the run record, mirror to the corpus like every other ledger, surface in `duet stats <runId>`, and aggregate across the archive into stop-precision signals sliced by workflow and gate.

**The approach:** grading is a **read-time reconstruction**, not a new runtime recording. A shared pure `decisionPoints()` core rebuilds a run's whole stop history from what the run *already* wrote — the state ledgers and the append-only, corpus-mirrored `orchestrator.log` — the same discipline `duet stats` uses to rebuild phase timings from logs. The only new write is the human's verdict.

**The boundary once it lands:**
- *Fixed:* every decision point of a finished run is enumerable, contextualized, and gradeable; verdicts are durable, idempotent to re-grade, and aggregate into triage-precision numbers.
- *Not touched:* when gates fire, how the protocol records decisions at run time, the statechart, resume/replay. A graded run behaves byte-for-byte like an ungraded one everywhere that doesn't read `grades`.
- *Deferred (one-line why):* automatic/model-judged grading — human verdicts are the entire point; notifications/reminders — the ritual is pull, not push; per-crossing gate granularity — reversible later from the log (below); operational (infra/budget) stop grading — no durable finished-run source, and the dials it would feed are already served by other ledgers (open questions); a durable write for facts reconstruction can't reach — held behind an explicit open question, never a quiet write.

## Goals

- Turn scattered, partly-erased run facts back into a judgeable decision point in seconds — **context assembly is where the value lives.**
- Produce the false-positive / false-negative signal `open-questions.md` §"Triage precision" names: over-flagging (a stop that wasn't worth it) turns AFK into a pager; under-flagging (a stop that should have happened) absorbs a decision the human owns.
- Stay a strictly additive read/write layer: absent grades are invisible; grading never mutates protocol state.

## User-facing behavior

### The walkthrough

`duet grade` presents each decision point in run order. A point's context block carries what the human needs and nothing else: the phase, what duet did (stopped-and-you-approved / stopped-and-you-rejected / auto-crossed / held for a high decision / asked you a question), the packet summary or question text or hold finding, and — for a gate that looped — **how many times you rejected it before approving**, derived from the gate's repeated re-entries in the log. That rejection count is *not* `state.rounds`, which counts checker **review** rounds (a different axis: a gate can loop once on review yet be rejected three times, or vice versa). One point per gate (rider), not one per rejection.

Each point takes one verdict, phrased plainly:
- for a point where duet **stopped** you: *"was stopping here right?"* → **right** / **wrong** (wrong = it shouldn't have interrupted you).
- for a point where duet **did not stop** (an auto-cross): *"should this have stopped you?"* → **right** (correct to sail through) / **wrong** (it should have stopped you).
- an optional short free-text **note** on any verdict.

The walkthrough also accepts **missed-stop** entries: a stop that should have happened but didn't, keyed to a phase and a short **id**, described free-form. It's the under-flag case that left no trace to grade — the human asserts it existed. Because a missed-stop has no log event to derive an ordinal from, the id is what makes re-grading it idempotent (below); the interactive flow suggests one, the non-TTY path requires it.

The human answers plain right/wrong; the readers do the confusion-matrix math (below). No TP/FP/FN/TN vocabulary is ever shown or stored.

### Idempotent re-grading

A verdict is an **upsert by the point's stable key**. A later `duet grade` pass over the same run revises verdicts in place and surfaces any newly-appeared points (a run graded before it finished, then re-graded after); it never appends a second verdict for the same point. The stable key is structural (below), so re-running discovery lands on the same keys.

### Non-TTY

Grading works over SSH and in tests via the injected `io` seam already used by `duet continue` / framing (`isTTY`, stdin reader):
- `duet grade <runId> --list [--json]` — print the decision points that *would* be asked (with their keys and context) and any discovery notes (below), record nothing.
- `duet grade <runId> --set <key>=right|wrong` (repeatable), `--note <key>="<text>"`, and `--missed <phase>:<id>="<text>"` — record verdicts scriptably, same upsert path. Verdict and note are **separate flags** so a note's free text (colons, pasted error/context strings) never collides with the value grammar — the one scriptable write path can't silently truncate a note.

### Run selection and write-safety

- Default target: the most recently **`done`** run (`latestRun` filtered to done).
- Explicit `duet grade <runId>` grades any **quiescent** run. An incomplete run is gradeable but **warns** — later stops aren't in the record yet, so the point set is partial.
- On an **actively-running** run (`probeRunPosition` kind `running` — a live driver owns its writes), `duet grade` **refuses the write** and says why; `--list` still works (read-only). This is a first-class rule, not a nicety: a grading write racing a live driver is exactly the class of bug the run-dir single-writer discipline exists to prevent.

## Non-goals

- **Automatic or model-judged grading.** Human verdicts only — that is the feature.
- **Notifications / reminders.** The ritual is something the human runs; no scheduling, no nudge machinery.
- **Any runtime-recording change.** No new writes at `advance_phase` / `ask_human` / `consumeHumanInput` / the `autoApprovals` paths, no statechart touch. If reconstruction proves genuinely lossy on a fact the ritual needs, that surfaces as an explicit open question (below), never a quiet write.

## Current vs desired

Today the four stop kinds land in four non-uniform places, and two are partly erased from state:

- **Auto-cross** → durable ledger `state.autoApprovals: [{ gate, at }]` + packet in `state.phaseSummaries[phase]`.
- **Hold** (a `high` `humanDecisions` withholding a pre-authorized auto-cross) → *not* a ledger entry; derived by `highDecisionsAt` + `!gateAttended`.
- **Attended crossing** → no structured record; the machine transition, an optional note, and log lines are the whole trace (there is no rejection counter — `state.rounds` counts checker review rounds, `tools.ts:511`).
- **Queued question** → `state.pendingQuestion` is transient; `consumeHumanInput` deletes it on answer (`store.ts:717`). No history in state.
- **Operational (infra/budget) stop** → the host sets only the transient `state.pendingQuestion` (`host-runner.ts` / `driver.ts:294`), bypassing the `ask_human` tool — so nothing durable survives in state or in the stable `orchestrator.log` event stream after the answer; rendered `driver.log` status is not a protocol source. Not reconstructable on a finished run (open questions).

But the **append-only `orchestrator.log` is a near-complete decision-event stream**, and the corpus mirrors it append-by-append:

```
◀ harness prompt (phase=X)        phase entry           driver.ts (headless only)
advance_phase (X) + summary       every advance, each round   tools.ts (both hosts — tool-level)
ask_human queued + question       every question        tools.ts (both hosts)
◀ approval rider + text           an approve rider      driver.ts (headless)
answerResumePrompt(answer)        the answer text, folded into the next phase prompt   briefs.ts → logged by driver.ts (headless)
```

So question text, per-round advance summaries (state keeps only the last), and the answer text are all recoverable from the mirrored log on the AFK/headless arc — the arc where triage precision actually matters. Desired state is a core that reads state ledgers first and the log only where state is silent, plus the verdict ledger.

---

## Module boundaries and seams

Three new things, one of them the load-bearing deep module.

```
src/run/
  store.ts             +Grade type, +grades? field, +upsertGrade mutator
  corpus.ts            UNCHANGED (grades ride state.json mirroring)
src/surfaces/
  decision-points.ts   NEW — the discovery core (deep; pure)
  grade.ts             NEW — the duet grade command (walkthrough + non-TTY), thin over the core
  stats.ts             + a grades section (reads the core)
scripts/corpus/
  grade-precision.ts   NEW — cross-run aggregation (imports the core)
```

The core lives in `src/surfaces/`, **not** `src/run/`, because the import direction is the trust gradient (`registry ← run ← voices ← orchestrator ← surfaces`, no upward value imports — `docs/engineering.md`, CLAUDE.md). It reads run state *plus* logs and reuses `stats.ts`'s log-parsing primitives; `run/` cannot import a surface, and `stats.ts` sits in `surfaces/` for exactly this reason (it too is a log-reading read-surface core). Placing the core beside it keeps the gradient intact — a read surface over run truth, not run truth itself.

### `decisionPoints()` — the discovery core (deep module)

The whole reconstruction complexity sits behind one small interface that returns points **and** its own degradation notes (a missing log must not silently shrink the point set into a rosy coverage rate — the same reason `stats.ts` returns `notes`):

```
decisionPoints(state: RunState, orchestratorLog: string | undefined): DecisionDiscovery
DecisionDiscovery = { points: DecisionPoint[]; notes: string[] }
```

`DecisionPoint = { key; kind; phase; polarity: 'stopped' | 'did-not-stop'; context; disposition }`, with just **two** kinds:

| kind | disposition | polarity | source |
| --- | --- | --- | --- |
| gate | `auto-crossed` | did-not-stop | `state.autoApprovals` + packet from `phaseSummaries` |
| gate | `held-high` | stopped | `highDecisionsAt` non-empty on a non-attended gate |
| gate | `attended` | stopped | log `advance_phase` at a gate phase, not in `autoApprovals`; approve vs reject-then-approve inferred from same-phase re-entry |
| question | — | stopped | log `ask_human queued` (question text); answer enriched from the following phase prompt on the AFK arc |

**One gate = one point (rider #2, and it fixes a real double-count).** A pre-authorized gate that a `high` held is *both* a `held-high` hold and, once the human resolves it, an `attended`-shaped `advance_phase` with no `autoApprovals` row (`lifecycle.ts:381`). Modeling `hold` as its own kind would emit two gradeable points for one gate — inflating the precision denominator. So `hold` is a **disposition of the single `gate:<phase>:0` point**, not a kind. The three dispositions carry a real grading distinction (`held-high` asks "was that high worth converting a walk-away run into a stop?" — the severity-hold calibration in `open-questions.md` §"The consultant's value"), so they stay distinct in context while collapsing to one point.

Multi-**finding** gates are deliberately collapsed too: the signal a graded gate yields is *"should this gate have stopped?"*, not *"which of its high findings was wrong?"* Finding-level precision is out of scope by design, named so in open questions.

**Depth / deletion test:** delete the core and the same reconstruction — state-ledger reads, anchored log parsing, phase attribution, approve/reject inference — reappears in `duet grade`, in the `stats` section, and in the corpus script, drifting apart. That drift is precisely the failure `corpus-runbook.md` documents as fatal ("the predecessor toolkit died of carrying its own regexes"). One core is the runbook's own prescribed mitigation.

**Deliberately independent, not folded into `stats`.** `duet stats`' model (`StatsModel`) is a timing abstraction; overloading it with decision points would make two unrelated concerns share one interface. The core is a *sibling* beside `stats.ts` in `surfaces/` — it **reuses** the timestamp-anchored regex discipline and `phaseForTurn` attribution (a same-layer import, gradient-safe) rather than reinventing them, but presents its own interface. It is depended on by `grade.ts`, the `stats` grades section, and the corpus script (which already imports `surfaces/stats.ts` cores) — and depends on nothing above it.

**Make illegal states unrepresentable:** `DecisionPoint` is parsed once at the interface; downstream consumers get a value they can trust. `polarity` is a property of the point, never re-derived at each read site.

### The `grades` ledger

```
Grade = { key: string; verdict: 'right' | 'wrong'; note?: string; gradedAt: string }
RunState.grades?: Grade[]        // additive; absent ⇒ byte-for-byte invisible
```

`upsertGrade(state, grade)` follows the `mutate()` fresh-load → apply → save discipline (`store.ts`), so a `duet grade` write can't clobber a concurrent state save, and re-grading replaces the entry with the matching `key`. It rides `saveRunState` → `mirrorFile` to the corpus — **no `corpus.ts` change** (state.json is already mirrored). Absent `grades` ⇒ every existing surface reads exactly as before; this is the same additive-field invariant as `acceptanceContract` / `gateless`.

The ledger is **minimal and jargon-free** (rider): it stores the human's plain verdict, not confusion-matrix cells. A **missed-stop** is stored in the same ledger as a grade whose key is `missed:<phase>:<id>` (the human-supplied id, not a derived ordinal — see the key rule), `verdict: 'wrong'`, `note` = the description — a synthetic did-not-stop point the human asserts. No separate structure.

### The stable key rule (first-class)

A discovered point's key is `"<kind>:<phase>:<ordinal>"`, ordinal = the 0-based index of that kind within that phase, in log/ledger appearance order.

- **Why ordinal, not a content hash:** the log is append-only and immutable, so appearance-ordinals are stable across re-grades. A hash over packet/question text would *move the key* if the wording were ever edited or normalized — orphaning the verdict, the one thing re-grading must never do.
- Gates are one-per-phase, so `gate:<phase>:0`. Ordinals earn their keep for **questions** (a phase can `ask_human` several times, appended in order).
- **Missed-stops are the exception: they have no log event, so no derivable ordinal.** A `--missed <phase>:<id>=` on a second pass must be able to tell *revise this one* from *add a new one*, and neither appearance-order (there is no log) nor the description (it may be edited) can supply that. So a missed-stop takes a **human-supplied id**: key `missed:<phase>:<id>`. The interactive walkthrough suggests an id; the non-TTY path requires one — which is what makes non-TTY missed-stop re-grading idempotent instead of duplicating.

### The three consumers

- **`duet grade` (`surfaces/grade.ts`)** — resolves the run (selection + write-safety above), runs `decisionPoints()`, zips against `state.grades`, drives the walkthrough or the non-TTY path, upserts. Thin over the core.
- **`duet stats` grades section** — runs the core, reports coverage (graded / total), the derived confusion-matrix counts, precision, and the missed-stop count. Reuses `stats`' fail-soft posture.
- **`scripts/corpus/grade-precision.ts`** — imports the core + `loadCorpusRecords` (`scripts/corpus/lib.ts`), aggregates verdicts by workflow, by gate/phase, by point kind, over time; outputs over-flag rate (FP / stops), under-flag rate ((FN + missed) / did-not-stops + missed), matching the triage-precision question.

**Confusion matrix, derived in the readers** (rider) from `(polarity, verdict)`:

```
stopped        + right  = TP        did-not-stop + right = TN
stopped        + wrong  = FP        did-not-stop + wrong = FN
missed:*                = FN (a did-not-stop the human asserts)
```

Every point in the set is a gate or a question, both of which have a clean `polarity`, so nothing can be fed to the matrix that doesn't belong in it. Operational (infra/budget) stops are **not in the point set at all** — they leave no durable finished-run trace (above) and triage precision is about product/direction routing, not environment recovery. Whether an operational stop was warranted is a separate question the durable `contextEvents` / `autoRetries` ledgers already inform; grading it is deferred (open questions).

## Foundation decision (preparatory refactoring)

The store/corpus structure absorbs the **write** side with zero reshaping — an additive field + mutator, auto-mirrored. The structure fights only on the **read** side, and exactly at the value center: **nothing today enumerates a run's whole stop history.** `status.ts`'s `stopModel` yields only the *current* stop; the rest is smeared across `autoApprovals` push sites, `highDecisionsAt`, and unparsed log lines.

The earned, **bounded** prep step is introducing the one shared `decisionPoints()` core — a new deep module that *composes* the existing `stats` anchored-regex primitives, not a rewrite of them. What it deliberately leaves alone: the statechart, the write sites, `stats`' timing model (untouched — the core is a sibling, not a merge), and `corpus.ts`. This is additive reshaping sized to the feature: one module and one ledger, no protocol surface moved.

## Architecture sketch

```
run record + orchestrator.log            (state.json ledgers + the append-only mirrored log)
        │
        ▼
decisionPoints(state, log) → {points, notes}   surfaces/decision-points.ts  — deep, pure
        │   state ledgers first; log parsed only where state is silent (questions, per-round packets, answer text)
        │   notes carry every degradation (missing log, pruned record) so coverage never lies
        ├──────────────┬───────────────────────────┐
        ▼              ▼                           ▼
  duet grade      duet stats §grades        scripts/corpus/grade-precision.ts
  (surfaces/      (reads core, derives      (imports core + loadCorpusRecords,
   grade.ts)       matrix + coverage)        aggregates by workflow/gate/time)
        │
        ├─ TTY: walkthrough (io.isTTY seam) → upsertGrade per point
        └─ non-TTY: --list / --set / --missed → upsertGrade
                          │
                          ▼
                 state.grades[]  →  saveRunState → mirrorFile (corpus, no new hook)
```

Control flow for one `duet grade`: resolve run → guard write-safety → `decisionPoints()` → zip `points` with `state.grades` (and surface `notes`) → walk (or apply `--set`/`--note`/`--missed`) → `upsertGrade` (mutate-safe) → mirror. The corpus script and the stats section run the *same* `decisionPoints()` and surface the same `notes`; only their output differs — one aggregates across records, one renders one run, one records verdicts.

## Test standards

Test through the public interfaces — the `decisionPoints()` core, the `duet grade` command via its `io` seam, the `stats` render — never past them. Fake only at the seams: the Environment `io` (`isTTY`, stdin reader) already used by `framing.ts` / `cli.ts`, and a **fixture run dir** (a real temp `.duet/runs/<id>/` with a hand-authored `state.json` + `orchestrator.log`) rather than mocking `store`/`corpus`. The behaviors that must be covered, and how to think about each:

- **Discovery of each disposition** (gate: attended-approve, attended-reject-then-approve, auto-crossed, held-high; question) — the core is pure over `(state, log)`, so drive it with fixture pairs and assert the returned `points` (kind, disposition, phase, polarity, key, extracted context). This is the deep module's interface and the bulk of the value; test it directly, no filesystem.
- **The held-then-attended gate yields one point, not two** — the fixture that most tempts a double-count (a `high` held a pre-authorized gate, then the human crossed it): assert a single `gate:<phase>:0` with disposition `held-high`. This guards the one-point-per-gate decision directly.
- **Idempotent re-grade by key** — grade, re-run discovery, re-grade with a changed verdict; assert one entry per key, verdict replaced. Two fixtures matter: a **reject loop appends a new question** (the graded question keeps its ordinal/key, the new one appears — the append-only ordinal guarantee), and a **second `--missed <phase>:<id>=`** with the same id revises rather than appends, while a different id adds (the missed-stop id contract).
- **Byte-for-byte invisibility when absent** — a run with no `grades` renders identically through `status` / `stats` / resume-shaped reads. Assert the serialized state has no `grades` key and existing surface output is unchanged.
- **Non-TTY record path** — `--set` / `--note` / `--missed` through `io.isTTY = false`; assert the upsert without a terminal, that a note with a colon survives intact (the separate-flag contract), and that `--list --json` records nothing.
- **Write-safety refusal** — a fixture positioned as `running` refuses the write and exits with a clear reason; `--list` on the same run still reads.
- **Fail-soft surfaces a note, not a silent drop** — a corpus record with `state.json` but no `orchestrator.log`: discovery still returns the state-sourced gate points, emits a `note` naming the log-sourced kinds it could not see, and never throws. Assert the note is present (a shrunken point set with an empty `notes` is the bug this guards).

Gotchas to hold in mind: the fixture log must carry the **real timestamped markers** the core anchors on (mirror `stats.ts`'s `TS`-anchored patterns — a body line must not masquerade as a header); the reject-loop, held-gate, and interactive-arc fixtures are where ordinal stability, the double-count guard, and the log-coupling limits actually get exercised, so they're worth writing early as tracer bullets. New tests at the core's interface **replace** any temptation to unit-test the private per-kind extractors — assert observable `points`/`notes`, not internals.

## Rabbit holes walked

- **Log-format coupling for the state-silent kinds.** Every fact the ritual needs is parseable on the **AFK/headless arc**: question text (`ask_human queued`), per-round packets (each `advance_phase` logs its summary), and the answer text (`answerResumePrompt` folded into the logged phase prompt). On the **interactive arc** the answer/reject-feedback *text* is the one genuine gap — get_task folds it into the unmirrored interactive tool-result path (returned to the MCP client, narrated to `driver.log` as kind only), and interactive phases log no `◀ harness prompt` header. The *fact and phase* of every interactive stop are still recoverable (`advance_phase` / `ask_human` are tool-level logged on both hosts); only the free-text the human typed on the attended arc is soft. Resolution: accept it — that arc is where the human was present, and triage-precision data comes from the AFK arc — and name it in open questions rather than adding a write (rider #1).
- **Ordinal derivation under a reject loop.** Because the log is append-only, a reject loop appends new events after the graded ones; earlier points keep their ordinals, new points get higher ones. Re-grade is therefore stable for graded points and additive for new ones — no key churn. One-point-per-gate (rider #2) means gate ordinals stay 0; ordinals only grow for repeated questions/missed-stops within a phase.
- **Corpus record with no local log.** `decisionPoints()` takes the log as `string | undefined` and degrades fail-soft: state-sourced points (the `auto-crossed` and `held-high` gate dispositions) still reconstruct; log-sourced points (questions, the `attended` disposition and per-round detail) drop out with a `note`. Grading a corpus record works because the log is mirrored; grading a bare local run works because the log is local; grading a record whose log was pruned still yields the state-sourced points and a note naming what it couldn't see.

## Open questions

- **Does the ritual need the interactive-arc answer/feedback text?** Reconstruction cannot recover the free-text a human typed at an *interactively-orchestrated* gate/flag (above). If dogfooding shows a grade there is un-judgeable without it, that is an explicit decision to make — relax the runtime-recording boundary for that single fact, weighed against its cost — **backed by the evidence of a run where it bit, never resolved by a quiet write** (rider #1). The current bet: it never bites, because interactive stops are attended in the moment and the AFK arc (where the data matters) is fully recoverable.
- **Per-gate vs per-crossing granularity.** We grade one point per gate, folding the rejection count into context (rider #2). If a cohort read wants to distinguish "rejected twice then approved" from "approved first pass," the per-round `advance_phase` summaries are already in the log, so promoting to per-crossing is a reversible follow-up needing no new recording. Deferred until a triage-precision read actually asks for it.
- **Gate-level, not finding-level, precision.** A gate carrying several `high` findings collapses to one gradeable point, so the signal answers *"should this gate have stopped?"*, not *"which high finding was the wrong one?"* This is intentional — it keeps the ritual at 60 seconds and the corpus number interpretable. If the severity-hold calibration (`open-questions.md` §"The consultant's value") later needs per-finding verdicts, that is a deliberate granularity increase, weighed against the ritual cost — not assumed now.
- **Operational (infra/budget) stops are not gradeable on a finished run.** Their terminal marker (`pendingQuestion`) is transient and deleted on answer, and they bypass the `ask_human` tool, so they leave no durable `orchestrator.log` event either — there is no reconstruct-only source. The dials this would feed (context-band, retry budget) are already served by the durable `contextEvents` / `autoRetries` ledgers. If a need arises to grade whether an operational stop was warranted, it is a separate reconstruction question with its own (currently missing) durable source — named here rather than papered over with a runtime write (rider #1).

---

**Final path:** written to `docs/specs/2026-07-07-decision-grading.md` per `docs/documentation-standards.md` (forward-looking, per-feature, dated design docs live under `docs/specs/`, not a top-level `docs/*.md`).

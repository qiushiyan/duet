# The corpus runbook — analyzing runs and evaluating changes

The operating manual for duet's evidence loop: where run data lives, how to read it, how to judge whether a prompt / snippet / workflow change helped, and where replay stands. The system design is `automation-design.md`; the code's mental model is `engineering.md`; what's next is `future-directions.md`. This doc is for future us, sitting down to answer *"what does the field data say?"*

## The corpus

Every run already writes a protocol-complete, plain-text record into its project's `.duet/runs/<id>/` — the full phase briefs, every worker prompt with its snippet tag and body, every response, the terminal calls, and the state ledgers. That location dies with its worktree. With `[corpus] dir` set in `~/.config/duet/config.toml`, the record **also mirrors, as it happens, into one central archive** that outlives the worktree — and the provider transcripts (which the CLIs prune on their own schedule) are captured into it gzipped when the run ends.

The guarantees, in order of how much they bite:

- **Default-absent is byte-for-byte off.** No config key, no corpus — nothing new is written anywhere.
- **Fail-soft is absolute.** A corpus write never affects a run — any failure (missing dir, full disk, unavailable synced volume) drops silently. The local run dir stays the working truth; every live surface (`status`, `doctor`, takeover, tmux) reads only it.
- **A record is an analysis archive, not a backup.** There is no restore path; live mechanics (`scratch/`, `driver.pid`, the interactive lease) are excluded.
- **The destination freezes per run at creation** (`RunState.corpusDir`) — changing config never re-points a live run, and runs created before the key existed never mirror.

One archived record:

```
<corpusDir>/<runId>/
  corpus.json           # era stamp: duet version, source cwd, creation time
  state.json            # the full ledger set: rounds, phaseSummaries + humanDecisions,
                        #   contextEvents, autoRetries, autoApprovals, bindings, sessions
  workflow.json         # the run's frozen compiled workflow
  framing.md  notes.md  machine.json
  orchestrator.log  <duty>.log …      # mirrored append-by-append (fresh to the last line)
  driver.log  steers/                 # swept in at quiescent stops
  transcripts/<voice>.<session-id>.jsonl.gz   # captured at done / abandon / purge
```

Data arrives by three paths: **append-through** during the run (voice logs, notes — a worktree deleted mid-phase loses nothing already logged), a **reconcile sweep** at every quiescent stop (self-heals any drifted file, catches `driver.log` and `steers/`), and **transcript capture** at terminal events — including the top of `duet abandon --purge`, before it deletes the originals.

## Setting up a machine

```toml
# ~/.config/duet/config.toml
[corpus]
dir = "~/duet-corpus"   # presence enables the mirror; use an absolute or ~ path
```

One trap to check by hand: the mirror is fail-soft in every direction, so a configured `[corpus] dir` whose directory doesn't exist means every run **silently skips mirroring** — create the directory and confirm the first run's record lands **(observed: exactly this silent-off state, caught 2026-07-07)**.

Then adopt whatever still exists on disk (idempotent; never modifies source run dirs):

```bash
node scripts/corpus/backfill.ts        # from the duet repo
```

For more than one machine, point `dir` at a folder your own sync tool carries — duet builds no sync (the standing remote constraint), and grouping across machines is a query over each record's `state.json` (`cwd`, `branch`, `workflow`), not a directory layout.

## Reading the corpus

For **one run in its project**, `duet stats <runId>` is the product surface — per-phase elapsed/worker time and the by-tag breakdown. Everything corpus-wide is deliberately *scripts, not CLI* (the graduation rule: a per-run, in-project, user-facing need earns a CLI surface; author-side analytics doesn't):

```bash
node scripts/corpus/phase-timings.ts          # where the time goes: span / busy / orchGap / idle@gates
node scripts/corpus/turn-stats.ts             # what it's spent on: duration by voice:tag, waste, loop costs
node scripts/corpus/compaction-durations.ts   # anomaly scan: /compact outliers
```

All take `--corpus <dir>` / `--sweep <root>` / `--json`; with no flags they read the configured archive, falling back to a live-worktree sweep while the archive is young. Each prints a load summary with skip counts — a nonzero `unloadable` count is pre-remodel-era records being refused by design, not an error.

**The method, distilled from the pass that built these tools** (2026-06-30, the AFK-resilience investigation): read the *shape* first — `phase-timings`' core tell is **busy ≪ span**, meaning the time is in orchestration and waits, not slow workers, which is a different fix entirely. Then the *waste* — `turn-stats`' failed/timeout itemization. Then chase the *anomaly* the first two surface. That order found the `7447` run's 117-minute "compaction" (one heartbeat in the window → a machine sleep under a monotonic timeout → the wall-clock backstop design), itemized ~9–10h of timeout waste (→ default-on bounded retry), and sized the 90-minute build cap from the healthy maxima **(observed; snapshotted in the AFK-resilience findings)**.

The metric glossary and its caveats — span/busy/orchGap definitions, wall-clock-vs-suspend and the heartbeat cross-check, small-corpus statistics — live beside the tools in `scripts/corpus/README.md`. One rule keeps the tools alive: **scripts compose the tested pure cores** (`buildStats`'s parsing primitives, `loadRunStateFromDir`, `workflowForRunDir`) **and never carry their own regexes** — the predecessor toolkit died of exactly that when the log format evolved under it.

## Evaluating a change

Replay answers one-phase policy questions; broader evaluation is still cohort comparison over the archive plus judgment over transcripts. The recipe:

1. **Pin the boundary.** The commit (and date) the prompt / snippet / workflow change shipped. Records carry `createdAt` and `corpus.json` carries the duet version, so the cohort split is mechanical.
2. **Build the cohorts.** Filter records by workflow, bindings, and date (`state.json` has all three). Like-for-like matters more than volume — a full run on Opus tells you little about a relay change.
3. **Compare the mechanical signals first** — these need no judgment: rounds per loop (`state.rounds` — did the spec loop stop marching to its cap?), turn durations by tag (`turn-stats` — did update turns shrink?), holds and their outcomes (`phaseSummaries[].humanDecisions`, `autoApprovals`), `contextEvents` (are cutoffs firing despite the 75% nudge?), `autoRetries`, and verify self-heal loops.
4. **Read for the judgment signals.** Triage precision, critique altitude, whether a routed rework actually converged — these live in the voice logs and the gzipped transcripts (`zless`, or `gunzip -c | jq`). Vibes are a legitimate instrument here; the discipline is writing them down.
5. **Snapshot what you conclude** into a dated findings doc, evidence-tagged **(observed)** with run ids. Corpus records are prunable; findings docs are the permanent layer — the AFK-resilience findings are the model.

Standing caveats: the corpus is small — read medians and maxima, not tight percentiles; durations are wall-clock, so cross-check a giant turn against the heartbeat cadence before calling it slow; and several open calibration questions (`open-questions.md`: triage precision, context bands, the consultant's value) name exactly which of these signals would settle them — check whether your cohort read moves one.

## Replay

Replay is the corpus tool for probing orchestrator policy under recorded worker stimuli. It re-runs one recorded phase's orchestrator against scripted workers reconstructed from the record, then writes a per-phase diff report: snippet tags and adaptation differences, terminal calls (`advance_phase` vs `ask_human` and their content), and loop shape (rounds, fan-outs, ordering). The report is evidence for a human reader, not a score; judging whether a divergence is better or worse stays outside the tool.

Run it from the repo:

```bash
node scripts/corpus/replay-phase.ts \
  --corpus ~/duet-corpus \
  --record <run-id> \
  --phase <phase> \
  --out <out-dir> \
  --yes
```

`--yes` is the cost gate: a live replay spends real orchestrator tokens, so the command refuses to drive the SDK unless the spend is explicit. `--dry-run` stops after record parsing and phase-entry reconstruction; it still writes the isolated replay workspace under `--out`, but it does not start the SDK and needs no provider auth.

The replay contract is **honest reconstruction**. The record supplies the logged phase brief, worker prompt bodies and tags, responses, steers that reached the harness, terminal calls, and the frozen workflow shape. Replay serves those where the record carries them; when it cannot, the report names the gap. Two gaps are expected in this slice: historical raw `list_snippets` tool output was not logged, so live replay serves the current snippet library if the orchestrator calls it; and phase-entry state is synthesized from terminal `state.json`, with phase-produced and downstream-produced fields cleared or noted.

Records are read-only instruments. Replay writes only under `--out`: its synthesized workspace, provider home, text report, and JSON report live there, never inside the corpus record or a live run dir. The shipped pipeline is verified by fake-turn tests and by dry-run reconstruction against a real corpus record. Live driven replay currently requires API-key, Bedrock, or Vertex auth. With OAuth Claude Code auth, the A1 isolation preserves the real provider store by redirecting session writes under `--out`, but that isolated config fails closed on authentication; the human ship gate still owns the auth-vs-isolation scope call.

## Era notes

`corpus.json` stamps each record's duet version at creation. Readers tolerate mixed eras by **skipping with a count**, never aborting; there are deliberately no era adapters — a record the current codecs refuse (everything pre-dating the 2026-07-04 remodel) stays refused, and that era's load-bearing conclusions live in its findings docs, not the corpus.

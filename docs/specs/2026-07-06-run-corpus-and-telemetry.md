# The run corpus — a durable archive for run records, and the telemetry scripts layer over it

**Status:** proposal, settled with the owner 2026-07-06; not yet built. First layer of the eval/replay direction (`docs/future-directions.md` §Active — "Eval/replay harness"); the replay harness itself is **out of scope** here and gets its own spec once this data substrate exists.

## Summary

**The problem, in product terms.** duet already records everything its evidence loop needs — every run dir is a protocol-complete, plain-text record (full phase briefs, every worker prompt with snippet tag and body, every response, terminal calls, the state ledgers) — but it records it into the most ephemeral location on the machine: `.duet/runs/<id>/` inside a project worktree. The owner works across many projects via worktrees and prunes them routinely, so field evidence keeps evaporating: the composed deep-relay run `20260705-1731-58a5`, cited as **(observed)** evidence in four docs, no longer exists on disk; only 12 run dirs survive machine-wide **(observed, 2026-07-06 sweep)**. The provider JSONL transcripts survive in `~/.claude` / `~/.codex` but lose their index when `state.json` dies with the worktree — and Claude Code prunes its transcripts on its own schedule (`cleanupPeriodDays`). Meanwhile "structure is verified by tests; judgment is verified by vibes" is this phase's named bottleneck: prompt and workflow changes ship unmeasured because the data to measure them against doesn't accumulate.

**What we're adding.** Three pieces, smallest-first:

1. **A corpus mirror** — opt-in via config presence: when `[corpus] dir` is set, every run's record is also written to one central home as it happens, so a run's record survives its worktree. Absent config ⇒ byte-for-byte today's behavior.
2. **Transcript capture** — at a run's terminal events (done, abandon) and *before* `purgeRun` deletes them, the voices' provider JSONL transcripts are copied into the run's corpus record, closing the `cleanupPeriodDays` rot and the orphaned-index problem.
3. **A committed `scripts/corpus/` telemetry layer** — the successor to the rotted `.duet/telemetry` reference set: enumeration, tolerant loading, and the proven timing/waste analyses, built as thin composers over the product's *tested pure cores* instead of private regexes, plus a one-time backfill of the runs that still exist.

**The boundary once this lands.** Every future run (on the owner's machines) becomes a durable eval sample, and the bird's-eye analyses that produced the AFK-resilience findings become rerunnable on demand. Explicitly deferred: the **replay harness** (needs this corpus; separate spec), any **corpus CLI surface** (analytics stays scripts until the `duet stats` graduation test is met — a per-run, in-project, user-facing need), **restore/resume from the corpus** (it is an archive, not a backup — a run whose worktree died lost its branch anyway), **cross-machine sync** (point `corpus.dir` at a synced folder; duet builds no sync, per the standing remote constraint), and **legacy-era adapters** (pre-remodel runs are skipped with a note; their load-bearing findings are already snapshotted in `afk-resilience-findings.md`).

**Risk and user impact.** None for anyone without the config key: the feature is default-absent and byte-for-byte off — the same discipline as the consultant binding. With it on, the mirror is fail-soft everywhere (a corpus write can never break or slow a run — the `store.ts` view-time-sidecar precedent), and no existing command changes behavior: `status`, `doctor`, `stats`, takeover, tmux all keep reading the local run dir, because the local dir remains the working truth.

## Current vs desired

```
Current:
  run writes → .duet/runs/<id>/          (worktree — dies with `git worktree remove` / rm -rf)
  provider transcripts → ~/.claude, ~/.codex   (survive, but index dies with state.json;
                                                pruned by cleanupPeriodDays)
  analytics → .duet/telemetry/*.py       (gitignored, uncommitted, private regexes —
                                          rotted at the seat→duty remodel)

Desired:
  run writes → .duet/runs/<id>/          (unchanged: the working truth for every live surface)
             ↘ <corpusDir>/<runId>/      (mirror, when configured: logs appended live,
                                          small files reconciled at quiescence,
                                          transcripts captured at terminal events)
  analytics → scripts/corpus/*.ts        (committed, typechecked, composing src's tested
                                          pure cores; reads <corpusDir>, falls back to a sweep)
```

## Coupling and foundation

**Coupling: an extension of the existing persistence discipline, not a new storage mode.** The corpus reuses four established patterns rather than inventing any: config-presence-means-on (the consultant binding), resolve-once-and-freeze at `createRun` (`gatesAt`, `budget`, `retryInfra` — the materialization discipline), fail-soft sidecar writes (`store.ts` — "a view-time sidecar must never affect the run"), and plain-text-inspectable-without-duet artifacts. The semantics are **duplicate, never redirect**: the local run dir stays primary and every existing reader is untouched. The redirect alternative (re-home run dirs centrally, project keeps a pointer) was considered and declined — it forces a project-identity scheme, breaks state-near-the-work (manual inspection, takeover, tmux `tail -F`), and leaves two storage modes to test forever; revisit only if the corpus ever becomes the primary consumer and local dirs vestigial.

**Foundation: the structure absorbs this cleanly — no preparatory refactoring.** Every analytically relevant write already funnels through `store.ts` helpers (`appendVoiceLog`, `saveRunState`/`mutate`, `saveMachineSnapshot`, `appendNote`); `buildStats` (`surfaces/stats.ts`) is already pure over log strings, pinned by tests; `loadRunState` already owns era normalization with typed refusals (`UnloadableRunError`). What we deliberately leave alone: the writes that *don't* funnel through the store — `driver.log` (a spawn-redirect fd), the `steers/` files, workers' `scratch/` — are handled by a quiescence sweep or excluded (below), not by rerouting their write paths.

## The design, decision by decision

1. **Opt-in by config presence.** `[corpus] dir = "<path>"` in `~/.config/duet/config.toml` (account-posture family, like `budget`/`transport` — not project knowledge, so the framing seam is untouched). Presence enables; absent ⇒ off, byte-for-byte. No per-run flag in v1 — the owner's machines set it once. Tilde-expanded and resolved at read time.
2. **Frozen on the run at creation.** `createRun` resolves the config and freezes `corpusDir` (the resolved run-record path) onto `RunState` — so the detached driver, the CLI, and the MCP host all mirror to the same place without re-reading config, and a run created before the config existed never half-mirrors. At freeze time, if `<corpusDir>/<runId>` already exists for a *different* run (cross-project same-minute collision — unlikely but representable), suffix the record dir; the frozen path is authoritative thereafter.
3. **The record is an analysis archive, not a backup.** Mirrored: the voice logs, `state.json`, `machine.json`, `notes.md`, `framing.md` (+ raw), `workflow.json`, the gate packets implicit in state, and captured transcripts. Excluded: `scratch/` (workers' workspace), `driver.pid`, `mcp-owner.json` (live-run mechanics, meaningless post-hoc). There is no restore path from the corpus.
4. **Write-through appends + quiescence reconcile.** Log appends mirror per-write (the tail-loss-sensitive part: a worktree deleted mid-phase loses nothing already logged); small whole files (`state.json`, `machine.json`) mirror as copies. At every quiescent stop the lifecycle additionally reconciles the record with a full copy of the run dir's included files — self-healing any drift from failed mirror appends, and catching the non-funneled files (`driver.log`, `steers/`). Between stops, log tails stay fresh; after stops, the record is exact. The `steers/` copy is deliberate, not redundant with the logged steer text: the directory preserves the channel's *state* — which steers were still pending (staged, never delivered) when the run stopped, a delivery-failure signal the corpus exists to catch — where the logs carry it only derived (diffing staged-markers against delivered-markers); its cost inside an existing dir walk is nil.
5. **Fail-soft is absolute.** Every corpus write is wrapped: any failure (missing dir, full disk, unavailable synced volume) drops the write silently and never surfaces to the run, the tool result, or the human. The corpus is best-effort telemetry; the local dir is truth until deleted.
6. **Transcript capture at terminal events, gzipped from day one.** On done and abandon, and at the top of `purgeRun` (**before** its `rmSync` — ordering is the point: purge currently deletes the transcripts *and* the run dir, destroying the record and its index in one stroke), copy every session transcript the state's `sessions` map + `orchestratorSessionId` name (via the existing `locateSessionTranscripts`) into `<record>/transcripts/`, **gzip-compressed, uniformly** (`.jsonl.gz`, `zlib` stdlib at the one capture site — backfill adoption included). Transcripts are the one unbounded-size artifact (a long orchestrator session reaches tens of MB; JSONL compresses ~5–10×), and the realistic pinch is a `corpus.dir` on a synced folder, not local disk. Uniform-from-day-one is the load-bearing part: a raw-then-compress-when-it-bites policy would create the two-format corpus this spec exists to avoid. The inspectability cost is confined to the forensic layer — duet's own logs/state/notes stay plain text, the provider-home originals stay raw until pruned, `zless` works, and corpus readers go through the scripts' one gzip-aware read helper. Runs that never reach a terminal event keep their transcripts in the provider homes; the mirrored `state.json` preserves the index, and the backfill script can adopt them later while they still exist.
7. **Flat record layout, grouping by query.** `<corpusDir>/<runId>/` — no per-project subdirectories. Project identity is a real design problem (worktrees of one repo should group; cwd says otherwise) that a flat layout dodges entirely: the mirrored `state.json` carries `cwd`, `branch`, and `workflow`, so grouping is the reader's query. A small `corpus.json` beside the record (duet version, source cwd, mirroredAt) stamps the era — the mixed-format lesson made mechanical.
8. **Scripts compose the tested pure cores; they never re-parse.** The anti-rot rule, and the reason `.duet/telemetry` died: each script carried its own regexes, so the seat→duty remodel broke all of them silently. The new layer imports `buildStats` (pure over strings), `loadRunState`, `workflowFor` — format knowledge lives once in `src/`, pinned by tests; when the format changes, a test breaks and the scripts inherit the fix. When a script needs a primitive the cores lack (busy-interval union, gap detection, heartbeat cross-check), the primitive is added to the pure core beside `buildStats` — tested — and the script stays a thin composer. Scripts themselves are deliberately untested (the view-glue carve-out). Node runs `.ts` directly, so `node scripts/corpus/<tool>.ts` works and `pnpm typecheck` covers them; `scripts/` is dev tooling, never shipped in the package `files`.
9. **Mixed-era tolerance in readers, refusal in the product.** The CLI is right to refuse unloadable runs; analytics readers catch `UnloadableRunError` (and genuinely foreign dirs) and **skip with a count**, never abort a sweep. No era adapters.
10. **Port the metric vocabulary, not the Python.** The durable asset of `.duet/telemetry` is its glossary and caveats, which have proven ROI (the span/busy/orchGap decomposition surfaced the `7447` 117-min "compaction" that unravelled the machine-sleep root cause → the wall-clock backstop; the timeout-waste view justified default-on retry; the healthy-turn maxima sized the 90-min build cap). That vocabulary — span/busy/orchGap, idle@gates, duration-by-`voice:tag` percentiles, failed-vs-timeout waste, compaction outliers, big-gap detection — is re-implemented against the current cores. `.duet/telemetry` itself stays untouched as frozen reference evidence (the `src/spike/` convention: executable evidence, do not modernize).

## Target shape

*Envisioned, not a contract — the build may drift for stated reasons, never silently.*

```
Structure — after:
  src/run/corpus.ts            # the mirror: record path resolution, mirrorAppend /
                               #   mirrorFile / reconcileRecord / captureTranscripts,
                               #   the include/exclude list — ALL fail-soft; run/-local
                               #   (fs + RunState only, no upward imports)
  scripts/corpus/
    lib.ts                     # enumerate records (corpusDir first, live-worktree sweep
                               #   as backfill fallback — find-based, never glob) +
                               #   tolerant load (skip-with-note) + gzip-aware transcript read
    backfill.ts                # one-time: sweep surviving run dirs + adopt still-living
                               #   orphaned transcripts into the corpus; idempotent
    phase-timings.ts           # span / busy / orchGap / idle@gates, per run and aggregate
    turn-stats.ts              # duration by voice:tag, waste itemization, loop costs
    compaction-durations.ts    # /compact outlier scan
    README.md                  # the metric glossary + caveats carried forward
                               #   (wall-clock vs suspend + heartbeat cross-check,
                               #    small-corpus statistics, enumeration gotcha)

Config — what the owner writes once per machine:
  # ~/.config/duet/config.toml
  [corpus]
  dir = "~/duet-corpus"        # presence enables the mirror; absent ⇒ off

Record — what one archived run looks like:
  <corpusDir>/<runId>/
    corpus.json                # duet version, source cwd, mirroredAt — the era stamp
    state.json  machine.json  workflow.json  framing.md  notes.md
    orchestrator.log  <duty>.log …           # appended live, reconciled at stops
    driver.log  steers/                      # from the quiescence sweep
    transcripts/<voice>.<session-id>.jsonl.gz   # captured at done/abandon/purge; gzipped uniformly

Wiring — who calls the mirror:
  store.ts append/save helpers  → mirrorAppend / mirrorFile   (per-write)
  lifecycle quiescent stops     → reconcileRecord             (sweep + self-heal)
  done / abandon / purgeRun     → captureTranscripts          (purge: BEFORE rmSync)
  createRun                     → freeze corpusDir; write corpus.json + creation files
```

## Behaviors that matter (test altitude)

- **Default-off is byte-for-byte**: with no `[corpus]` config, no new file, dir, or state field appears anywhere (the parity discipline).
- A mirrored run's included files are **identical to the local run dir at every quiescent stop**, including after simulated mirror-append failures mid-phase (the reconcile self-heals).
- **No corpus failure is observable** in run behavior, tool results, or exit codes.
- **Purge with a corpus configured captures transcripts before deletion**; purge without one behaves exactly as today. Every captured transcript is gzipped — no raw-format transcript ever lands in a record, from any capture path (terminal event, purge, backfill).
- **Backfill is idempotent**, skips unloadable/foreign dirs with a count, and never modifies source run dirs.
- A run created **before** the config key existed never mirrors (frozen-at-creation governs).

## Rabbit holes, named and dispatched

- **Non-funneled writes** (`driver.log` is a spawn-redirect fd; `steers/` are file-per-steer renames): not rerouted — the quiescence reconcile carries them. Accepted loss: a mid-phase worktree deletion loses the `driver.log` tail since the last stop; the protocol substance (voice logs) is append-mirrored and current to the last line.
- **Mirror drift** (a failed append followed by successful ones): accepted between stops, erased by the quiescence full-copy reconcile. Never reconcile per-append (O(n²) on growing logs).
- **Concurrent runs, one corpus dir**: append targets are per-run files under distinct `runId` dirs; the existing at-most-one-writer-per-run discipline covers the rest. No locking added.
- **`runId` collisions across projects**: handled once at freeze time (decision 2), never at write time.
- **Scripts on a published install**: `scripts/` is repo-dev tooling importing `src/` directly; it is excluded from the package and its absence costs users nothing. If corpus analytics ever meets the graduation test, that is a product decision for a future spec, not a packaging accident.
- **Replay's data needs**: everything slice-one replay diffs (phase briefs, tags, bodies, terminal calls) is verified present in the record today (`driver.ts:157` logs the full brief; `tools.ts` logs prompt/response bodies). Whether replay re-renders briefs from the frozen workflow or replays recorded ones is that spec's question, not this one's.

No open questions remain — the two this spec carried at first writing (steer-file redundancy, transcript size) were settled with the owner 2026-07-06 and folded into decisions 4 and 6.

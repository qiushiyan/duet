# greenflag corpus scripts

Committed telemetry scripts over the run corpus. They are repo-dev tooling, not a
product CLI surface: run them with Node 24 directly, for example:

```bash
node scripts/corpus/phase-timings.ts
node scripts/corpus/turn-stats.ts
node scripts/corpus/compaction-durations.ts
node scripts/corpus/grade-precision.ts
node scripts/corpus/backfill.ts --corpus ~/greenflag-corpus --sweep ~/dev
```

By default the scripts read `[corpus] dir` from `~/.config/greenflag/config.toml`.
If that has no records, the analysis scripts fall back to a live-run sweep under
`~/dev` (or the current directory if `~/dev` is absent). Pass `--corpus <dir>`
or `--sweep <dir>` to override. The sweep uses a readdir walk that deliberately
enters hidden path components like `.worktrees` and `.greenflag`; do not replace it
with a default glob.

## Record Shape

One archived run lives at `<corpusDir>/<runId>/`:

| file | what it carries |
| --- | --- |
| `corpus.json` | archive stamp: greenflag version, source cwd, mirroredAt |
| `state.json`, `machine.json`, `workflow.json` | the product codecs, copied from the run dir |
| `*.log`, `driver.log` | voice logs plus driver narration |
| `framing.md`, `notes.md`, `steers/` | human-readable run context and steer channel state |
| `transcripts/*.jsonl.gz` | provider transcripts captured at terminal events, purge, or backfill |

The corpus is an archive, not a restore path. Local `.greenflag/runs/<id>/` remains
the working truth for live commands.

## Tools

`phase-timings.ts`

Breaks each phase into:

- `span`: wall-clock from phase entry to `advance_phase`.
- `busy`: union of worker-turn intervals inside the phase. Parallel turns do
  not double-count.
- `orchGap`: `span - busy`, the orchestration and waiting remainder.
- `idle@gates`: wall-clock between a phase close and the next phase open.
- `!NTO/Mfail`: timed-out and failed worker turns inside the phase.

`turn-stats.ts`

Prints duration by `voice:tag` (n, median, p90, max, total), compute share by
voice, failed/timed-out waste, and big gaps over 25 minutes between consecutive
worker turns.

`compaction-durations.ts`

Lists `/compact`, reread, and recover-like turns by duration, flagging anything
over 10 minutes. It also counts the worker log's `⏳ … elapsed` heartbeats inside
the turn window (the driver-log copy carries no parseable timestamp, so the
worker log is the source); a long turn with only one or two heartbeats often
means the machine slept rather than computed.

`grade-precision.ts`

Aggregates human decision grades by workflow, phase, decision kind, and grading
month. It reports over-flag rate (`FP / stopped`) and under-flag rate
(`FN / did-not-stop`, including human-declared missed stops).

`backfill.ts`

Sweeps surviving live run dirs, mirrors included files into the corpus, and
adopts still-present provider transcripts as `.jsonl.gz`. It is idempotent and
does not modify source run dirs. Unloadable pre-remodel runs and foreign dirs are
skipped with counts.

## Caveats

- Durations are wall-clock from stored UTC log timestamps. A giant "turn" can be
  machine sleep. Cross-check suspicious spans against the worker log's heartbeat
  cadence (`about every 5 minutes` during a healthy running turn).
- The corpus is usually small. Treat medians, maxima, and outliers as triage
  signals, not statistically robust distributions.
- Product readers refuse old eras. These scripts tolerate them by skipping
  `UnloadableRunError` records with a count; they do not build era adapters.
- Parsing lives in `src/surfaces/stats.ts` and state/workflow loading goes
  through `src/run/*` helpers. Keep scripts as composers; when a new metric needs
  parsing, add a tested pure primitive in `src/` first.

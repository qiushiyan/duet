# Acceptance contract — the visualization surface (`duet graph`)

Frozen, falsifiable assertions defining what "shipped correctly" means for the
`docs/visualization-surface.md` design. Independent of the implementation; authored before code.
Each line is one observable behavior with a concrete probe. IDs are stable and never renumbered.

Scope note: this contract deliberately skips the happy-path structural rendering (phase order, gate
labels, duty pairs, caps) — the implementer's own tests own that. It spends its budget on the
runtime behaviors that can silently drift from the document's intent while every obvious test passes:
the read-only/no-write boundary, the honesty limits on what state can attest, artifact plain-textness,
schema stability of the untouched surfaces, and the two novel log-timeline rules (live-phase and
ordering drift).

---

[A1] When `duet graph --workflow <name>` is run against an existing project workflow dir
(`.duet/workflows/<name>.ts`), the system SHALL NOT create, modify, or delete any file in that dir or
its parents.
  Verify by: snapshot the workflow dir's file list + contents + mtimes before and after the command →
  identical afterward; specifically no `tsconfig.json` and no `*.d.ts` stub appear. Contrast probe:
  `duet workflows check <name>` on the same fresh dir DOES provision those files (proving the
  no-provision path is the one graph takes, not that provisioning is globally broken).

[A2] While a driver holds the run (a live `driver.pid` present in `.duet/runs/<id>/`), any invocation
of `duet graph [runId]` (ANSI or `--json`) SHALL NOT modify `state.json` or any other file under
`.duet/runs/<id>/`.
  Verify by: hash every file under the run dir before and after the command with a live `driver.pid`
  in place → all hashes unchanged; `state.json` mtime unchanged.

[A3] Where a gate has already been passed and has no entry in `autoApprovals`, the run view SHALL
render that gate's crossing as `crossed` and SHALL NOT render it as `attended` (state does not attest
an explicit human approval).
  Verify by: build a run that crossed an attended gate by human tap (no `autoApprovals` ledger entry);
  `duet graph <runId> --json` → that gate node's `outcome` is `"crossed"`; assert the token
  `"attended"` never appears as a gate outcome anywhere in the output.

[A4] Where a passed gate IS ledgered in `autoApprovals`, the run view SHALL render its outcome as
`auto-crossed`, and where a passed gate is not so ledgered it SHALL render `crossed`.
  Verify by: a run with one auto-crossed gate and one human-crossed gate → `--json` shows the ledgered
  gate `outcome: "auto-crossed"` and the other `outcome: "crossed"`; the two never swap.

[A5] When `state.contextEvents` contains a context intervention (compaction / salvage / cutoff /
session-reset), the run view SHALL surface it in the run-level `interventions` list (by voice + kind)
and SHALL NOT emit it as a per-phase drift flag on any phase node.
  Verify by: a run whose state carries one `contextEvents` compaction → `duet graph <runId> --json`
  has that event in top-level `interventions`; every phase node's `drift` array is free of any
  compaction/context-kind flag.

[A6] The `--json` and `--mermaid` render targets (blueprint, run, and `stats --trace`) SHALL emit no
ANSI escape sequences.
  Verify by: capture each of `duet graph --workflow <name> --json`, `duet graph --workflow <name>
  --mermaid`, `duet graph <runId> --json`, `duet stats <runId> --trace --json` to a pipe → none
  contains the byte `0x1B` (`\x1b[`); the same commands under a forced-color TTY env still emit none.

[A7] The change SHALL NOT alter the shape or values of `duet status --json` output.
  Verify by: `duet status <runId> --json` against a fixture run matches the pre-change pinned schema
  snapshot key-for-key and value-for-value (the snapshot already asserted in `status.test.ts`); no key
  added, removed, or retyped.

[A8] When a run is stopped mid-phase (the current phase has worker turns but no `advance_phase` yet),
`duet stats [runId] --trace` SHALL attribute that phase's worker turns to that phase.
  Verify by: a run parked inside a running phase with ≥1 worker turn and no advance for it →
  `--trace --json` lists that phase with its turns present; those turns do NOT appear as
  `unattributed`, and the phase is not absent from the timeline.

[A9] The open-current-phase window used by `--trace` SHALL NOT change the output of `duet stats
[runId]` when `--trace` is absent.
  Verify by: `duet stats <runId> --json` (no `--trace`) against a mid-phase fixture run matches the
  aggregate-stats snapshot with no synthesized open/current window and no new per-phase entry leaking
  into the aggregate output.

[A10] When a run has a steer that was already delivered (renamed into `steers/delivered/`),
`duet stats [runId] --trace` SHALL still render that steer, placed at its `stagedAt` in its
`stagedDuring` phase and labeled `staged`.
  Verify by: a run with one steer file physically in `steers/delivered/` → `--trace --json` includes
  it at its `stagedAt` timestamp under its `stagedDuring` phase with a `"staged"` label; it is not
  dropped, and its rendered time is the staging time, not any delivery time.

[A11] If two consecutive checker review-family turns occur in the same phase with no maker turn
started between them, `duet stats [runId] --trace` SHALL raise an ordering-drift flag for that phase;
and if a maker turn started between them it SHALL NOT.
  Verify by: fixture logs with checker-review → checker-review (no maker between) → drift flag present
  for the phase; fixture with checker-review → maker → checker-review → no drift flag. A non-cataloged
  / anytime tag between two reviews SHALL NOT be treated as a review turn and SHALL NOT itself raise
  the flag.

[A12] Where a consultant turn occurs between two consecutive checker review-family turns in a phase,
`duet stats [runId] --trace` SHALL still raise the ordering-drift flag for that phase (a consultant
turn is not a maker interleave).
  Verify by: fixture logs with checker-review → consultant → checker-review in one phase →
  `--trace --json` shows the ordering-drift flag for that phase (the consultant turn does not suppress
  it), and the command completes without erroring on the consultant address.

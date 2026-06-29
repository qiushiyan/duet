# Acceptance contract: deepen the five hottest modules

Frozen list of falsifiable assertions that define success for the change specified
in `2026-06-28-deepen-hot-modules.md`. This is a **behavior-preserving structural
refactor**, so the contract does not re-list every reshape — it pins what
"behavior-preserving" concretely *means* here, plus the spec's named invariants,
focused on runtime behavior that can silently drift from the spec while the existing
727-test suite (the author's own preservation oracle) still passes green.

Out of contract scope by design: blanket "every string / `isError` / CLI message /
status line is unchanged" — that is exactly what the existing suite owns. The
assertions below spend their budget on the quiet, high-impact drifts that survive a
green suite. Verified independently of the implementer's tests.

---

[A1] While a rail-bearing tool handler (`send_prompt`, `ask_human`, `advance_phase`, and `create_branch`'s branch-fixed guard) processes an action that a rail rejects, the system SHALL return a tool result carrying `isError: true` and non-empty steering text, and SHALL NOT throw or reject.
  Verify by: invoke each rail-bearing handler with an input that triggers each of its refusal conditions → each call resolves to a result object with `isError === true` and non-empty text content; no exception or rejected promise escapes any handler.

[A2] When `send_prompt` is called for a role that has both a live in-flight turn and an on-disk pending record, the system SHALL refuse with the same-role-in-flight steering and SHALL NOT refuse as a reconnect-orphan nor reseed the turn.
  Verify by: construct that combined state and call `send_prompt` for the role → the refusal text names the in-flight/wait recovery, not a reconnect/`duet takeover` recovery; no reseed dispatch is issued.

[A3] Where the statechart defines the `full` and `rir` arcs, every phase SHALL report a non-null human gate, and each phase's gate-and-advance-target mapping SHALL equal its pre-refactor mapping.
  Verify by: enumerate each arc's phases and their (gate, advance-target) after the change → no phase reports a null/absent gate, and the per-phase mapping is identical, phase-for-phase, to a snapshot taken from the pre-change build.

[A4] While the same run state that triggers a rail is presented to both the blocking stdio host and the async interactive run-scoped server, the system SHALL produce the same `isError` flag and the same steering text on both hosts.
  Verify by: drive an identical rail-triggering state through a real stdio `_mcp` subprocess and through the interactive host → the `isError` flag and text are byte-identical between the two.

[A5] When two mutators for different roles run interleaved against the same run, the system SHALL persist both roles' changes, neither role's entry overwriting the other's.
  Verify by: interleave e.g. `markTurnActive(reviewer)` with `clearTurnActive(implementer)` → the saved `state.json` reflects both mutations and the sibling role's entry is intact.

[A6] When a clearing mutator (`clearTurnActive`, `clearPendingTurn`) removes a role's entry, the system SHALL persist the absence of that key.
  Verify by: set, then clear, a role's entry → reload `state.json`; the deleted key is absent, not stale-present.

[A7] If a mutator targets an entry that is absent or already at its target value (e.g. `recordTurnSessionId` for an absent turn, `markWorkerDispatched` when already dispatched), then the system SHALL NOT write `state.json`.
  Verify by: invoke such a no-op mutator → no disk write occurs (the `state.json` content and mtime are unchanged; no save is performed).

[A8] Where a fan-out tool result combines multiple roles' turn outcomes (`combineFanoutResults`), the system SHALL set `isError: true` if and only if at least one role's turn errored.
  Verify by: a fan-out with one errored and one succeeded role → `isError === true`; a fan-out with all roles succeeded → `isError` is false/absent.

[A9] When `duet continue` targets a run whose driver crashed or was abandoned, the system SHALL resume that existing run and SHALL NOT exit with a no-run error nor create a new run.
  Verify by: leave a run in a crashed/abandoned state and run `duet continue` → it re-attaches/recovers the same run id; no new run directory is created and the command does not exit non-zero with a "no run found" error.

[A10] When `advance_phase` in the `full` arc would cross the acceptance-contract checkpoint without this run's contract author and verify markers both present, the system SHALL refuse the crossing and SHALL NOT change phase.
  Verify by: at the contract checkpoint with the author/verify markers absent → `advance_phase` returns a refusal and the phase is unchanged; with both markers present, the same call crosses.

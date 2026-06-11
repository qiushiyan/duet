# Spec: `duet runs` — list known runs

## Problem

Duet persists one state file per run under `.duet/runs/<run_id>.json`, but there is no way to see what runs exist, which phase each is in, or which are waiting on a human answer — short of reading the JSON by hand. The `duet status <run_id>` command (planned) presupposes the user already knows the run id.

## Proposal

Add a `duet runs` command that scans `.duet/runs/*.json` in the current repository and prints one line per run:

```
<run_id>  <phase>  <gate-or-flag>  <started>  <branch>
```

Runs are sorted newest-first. The command takes no arguments and no flags in v1.

## Behavior

- Reads every `*.json` file in `.duet/runs/`.
- Prints the table to stdout; exits 0.
- If `.duet/runs/` does not exist, prints "no runs" and exits 0.
- The state file is a hint, not the source of truth — `duet runs` reports what the hints say without verifying against the JSONL transcripts.

## Out of scope

- Filtering, JSON output, cross-repo listing.
- Verifying state files against transcripts.
- Any mutation (cleanup, archival).

---
workflow: blueprint
bind.architect: codex:gpt-5.5@high
bind.analyst: claude:claude-opus-4-8@high
bind.builder: codex:gpt-5.5@high
bind.critic: claude:claude-opus-4-8@high
bind.consultant: codex:gpt-5.5@high
---

# Problem

The corpus archives every run's full protocol record; nothing yet *replays* one. Build replay's first slice, as designed in `docs/corpus-runbook.md` §"Replay" and active in `docs/future-directions.md`: re-run a recorded phase's **orchestrator** — a real orchestrator session, driven fresh — against **scripted workers** reconstructed from the record, and diff the routing choices against the original:

- which snippet was picked per turn (by tag), and where the adaptation diverged;
- the terminal calls (advance vs ask, and their content);
- the loop shape: review rounds used, fan-outs, ordering.

Output: a per-phase diff report, human-readable text plus a JSON form. **Scoring is explicitly out of scope** — this slice produces the diff; judging whether a divergence is better or worse stays with the human reading it.

Fixtures: the corpus archive at `~/duet-corpus` holds this series' earlier records (runs A and B — the graph and grade features). Use one of their phases as the worked example. The record already carries what this slice needs: the full phase brief arrives as the logged harness prompt, and every prompt body, tag, response, and terminal call is in the voice logs.

The ambition target is **honest reconstruction**: the replayed orchestrator sees byte-identical inputs — brief, snippet bodies, steers — wherever the record carries them, and the report *names* anything it could not reconstruct rather than silently approximating. An honest narrow replay beats a broad lossy one.

# Onboarding

Read first: `CLAUDE.md`, `docs/engineering.md` (the seams table especially), `docs/corpus-runbook.md`. Then:

- `src/orchestrator/hosts/driver.ts` — `RunOrchestratorTurn`, the in-process SDK seam a replay drives.
- `src/voices/providers/types.ts` — the `WorkerProvider` contract; `tests/helpers/` shows worker scripting. Replay's scripted workers are a third adapter at this seam — exactly what the seam rule prescribes instead of mocking.
- `src/orchestrator/tools.ts` + `src/orchestrator/briefs.ts` — what the orchestrator reads per phase; replay serves these from the record's vintage where possible.
- `src/surfaces/stats.ts` exported cores + `scripts/corpus/lib.ts` — record reading; no new log regexes.
- `src/run/workflow.ts` — the record's frozen `workflow.json` is the phase-shape source.

# Constraints

- Corpus records are read-only instruments: replay never writes into a record, a live run dir, or the provider session stores; outputs land in replay's own output directory.
- A replay spends real orchestrator tokens — running one is a deliberate act whose cost the command surface names, never something ambient.
- Placement is a design decision to make explicitly: the graduation rule sends author-side analytics to `scripts/`, but the orchestrator re-run composes `src/` seams. A `src/` replay kernel wrapped by a thin script is the expected shape — argue the exact line at the design gate.
- The diff must separate benign nondeterminism (adaptation wording) from structural drift (a different snippet, a different terminal call, extra rounds) — report both, kept distinguishable.
- The snippet library may have changed since a record was made: replay serves the record's logged bodies where they exist; where it must fall back to the current library, the report says so.

# Scope boundary

In: replaying one recorded phase headless, the scripted-worker reconstruction, the diff report, tests, and doc updates per `docs/documentation-standards.md` (the corpus runbook's replay section graduates from "designed, unbuilt"). Out: scoring, batch replay across many runs, replaying the workers themselves (they are scripted by definition), any UI.

# Verification

- `pnpm typecheck && pnpm test`
- Drive it: replay one phase of a real archived record and include the diff report in the PR description.

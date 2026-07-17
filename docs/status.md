# Status

What greenflag has actually done on real work, and what it hasn't. Honest markers live here and in `docs/open-questions.md`, never scattered through the design docs.

**Early and personal.** Built for one developer's workflow, published in case the shape is useful. Expect rough edges.

## Live-verified end to end

- **All four shipped workflows** — full and short on both orchestrator hosts (headless and interactive); **blueprint** and **relay** via the 2026-07-07 three-run series on greenflag itself ([findings](researches/2026-07-07-live-run-series-findings.md)): three framings → three AFK deliveries → three merged PRs, every human stop graded.
- **Composing your own workflow** — the `greenflag/workflows` SDK end to end (an authored `deep-relay` definition → compile-and-freeze → gateless run → open PR; run `20260705-1731-58a5`). The same run gave the duty-keyed remodel its first outing and exercised the **fixer** (judge) delivery posture, the severity holds (two mid-run holds, both genuine catches), and the pre-run `greenflag workflows` inspector.
- **The consultant and the acceptance contract** — frozen success assertions verified against the built system, self-healing through the workflow's fixer before they hold a gate. Including the hold path: a mis-authored assertion failed verify and held the Ship gate rather than shipping past it.
- **The gateless posture**, run supervision (`greenflag doctor`, default-on infra retry), the shared PR-only `finish` tail, and `greenflag stats`.
- **The evaluation loop** — the run corpus (records mirrored live, transcripts captured gzipped); decision grading (`greenflag grade`'s first sessions produced the first instrumented triage-precision numbers — over-flag 0%, under-flag 14% — and caught a real classification bug the same day, PR #39); `greenflag graph` and `greenflag stats --trace` against live runs; inline provider tuning, preflighted at creation; and replay's first slice reconstructing a real record dry-run. The method: [`corpus-runbook.md`](corpus-runbook.md).

## Built and test-verified, awaiting a first live run

- **The live driven-replay diff** — replay's fresh-vs-original routing diff needs API-key/Bedrock/Vertex auth (the record-isolation contract correctly fails closed on OAuth Claude Code). The dry-run reconstruction already ran on a real record, so this is a one-command re-run once auth is set.
- **The interactive-Claude worker transport** (bill a maker duty's turns to your flat subscription quota) — pending one live-auth check: [`interactive-transport.md`](interactive-transport.md).

## Deliberately unbuilt

**Codex-as-orchestrator.** Designed, not built — the orchestrator must be `claude` in v1.

The open *design* questions and their evidence: [`open-questions.md`](open-questions.md).

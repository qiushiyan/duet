# Worker/phase budget policy — opt-out for the maintainer, infrastructure for the audience

**Status:** Problem definition + design directions (deliberately *not* a full implementation spec — the resolution is open). **Date:** 2026-06-21. Refines Q19.

## The problem

The phase table caps each turn's spend: every phase carries `workerBudgetUsd` and `orchestratorBudgetUsd` (`src/phases.ts` — impl is the highest at worker `25` / orchestrator `30`), which become `claude -p --max-budget-usd <n>` (`src/providers/index.ts:30` → `src/providers/claude.ts:134`) and the headless orchestrator's own per-turn cap (`src/harness/driver.ts:241`). The rail exists to bound runaway cost — and Q19 already states the invariant: **worker budget is per-turn and must never shape scope.**

Two failure modes showed up in the first real workflow-aware run (observed, run `20260620-1655-be66`):

1. **The cap surfaces as a hard mid-turn failure, not a graceful "I'm low."** A `respond-midpoint` turn was asked to build four slices; it committed two, then hit the `$25` worker cap ~20 min in and died with `exit 1` behind a *misleading* error envelope ("the worker never saw your prompt, retry"). Per-slice commits saved the work and the orchestrator recovered — but the budget **did** decide how much fit in the turn. That is exactly the scope-shaping Q19 says must not happen.
2. **For a flat-quota user the cap is pure downside.** When the workers and reviewer run on the maintainer's Claude *subscription* (flat quota, no per-token charge), the budget can only ever *cut work* — it can never *save money*, because there is no marginal money to save.

## The tension to resolve

Two legitimate, opposed positions, and the design must serve both without forking the codebase:

1. **The maintainer, today.** Workers + reviewer run on the subscription; marginal cost is zero. Budget caps bring zero benefit and nonzero harm (cut turns, confusing failures). The maintainer wants budgets **effectively off** — care only that the problem gets solved, not what it "costs."
2. **The audience, later.** Once others run duet on metered API billing, per-phase budget caps are a genuinely valuable cost-control feature — bound a runaway, cap an expensive phase, make spend predictable. The infrastructure must **not** be deleted to scratch the maintainer's itch.

So: *unbudgeted-by-default for the flat-quota maintainer, budget-enforced-when-wanted for metered users — one knob, same code.*

## Design directions (open; nothing committed here)

- **Budget becomes a profile + override, not hardcoded constants.** Keep the per-phase numbers as a *default cost-controlled profile*, but let a single config knob scale or disable them: `budget: off` (omit `--max-budget-usd` entirely → unbounded), `budget: default` (today's per-phase caps), or a scalar multiplier. It belongs with the existing run config (the role→provider bindings), not as a per-call argument.
- **Default keyed to billing reality.** A flat-quota transport (subscription, no per-token charge) should default budgets **off**; a metered API transport should default them **on**. Where duet can't tell, default to *off* — the shipped audience can opt in, and off is the maintainer's posture anyway.
- **Fix the failure mode regardless of the cap value.** A hit budget should be a *graceful checkpoint*, not an `exit 1` wearing an infra-error costume: commit what's done (already per-slice), report "budget reached — N committed, M remaining," and let the orchestrator continue deliberately. This de-risks budgets for *everyone* (maintainer and audience) and is worth doing independently of the opt-out.
- **Turn-sizing is the orthogonal lever — don't conflate it.** Part of this run's cut was "one turn asked to build four slices." Even with budgets off, right-sizing turns (≈ one slice per turn) keeps spend predictable and failures rare. Note it; it's a separate fix from the budget knob.

## Non-goals

- Deleting the per-phase budget fields — the audience needs them.
- A full billing/quota accounting system.
- Splitting the orchestrator budget from the worker budget — one knob should cover both.

## Relation to the ledger

- **Q19 (per-turn budget must never shape scope):** the observed cut is direct evidence the current cap *can* shape scope, via hard failure. That argues for both the graceful-checkpoint fix and the opt-out.
- No change to Q20.

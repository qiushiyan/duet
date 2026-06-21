# Mid-session AFK handoff — pre-authorization set in flight

**Status:** Design spec. **Date:** 2026-06-21. Implement after the workflow-aware/RIR run lands — it builds on workflow-awareness and touches the same surfaces (`framing.ts`, `cli.ts`, `lifecycle.ts`, `run-store.ts`). Drafted as a standalone design artifact; no open-questions/ledger writeup attached (the relevant ledger touchpoint is Q20, pre-authorization precision).

## Summary

duet's semi-AFK promise is "walk away at plan approval; return to a ship packet." Today you can only choose your gate posture **once, at `duet new`** (`--gates-at <overnight|skip-plan|…>`). And on the **interactive** orchestrator host that posture is ignored entirely: the orchestrator crosses every gate inline with a human tap, and `gates_at` only governs the headless tail after the plan handoff (see the comment at `cli.ts:188` — "`--gates-at` still applies to the headless tail after the handoff"). So the natural workflow — *"I've seen the framing, it's good; I'm going to sleep now; take the rest unless something major comes up"* — is impossible: the run stalls at the next gate waiting for a tap you're not there to give.

**What we're adding.** A single mid-session command that enters the autonomous stretch from *any* attended gate: cross this gate, re-set the downstream gates to a pre-authorized posture, and hand off to the detached headless driver. Working name **`duet afk`** — a thin wrapper over `duet continue --headless --approve --gates-at <preset>`. One deliberate tap to authorize the stretch; zero taps after it until the run reaches a still-attended gate, a queued `ask_human` question, or `done`.

**The boundary once it lands.**

- **Covered:** mutate the run's `gates_at` posture in flight; enter headless AFK from any attended gate (not only the plan handoff); the AFK-entry surface shows the resulting attended set so the one tap is informed consent, not a blind handoff.
- **Preserved — the invariant:** the launch-injected `ask` rule (`orchestrate.ts:44`, `GATE_ASK_RULE`) is unchanged; the single AFK-entry tap remains the un-forgeable binding between human authority and the bytes that execute; after handoff the deterministic headless driver is the only gate-crosser — no inline LLM crossing is introduced.
- **Reused, not rebuilt:** `ask_human` (pause-on-major), the headless `gates_at` auto-cross, the detached pid-guarded driver (`duet continue --headless` → `cli.ts:375`), the `overnight`/`skip-plan` presets (`framing.ts:314`).
- **Non-goals / deferred:** no change to the `ask` rule or the permission model; **no** "interactive session auto-crosses inline" mode (it would require relaxing the rule — the forgeable path we reject); **no** per-gate severity-gated auto-cross (the orchestrator authors its own `human_decisions` severity, so it can't be a real boundary — "unless major" stays `ask_human` plus the existing pre-authorized-gate brief discipline); no presets richer than the existing set.

## Current → desired

```
Current:
  duet new --gates-at overnight          (posture fixed here, forever)
   └─ interactive arc: orchestrator crosses EVERY gate inline (tap each) — gates_at ignored
        └─ plan handoff: duet continue --headless --approve → detached driver
             └─ headless tail: gates_at finally honored (auto-cross pre-authorized)

Desired:
  duet new [--gates-at …]
   └─ interactive arc: tap per attended gate (you're supervising; rider visible)
        └─ at ANY attended gate:  duet afk [preset]      ← one tap
             ├─ crosses this gate
             ├─ re-sets downstream gates_at to the preset
             └─ hands off to the detached driver → auto-crosses the rest,
                parks on ask_human / a still-attended gate / done
```

## Coupling decision

This **extends two existing concepts** — `gates_at` and the interactive→headless handoff — rather than introducing a new authority model. The only genuinely new capability is that **`gates_at` becomes mutable mid-run** (today it is written once at `createRun` and never changed). The handoff already exists; we are allowing it *before* the plan gate and carrying a new posture through it. Framing this as "a new AFK mode" or "a permission-model change" would be wrong: the `ask` rule, the statechart's `phase.*`/`human.*` vocabulary, and the deterministic-crosser guarantee are all untouched.

## Mechanism

- **Command surface:** `duet afk [<preset>]` at any attended gate, sugar for `duet continue --headless --approve [--gates-at <preset>] ["rider"]`. Default preset = the most-AFK posture (attend nothing downstream → run to `done`); `overnight`/`skip-plan` remain available for "stop me at the later milestones."
- **State:** the persisted `gatesAt` on `RunState` becomes writable after `createRun`; the AFK command re-sets it *before* crossing/handoff. The "CLI write vs. live driver" race that normally forbids `state.json` writes does **not** apply here: there is no live headless driver during the interactive arc, and the handoff *spawns* the driver only after the posture is written.
- **Informed consent:** the AFK-entry command/dialog renders the resulting split (e.g. *"after this: attending {pr}; pre-authorized {plan, impl, docs}"*) so the single tap shows you exactly which downstream gates you are authorizing to auto-cross.

## Why the invariant survives (the load-bearing argument)

The property to protect: human-origin authority is un-forgeable, and an autonomous session cannot promote itself to unattended. This design keeps it because —

1. Entering AFK still costs exactly **one** human tap, gated by the unchanged `ask` rule; the agent cannot author that tap.
2. After handoff the crosser is the **deterministic headless driver**, not an LLM reading a transcript. There is no point where "the conversation said approve" becomes a crossing.
3. AFK is precisely where forgery is most costly — asleep, a forged cross runs unsupervised for hours and you wake to a shipped PR you did not want. So concentrating authority at a single, un-forgeable entry tap is the right move. We are **not** relaxing the guarantee for the AFK case; we are making the AFK case reachable *through* it.

## Billing note

Handoff routes the AFK tail's *orchestrator* to the metered headless path (vs. the interactive subscription/flat quota). Workers are metered regardless of host today; the orchestrator is the only cost that moves, and it is the lighter line item. There is no headless-and-flat-quota orchestrator — flat quota exists only because the interactive session stays open, which is incompatible with walking away. (If Claude's billing keeps workers on subscription in practice, the moved cost is smaller still.) Decision taken with the human: hand off and accept the metered tail, because the flat-quota alternative requires keeping the session open *and* relaxing the rule.

## Testing (spec altitude)

- Mutating `gatesAt` mid-run persists and is read by the spawned driver; a run that never calls `duet afk` behaves exactly as today.
- `duet afk` at the Direction or Commit-spec gate crosses that gate, sets the downstream posture, and the run proceeds headless with no further taps until a still-attended gate, an `ask_human`, or `done`.
- A still-attended gate under the new posture (e.g. `pr` under `overnight`) parks and notifies; it is **not** auto-crossed.
- The AFK-entry surface lists the resulting attended / pre-authorized split.
- Regression: a plain `duet continue --approve` at an attended gate with no AFK handoff still fires the `ask` rule — the invariant path is untouched.
- This is Q20's (pre-authorization precision) first real exercise; the new behavior is its evidence.

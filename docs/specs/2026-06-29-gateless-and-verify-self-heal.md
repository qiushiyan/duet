# Spec: gateless runs, universal verify self-heal, and framing-frontmatter parity

**Status:** Design spec. **Date:** 2026-06-29. Three coupled changes that fell out of one keystone decision (the acceptance contract is *AFK-protection*, not attended-deliberation). Touches `src/phases.ts`, `src/framing.ts`, `src/run-store.ts`, `src/cli.ts`, `src/harness/orchestrator-prompts.ts`, `src/harness/lifecycle.ts`. Drafted from a real run's forensics (`20260628-1142-bc1c`, **observed**). Doc-tree (`automation-design.md`, `engineering.md`) and `skills/duet-frame/` reconciliation are **deferred by decision** — see Out of scope.

## Summary (read this if you read nothing else)

A run owner who has pre-decided the direction wants to walk away from the *start* and return to an open PR — a **gateless** run. Today that's unreachable: even with an attend-nothing posture, a `high` human decision re-stops the run (the **severity hold**, `lifecycle.ts:444`), and on `full` you can't even *express* attend-nothing at `duet new` (`parseGatesAt` rejects an empty list and `full` has no attend-none preset, `framing.ts:337`). In the observed run, a consultant **bet-audit** `high` ("opportunity cost — velocity refactor vs. the unproven tails") held the Commit-spec gate and forced a manual approve, even though `duet afk` had set `gatesAt: []`.

The resolution turns on one fact: the consultant does **two** jobs with **opposite** AFK-compatibility. Its **bet audits** (`frame`/`specGate`/`implGate`) *challenge the bet* — anti-AFK; you opt out of them by walking away. Its **acceptance-contract author + verify** (`contract`/`verify`) is an *automated correctness backstop* — documented as "load-bearing AFK protection" (`orchestrator-prompts.ts:348`) — pro-AFK, built for it. So this spec ships three things:

1. **Universal verify self-heal** (independent of gateless): a failed contract assertion routes to the **implementer first** — fix → consultant re-verifies → bounded loop → **holds only if still stuck**. The human sees a *summary*, not every fix. This improves the attended flow too, and it *decouples verify from gateless entirely*.
2. **The gateless posture**: `--gateless` / `gateless: true` = attend nothing + the consultant runs **only its backstop** (`contract`+`verify`), its bet audits don't fire. The verify backstop (now universal) is unchanged; nothing else holds except a genuine `ask_human` or a verify-stuck case. Notably this needs **no change to the severity-hold mechanism** — it's achieved by *what produces holds*, not by filtering them.
3. **Framing-frontmatter parity** for the posture-shaped launch options the boundary rule already admits — `interactive`, a `consultant: on|off` *toggle*, and `gateless` — so templates can carry them. Role *bindings*, billing, and view flags stay out by the same rule.

The two irreducible human points are untouched: a genuine `ask_human` always parks, and **the merge is never automated**. A gateless run's worst case is "an open PR that passed its own contract, with flagged concerns in the body" — exactly success-criterion 2.

## Why (the problem)

`duet status`/`gates_at` gave the impression AFK is one knob. It's three independent layers of "stop," and the observed run hit the second:

| Layer | What it is | Controllable today? |
|---|---|---|
| **1. Gate posture** (`gatesAt`, `gateAttended` `run-store.ts:305`) | which gates auto-cross | yes — but `full` can't express attend-none at `new` |
| **2. Severity hold** (`highDecisionsAt` → `driveToQuiescence` `lifecycle.ts:444-468`; `enterAfk` refusal `:601`) | re-stops a *pre-authorized* gate when its packet carries a `high` | **no — always on, undifferentiated** |
| **3. `ask_human` flags** | orchestrator declares itself genuinely blocked | no (and must stay so) |

**Observed** (`20260628-1142-bc1c`, `full` + consultant, `gatesAt: []`): exactly one gate required a manual tap — Commit-spec — held by a consultant **bet-audit** `high` (`driver.log:82` "commitSpecGate held — a high human decision withheld the pre-authorized auto-cross"). The human dissolved it in one approval rider. Every other gate auto-crossed, and the impl **verify** checkpoint's assertions all passed (Ship auto-crossed). So the thing that stopped a confident AFK run was a *direction* question the owner had already pre-decided — while the *correctness* backstop ran silently and never intruded. That asymmetry is the whole design.

### The keystone: the contract is AFK-protection, so the consultant is two things

Resolved with the owner (2026-06-29): the acceptance contract is an **AFK-protection** feature, not an attended-only one. That forces the consultant to be seen as two functions, not one voice:

- **Challenge the bet** — `frame` (a third bet-level analysis), `specGate`/`implGate` (bet audits before a gate). *Open-ended judgment, no objective backstop.* This is the friction that conflicts with walking away.
- **Correctness backstop** — `contract` (authors a frozen, falsifiable success definition at `plan`) + `verify` (a fresh session runs the built system and checks each assertion at `impl`). *Objective; built specifically to stop an overnight run from shipping past a broken target.*

"AFK ⟹ no consultant" would throw the second away with the first. The right cut keeps the backstop and drops the challenge.

### Why "route consultant findings to the implementer first" generalizes for *verify* but not bet audits

The owner's instinct — *route findings to the implementer first; it fixes the obvious ones; only genuine decisions reach me* — is **right for facts and wrong for opinions**, and the dividing line is an **objective backstop**:

- A **verify failure** is a *fact* (the system did X, the contract said Y). "Ignore the bad ones" is self-checking: the only way to truly ignore a finding is to not fix it, and then **re-verification fails the same assertion again**. The implementer can only successfully "ignore" a finding that, on an independent re-run, genuinely passes. So letting the implementer triage verify findings is safe.
- A **bet audit** is a *product/direction judgment* with **no fix and no re-run that settles it**. Route it to the implementer and either it bounces back to be flagged (a harmless hop) or the party that writes the code decides whether its own bet needed sign-off — the **under-flagging** failure the architecture calls the worst one, and exactly why triage lives in the read-only orchestrator, never in the actor. Verify is the *sole* exception because re-verify neutralizes the conflict of interest.

And the owner's own rule partitions itself: "surface only genuine decisions" — a bet audit *is*, by construction, a genuine decision (it reaches the human in attended runs; it doesn't run in gateless); verify findings mostly *aren't* (they self-heal). So "route to the implementer first" is operationally a **verify** change, and a good one.

## Current vs. desired

```
VERIFY (impl) — today:
  consultant verify → per-assertion PASS/FAIL → each FAIL = high human_decision
   └─ high HOLDS the Ship gate → run stops → HUMAN reads it and manually routes a fix

VERIFY — desired (universal, attended AND gateless):
  consultant verify → FAILs route to the IMPLEMENTER (reuse the impl review-loop shape)
   └─ implementer fixes → consultant RE-verifies (fresh session) → repeat to a small bound
        ├─ all pass → Ship packet summarizes ("10/10, 2 self-healed in N rounds")
        └─ still failing after the bound → HOLD (the preserved backstop) → human sees the stuck ones

GATELESS — desired:
  duet new --gateless           (or  gateless: true  in frontmatter; or  duet afk --gateless)
   ├─ posture: attend NOTHING (gatesAt = [])                ← also closes full's attend-none gap
   ├─ consultant = BACKSTOP ONLY: contract + verify run; frame/specGate/implGate do NOT
   └─ holds only on: a verify-stuck case  OR  a genuine ask_human.  Merge is still yours.
```

## The mechanism, by flow

### A. Universal verify self-heal (`orchestrator-prompts.ts`, impl phase; not gateless-specific)

The `verify` checkpoint (`consultantVerifyStep`, `orchestrator-prompts.ts:337`) changes from "record FAILs as gate-packet highs and stop" to an **implementer-first loop** that sits in the impl phase after the review rounds and **before** the `ceo-summary`/`advance` (so the packet reflects the post-self-heal state):

1. Consultant verifies the frozen contract over a fresh ephemeral session (unchanged — runs the built system, cites evidence, per-assertion PASS/FAIL).
2. Each **FAIL** is routed to the **implementer** as a critique-shaped input, reusing the existing implementer-facing review-loop machinery (`review-implementation`/`respond-review` shape) rather than a new channel. The implementer fixes (or, for an assertion it believes is itself wrong, leaves it — see below).
3. A **fresh** consultant session **re-verifies** (the independence guarantee: the verifier is never the implementer; the implementer cannot game an independent re-run the way it could its own tests).
4. Loop to a **small bound** (the plan picks the number; *separate* from the review `roundCap`). On exhaustion, the still-failing assertions become `high` human_decisions and **hold** the Ship gate — the backstop, intact.
5. The Ship packet **transparently reports** what self-healed ("assertion #4 self-healed in 2 rounds") so auditability (success-criterion 3) survives without the human in the loop.

**The conscious softening (docs-lead-code-follows):** today "a failed assertion **holds**" — full stop. This becomes "a failed assertion gets N fix attempts, **then** holds if still failing." A deliberate, defensible loosening — justified by re-verify objectivity and the owner's stated preference (you don't want to clerk obvious fixes) — and it degrades safely: the worst case is still a *hold*, never a silent ship. An assertion the implementer wrongly judges "wrong" and refuses to fix simply stays failing and holds at the bound; it cannot ship a real failure past the human.

### B. The gateless posture (`framing.ts`, `run-store.ts`, `cli.ts`, prompts)

`--gateless` / `gateless: true` / `duet afk --gateless` is **sugar over two orthogonal axes**, kept orthogonal in code (the established opt-in-rail pattern beside `gateAttended`/`budgetFor`):

- **Posture axis:** `gatesAt = []` (attend nothing). This *also* closes the attend-none gap for `full` — gateless is the first attend-none `full` run, with no new preset needed. Gateless implies attend-none, so it **conflicts** with an explicit non-empty `gates_at` (error, naming both).
- **Consultant axis:** a persisted run flag (working name `gateless: true` on `RunState`) that makes the orchestrator's checkpoint routing run **only the backstop** (`contract`, `verify`) and **skip the bet-level checkpoints** (`frame`, `specGate`, `implGate`). The phase→checkpoint map is registry data (`consultantCheckpoint`, `phases.ts`); gateless filters *which modes fire*, so this is a routing posture, not new architecture. (`frame` is dropped too, not just the holding audits: its value is bet-level perspective, which gateless explicitly opts out of; framing degrades to the existing no-consultant synthesis path, `synthesisStep` `:293`. Keeping `frame` — it never holds — is the defensible alternative; called as drop for a clean "consultant = backstop only" rule.)

**The elegant part — gateless needs (almost) no change to the severity-hold mechanism.** The highs that can reach a gateless gate are: (a) bet-audit highs — *gone*, the checkpoints don't fire; (b) the orchestrator's own product/direction calls — already *carried forward as recommendations* on a pre-authorized run (the existing brief discipline, automation-design §"Gate pre-authorization"; `ask_human` reserved for the would-make-downstream-work-throwaway case); (c) verify highs — now produced *only* when stuck after self-heal, which we *want* to hold even in gateless; (d) the **contract-not-authored** backstop high (`contractCheckpointRail`/`consultantContractStep`) — recorded at the plan gate when a bound consultant failed to author a contract, and which we likewise *want* to hold, because without a frozen contract there is no verify backstop to protect the run downstream.

So `highDecisionsAt`/`driveToQuiescence` stay **byte-for-byte** — the headless `duet new --gateless` path holds on any of (b)/(c)/(d) through the unchanged severity hold. The one carve-out is in **`enterAfk`** (the `duet afk --gateless` bridge): it crosses the bet/product highs the human pre-decided (an explicit full-send, like `--approve`) **but preserves the backstop** — it still refuses to hand off at the contract-author gate when no contract was frozen, so (d) holds on *both* gateless paths. (The original draft of this spec claimed `enterAfk` too was byte-for-byte and enumerated only (a)–(c); a code review found that the undifferentiated cross would ship a gateless afk run past a missing contract — this is the corrected design.) The partition is still achieved by *what produces holds* plus that one backstop-preserving refusal, not by a per-decision `kind` field — the taxonomy we rejected (see Out of scope) is unnecessary. The safe-degradation property holds: if the orchestrator records a product high anyway, the worst case is a flagged stop, never a silent proceed.

Gateless with **no consultant bound** is simply attend-none (axis 1 only) — so `--gateless` is also the clean way to get an attend-none `full` run regardless of the consultant.

### C. Framing-frontmatter parity (`framing.ts` `frontmatterSchema`, `resolveRunInputs`)

Not blanket CLI↔frontmatter parity — the **boundary rule** still governs (`framing.ts`; a key earns frontmatter only when its expression is a *fixed value* the harness consumes *without judgment*, and it is *not a binding or billing posture*). The three-tier layering — **config** (role→provider/model bindings + billing) / **framing prose** (project knowledge) / **framing frontmatter** (fixed, deterministic) — is preserved. Applying the rule to the current CLI-only options:

| Option | Verdict | Why |
|---|---|---|
| `gateless` | **add** | fixed posture, deterministic consumer |
| `interactive` | **add (with a caveat)** | fixed; but it also names a *launch context* — a non-interactive `duet new` honoring `interactive: true` must error clearly ("this framing wants interactive; launch from a CC session / pass `--interactive`"), since the interactive host needs a live session to drive |
| `consultant: on\|off` (**toggle**) | **add** | a per-run flip of a *config-bound* consultant (today's `--no-consultant`) is posture-shaped |
| `--consultant claude:opus` (**binding**) | **keep out** | a role binding is config-tier; "which model" never enters the framing |
| `--orchestrator/--impl/--reviewer` | **keep out** | role bindings — the canonical not-framing case |
| `budget` | **keep out** | billing posture → config (a future run-level `budget_usd` is pre-approved *if* that model lands) |
| `--tmux/--here` | **keep out** | view/ephemeral, per-invocation |

The motivating use case is **templates** (`.duet/templates/<name>.md`, pre-baked framing): "this *kind* of work is interactive + uses the consultant + gateless" is exactly the per-work-type posture a template should carry — while the toggle-vs-binding line keeps "*which model*" in config. Each new key validates deterministically and strips before the orchestrator sees the body, like the existing keys; flags win over frontmatter, as today (`resolveRunInputs` `:456`).

## Why the invariants survive (the load-bearing argument)

- **The human owns substance** — relocated, not removed. The two irreducible points stay: a genuine `ask_human` always parks (gateless never suppresses it), and **the merge is never automated**. A gateless run ends at an *open* PR carrying its `Verification (pending)` checklist and `notes.md`; substantive authority lives in the merge.
- **Trust gradient** — each rail placed correctly. The verify *re-run's independence* is **structure** (a fresh consultant session, un-gameable). The *hold-if-stuck* itself, though, is **orchestrator-recorded** — `verifyCheckpointRail` enforces that verify *ran* (the checkpoint exists), and the per-assertion outcome rides the gate packet as recorded highs, exactly as triage works everywhere (the rail checks existence, not pass/fail — it always has; this is the pre-existing acceptance-contract trust model, unchanged by the self-heal loop). So "a failure that stays broken holds" is a *steered* guarantee resting on the same orchestrator-as-honest-triager assumption as the rest of the system, backstopped by the structural independence of the re-run, not a prose-parsed one. The implementer's fix-or-leave judgment and the orchestrator's carry-forward of product calls are likewise **text** (steerable). We never parse prose for a guarantee; we do trust the read-only orchestrator to record what it found.
- **Independence preserved structurally** — the verifier is always a *fresh* consultant session, never the implementer; "ignore the bad ones" is bounded by an independent re-verify, not by trusting the actor.
- **Gate-crossing stays un-forgeable** — gateless changes *which highs are produced* and *when verify holds*, never the `phase.*`/`human.*` vocabulary. `advance_phase` still only parks; no tool emits `human.*`. `enterAfk`'s one-tap consent and the `Bash(duet continue:*)` ask rule are untouched.
- **Default-off, byte-for-byte** — absent `--gateless`/`gateless:` and the new frontmatter keys, every surface reads exactly as today; the verify self-heal is the one behavior that changes for *all* consultant runs, and it's gated on a consultant being bound (no consultant ⇒ no verify ⇒ no change).

## Out of scope (with the one-line why)

- **A per-decision `kind` taxonomy on `HumanDecision`** — rejected: re-pointing the *verify* checkpoint to the implementer and gating *which checkpoints run* achieves the partition structurally; classifying open-ended findings into direction/correctness buckets is premature and wouldn't generalize across projects.
- **Routing bet audits to the implementer** — rejected: no objective backstop, so it reopens under-flagging (the worst failure); bet audits stay human-facing (attended) or off (gateless).
- **Suppressing `ask_human` or auto-merging** — never; the two irreducible human points.
- **Doc-tree reconciliation** (`automation-design.md` §"Consultant checkpoints"/§"Gate pre-authorization", `engineering.md`) and **`skills/duet-frame/SKILL.md`** updates — **deferred by decision**; reconcile after the code lands (the design change to the contract's "holds" wording must reach the docs then, docs-lead-code-follows).
- **The two forensics defects** — separately tracked, not bundled: (1) the orchestrator's resume brief narrates a held gate as "auto-crossed" (`orchestrator.log:625` vs the actual hold); (2) `autoApprovals` omits the frame/Direction gate. Real, small, independent of this work.
- **Richer gate presets / a run-level budget model** — unchanged here.

## Open questions (flagged, not resolved here)

- **Self-heal bound** — how many fix→re-verify cycles before holding? (plan-altitude; start tight, watch run notes.)
- **`frame` in gateless** — drop (clean "backstop-only" rule, specced) vs. keep (it never holds; free direction enrichment). Called as drop; revisit if a gateless run misses the third analysis.
- **`interactive` frontmatter ergonomics** — error vs. soft-fallback when a non-interactive `duet new` meets `interactive: true`. Leaning error (loud, deterministic — boundary-rule consistent).
- **Does universal self-heal change the bet-audit calibration question** (`open-questions.md` §"…consultant too eager")? The gate-stalling pressure now comes only from bet audits in *attended* runs; the calibration evidence stream narrows to that case.

## Testing (behaviors that matter; cases and fixtures are the plan's job)

- **Verify self-heal:** a contract FAIL routes to the implementer, a fresh consultant re-verifies, and a pass within the bound advances with a packet that *names* the self-heal; exhaustion holds the Ship gate with the stuck assertions. A run with no consultant is byte-for-byte unchanged.
- **Independence:** re-verify always uses a fresh consultant session; an implementer that does *not* fix a real failure cannot advance (it re-fails and holds at the bound).
- **Gateless posture:** `--gateless` persists `gatesAt: []`; the bet-level checkpoints don't fire; `contract`+`verify` do; the only stops are a verify-stuck case or `ask_human`. `--gateless` with no consultant is plain attend-none. An explicit non-empty `gates_at` + `gateless` errors.
- **Severity hold untouched:** a non-gateless run's hold behaves exactly as today; the mechanism (`highDecisionsAt`/`driveToQuiescence`/`enterAfk`) is unchanged by gateless.
- **Frontmatter parity:** `interactive`, `consultant: on|off`, `gateless` validate deterministically, strip before the orchestrator sees the body, and lose to their flags; an unknown key still fails loudly; a binding-shaped `consultant: claude:opus` is rejected (toggle only). A template carrying the new keys seeds a run with that posture.
- **Default-off:** absent the new keys/flags, config, tool schema, snippet library, and phase briefs read byte-for-byte as before.

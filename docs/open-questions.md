# Open questions

The design questions still genuinely open — waiting on evidence, or on a decision nobody has needed to make yet. Each carries what we believe now and what would change the answer.

A question leaves this file when it settles, and its resolution lives in the design doc it shaped — that doc is the source of truth, not an entry here. Sections are topical and unnumbered: cite them by name so a reference survives a reshuffle. (Resolved questions and their full deliberations are in this file's git history.)

Most settle the same way: run duet on real work and review each run's `.duet/runs/<id>/notes.md` — the dogfooding journal both the human and the orchestrator write. What stays open is **calibration, not capability**. The whole workflow is live-verified; these are the dials.

## Triage precision

The orchestrator's AFK value rests on flag precision. Under-flagging silently absorbs a product decision the human owns — the worst failure; over-flagging turns AFK into a pager. The rules (product/direction → always flag; environment → always flag; tactical → bounce to the worker with process, not substance) are instructions, not mechanisms — and the same under-flag risk reaches review-loop convergence, where deferring to a worker's unverifiable "already handled" absorbs a call the orchestrator should have routed.

The bet: modern models follow concrete triage examples well, and the failure is asymmetric by design — when in doubt, flag, because a spurious flag costs minutes and an absorbed decision costs trust. Expect over-flagging first; tighten from observed false positives.

Evidence cuts both ways. A full framing-to-ship run held triage cleanly — product calls waited for gates, environment limits were reported honestly, no spurious AFK interrupts. But one run showed the under-side miss the rules don't prevent: the orchestrator took an implementer's rebuttal of a reviewer point at face value rather than routing it to verify. The fix was an instruction edit — a route-to-verify example and a review-loop clause in `src/harness/orchestrator-prompts.ts`. Whether it holds is for a later run's notes.

## Worker output schema

`schemas/agent-response.json` was the dumb router's protocol contract: `needs_human` and `disagree` were how judgment-free code detected exceptions. The orchestrator reads prose now, so the schema isn't load-bearing — but a minimal `{response_text}` envelope might still make routing cleaner than scraping chatty final messages.

Demote, don't delete. Workers run schema-free today and the verified runs routed fine on prose. The envelope earns its way back only if routing breaks on a chatty message; any revived schema must stay OpenAI-strict-compliant (every property required, optionals as nullable unions). Schema-on-resume is verified on the pinned codex CLI, so availability no longer constrains the call — only evidence does.

## Run-level budget

Worker budget caps are per turn (opt-in, off by default) — a fresh turn carries a fresh ceiling, and nothing enforces or communicates a total for the whole run. The first real run showed the per-turn rail leaking into product scope: the implementer descoped a slice citing "~$7 of budget left," and the orchestrator collapsed an analysis step "given your session budget." An infrastructure parameter shaped a scope decision the human owns.

The 2026-06-12 fix was transparency, not a model: `send_prompt` and the impl entry brief now state that budget is per-turn and that running low means splitting work across turns, never shrinking scope. That may suffice — the descope also had a legitimate risk argument. If post-fix runs still show budget-shaped scope, the next step is an explicit run-level budget the orchestrator can reason about (`budget_usd` is pre-approved as a framing-frontmatter key under the boundary rule). The opt-in `--budget` knob added since is still per-turn, not this model.

## The consultant's value

The consultant is a bet on a bet: that a deliberately low-context, ephemeral, cross-family reviewer challenges the *premise* where the embedded reviewer — invested in the run's accumulated context — is strong on execution and blind to it. The mechanism is built and live-verified; its value is still thin on evidence.

The altitude gap is real, and a different model family is the one thing a single reviewer working harder can't supply — so the consultant should surface a class of finding the reviewer structurally won't. It is off by default and additive (never a review round, never substitutive), so a weak consultant's downside is bounded to wasted turns on a run that opted in. The calibration risk to watch is the severity hold: a consultant too eager with `high` converts pre-authorized runs into attended stops. Two recent changes **narrow** this evidence stream to the case that still matters: gateless turns the bet audits off entirely (so the stalling pressure now lives only in *attended* runs), and the universal verify self-heal routes a failed contract assertion to the implementer first, so verify findings rarely reach a `high` at all. What would settle it — more bound runs reviewed against notes: did a bet audit change a direction or catch a premise the reviewer and human both missed, and how often versus restating known tradeoffs? Did a `high` hold ever save a wrong-subject overnight arc, or only stall good ones?

A smaller dial rides along: the **self-heal bound** — how many fix→re-verify cycles before a still-failing assertion holds (`consultantVerifyStep` prose, plan-altitude). Start tight; watch run notes for a contract that thrashes the loop without converging, or one that holds on the first failure where a second round would have fixed it.

## Codex as the orchestrator

Role–provider decoupling makes orchestrator-on-codex a legal configuration, but the orchestrator's capability contract — custom harness tools, read-only enforcement, pause/resume at a tool call — is claude-only today. This records the designed path so the decoupling isn't an empty promise.

The bridge is the host-neutral kernel served over stdio MCP (`duet _mcp`) — the same server a codex orchestrator would connect to; the harness-side half exists. Two codex-specific unknowns gate it: **pause/resume at a tool call** (codex has no `canUseTool` callback, and what `codex exec resume` does with a turn ended mid-tool-call is unknown — the hard part), and **tool-call faithfulness** under codex's MCP client. It stays deliberately unbuilt because nobody has wanted the configuration — the interface allows it, no one pays for it. If wanted: a half-day spike mirroring the claude substrate spike, against the same tools.

## Deferred small defects (forensics)

Not design questions — two real, small implementation defects surfaced while tracing an AFK run, kept here only so the prune of their origin spec doesn't lose them. Independent of any feature; fix when convenient.

- **Resume-brief narration of a held gate.** The orchestrator's resume brief can narrate a gate that was *held* (a `high` withheld its auto-cross) as "auto-crossed" — the narration doesn't distinguish the held case from the crossed one (observed in an overnight run's `orchestrator.log`).
- **`autoApprovals` omits the first gate.** The "while you were away" auto-cross ledger doesn't record the frame/Direction gate, so a morning review of a fully pre-authorized run under-counts by one.

## Settled, still watched

Resolved by decision, kept only for a live revisit trigger; the substance lives in the named design doc.

- **Overnight as full's default posture** (`automation-design.md` §"Gate pre-authorization"). Pre-authorization is the out-of-the-box behavior — a new full run attends only frame and spec. Watch each run's notes for a *recurring* morning reversal at one gate (that argues for restoring its attendance), or for the throwaway-test escape hatch failing to fire (flag when proceeding unanswered would make most downstream work throwaway).
- **Fire-and-collect interactive `send_prompt`** (`engineering.md` §"Fire-and-collect worker turns"). The in-process dispatch-and-collect path, live-verified. Revisit only if mid-turn session quits become common or overnight orphans misfire — then a detached-child-per-turn model earns its cost.

# CLAUDE.md

## What

`duet` — personal semi-AFK orchestrator for one developer's two-agent workflow: a read-only LLM **orchestrator** routes a snippet protocol between an **implementer** and a **reviewer**, inside a code-enforced statechart whose human gates agents cannot cross. Workflow-aware: a run picks one arc — the thorough `full` (spec → plan → … → PR) or the lighter `rir` (research → implement → … → PR). Repo = design docs (authoritative for _what_ to build) + implementation at root (pnpm + TS, no build step in dev).

Product goals — the bar every change is measured against:

- **Augment, never lock in.** Same CLIs, same snippets, standard transcripts and normal branches; manual takeover and resume must always work; the state file is a hint, never an obstacle.
- **The human owns substance.** The orchestrator does triage, never opinions; product/direction/environment questions always reach the human; gates are structural (statechart), not prompt-enforced.
- **Semi-AFK.** By default the human walks away after the spec (full's `overnight` posture auto-crosses plan, Ship, and the Open-PR gate; rir walks away after Direction); plan-approval is where an *interactively-orchestrated* run hands its session off to the headless driver (the structural handoff gate), and it is the walk-away point only under a posture that still attends plan. Return to an open PR or a well-formed queued question. Nothing runs between quiescent stops — no daemon.
- **Personal tool first, publish-ready.** Project knowledge enters only via the framing turn; the only config is role→provider bindings; exactly two providers. Shipped artifacts (`skills/`, README) are written for any user.

**Status** (detail in `README.md`): the whole workflow is live-verified end to end — both arcs, both orchestrator hosts, the consultant, the acceptance contract, run-supervision, the interactive transport, the shared `finish` finishing tail, and `duet stats` have all run on real work. Codex-as-orchestrator is deliberately unbuilt.

## Map

**Read first**, in order:
- `docs/automation-design.md` — THE design: roles, layers, phases/gates, triage, branch policy, lifecycle, what-not-to-build.
- `docs/engineering.md` — the codebase mental model: the module map, the seams, the patterns. **Read before moving code**; it holds the per-module detail this file deliberately omits.

For code, start there or run `/onboarding [topic]` (`statechart` · `providers` · `prompts` · `surface` · `design`) — it routes to the right doc + code anchors. This file indexes the docs; it does not duplicate the module map.

**Other docs, by what they answer:**
- prompts / tools / errors → `docs/prompting-and-tool-design.md` (the binding conventions; consult for any prompt or tool surface).
- the snippet library → `snippets.toml` (source of truth) + `docs/snippets.md` (catalog); the PLAN snippets cite the vendored `lessons/` methodology (`pnpm vendor-lessons` re-syncs it).
- the interactive-Claude transport → `docs/interactive-transport.md` (opt-in, flat-quota billing).
- the protocol & its evidence → `docs/workflow-model.md` / `docs/observed-pattern.md`.
- the open design questions (the roadmap) → `docs/open-questions.md`: triage precision, the worker output schema, a run-level budget, the consultant's value, codex-as-orchestrator.
- product direction → `docs/future-directions.md` (check before proposing one).
- how docs are kept → `docs/documentation-standards.md`; status → `README.md`.

**Shipped skills** (prompts, pinned to the CLI by `tests/skill.test.ts`): `skills/duet-concierge/` (a Claude Code session as duet's remote layer), `skills/duet-frame/` (the framing author → `duet new --interactive`), `prompts/orchestrator-identity.md` (the interactive orchestrator's identity).

**Run state** — `.duet/runs/<id>/`: `state.json` is a hint, the provider JSONL transcripts are truth; `steers/` holds staged mid-phase notes (`delivered/` = consumed); `notes.md` = the dogfooding journal.

## Invariants that bite if forgotten

Cross-cutting rules; full reasoning in `docs/engineering.md` and `docs/open-questions.md`.

- **Cooperative pause.** `ask_human`/`advance_phase` persist a marker and end the turn; mechanical SDK pauses corrupt resume (repros in `src/spike/`).
- **Gate-crossing is un-forgeable by vocabulary.** A phase emits `phase.*`; only `human.*` crosses a gate; no tool emits `human.*` (in-process, over MCP, or from a Bash-equipped interactive session), so `advance_phase` only ever parks.
- **The terminal marker** is the cross-process phase decision — cleared deliver-before-clear, guarded by the spent-marker check (keyed off the *restored snapshot*), so a crash can't replay a stale decision over a human's answer/reject.
- **Compaction:** claude workers compact via a literal `/compact` prompt; codex auto-compacts and must never be sent a command.
- **One branch per run,** fixed before the first worker prompt.
- **Worker budget is per-turn, opt-in, off by default** (off ≡ absent, never `0`); it must never shape scope; a hit cap is a resumable checkpoint, not an infra crash.
- **The implementer's post-handoff model is opt-in, resolved off the handoff gate.** `impl`/`--impl-model` runs the implementer on a second claude model for phases strictly after the handoff gate (build + finishing tail); planning keeps the base; absent ⇒ base everywhere, byte-for-byte (`implementerModelFor`, the opt-in resolver beside `budgetFor`). Applying it must **replace** the implementer binding, never mutate it — an un-overridden binding is still the shared `DEFAULT_BINDINGS` object, so an in-place write leaks the model into later default loads. Implementer- and claude-only in v1 (`docs/automation-design.md` §"Roles are decoupled from providers").
- **`gates_at` is the complete attend set, not a delta** (so `--gates-at finish` attends only the Open-PR gate). full's default posture is `overnight` (attend frame,spec); its Open-PR gate sits *after* the open and auto-crosses the auto-opened PR by default; an attended gate still takes a human tap, as does the interactive orchestrator's one `ask` rule on `duet continue`. An empty `gatesAt: []` is attend-*none* (distinct from absent ⇒ attend-all); **gateless** (`--gateless`/`gateless:`) is that posture plus dropping the consultant's holding bet-audit (its non-holding frame + the contract/verify backstop still run) — walk away from the *start* (`docs/automation-design.md` §Gate pre-authorization).
- **A `high` `human_decisions` entry** holds a non-explicit crossing (`gates_at` auto-cross, bare `duet afk`) but not an explicit one (`--approve`; `duet afk --gateless`, the deliberate full-send, crosses the bet/product highs too — yet even it preserves the acceptance-contract backstop, refusing to hand off when no contract was authored).
- **Steers live in `steers/`, never `state.json`** (a CLI write there would race the live driver's saves); deliver-then-consume, so a crash redelivers a steer rather than loses one.
- **Runtime artifacts under self-ignored `.duet/`, never the repo root; log files stay plain text** — color and local time are view-time only (`--json` and stored logs stay raw UTC). A worker's scratch is *inside* its run dir (`.duet/runs/<id>/scratch/`, torn down with the run, no cleanup step), and no worker deletes under `.duet/` — it holds the live run state; harness writes route through `ensureRunDir` so a stray deletion (a worker once ran `rm -rf .duet` cleaning scratch and stranded a run mid-build) self-heals on the next write instead of dying silently.
- **The health substrate stays pure** — `worker-health.ts` imports no fs/lifecycle/status, or a `status → worker-health → lifecycle → status` value cycle closes (the fs tail-read lives in `sessions.ts`, the lifecycle-needing composition in `doctor.ts`). Infra classifies on every surface but auto-retries only on the headless driver (a human is present on the interactive host); that retry is **default-on for new runs** — 3, materialized at `createRun`, an old/absent budget off byte-for-byte (the `gatesAt` materialization discipline), every retry recorded in the `autoRetries` ledger.
- **AFK time caps are wall-clock, not monotonic.** A turn's cap re-checks `now()` against a fixed `Date` deadline (`runWithWallClockDeadline`), so a machine-sleep can't freeze the countdown — a monotonic timer (`AbortSignal.timeout`/execa `timeout`) stranded the audited `7447` dead-run on suspend; the build caps (`implement`, 90 min) are wall-clock too. The forced stream-watchdog env `API_FORCE_IDLE_TIMEOUT` is **Claude-only**, never set on codex, and its facts are pinned to a claude CLI version (re-verify on upgrade). Full design: `docs/automation-design.md` §"Resilience for the AFK window".
- **The interactive host's `send_prompt` is fire-and-collect,** fenced by the single-writer lease at the tool gate and the background settle; its turn lifecycle is non-throwing/total (a faulting turn flips to a collectible `failed`, never strands a role `running`); a turn orphaned by a session quit is a durable on-disk record that blocks phase-exit until `duet takeover` clears it.
- **The consultant is default-off byte-for-byte** — absent its binding, config / tool schema / snippet library / phase briefs read exactly as before. Its asymmetries live as data in `src/roles.ts` (never scattered `role === 'reviewer'` checks); worker surfaces enumerate `workerRolesFor`, voice surfaces `voicesFor` (and must keep the orchestrator). The checkpoint-kind split (generative frame / bet-audit `challenge` / backstop) is data too — `consultantCheckpointLive` (`src/phases.ts`) is the one gate both the briefs and `list_snippets` read, so a gateless run drops only the holding bet-audit (keeping frame + backstop) identically on both surfaces.
- **The acceptance contract is consultant-authored but never consultant-committed** — duet commits it path-scoped at the plan-gate crossing (`freezeContractAt`); the author→verify chain is enforced mechanically (this-run markers + `advance_phase` rails, not prompts), and it is arc-scoped (rir authors none and stays byte-for-byte unchanged). A failed verify assertion **self-heals** — routed to the implementer first, holding only if still stuck after a bounded re-verify loop (universal). A code-changing turn at `implement` clears `verifiedAt` (`settleTurn`) — a self-heal fix, but also `reconcile-docs` and the CEO summary, which is why verify runs **last** (after docs and the packet) — so a fix structurally forces a fresh, independent re-verify before advance; whether that re-verify *passed* is the orchestrator-recorded part (a `high` on the packet), the same trust model as triage.

## Conventions

- **Docs lead, code follows.** A code/docs disagreement is a doc bug or a design regression; resolve it explicitly, never silently. How docs are kept: `docs/documentation-standards.md`.
- **Evidence-backed claims.** Workflow claims cite `examples/*.jsonl` turns or run logs; tag **(observed)** vs **(general)**.
- **Tests are behavior-through-interface.** Fake only at the seams (`docs/engineering.md` §Seams); never mock our own modules.
- **Personal tool / augmentation** — the product goals above are conventions too.

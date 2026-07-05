# The domain remodel — workflow → stage → phase, the duty-keyed runtime, and the vocabulary sweep

**Status:** proposal, settled with the owner 2026-07-04; not yet built. **Revised the same day:** the owner waived backward compatibility (no public users; aggressive cleanup preferred), which flipped the runtime-depth decision from "stages up top, two seats below" to the **duty-keyed runtime** below — v1's two-seat compromise is in git history. **Supersedes** `docs/specs/2026-07-04-phase-scoped-bindings.md` (its tier-2 per-phase binding maps are rejected below). The ratified ubiquitous language lives in **`CONTEXT.md`** (repo root) — this spec implements it; the glossary is the tiebreaker for any naming question it doesn't answer.

**Motivating evidence (observed):**

- **`20260703-1500-e035`** — the first live relay run (worktree `feat/loopy-infra-pr6`), end-to-end: the criss-cross session reset fired and was ledgered, the contract was authored → frozen → verified, midpoint + review-and-fix + reviewer-owned tails all ran, Ship and Open-PR auto-crossed, the PR opened. The arc works. Two frictions surfaced, both representational, neither mechanical.
- **The frame stall** (e035, 15:17→16:38): both `think-holistic` turns settled by 15:17; `compare-notes` went out at 16:38. Fire-and-collect and the armed wake worked — the orchestrator *chose* to hold the synthesis on a reviewer-flagged scope question, per the frame brief's own "flag product questions as they arise", against the run's declared posture (`gatesAt: [design]`). The human's in-session words are the product intent verbatim: "go into compare notes directly… without me giving an opinion first."
- **`20260703-1444-717d`** — created 16 minutes before e035 with default bindings silently frozen, abandoned, recreated. No surface showed which bindings either run froze.
- **The altitude mismatch** — the superseded spec's analysis stands: composition resolves per-phase in the registry while bindings resolved role-first through one binary band aliased to `handoffGate`; the natural sentence ("codex frames and designs, GPT builds, Fable judges") had no surface that spoke it.

## The remodel in one paragraph

A **workflow** (full · blueprint · relay · short) is an ordered list of **stages** (planning, delivery); a stage is one holistic thinking flow whose two **workers** are identified by **duty** — architect/analyst in planning, builder/critic-or-judge in delivery. Duties are the protocol addresses *and* the runtime keys: `send_prompt('builder', …)`, `takeover analyst`, `builder.log`, sessions and bindings per (stage, duty). Cross-stage session continuity is an explicit registry **continuity edge** (full's architect→builder edge rides the boundary compact; relay's delivery has no edges — both sessions born fresh), which subsumes the old `build`-override and session-reset machinery entirely. The framing frontmatter is the **run manifest** — one file answering "what run will this be". A stage contains **phases** (the gate/loop units, unchanged), each an instance of a **block** with knobs (unchanged). "Role" and the implementer/reviewer seat names are retired; no backward compatibility is kept.

## What is settled (the decisions, with their reasons)

1. **Hierarchy `workflow → stage → phase`, `block` unchanged as the phase-kind.** "Stage" is the industry term for a grouping with approval-boundary semantics (GitLab; Azure attaches approvals at stage edges); "phase" keeps its meaning — one word, one size of thing.
2. **Stage names `planning` / `delivery`**, shared across workflows. "Delivery" covers implement *and* finish honestly and dodges the `build` block collision.
3. **The duty-keyed runtime.** Duties are the protocol identities and the persisted keys: addresses (`send_prompt`, `takeover`), log/pane names, binding keys, session keys (`sessions["delivery.builder"]`), status grouping. *(v1 of this spec kept two seat lanes under stage-scoped views, justified entirely by pinned contracts and migration; the owner waived compatibility the same day, dissolving that justification — the model and the runtime now say the same thing.)* Addressing by run-long seat names was the thing to retire: "implementer/reviewer" were stale duty-words promoted to identities, lying the moment relay's checker writes.
4. **The duty vocabulary is closed**: `architect` + `analyst` (planning), `builder` + `critic` | `judge` (delivery; which checker duty a workflow uses is its review-posture knob — "judge" not "judge-fixer", for addressability; the fixing is the posture's behavior, said by the brief). Duties are **stage-unique across the vocabulary**, so a duty alone names its stage. Exactly two duties per stage — the old two-worker legibility, restated per stage; the vocabulary grows only with a shipping workflow.
5. **Continuity edges are registry data, declared for both lanes.** An edge `delivery.builder ← planning.architect (via <seed ritual>)` declares that the delivery duty continues the planning session, carrying the seed ritual that today lives in `entrySeed`. **Every workflow declares its checker lane too** — full/blueprint/short carry both lanes (`builder ← architect` via the boundary compact + doc re-anchor, `critic ← analyst` directly — today's reviewer persists across the whole run and that behavior is kept, not silently dropped); relay declares **no edges** (its whole delivery is fresh). This one concept **replaces** `build`/`impl` overrides, `isPostHandoffPhase` in binding resolution, and the `sessionResets` ledger. An edge whose two duties' *frozen bindings* cross providers **degrades to fresh at manifest freeze** — never an error (binding `builder=codex` on full is a legitimate plan-on-claude/build-on-codex run, expressible today and kept), never silent (echoed by `duet new` and ledgered), with the ritual adapted (a degraded edge seeds from the committed document instead of compacting a session the duty doesn't have). Cross-provider resume stays unrepresentable — the degrade is what enforces it.
6. **"Role" is retired; the voice taxonomy stands.** **Voice** is the umbrella for the mechanical surfaces (bindings, sessions, logs, panes, health): the **orchestrator** (the machinery's voice — routing only, a replaceable mechanism, no duty, never addressable), the **workers** (a stage's two duty voices), and the **consultant** (the ephemeral advisor — checkpoint kinds, never duties). The code had already refused the unified "role" concept (three unions, two enumerators, a policy table); the language now matches the structure.
7. **The framing frontmatter is the run manifest.** Duty bindings enter frontmatter (optional; precedence **flags > framing > config > shipped defaults**, resolved and frozen at `createRun`, echoed by `duet new` — the 717d fix). This deliberately reverses the 2026-06-22 toggle-vs-binding line — a binding is workflow intent, not only billing posture — while the frontmatter boundary rule survives (a binding spec is a fixed value deterministically consumed). Config keeps account-level defaults; the consultant's binding rides the same grammar.
8. **The standard library renames: `design` → `blueprint`, `rir` → `short`; `full` and `relay` keep.** "design" collided three ways (the design phase, `artifactKind: design`, the Design gate); "rir" was an invented acronym; "lean" fell to the size-axis blur with "short"; "spec" fell to a triple collision (full's spec phase, the artifactKind, the `--spec` entry flag). "blueprint" names the middle arc by its artifact-metaphor — the single unified drawing you build from. Spec-driven-development resonance lands in prose ("full is the spec-driven workflow; blueprint is the design-doc workflow"), never in identifiers.
9. **CLI: one repeatable `--bind <duty>=<provider[:model]>`** — the stage is derived (duty names are globally stage-unique, *enforced by `validateRegistry`*), so relay's criss-cross is `--bind builder=codex --bind judge=claude:claude-fable-5`. The explicit long form `--bind <stage.duty>=…` is **reserved** as the escape hatch if a future workflow ever collides duty names — a documented spelling, not built now. `--workflow` unchanged. The old flags (`--impl`, `--reviewer`, `--impl-model`) and config keys (`build`, `impl`) are **deleted, no aliases**.
10. **No backward compatibility, anywhere.** Old run dirs don't load; old config/framing keys error with a pointer to the new grammar; the status `--json` schema and the concierge skill are updated together in the same commit. Pre-user aggressive cleanup, the owner's explicit call. If legacy loading is ever genuinely wanted, it is one self-contained `run/legacy.ts` translator — added later, deletable — not built now.
11. **Per-phase binding maps stay rejected** (the superseded spec's tier 2): a stage is one thinking flow by definition; a finer split would be a new stage boundary in the *registry*, not config.

## The data model (the essence of the refactor)

```
StageName = 'planning' | 'delivery'
Duty      = 'architect' | 'analyst' | 'builder' | 'critic' | 'judge'   // closed; stage-unique across the vocabulary

StageSpec = { name: StageName,
              phases: PhaseName[],                    // ordered; stages PARTITION the workflow's phase list
              duties: { maker: Duty, checker: Duty },  // planning: architect/analyst; delivery: builder/critic|judge
              edges?: { [into: Duty]: { from: Duty, ritual: SeedRitual } } }  // continuity, delivery-side only

WorkflowSpec gains: stages: StageSpec[]               // handoffGateOf(wf) DERIVES as planning's last phase;
                                                      // the handoffGate field is deleted (one source)
```

- `validateRegistry` (extended) checks **topology only** — it cannot see bindings: stages partition the phases in order; duty names are **globally stage-unique** across the vocabulary (the invariant the bare `--bind builder=…` grammar rests on, enforced, not assumed); edges run planning→delivery only. Binding-dependent validation (the provider-crossing degrade) happens at **manifest freeze**, the one place all binding sources are resolved.
- `stageOf(workflow, phase)` and `dutiesOf(workflow, stage)` are the resolvers everything reads; `isPostHandoffPhase` is deleted and must not regrow (the deletion test). Beside them, the **duty-routing resolvers** — `makerDutyOf` / `checkerDutyOf(workflow, stage)` and `fixerDutyFor(workflow)` — replace every prose role reference in routing: the verify self-heal routes a failed assertion to `fixerDutyFor` (relay → `judge`, every other workflow → `builder`), and briefs, write authority, and tool copy read the same resolvers, never a hardcoded duty name.

```
Bindings:  per-voice — { orchestrator, consultant?, duties: { [duty]: BindingSpec } }
           effective binding for a turn = frozen manifest lookup by the phase's stage + duty; no band logic remains.

Manifest:  frontmatter  workflow: relay · gates_at: design · bind.builder: codex · bind.judge: claude:claude-fable-5
           config       account defaults (top-level [orchestrator]/[consultant] + [duties] tables)
           flags        --workflow · --gates-at · --bind duty=spec
           → resolved once at createRun, frozen on state, echoed.
           Precision (the parts a parser fight would otherwise decide): precedence is PER KEY — each duty/voice
           resolves independently through flags > framing > config > defaults (a framing that binds only the judge
           leaves the builder on config/defaults). `bind.*` keys parse in a dedicated pre-pass ahead of the strict
           frontmatter schema (today's zod parser rejects unknown keys — the pre-pass strips bind.* first);
           a duplicated key in one source rejects, never last-wins. The consultant toggle and binding compose:
           `consultant: off` / `--no-consultant` beats any `bind.consultant`; both in ONE source is a rejected
           contradiction; `bind.consultant` alone implies bound. The provider-crossing edge degrade (decision 5)
           runs here, at freeze, and rides the echo.

Addresses: VoiceAddress = Duty | 'consultant' — the one surface key for send_prompt/check_turns, pendingTurns/
           activeTurns, orphan records, takeover, logs, and sentSnippets bookkeeping. The consultant is an address
           with NO stage-keyed session: its record stays checkpoint-scoped (latest only), today's ephemerality.

Sessions:  state.json sessions keyed "stage.duty" ("planning.architect", "delivery.builder", …), provider-qualified,
           plus the consultant's checkpoint-scoped record.
           sessionIdFor(state, duty): own key first; else walk the continuity edge; else fresh.
           The sessionResets ledger is deleted; contextEvents/autoApprovals/autoRetries stay.

Logs:      one per address — orchestrator.log · architect.log · analyst.log · builder.log · critic.log|judge.log ·
           consultant.log — with a harness-written boundary line where an edge carries a session forward.
```

Illegal states stay unrepresentable at the load boundary: a duty the workflow lacks, a binding for a missing duty, a `stages`-style table on the orchestrator/consultant, a provider-crossing edge — all reject with prescriptive errors; past the boundary nothing re-checks.

## The target directory structure (directional, not a dictation)

The macro shape the domain model implies — a thought-experiment record to steer the implementation, not a file-by-file mandate; real slices may adjust it. Two properties are the point: **the import direction is the trust gradient** (each layer imports downward only), and **the seams are the directory edges** (every existing seam lands where adapters already plug in — no new seams needed).

```
src/
├── registry/          THE deep module: the pure domain model. Imports nothing; nothing writes it.
│   ├── workflows.ts     full · blueprint · relay · short — stages, duties, continuity edges,
│   │                    phases, blocks, knobs, gates, caps, consultant checkpoints
│   └── snippet-map.ts   block/knob → snippet-family attachment; validateRegistry
│
├── run/               one run's truth: what was decided and what happened
│   ├── manifest.ts      framing frontmatter + config + flags → the frozen run manifest
│   ├── store.ts         persisted state, mutate(), ledgers, markers
│   ├── machine.ts       the statechart grammar (phase.* / human.* vocabularies)
│   ├── steers.ts        the mid-phase steer channel
│   └── position.ts      probeRunPosition
│
├── orchestrator/      judgment's cage: the kernel and its hosts
│   ├── tools.ts         the host-neutral tool registry + every rail (send_prompt(duty), …)
│   ├── briefs.ts        registry-driven single-world brief renderer
│   ├── library.ts       the served snippet library + override layers
│   └── hosts/           driver (in-process) · mcp-server (stdio) · turn-dispatcher (interactive)
│                        · host-runner (the shared phase-loop rails)
│
├── voices/            execution: models actually speaking
│   ├── bindings.ts      per-(stage,duty) + orchestrator/consultant resolution; one binding-spec parser
│   ├── sessions.ts      session records per (stage,duty), the continuity-edge walk, transcript location
│   ├── policy.ts        write authority, ephemerality, the action catalog
│   ├── providers/       claude · codex · types (the WorkerProvider seam) · transports · wall-clock
│   └── health.ts / activity.ts / context.ts     (the pure substrates — no fs/clock, as today)
│
└── surfaces/          humans reading and typing
    ├── cli.ts + continue-planner.ts
    ├── status.ts · doctor.ts · stats.ts
    ├── framing-editor.ts   the editor journey + seed templates (the manifest PARSE lives in run/)
    └── view/               tmux · colorize · notify
```

Through the three lenses: **deep modules** — `registry/` compresses the whole design behind a dozen pure resolvers; `orchestrator/tools.ts` stays the deepest enforcement module (all rails, no SDK import); the deletion tests sharpen (delete `registry/` → duty/stage/edge conditionals regrow at N sites). **Seams** — unchanged in kind (`WorkerProvider`, `PhaseHost`, the stdio `Orchestrate` boundary, `PaneController`, env), now physically at directory boundaries. **APIs** — one index per domain exporting its charter; cross-domain imports go through it; `registry ← run ← voices ← orchestrator ← surfaces` is enforced by review (and lint if it drifts).

One composition rule keeps the gradient acyclic where today's code has cross-pressure: **anything spanning `run/` + `voices/` composes in `surfaces/`** — `--purge` (run-dir deletion + transcript deletion by session id) and `doctor` (position + health + lifecycle facts) are surface-level composers; `run/` holds persisted-state codecs only and never imports `voices/` (the same move that already keeps `worker-health` pure today).

What this dissolves: `roles.ts` as a concept-holder (duties → registry; policy → `voices/policy.ts`; `workerRolesFor`/`voicesFor` → registry-driven per-stage enumerations), the four binding parsers → one, `build`/`impl` keys, `sessionResets`, `isPostHandoffPhase`, the `handoffGate` field, and the hardcoded 3-vs-4-pane viewer branches.

## Renames and dissolutions (the important ones)

| Today | Becomes |
|---|---|
| `send_prompt(role, …)` | `send_prompt(duty, …)` — enum is the phase's live duties + `consultant` |
| `duet takeover <role>` / `<role>.log` | `duet takeover <duty>` / `<duty>.log` (point-in-time; errors name the run's real duties) |
| `[roles.*]` config · `build`/`impl` keys · `--impl`/`--reviewer`/`--impl-model` | top-level voice tables + `[duties]` · `--bind duty=spec` — old forms deleted, no aliases |
| `workerSessions[role]` + `sessionResets` | `sessions["stage.duty"]` + continuity edges |
| `src/phases.ts` | `src/registry/workflows.ts` |
| `src/roles.ts` | dissolved: registry duties + `voices/policy.ts` |
| `isPostHandoffPhase` / `handoffGate` field | `stageOf` / derived `handoffGateOf` (planning's last phase) |
| `WORKFLOWS.design` / `WORKFLOWS.rir` | `WORKFLOWS.blueprint` / `WORKFLOWS.short` (no load aliases — old runs don't load) |
| docs "The three roles" | "The voices" |

## Stage-aware surfaces

- **`duet new`** echoes the resolved manifest: workflow, stages with duties and bindings, gate posture, consultant.
- **`duet status`**: sessions grouped by stage → duty; the schema changes in the same commit as the concierge skill (decision 10).
- **The tmux viewer** becomes stage-aware by construction: panes are the orchestrator + the *current stage's* duty logs (+ consultant when bound), derived from the registry enumeration rather than a hardcoded voice list — retitled `glyph duty · provider` at the boundary. Philosophy untouched: view glue, best-effort, degrade to a one-line note, deliberately untested, colorizer producer contract unchanged.
- **Voice logs**: per-duty files; the boundary line marks an edge carrying a session forward.

## Prompt tier

- **The frame-brief fix** (independent; can land first, before any restructuring). In both `FRAME_BRIEFS` worlds: once the analysis fan-out settles, firing `compare-notes` is **unconditional** — product/direction questions raised by the analyses fold into the synthesis prompt as open items and surface at the Direction gate as `human_decisions`, holding the pipeline only under the existing throwaway-work escape hatch (environment blockers still flag). This is the e035 stall, fixed at the altitude it lives.
- **Orchestrator-facing prose moves with the remodel** (slice 5): briefs, the identity prompt, tool descriptions, and CLI help carry the addresses and stage language, so they cannot defer — `send_prompt(duty)` forces them. Single-world rule throughout: the registry's duty values select dedicated fragments, never conditional prose; "the attended arc" becomes planning-stage language; "arc" retires for "workflow" everywhere a model reads it.
- **Worker-facing snippet bodies are deliberately deferred.** The principled reason, not a shortcut: snippets already obey the familiar-term discipline — a worker hears the work, never duet's machinery — so the new vocabulary mostly *cannot* leak into them, and the remodel ships with the library byte-identical. A later, dedicated quirk pass audits the residue where the old seat model shaped phrasing (known candidates: the `compact-for-*` bodies' implementer-centric prose — flagged in the vocabulary spec's build checks — the addressee framing in `review-and-fix` and the handoff family, and any "as the reviewer…" role self-references). That pass reads `/prompt-engineering` and `docs/prompting-and-tool-design.md` first, and prefers structural rewrites over word-patches — a snippet is a behavioral frame, not a string to sed.

## Build approach

Vertical slices, behavior tests through public interfaces (resolvers, rendered briefs, the manifest parse, the status model), fakes only at the existing seams; red-green inside a slice where behavior is subtle (manifest precedence, edge-walking session derivation, rejection guards). The parity harness stays the refactor rail with one amendment: **breaking commits re-baseline pins deliberately and alone**; the byte-identical bar applies within pure-refactor commits.

0. Frame-brief fix + `duet new` manifest echo *(independently landable now, pre-remodel)*.
1. Registry: stages + duties + edges as validated data, zero consumers — a no-op commit.
2. The core re-key — a coordinated breaking stretch, landed as **invariant-scoped sub-slices**, each with focused behavior tests for its rail family before the next begins: (a) bindings + manifest freeze (incl. the edge degrade), (b) sessions by (stage, duty) + the edge walk, (c) the tool surface and rails on `VoiceAddress` — same-address-in-flight, orphan recovery, context-pressure scope, verify staleness each re-proven, not assumed — (d) logs and operational addresses. Old-run loading is *not* preserved. Model-read pins re-baseline only after a reviewed diff of the pin delta — never a bulk snapshot update that could bless an accidental prompt change.
3. Workflow renames (`blueprint`, `short`) + CLI grammar (`--bind`) + config tables.
4. Surfaces: status re-shape + concierge skill together, new-echo polish, stage-aware tmux viewer.
5. Prompt sweep: briefs, identity, tool descriptions, CLI help — pins move here, deliberately. Snippet bodies are excluded (deferred quirk pass, §Prompt tier).
6. Directory moves into the target structure (git mv, import direction enforced) — kept separate from behavior commits so blame stays readable.
7. Docs sweep (below). Skill rewrites stay deferred on their own triggers (§Skill rewrites).

## Docs to update (marked; no detail here)

`CLAUDE.md` · `docs/automation-design.md` (the vocabulary section becomes workflow→stage→phase→duty; "The three roles" becomes "The voices"; the arcs, gate-preauth, and frontmatter-boundary sections absorb the manifest and the reversal) · `docs/engineering.md` (module map → the target directory structure, patterns) · `docs/snippets.md` · `README.md` · `docs/open-questions.md` (replace §"Phase-scoped bindings" with a settled pointer here) · `docs/future-directions.md` · `docs/prompting-and-tool-design.md` · `prompts/orchestrator-identity.md` and the built-in framing template (slice 5 — they carry addresses). `CONTEXT.md` is maintained inline as language evolves.

## Skill rewrites — deferred, top-down, never word-patched

The shipped skills (`skills/duet-frame`, `skills/duet-concierge`) and `.claude/skills/onboarding` teach the **old mental model** — arcs, roles, seat names thread their structure, not just their sentences. Patching terms into them produces sediment: a skill whose skeleton says one model and whose words say another. So they are **excluded from the remodel's slices** and each gets a later **top-down rewrite** against the settled model, grounded in `/writing-great-skills`. Two of that skill's ideas do the heavy lifting here: the ratified ubiquitous language is precisely a **leading-word inventory** (workflow, stage, phase, duty, gate — pretrained-adjacent words that anchor invocation and execution in few tokens; the rewrite should lean on them rather than re-explaining), and skill **descriptions re-earn their triggers** under the new names ("relay run", "blueprint workflow"). Each rewrite lands with its `tests/skill.test.ts` pin updates; the concierge additionally must move in the same commit as any status-schema change it reads (decision 10). Timing triggers, not dates: `duet-frame` before the first post-remodel interactive run; `duet-concierge` before the first post-remodel remote-supervised run; `onboarding` with the docs pass.

## Watch items

- **Duty addressing in practice** — does the orchestrator misaddress across a stage transition (sending to `architect` after delivery began)? The tool enum is per-stage, so the failure mode is a helpful refusal; watch whether it fires often enough to warrant a brief nudge.
- **Midpoint-status via pause report** — e035's orchestrator note: a voluntary pause report matching `midpoint-status`'s shape was accepted in its place; consider documenting that as the default.
- **"blueprint" in the wild** — watch whether the name reads as over-promising detail; the glossary gloss is the counter.
- **A third stage / a new duty** stays closed until a workflow ships one (the closed-vocabulary rule).
- **Interactive ask-eagerness vs posture** — the frame fix covers the observed case; generalizing chat-asks onto `gates_at` waits for a second stall.

## Resources — required reading, bound per artifact

Read the matching resource **before** touching the artifact, not after a draft exists:

- **Any model-read prose** — briefs, the identity prompt, tool descriptions/results/errors, snippet bodies (when their deferred pass comes): `/prompt-engineering` plus `docs/prompting-and-tool-design.md` (the binding house conventions, incl. the single-world rule). The tests that matter here: the familiar-term test (workers never hear duet's vocabulary — name the work, not the machinery) and the cold-reader test; prefer structural rewrites over word-patches.
- **Any skill file** — `skills/*`, `.claude/skills/*`: `/writing-great-skills`. Rewrites are top-down (§Skill rewrites); lean on the ubiquitous language as the leading-word inventory, re-earn descriptions' triggers under the new names, and prune sediment rather than layering over it.
- **State machine changes** (none expected): `.agents/skills/xstate-v5/SKILL.md`.
- **Engineering shape**: `docs/engineering.md`; `~/.config/lessons/codebase-design/deep-modules.md` (deep modules, seams, the deletion test, illegal states); `~/.config/lessons/testing/tdd-loop.md` (vertical slices, behavior-focused tests, mock only at boundaries).

All prompt and skill changes read top-down as clear, natural instructions — structural rewrites over patches.

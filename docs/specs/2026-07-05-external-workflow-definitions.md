# External workflow definitions — the workflow SDK and the compile-and-freeze kernel

**Status:** proposal, settled with the owner 2026-07-05; not yet built. Implements the deliberately-deferred stage 4 of the workflow vocabulary (`docs/specs/2026-07-03-workflow-vocabulary.md` §"Watch items"; `docs/future-directions.md` §"External workflow definitions") — with one settled amendment: the definition surface is a **TypeScript SDK**, not the `.toml` file that entry hypothesized. The vocabulary, grammar, and duty model are the ratified ones (`CONTEXT.md`, `docs/specs/2026-07-04-domain-remodel.md`); this spec composes them, it does not reopen them.

This spec is written to be handed to an implementing model whole. The direction and target shape are decided — execute them, don't re-decide. Where a decision turns out wrong or underspecified once you're in the code, **stop and flag it** rather than guessing past it.

## The trigger, honestly stated

The future-directions entry gates this feature on "a real wanted composition the shipped set doesn't cover — not the abstract appeal of user-defined workflows." No single composition has named itself yet (the frame-skill example request that nudged this feature does not satisfy the discipline alone). The owner replaced the trigger with a stronger, structural requirement:

**The bootstrap requirement.** The external definition path must be able to express all four built-in workflows, proven executable: each built-in, written as an SDK expression, must compile **byte-identical** to the shipped registry's served shape (equivalence pins). If the path cannot express a built-in, that is a domain-modeling finding to surface and fix — never a gap to paper over with a special case.

The first known pinch point beyond the built-ins is recorded so it isn't rediscovered: a full-ceremony + fixer-delivery composition ("full's spec loop with a writing checker" — the very example future-directions hypothesizes) compiles cleanly *except* that no fixer-build prose world exists for an upstream **plan** (`FIXER_BUILD_BRIEFS` carries only the upstream-design world, `src/orchestrator/briefs.ts:1002`). That world is a code contribution when a real run wants it — the closed-vocabulary rule applied to prose — and the loader must reject the composition until then with an error that says exactly that.

## What ships (top-down)

1. **A typed workflow SDK** — `defineWorkflow()` plus four semantic block constructors (`frame`, `doc`, `build`, `finish`), exported at a `duet/workflows` package subpath. The author writes the composition; the SDK **derives** everything the composition already implies (stages, duties, edges, prose worlds, gate copy, caps — the full list below).
2. **The compile-and-freeze kernel** — `compileWorkflow()` turns an SDK expression into a `CompiledWorkflow` (the full explicit registry shape, validated by `validateRegistry`), and `createRun` **freezes** it into the run dir. Every consumer re-keys from name-lookup in the static registry to the run-carried spec. This is the real feature; the SDK is its front-end.
3. **Two workflow-file layers**, mirroring the snippet-override architecture: user-level `~/.config/duet/workflows/*.ts` (workflows are tool-opinion, not project knowledge — a personal composition follows the owner across repos) and project-level `<repo>/.duet/workflows/*.ts`. Loaded explicitly by name at `duet new --workflow <name>`; never scanned as a daemon or watched.
4. **Script-Kit-style access, zero per-project npm** (owner constraint: duet runs in repos that are not npm projects, so a devDependency must never be required). duet provisions the workflow dirs it creates — a `tsconfig.json` and a generated, version-stamped `duet-workflows.d.ts` — so editor typing and `tsc` work anywhere; at load time duet resolves the `duet/workflows` import itself (see K5). Prior art: johnlindquist/kit's tool-provisioned environment.
5. **The dogfooded standard library** — `src/registry/workflows.ts` re-authored as four `defineWorkflow()` calls, as the final slice, with parity pins proving the rewrite moved nothing.

What deliberately does **not** ship: any new block, knob value, duty, stage shape, or snippet-membership channel (composition never mints — remodel decisions 4 and 11); any model-read prose authored by a workflow file (prose is selected by derivation, never written — the single-world rule's composition-side half); a TOML front-end (the compile target is data, so a data front-end stays a cheap later adapter if the `.ts` surface ever chafes — record, don't build); the additive project-snippet-membership-per-phase idea (behavior-tier per T3; deferred with its own trigger).

## Why SDK, and why freeze (the two load-bearing bets)

**SDK over data file** (owner decision 2026-07-05). One authoring technology that the tool itself runs on cannot rot; typed constructors give authors and agents compile-time feedback; there is no hand-maintained schema mirroring `WorkflowSpecInput`. The documented regret of code-as-config — Airflow's dags-folder re-parse plague — does not apply structurally: duet has no daemon and the file is imported **exactly once, at `duet new`**; everything downstream reads the frozen artifact. The returned value is data in a closed vocabulary with no prose slots, so logic in the file has nothing to smuggle. (Survey evidence, 2026-07-05: pin-at-start is unanimous across Step Functions' immutable versions, Airflow 3.0's DAG versioning, Temporal's pinned deployments, Camunda's default; the healthy closed-vocabulary precedents are ASL's eight state types and CircleCI's `enum` parameters.)

**The run carries its workflow; it never points at one.** Today a run stores a *name* and every consumer re-dereferences `WORKFLOWS[name]` at every hydration, in every process (`machineFor`, `src/run/machine.ts:192`; `gateAttended`, `src/run/store.ts:406`; the position probe; the briefs). With runtime-open identity that is a live-run corruption channel (edit the file mid-run; three processes disagree). Freezing the compiled spec at `createRun` extends duet's own strongest discipline — bindings frozen at the manifest, `gatesAt` materialized at creation — to the last un-frozen registry dependency a run has.

## The API (settled surface — pin this, don't grow it)

The author writes only what the shipped set actually varies; every option exists because a built-in exercises it. **Speculative options are refused on sight** — the closed-vocabulary rule applied to the SDK surface itself. A derivable fact gains an override option only when a shipped workflow needs the override (there is exactly one today: short renames its frame phase).

```ts
defineWorkflow({
  name: string,            // identity; collision with shipped/other-layer names = load error
  title: string,           // displayName
  phases: PhaseExpr[],     // ordered; blocks decide the stage split
  attend?: GateName[],     // default-attended gates (compiled to defaultPreAuthorized =
                           // gates − attend); ABSENT ⇒ attend-all (short's stance)
  presets?: Record<string, GateName[]>,  // named gates_at aliases; `afk: []` provided universally
})

frame({ name? })                            // name default 'frame' (short: { name: 'research' })
doc(artifact: 'spec'|'plan'|'design', {     // a doc-loop phase
  rounds?,                                  // default per artifact: spec 3 · plan 3 · design 2
  contract?: boolean,                       // the contract-author checkpoint sits HERE (early/late
                                            // placement falls out of position — full puts it on plan,
                                            // blueprint/relay on design)
  audit?: boolean,                          // the bet-audit checkpoint (full's spec)
  name? })                                  // default = the artifact name
build({
  review: 'critique'|'writable'|'fixer',    // THE load-bearing knob; almost everything derives from it
  audit?: boolean,                          // short's implGate bet-audit
  name? })                                  // default 'implement'
finish({ name? })                           // default 'finish'
```

**Derived, never written** (each with its rule; the compiled artifact stores every derived fact explicitly):

| Derived fact | Rule (reproduces the shipped set exactly) |
|---|---|
| Stage partition | frame/doc-loop blocks ⇒ planning; build/finish ⇒ delivery |
| Duties | planning = architect + analyst; delivery maker = builder; checker = **judge iff `review: 'fixer'`, else critic** (ratified: the checker duty and the posture are one fact) |
| Continuity edges | fixer ⇒ none (fresh delivery); otherwise `builder ← architect` + `critic ← analyst` |
| `entrySeed` | (upstream artifact × freshness): plan+continue ⇒ `compact-for-impl`; design+continue ⇒ `implement-design`; none+continue ⇒ `implement-direct`; design+fresh ⇒ `fresh-seed`. Any other pair (e.g. plan+fresh) ⇒ load error naming the missing world |
| `midpoint`, `shipPacket`, `buildTailOwner`, `finishOwner`, build `roundCap` | by posture: critique ⇒ judgment · ceo-summary · maker · maker · 3; writable ⇒ none · lean · maker · maker · 1; fixer ⇒ judgment · ceo-summary · checker · checker · 1 |
| Prose worlds (`examplesKey`) | (block/posture × upstream artifact) — frame: doc-loop-follows ⇒ `frame`, build-follows ⇒ `research`; doc-loop: its artifact; build: critique×plan ⇒ `impl`, critique×design ⇒ `blueprint-impl`, writable×none ⇒ `short-impl`, fixer×design ⇒ `relay-impl`. A combination with no declared world ⇒ load error |
| Gate spec (state name, heading, ready, hint) | per (block, artifact, packet); the handoff hint rides whichever gate is planning's last (`handoffGateOf` stays derived) |
| Consultant `frame` checkpoint | always, on planning's first frame-block phase |
| `verify` checkpoint | automatically on the build phase iff any `contract: true` exists (the author→verify pairing rule satisfied by construction) |
| Entry route | `firstPhase` = first phase; `specSkipsTo` = first doc-loop (absent when none) |
| Budgets, timeouts, `artifactLabel`, non-build round caps | block defaults (today's shipped values) |

`forceAttend` is not exposed — no shipped workflow uses it; the mechanism stays internal.

**The bootstrap, as it will actually read** (these four expressions are the equivalence-pin fixtures):

```ts
full      = defineWorkflow({ name: 'full', title: 'Full (spec → plan → implement → ship → PR)',
              attend: ['frame', 'spec'],
              presets: { overnight: ['frame', 'spec'], 'skip-plan': ['frame', 'spec', 'implement'], afk: [] },
              phases: [frame(), doc('spec', { audit: true }), doc('plan', { contract: true }),
                       build({ review: 'critique' }), finish()] })
blueprint = defineWorkflow({ name: 'blueprint', title: 'Blueprint (…)', attend: ['design'], presets: { afk: [] },
              phases: [frame(), doc('design', { contract: true }), build({ review: 'critique' }), finish()] })
relay     = defineWorkflow({ name: 'relay', title: 'Relay (…)', attend: ['design'], presets: { afk: [] },
              phases: [frame(), doc('design', { contract: true }), build({ review: 'fixer' }), finish()] })
short     = defineWorkflow({ name: 'short', title: 'Short (…)', presets: { afk: [] },
              phases: [frame({ name: 'research' }), build({ review: 'writable', audit: true }), finish()] })
```

If any of these needs an option this table doesn't grant, the derivation table is wrong — fix the rule (or, if the fact is genuinely a stance, add the option) and record which; that is the bootstrap requirement doing its job.

## Kernel decisions

**K1 — Identity types widen; vocabulary types stay closed.** `WorkflowName` (`keyof typeof WORKFLOWS` today, `src/registry/workflows.ts:923`) and the derived `PhaseName`/`GatePhase` become boundary-validated strings. `Duty`, `StageName`, `PhaseSemantics`, every knob union, and `ExamplesKey` remain closed literal unions — identity is who you are; vocabulary is what you may be made of. The compile-time completeness the static union bought (the `SERVED_PHASES` literal, `workflows.ts:1233` — the only `Record<WorkflowName,…>` in the codebase) is deliberately traded away; its job moves into the compile step (snippet lists derived at compile) plus the equivalence pins. Where a shipped-only narrowing is still wanted (help copy, tests), derive `ShippedWorkflowName` locally; do not thread it through the kernel.

**K2 — One parse boundary; a branded compiled value.** `compileWorkflow(input) → CompiledWorkflow` is the single constructor: it runs the derivations, then `validateRegistry` (which already accepts data — its own comment says so, `workflows.ts:1047`). `CompiledWorkflow` is branded so downstream code cannot receive an unvalidated spec (parse, don't validate; make the bad state unconstructible). The validator keeps every existing coherence check even where derivation makes violation unconstructible via the SDK — because compiled specs also arrive from **disk** (frozen run files), which is untrusted input. Prescriptive errors throughout: name the file, the offending value, the valid set, and the fix (the survey's actionlint lesson — the closed vocabulary is what makes did-you-mean errors possible; silent tolerance is the documented worst case).

**K3 — Freeze at `createRun`; structure frozen, prose live.** The compiled spec is written to `.duet/runs/<id>/workflow.json` with all defaults materialized (snapshot, not pointer — the `gatesAt` materialization discipline). `workflowFor(state)` in `run/workflow.ts` is the one resolver: frozen file when present; compiled-from-registry fallback for a shipped name with no file (so every existing run loads byte-identically — zero migration). **All new runs freeze, shipped workflows included** — uniform semantics, and runs become durable across duet upgrades. Prose (briefs, snippets, worked examples) stays live by key reference, exactly like the snippet-override split: membership/structure is behavior and freezes; bodies are tool opinion and stay current. Editing a workflow file mid-run is a no-op for that run; "re-run on the new definition" is `duet abandon` + `duet new`, an explicit human act, never an ambient effect.

**K4 — `BRIEF_WORLDS`: close the prose gap without inverting the import gradient.** Today a missing brief world **throws at brief-render time, mid-run** (`briefs.ts:1110/1115/1120`), guarded only for shipped workflows by `tests/driver.test.ts:88`. The fix must respect `registry ← orchestrator` (registry imports nothing): the **registry declares** `BRIEF_WORLDS` — the valid (block/posture × examplesKey) pairs — `briefs.ts` `satisfies`-checks its prose maps against the declaration so drift is a compile error, and `validateRegistry` checks every composition against it at load. This lands as slice 0 because it is a standalone win with zero behavior change for the shipped set.

**K5 — The loader and the provisioned environment.** `surfaces/workflow-source.ts` owns: resolving a `--workflow` name (shipped first; then project layer; then user layer; **any duplicate across layers or with a shipped name is a load error**, never shadow/merge); `await import(pathToFileURL(file))` exactly once at `duet new`; the module-resolution hook that always aliases the `duet/workflows` specifier to the running duet's own SDK module (self-reference via `process.execPath` + `process.argv[1]`, the `_drive` discipline — never a bare name on PATH); and provisioning — on first creation of a workflows dir, write `tsconfig.json` (with a `paths` entry resolving `duet/workflows` to the local d.ts) and copy in the generated `duet-workflows.d.ts`, header-stamped with the duet version and refreshed when it differs. *One deliberately open sub-choice:* Script Kit's runtime move is injected globals rather than a resolve hook — spike both shapes in slice 4 (each is ~30 contained lines) and keep the one that survives the published-bundle path test; the provisioning and everything else is identical between them. `createRun` **receives** the `CompiledWorkflow` value (accept dependencies, don't create them) — `run/` stays a codec layer and the registry stays pure.

**K6 — The machine takes the spec value.** `machineFor(workflow: WorkflowName)` becomes `machineFor(spec: CompiledWorkflow)` (thin name-keyed wrapper acceptable for tests/shipped call sites). No statechart change: `buildStates` already builds any phase list into the loop/flag/gate idiom, gates still transition only on `human.*`, and no tool emits `human.*` — a composed workflow cannot compose its way past a gate, by construction, unchanged.

**K7 — Packaging.** tsdown gains a second entry for the SDK (needed for both the resolve-hook target and the d.ts emit); `package.json` gains the `exports` subpath and the d.ts in `files`. Re-count the `import.meta.url`-relative hops if any module moves (`docs/engineering.md` §Build & publish — they are depth-sensitive). Node ≥24 type-strips user `.ts` outside `node_modules`, **erasable syntax only** — the provisioned tsconfig should set `erasableSyntaxOnly`, and no example may use enums/namespaces/parameter properties.

**K8 — Surfaces.** `duet new` echoes the compiled workflow — name, source layer (`shipped` / `project` / `user`), the stage/duty/edge shape — in the manifest echo; a run must never freeze a workflow nobody saw (the `717d` lesson). `status --json` gains **additive** fields only (`workflow` stays the name string; add a sibling source/detail object); if the schema changes, the concierge skill moves in the same commit (remodel decision 10). `duet workflows` (list names, layers, validity) is in scope only if it falls out nearly free; otherwise record it as a follow-up.

## How to build it

### Read these first, then build

The bar, not optional background; ask for a path if one is missing:

- `~/.config/lessons/codebase-design/deep-modules.md` — deep modules, seams, the deletion test, illegal states.
- `~/.config/lessons/testing/tdd-loop.md` — vertical slices, behavior-focused tests, mock only at boundaries.
- `docs/engineering.md` — the trust gradient, module map, seams; `CONTEXT.md` — the vocabulary (name new concepts from it).
- For any model-read prose you touch (there should be almost none — wording changes are deferred, never folded into refactors): `docs/prompting-and-tool-design.md`.
- For the machine signature change (K6): `.claude/skills/xstate-v5` — no behavioral statechart change is expected; flag it if one appears.

Then re-read the code each slice touches and trace the real flow before editing — the registry resolvers, `createRun`, the three hydration sites (lifecycle, position probe, interactive host).

### Implementation order (one slice per commit; 0–2 are behavior-preserving prep)

0. **`BRIEF_WORLDS` + load-time world validation** (K4). Standalone; every parity pin stays byte-identical.
1. **`compileWorkflow`/`defineWorkflow` + the derivations**, proven by the **bootstrap equivalence pins**: each built-in's SDK expression compiles deep-equal to the shipped registry's served shape (including gate copy strings — the derivation tables are built *from* today's rows). The registry literal stays authoritative; nothing else changes.
2. **The run-carried spec** (K3, K6, K1): freeze at `createRun`, `workflowFor(state)`, re-key every `WORKFLOWS[name]` consumer (the Explore-mapped set: machine, store's `gateAttended`, position, briefs, status, stats, tmux viewer, framing's `parseGatesAt`), widen the identity types. The largest slice; if it needs splitting, split by consumer family and keep each sub-step green. Parity pins byte-identical throughout.
3. **The loader** (K5 minus provisioning): the two dirs, import-once, collision and validation errors, manifest echo, status fields. First end-to-end: a tmpdir project workflow runs `duet new --workflow <name>` through a fake-worker phase.
4. **Packaging + provisioning** (K5, K7): exports subpath, d.ts emit, tsconfig/d.ts provisioning, the resolve-hook-vs-globals spike, resolved.
5. **Dogfood**: `workflows.ts` re-authored as the four `defineWorkflow()` calls; the pins prove the rewrite moved nothing; the derivation tables become the single home of gate copy and block defaults (delete the now-dead duplicated literals — prefer the shape that deletes a concept).
6. **Docs + skill**: the sweep below, plus the frame-skill "compose a workflow" manifest example — executable through the real grammar like the existing examples (`tests/skill.test.ts`), and only now, per the standing engineering note.

### Technical standards (apply throughout)

- **Vertical slices, tests with the slice** — behavior through public interfaces (`defineWorkflow → compile → serve → machineFor → buildPhaseBrief`, the loader through `duet new`'s path), never against derivation internals. Red-green inside a slice where behavior is subtle (the derivation rules, the freeze fallback, collision errors); test-and-code-together elsewhere. Filesystem real in tmpdirs; fakes only at the existing seams — the loader needs **no new seam** (real files in a tmp workflows dir; the resolve hook is exercised by a real import).
- **Make bad states unconstructible; validate once at the boundary.** The branded `CompiledWorkflow`, the derivations replacing coherence-checked double-storage, `erasableSyntaxOnly`. A real invariant violation fails loudly — no fallbacks that hide bugs.
- **Prefer deleting a concept over rearranging it.** Candidates already identified: the `SERVED_PHASES` literal (dissolves into compile), the hand-authored per-row gate copy and `duties` fields after dogfood (derived), the render-time brief throw (superseded by load validation). Run the deletion test on anything new: `define.ts` must concentrate the derivation complexity that would otherwise regrow at N call sites.
- **The parity harness is the refactor rail.** Slices 0–4 must not move a pin; slice 5's pins prove byte-identity across the re-authoring; any deliberate pin change lands alone with a reviewed pin diff, never bulk-updated (the remodel's amendment).
- **No speculative surface.** No option the four built-ins don't exercise, no third layer, no watch mode, no `duet workflows validate` subcommand unless it falls out of the loader's own error path for free.

### Tips, gotchas, hard-won lessons (from the 2026-07-05 exploration — read before slice 2)

- **Cross-process consistency comes only from the frozen file.** The CLI, the detached driver, `_mcp`, and the interactive host each hydrate independently; all must read `workflow.json`, never the source `.ts`. A run whose source file is deleted must keep working — that is the point of freezing, and a test should say so.
- **The registry cannot see `briefs.ts`** — that is why `BRIEF_WORLDS` is a registry *declaration* that briefs `satisfies`-check, not a registry import of the prose maps. Inverting this would close the `registry ← … ← orchestrator` gradient the remodel just established.
- **`validateRegistry` keeps "redundant" checks on purpose** (checker⇔posture, edge⇔seed): the SDK makes them unconstructible, but frozen JSON from disk is untrusted input and must re-validate at load. Don't "clean them up."
- **Derivation tables are built from, and must reproduce, today's exact bytes** — gate copy strings, budgets, caps, `artifactLabel`s. The equivalence pins are the proof; a mismatch means the derivation rule is wrong or the fact is genuinely a stance needing an option. Surface it (bootstrap requirement), don't special-case it.
- **The `research` prose world is selected by structure** (a frame block with no doc-loop after it), not by the phase's display name. A renamed frame phase in a doc-bearing workflow correctly keeps the `frame` world. Known cosmetic nit, accepted: an exotically-renamed direct-to-build frame reads "RESEARCH phase" in its brief.
- **`normalizeRunState`'s retired-name rejection** (`store.ts:627`) must learn the fallback order: a frozen `workflow.json` legitimizes any name; only a name with neither frozen file nor registry entry is unloadable — and the error should now also mention the workflow-file layers.
- **The help copy hardcodes the four names** (`cli.ts:294-301`); rewrite it to render from the registry + a "plus project/user workflows" line, not to a longer hardcoded list.
- **`tests/machine.test.ts:28` hand-lists `ARCS` and already silently omits relay** — fix it to derive from `Object.keys(WORKFLOWS)` while you are in there (a pre-existing coverage hole this feature would widen).
- **Budget honesty**: `budgetFor` scales registry budgets; after slice 2 it must read the frozen spec's numbers so a frozen run's caps can't shift under a registry retune.

## Docs to update (marked; with the slices they belong to)

`docs/future-directions.md` (supersede the External-workflow-definitions entry → shipped pointer here; note the TOML→SDK amendment) · `docs/automation-design.md` §"The workflow vocabulary" (stage 4 shipped: the SDK, the freeze model, the layers) · `docs/engineering.md` (module map: `registry/define.ts`, `run/workflow.ts`, `surfaces/workflow-source.ts`; the freeze pattern joins "Opt-in rails, safe defaults") · `CONTEXT.md` (new entries: **Workflow definition** — the authored SDK expression; **Compiled workflow** — the validated, frozen artifact a run carries) · `README.md` (status line) · `CLAUDE.md` (one invariant line: *a run carries its frozen workflow; the source file is never read after `createRun`*) · `skills/duet-frame` (slice 6 only). The comprehensive pass follows the first live run on a project-defined workflow, per house cadence.

## Watch items and open questions

- **Resolve hook vs injected globals** (K5) — decided by the slice-4 spike; whichever loses is deleted, not kept as an option.
- **d.ts staleness** — the version-stamp refresh covers upgrades; watch whether a stale editor session confuses authoring in practice.
- **User-layer vs project-layer ergonomics** — both error on collision for v1; if real use wants project-wins layering, that is a deliberate follow-up decision, not a default.
- **The first non-built-in composition** — when one names itself (full+fixer is the standing candidate), its missing prose world is authored as a code contribution, and that event is the signal to re-examine whether build-brief narration should re-key onto derivable composition facts (the `CritiqueBuildData` fields are ~fully determined by upstream artifact — a known, deferred deepening).
- **Freezing shipped runs** — uniform freeze is settled; watch the first post-upgrade resume of a pre-feature run through the registry fallback for surprises.

## Acceptance

1. The four bootstrap equivalence pins are green, and stay green through slice 5's re-authoring.
2. A project-defined workflow (the tmpdir fixture) runs `duet new --workflow <name>` through a full fake-worker phase, freezes `workflow.json`, survives source-file deletion mid-run, and echoes its source layer at creation.
3. Every illegal composition in the test matrix — shipped-name collision, cross-layer duplicate, unshipped knob combination, missing prose world, unknown knob value — fails at load with a prescriptive error naming the fix.
4. All parity pins byte-identical across slices 0–4; `pnpm typecheck && pnpm test` green at every slice boundary.

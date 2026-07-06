# Spec — `duet workflows`: a pre-run window into the workflow-definition layer

## Summary (for the leader)

**What we're adding.** A `duet workflows` command family — `list` (bare), `check <name>`, and `init <name>` — that lets a user see, validate, and scaffold workflow definitions *without starting a run*. duet recently shipped composable workflow definitions (the `duet/workflows` SDK compiles a project's `.duet/workflows/<name>.ts` or a user's `~/.config/duet/workflows/<name>.ts` into a frozen per-run workflow). That authoring layer has no CLI surface: today the only way to learn whether a definition resolves, collides across layers, or compiles is to attempt `duet new` and read the exception. This closes that gap.

**The approach.** A thin read-and-scaffold surface *over the existing loader and compiler* — the same seam `duet snippets` is for the override library. It adds no SDK vocabulary (no new blocks, knobs, or prose worlds), reads and writes nothing under `.duet/runs/`, and changes no `duet new` behavior. `list` is pure filesystem discovery; `check` is the one deliberate compile boundary (joining `duet new`); `init` is a boring scaffold. One earned preparatory refactor: extract the private layer-discovery from `workflow-source.ts` so the new commands and the loader share a single collision rule.

**The boundary once it lands.**
- **Covered.** Listing every discoverable workflow name (four shipped + project + user) with source layer, collisions surfaced from the filesystem; per-name compile-and-summarize; scaffold a new typed project definition that refuses to clobber or shadow.
- **Not covered — by decision.** The bare list **executes nothing**: importing a user TS file as a side effect of listing is surprise code execution, and one broken file would break the whole listing — so external definitions show name + layer + path, **no title** (a title can't be read without running the file). Titles and structure surface per-name at `check`, on demand.
- **Deferred.** A future `--verify` / compile-all mode on the list (import every definition, show titles + broken rows) — a **non-goal for this run**, recorded below. Its trigger: the bare listing *feeling blind* in real use. `--json` ships for the list only; `check`/`init` stay text.

## Problem

The workflow-definition layer is real product surface — the duet-frame skill teaches authoring it (`skills/duet-frame/references/workflow-definitions.md`), and `tests/workflow-source.test.ts` pins it as behavior — but the CLI still treats it as an implementation detail of `duet new`. Every inspection question routes through a run attempt:

- *Which workflows can I run here?* — no listing exists; you recall the shipped four and guess at your own files.
- *Does my definition compile, and into what shape?* — only `duet new` tells you, and it also creates a run.
- *Did I collide a name across layers?* — `resolveWorkflowSource` already refuses this (`workflow-source.ts:264`), but only when you try to use the name.
- *How do I start a new definition?* — you hand-create the file, get the filename/name-match rule and the imports right, and hope the editor typing is provisioned.

The underlying goal is not a new workflow system: it is a run-independent inspector over the resolution / compile / freeze model that already exists.

## Current vs. desired

**Preserved, untouched in behavior:**
- `resolveWorkflowSource(cwd, name)` (`workflow-source.ts:233`) — the shipped/project/user resolution, the collision refusal (`:264`), the prescriptive not-found error (`:269`), the one-time SDK import via the `duet/workflows` resolve hook (`:172`), and the filename↔`name` match check (`:225`).
- `provisionWorkflowDir` (`workflow-source.ts:159`) — the `tsconfig.json` + version-stamped `duet-workflows.d.ts` typing stub.
- `compileWorkflow` (`define.ts:147`) and its prescriptive, valid-worlds-naming errors.
- The registry resolvers `check` summarizes from: `phasesOf`, `gatePhasesOf` / `defaultPreAuthorizedOf` / `defaultPosture`, `stagesOf`, `contractAuthorPhaseOf`, `continuityEdgeFor` (`registry/workflows.ts`).

**New:**
- Three subcommands under a `workflows` parent (the `duet snippets` shape: a parent action plus subcommands, `cli.ts:1139`).
- A **pure layer-discovery enumeration** in `workflow-source.ts` — grouped-by-name facts across shipped/project/user, no import, no writes.
- A small **`src/surfaces/workflows.ts`** holding the display/JSON models and the three renderers; `cli.ts` wiring stays thin.

## Coupling: a surface over the loader/compiler

This extends the `duet snippets` precedent exactly (`renderSnippetListing` + a thin action that surfaces loader errors through `fail()`, `cli.ts:90`, `:1139`). The seam is the existing resolution/compile layer, not `duet new`:

- **`check`** calls `resolveWorkflowSource` directly and — on any failure — **adds no command-specific wrapper**: it surfaces the message exactly as `resolveWorkflowSource` produces it, through `fail()`. Those messages are already recovery-worded, but they come from different points in the load path, and the spec should not claim more uniformity than the code delivers: collision and not-found are the resolver's own errors (`workflow-source.ts:264`, `:269`); a syntax error, a top-level throw, or an SDK constructor error like `doc('bogus')` throws at *import* time and arrives wrapped as "…could not be imported (…) — fix or remove the workflow file" (`:218`); the filename↔`name` mismatch is `loadWorkflowFile`'s own error (`:225`); and only a file that imports cleanly and default-exports a `defineWorkflow(...)` value reaches raw `compileWorkflow` errors afterward (`:221`), so the closed-vocabulary rejections (e.g. `define.ts:356`) surface unwrapped. `check` deliberately does **not** pre-filter collisions or not-found — for `check`, "it collides" / "it doesn't resolve" *is* the diagnostic.
- **`list`** and **`init`** never compile a definition; they read the extracted discovery + provisioning helpers.

Import direction holds throughout: `surfaces/` → `registry/` + `run/`, downward only.

## Foundation: one earned preparatory refactor

The collision rule and the candidate-gathering are private inside `resolveWorkflowSource` (`workflow-source.ts:242–268`), and `tsNames` / `candidateFile` are private. Listing and `init` both need "which layers define this name" as *data*, per name, without throwing. Re-deriving that in the CLI would duplicate layer logic (explicitly forbidden) and could drift from the loader's collision definition.

**Extract, bounded:**
- A **definition-file predicate**: `<name>.ts` excluding `*.d.ts`. Today `tsNames` filters on `.endsWith('.ts')` alone (`workflow-source.ts:187`), so it matches the provisioned `duet-workflows.d.ts` stub and yields a bogus `duet-workflows.d` name — a latent bug the *existing* not-found available-list already carries (`:270`). The extraction must exclude `*.d.ts` (`tsconfig.json` is already excluded, not being `.ts`) and route the not-found list through the same predicate, so enumeration is correct in one place. The error *wording* is unchanged; only the stub drops out of the enumerated set. The predicate also governs **per-name lookup**, not just directory enumeration: `candidateLayersFor` must treat the stub name as no candidate (today `candidateFile` only checks that `<name>.ts` exists, `:192`), so `duet workflows check duet-workflows.d` reports not-found rather than resolving the generated stub.
- `candidateLayersFor(name, projectDir, userDir): WorkflowSource[]` — the ordered shipped?/project?/user? candidate list, the **single source of the collision rule** — kept **private** to `workflow-source.ts`. Its dir-level signature is deliberately *not* the caller seam: exposing `projectDir`/`userDir` would push directory derivation (`projectWorkflowDir`/`userWorkflowDir`) and the layer ordering back into callers — the deletion test the extraction exists to pass.
- `definedWorkflowSources(cwd, name, { home }): WorkflowSource[]` — the **public cwd/home-level per-name lookup**, the seam callers read. Non-throwing (returns the candidate layers as data, empty when the name is undefined anywhere), distinct from `resolveWorkflowSource` which throws and *loads*. It derives the dirs and delegates to `candidateLayersFor`, so `resolveWorkflowSource`, `init`'s refuse-check, and discovery all share the collision rule at the cwd level while the layer layout stays owned inside `workflow-source.ts`.
- `discoverWorkflowSources(cwd, {home}): { name, layers: WorkflowSource[] }[]` — enumerate shipped names + the project/user definition files (via the predicate above), grouping by name through the same private helper. Pure: no import, no `provisionWorkflowDir`, no writes.

**Left alone:** `loadWorkflowFile`, the resolve hook, the provisioning internals, and the shape/wording of every existing error (`check` surfaces them unchanged; the not-found list's *content* loses only the spurious stub). This is the minimum that keeps the collision rule and the enumeration single-source; it is not license to touch the load path.

## What each command shows and does

### `duet workflows` — pure discovery

Filesystem + registry only. Shipped rows show their title (free from `WORKFLOWS[name].displayName`); external rows show name + layer + path, **no title**. Collisions are their own section, since a collided name belongs to no single layer and is unusable until resolved (it never silently disappears). `--json` (approved, list-only) emits one row per discovered name: `{ name, status: "available" | "collision", sources: [{ layer, path? }] }`, with `title` present only on a shipped `available` row. `available` means discovered in exactly one layer — *not* compile-verified: a broken external file is still `available`, and whether it compiles is `check`'s job. `sources` carries one entry for an available name and every colliding layer for a collision, so the model is uniform; shape follows the `status --json` additive discipline.

```
shipped
  full       Full (spec → plan → implement → ship → PR)
  blueprint  Blueprint (frame → design doc → implement → ship → PR)
  relay      Relay (frame → design doc → fresh build → judge review-and-fix → PR)
  short      Short (research → implement → ship → PR)
project · .duet/workflows
  deep-relay  .duet/workflows/deep-relay.ts
user · ~/.config/duet/workflows
  personal    ~/.config/duet/workflows/personal.ts

⚠ collisions
  full  shipped + project (.duet/workflows/full.ts) — remove the duplicate; duet rejects shadowing
```

A broken or filename/name-mismatched external file still *appears* (discovered by filename, never hidden); whether it compiles is `check`'s question. Empty project/user layers render nothing (no headerless noise).

### `duet workflows check <name>` — the compile boundary

Resolve + compile one name. On failure: whatever `resolveWorkflowSource` throws, surfaced via `fail()` with no command-specific wrapper (each message is already recovery-worded — resolver, import-wrapper, or raw compiler, per the coupling section). On success: a compact structural summary, in this order — identity + source · phases in order · stages + duty pairs (with delivery continuity) · default attended gates · acceptance contract author/verify. No budgets, timeouts, or round-caps beyond doc-loop rounds (internal rails, noise for a sanity-check).

```
workflow  deep-relay — Deep relay (frame → spec → design → fresh build → judge review-and-fix → PR)
source    project · .duet/workflows/deep-relay.ts

phases (5)
  frame      frame             → DIRECTION gate
  spec       doc-loop (spec)    → SPEC gate    · 2 rounds
  design     doc-loop (design)  → DESIGN gate  · authors the acceptance contract
  implement  build (fixer)      → SHIP gate
  finish     finish             → OPEN-PR gate

stages
  planning   architect + analyst
  delivery   builder + judge · structurally fresh (no continuity edge declared)

default attended gates   design   (others pre-authorized, auto-cross)
acceptance contract      authored at design, verified at implement (when a consultant is bound)
```

Facts derive from resolvers, never re-parsed prose: phases/blocks from `phasesOf`; default gates from `defaultPosture(gatePhasesOf(wf), defaultPreAuthorizedOf(wf))` (`undefined` ⇒ "all", `[]` ⇒ "none — walk away from the start"); contract from `contractAuthorPhaseOf` plus the build phase's `verify` checkpoint (`undefined` ⇒ "none"). Continuity is reported at **definition level**, not runtime: `stagesOf`/`continuityEdgeFor` is registry structure, and the provider-crossing degrade happens later at manifest freeze (`resolveRunConfig`), which `check` can't see (it has no bindings). So a workflow with no delivery-maker edge reads "structurally fresh," and one that has an edge reads "declares builder←architect / critic←analyst continuity (a cross-provider binding may degrade an edge to fresh at run creation)" — never a bare runtime promise. Two lines stay honest the same way: the contract's placement is structural but its firing is consultant-gated; continuity is declared but binding-degradable.

### `duet workflows init <name>` — the boring scaffold

Provision typing, refuse to clobber or shadow, seed one minimal *compiling* commented starter. No shape-picking wizard — the human owns substance.

- **Refuses** a name that already resolves in **any** layer — the cwd-level `definedWorkflowSources(cwd, name, { home })` reporting any shipped/project/user source catches shipped names, an existing project file (even a broken one), and a user file in one check, with a prescriptive message pointing at the resolving layer. It also lightly validates the name up front (non-empty, kebab-ish, no path separators) so `init ../x` can't escape the dir and the filename↔`name` rule stays satisfiable.
- **Provisions** `provisionWorkflowDir(projectWorkflowDir(cwd))` so the file typechecks in an editor immediately.
- **Seeds** `.duet/workflows/<name>.ts` — a default-exported `defineWorkflow` with the four block constructors imported and one minimal *complete, compiling* shape: `frame() → build({ review: 'writable' }) → finish()` (docless), with `name:` and the filename both `<name>` (the loader asserts they match). The comments explain the four blocks and the `attend` posture at a high level and **point to the duet-frame worked examples** (`skills/duet-frame/references/workflow-definitions.md`) for other whole shapes. They must **not** present `doc(...)` or a non-writable `review` as a drop-in edit to this shape: the vocabulary is closed and `writable` has a prose world *only* with no upstream doc (`define.ts:364`), so a `doc` + writable edit would fail to compile. The honest teaching is whole valid shapes (docless+writable, design+critique, design+fixer, spec+plan+critique), not knob-level tweaks — and `duet workflows check <name>` is the way to validate any change.
- **Closes** by naming the next commands (`duet workflows check <name>`, then `duet new --workflow <name>`) and the `!/workflows/` `.duet/.gitignore` carve-out for sharing project definitions.

## Before / after

| Question | Today | With `duet workflows` |
|---|---|---|
| What can I run here? | recall the shipped four; guess your own | `duet workflows` — all layers, collisions surfaced |
| Does my file compile, into what? | `duet new` (and it starts a run) | `duet workflows check <name>` |
| Did I collide a name? | discovered only when you use it | listed as a collision; named at `check` |
| Start a new definition | hand-create file, imports, typing | `duet workflows init <name>` |

## Testing (behaviors that matter; cases/fixtures deferred to the plan)

- **List across layers** — shipped titles present; a project and a user definition each render under their layer with path and no title; empty layers omitted.
- **Collision row** — a shipped-name redefinition and a project+user duplicate each render in the collisions section, not under a layer, not silently dropped.
- **Discovery executes nothing** — listing a directory containing a definition that would throw on import still lists it (by filename) and does not run it; no writes land under `.duet/`.
- **Generated `.d.ts` stubs are never a workflow** — with a provisioned dir present, the `duet-workflows.d.ts` stub is never listed, never collided, and never resolved by `check`; the definition-file predicate holds across enumeration, the not-found list, and per-name lookup, so the latent `tsNames` bug (`workflow-source.ts:187`) can't be left half-fixed.
- **`check` success** — the summary reports phases in order, the duty pairs, the default attended set, and the contract author/verify phases for a representative arc (e.g. deep-relay: fresh delivery + contract at design).
- **`check` failure** — a collision, a not-found, a filename/name mismatch, and a closed-vocabulary compile rejection each surface the message `resolveWorkflowSource` produces, unwrapped by `check` (resolver / import-wrapper / raw compiler, per the failure mode).
- **`init`** — refuses an existing file, refuses a name that resolves in any layer (including a shipped name), provisions the typing stub, and seeds a file that `check` then compiles green.

## Done — known constraints that shape it

- **`tests/parity/` pins must not move.** This surface renders nothing a worker or orchestrator reads; briefs, system prompts, and served snippet libraries are untouched. A moved parity pin means something leaked into the prompt path — a red flag, not an expected diff.
- **`tests/skill.test.ts` forces the concierge reference.** It asserts every public command name appears in `skills/duet-concierge/references/cli-reference.md` and that every `duet <verb>`/`--flag` the reference names exists on the real command table. Adding `workflows` requires a matching `cli-reference.md` entry (and `--json` there must be a real flag of the command) or the suite fails — the doc-update is part of landing, planned later.

## Non-goals (deferred, one line each)

- **`--verify` / compile-all list mode** — import every definition to show external titles + broken rows. Deferred to keep the bare list execution-free; revisit only if the titleless listing *feels blind* in real use.
- **`--json` on `check` / `init`** — no consumer, and the `CompiledWorkflow` shape shouldn't become a public contract; text only.
- **A shared snippets+workflows "authoring catalog"** — snippets *shadow*, workflows *collide*; one abstraction would blur that product distinction.
- **Editing or deleting definitions** (`duet workflows edit/rm`) — out of scope; the file is the editable surface.

## Open questions

No open questions; the settled list `--json` decision is recorded here for implementation clarity. `duet snippets` ships no `--json`; this spec adds it to `duet workflows` (list only) — a deliberate departure, approved: it's a side-effect-free mirror of the discovery model, the natural machine surface the concierge already consumes for `status`/`snippets`. `check` and `init` stay text.

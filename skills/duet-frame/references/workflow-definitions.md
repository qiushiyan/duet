# Workflow definitions — the SDK, by worked example

When no shipped workflow says what the user means, compose one: a TypeScript file that default-exports `defineWorkflow({ ... })`, importing from `duet/workflows`. duet compiles the file at `duet new` and freezes the result into the run — later edits to the file never touch a live run.

The grammar is four blocks in a phase list, plus a gate posture:

- `frame({ name? })` — the direction phase that opens planning (every workflow starts with one).
- `doc(artifact, { rounds?, contract?, audit?, name? })` — a maker/checker review loop over a committed document; `artifact` is `'spec' | 'plan' | 'design'`.
- `build({ review, audit?, name? })` — the delivery build; `review` is `'critique' | 'writable' | 'fixer'`; exactly one per workflow.
- `finish({ name? })` — open the PR; always last.

`attend` lists the gates the human attends by default (omit = attend all); `presets` are named `gates_at` values a framing or flag can invoke; the `afk` preset (attend none) is provided universally — never write it. Default phase names are the block or artifact names (`frame`, `spec`, `implement`, `finish`); `name:` renames one, and every gate token — `attend`, `presets`, `gates_at` — follows the phase names.

You state the phase list; duet derives the rest from its semantics: the planning/delivery stages, the duty pair each stage runs, session continuity across the stage boundary, the gate copy, the entry route, the per-phase budgets. The vocabulary is closed — every composition must land on shipped prose, and the compiler rejects one that doesn't, naming the valid worlds (e.g. `build({ review: 'fixer' })` after a `plan` doc has no world). A rejection is the SDK working: report it to the user rather than working around it in the framing prose.

Two authoring layers, no npm install: `.duet/workflows/<name>.ts` for a project shape (add `!/workflows/` to `.duet/.gitignore` to commit it), `~/.config/duet/workflows/<name>.ts` for one the user wants across repos. `duet workflows init <name>` scaffolds a typed starter (or write the file by hand — either way the dir gets a `tsconfig.json` and a typed SDK stub, so the editor typechecks the file as-is), and `duet workflows check <name>` compiles a definition and prints its derived shape without starting a run — run it before handing the user the launch command. The filename must match the `name:` inside, and one name may live in only one layer — a name defined twice (including redefining a shipped name, as examples 1 and 2 do) is a load error, never a silent shadow; the bare `duet workflows` listing surfaces any collision.

Every definition below compiles through duet's real compiler in `tests/skill.test.ts`, and the two rebuilds are pinned **byte-identical** to the shipped registry rows — what you read here is exactly what ships.

## 1 · relay, rebuilt — the criss-cross is one knob

```workflow-ts
import { build, defineWorkflow, doc, finish, frame } from 'duet/workflows';

export default defineWorkflow({
  name: 'relay',
  title: 'Relay (frame → design doc → fresh build → judge review-and-fix → PR)',
  attend: ['design'],
  phases: [frame(), doc('design', { contract: true }), build({ review: 'fixer' }), finish()],
});
```

This compiles to the shipped relay, byte-for-byte — and swap `'fixer'` back to `'critique'` and you have rebuilt blueprint, so the whole criss-cross is one knob. `review: 'fixer'` derives it all: the delivery checker becomes a **judge** (write access at review — ordinary findings get fixed, not reported back), delivery is **born fresh** (no session continuity from planning; the builder implements the committed design doc cold), and the judge owns the build's docs tail and the PR. Everything else — the one attended Design gate, the contract, the doc loop — is blueprint unchanged. **Omitted:** `presets` — `afk` is provided universally, and relay needs no others.

Because `relay` is a shipped name, this exact file is not loadable — `duet new --workflow relay` would find both the shipped workflow and yours and refuse the collision. That is what a rebuild is for: proof the standard library is written in the grammar you're using. To make it yours, rename it, then turn a knob.

## 2 · full, rebuilt — doc chains and the consultant knobs

```workflow-ts
import { build, defineWorkflow, doc, finish, frame } from 'duet/workflows';

export default defineWorkflow({
  name: 'full',
  title: 'Full (spec → plan → implement → ship → PR)',
  attend: ['frame', 'spec'],
  presets: { overnight: ['frame', 'spec'], 'skip-plan': ['frame', 'spec', 'implement'] },
  phases: [
    frame(),
    doc('spec', { audit: true }),
    doc('plan', { contract: true }),
    build({ review: 'critique' }),
    finish(),
  ],
});
```

Docs chain: the doc nearest the build is delivery's upstream artifact — the plan here — and that decides how the build enters (full's builder compacts its planning session over the committed plan; a design upstream seeds differently). The entry route is derived too: `duet new --spec <draft>` enters at the first doc loop. The consultant knobs are per-phase and live only when the run binds a consultant: `audit: true` on the spec has it challenge the bet at that gate; `contract: true` on the plan has it author the acceptance contract there — and declaring a contract anywhere derives the verify checkpoint on the build automatically; you never write verify. `rounds:` would override a doc loop's review cap (spec and plan default 3, design 2). `attend` names the default posture and each preset a sayable alternative — `overnight` restates the default so the user can invoke it by name; `skip-plan` returns them at the Ship gate. **Omitted:** the `afk` preset (universal); `name:`s — the defaults `frame`/`spec`/`plan`/`implement`/`finish` are already right.

## 3 · hotfix — a shape with no shipped name

```workflow-ts
import { build, defineWorkflow, finish, frame } from 'duet/workflows';

export default defineWorkflow({
  name: 'hotfix',
  title: 'Hotfix (triage → patch → PR)',
  attend: ['triage'],
  phases: [
    frame({ name: 'triage' }),
    build({ name: 'patch', review: 'writable', audit: true }),
    finish(),
  ],
});
```

One attended triage gate, then a single writable patch pass straight to an open PR. The `name:` overrides are what make it a hotfix lane — the run's gates really are `triage`/`patch`/`finish`, in `attend`, in `gates_at`, in every status line the user reads. The docless build is the one home for `review: 'writable'` and for `audit: true` on the build (the consultant's implementation audit); with no doc upstream, delivery enters directly from the frame's decisions — they are the spec. Structurally this is short renamed and re-postured (strip the names and the attend and you're back to it): a workflow worth defining can be as small as the right vocabulary and a different default posture. **Omitted:** `presets` — `afk` is provided universally; bindings never live here — they ride the framing (`bind.*`), config, or flags.

The manifest side — selecting it with `workflow: hotfix` and what that omits — is example 5 in [manifest-examples.md](manifest-examples.md).

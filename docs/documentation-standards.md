# Documentation standards

duet's docs serve one purpose: give an engineer — human or agent — the **mental model** to understand the orchestrator without reading every source file. They cover architecture, intent, relationships, and the load-bearing constraints; they never duplicate code.

This file is the canonical home for how duet keeps its docs. `CLAUDE.md` carries the always-loaded summary and points here; the `/onboarding` and `/update-docs` skills in `.claude/skills/` are the two ends of the cadence it governs.

## Documentation shape

`docs/` is organized by **kind of content**, not by feature. The conceptual layout:

```
CLAUDE.md                       always-loaded mental model + conventions; the doc map
README.md                       orientation + the verified-vs-not status line
snippets.toml                   the orchestrator's snippet library
docs/
  automation-design.md          THE design — roles, layers, phases/gates, triage, policy
  engineering.md                the codebase mental model — module map, seams, patterns
  prompting-and-tool-design.md  the binding prompt/tool conventions
  workflow-model.md             the abstracted snippet protocol
  observed-pattern.md           the evidence sessions the protocol is drawn from
  open-questions.md             the design questions still open, and what would settle them
  future-directions.md          the product-direction ledger
  interactive-transport.md      the opt-in transport's direction + status
  specs/  plans/                per-feature, forward-looking, dated
```

Three kinds, three jobs:

- **Design docs** (`automation-design.md`, `engineering.md`, `prompting-and-tool-design.md`, `workflow-model.md`) describe **what is true today**. Durable — updated in place, never appended to. Present tense; future tense ("we will…") is a smell.
- **Rationale & evidence** (`open-questions.md`, `observed-pattern.md`) record **why**, and the runs that proved it. `open-questions.md` keeps only the questions still genuinely open, in topical (unnumbered) sections cited by name; when one settles, its answer moves into the design doc it shaped and the entry goes — the deliberations stay in git.
- **Direction & specs** (`future-directions.md`, `interactive-transport.md`, `docs/specs/`, `docs/plans/`) are **proposals** — what we might build and why. When one ships, distill its surviving content into the design doc it touches, in present tense, then prune the proposal.

This is a conceptual map. `ls docs/` is the source of truth for what exists right now; don't mirror that listing here, and adding a doc doesn't require editing this file.

## Design vs proposal — keep them apart

The drift to avoid: a feature ships, the spec stays "for history," and now two docs describe one subsystem — one what exists, one what someone wanted. New readers can't tell which is live. The discipline:

- A design doc answers "what is true today?" When a spec or direction lands, fold its decisions into the design doc and prune the proposal.
- `docs/specs/` and `docs/plans/` are forward-looking and dated; they don't become architecture by sitting still.
- Status lives in two honest places: the README's verified-vs-not line and `open-questions.md`. Don't sprinkle "shipped" / "not yet" markers through the design docs.

## Two conventions that are duet's, not generic

These already govern the repo (`CLAUDE.md` §Conventions); they bind doc work too:

- **Docs lead, code follows.** A doc/code disagreement is a doc bug or a design regression — resolve it explicitly, never silently match the code to a stale doc or vice versa.
- **Evidence-backed claims.** A workflow claim cites a run log or `examples/*.jsonl` turn and is tagged **(observed)** vs **(general)**. Don't launder a hoped-for behavior into the present tense; if it isn't verified, the README status line and `open-questions.md` are where that's said.

## When docs need updating

**Update when:**

- A new module, tool, phase, gate, provider, or snippet was introduced and isn't reflected anywhere.
- A doc section describes behavior a change altered or removed.
- The module map in `engineering.md` no longer matches the system shape, or a new top-level doc is missing from the `CLAUDE.md` Map.
- A cross-reference went stale, or a proposal in `specs/` / `future-directions.md` shipped and should distill into a design doc.

**No update needed when** the change is implementation-level (internal refactor, bug fix, test) and doesn't change how a developer thinks about the system.

**Significance tiers:**

- **None** — bug fixes, internal refactors, test additions, dependency bumps.
- **Module-level** — a new tool, snippet, or control flow inside an existing subsystem. Update the one design doc that owns it.
- **Design-level** — a new phase/gate, a new provider or transport, a new seam, a changed policy. May touch `automation-design.md`, the `engineering.md` map, the README status line, and `open-questions.md`.

**Deletion is maintenance; addition is maintenance.** A branch that adds 30 lines of doc and deletes none of the newly-redundant prose has done half the work. For a design-level change, assume the doc *structure* needs reconsidering, not just a wording patch at the point of change.

## Writing standards

**Don't write:**

- Source code — function bodies, signatures, type definitions. They rot instantly; point at the file instead.
- API tables generated from code, or descriptions of things obvious from a filename.
- Changelog entries ("added X on date Y") — restructure the narrative to describe the latest state.
- Absolute file paths — use repo-root-relative ones.

**Do write:**

- The mental model — the core abstraction, how to think about the subsystem.
- The decisions and their *why* — what was chosen over what, and the cost.
- Module relationships and boundaries; behavioral flows in prose or pseudo-code.
- The load-bearing invariants a new contributor would otherwise violate.
- One-line file pointers ("the statechart: `src/harness/machine.ts`") — never the contents.
- Directory structures as an indented tree — indentation under a directory name, not a repeated full path per file:

  ```
  src/
    test.ts
    another.ts
    folder/
      hello.ts
  ```

## Spotlight the load-bearing; let the code hold the inventory

The reader is a senior engineer who *will* read the code. A doc that re-lists what the code already enumerates spends their attention without growing their mental model — and rots the moment the code changes. Name what is load-bearing; leave the complete list to the source. Three anti-patterns this rules out — the `/update-docs` skill should actively cut them, not just avoid adding them:

- **Exhaustive listing.** Don't enumerate every seam, tool, field, or module a subsystem has. List the ones a reader *must* grasp to hold the model; let the rest live in the code or get a single grouped mention. A complete catalogue is the code's job.
- **A table row is earned, not automatic.** A new interface is not a reason for a new row. Add one only when the reader needs that item to navigate the system; fold a secondary change into an existing entry instead of growing the table. The reflex "new thing → new row" is what bloats a module map.
- **No live counts.** Don't write "there are seven seams" or "the five rules." A cardinal number is a maintenance tax that silently rots — one already had ("seven seams" in one doc, "five" in another) — and a senior engineer never navigates by it. Name the few that matter; the count is the code's to know.

When cutting leaves a flow or relationship that prose traces clumsily, **draw it** instead — an indented tree, an arrow chain (`marker → markerToEvent → phase.*`), a short sequence sketch. A diagram scanned in two seconds beats a 60-word sentence threading the same path (`engineering.md`'s trust-gradient sketch and the `phases.ts` header arc are the models in-repo).

## Consolidation principles

**Adding content is an opportunity to simplify.** Each time you touch a doc, make it tighter, not just longer — the goal is a stable size as the system grows.

1. Re-read the whole doc, not just the section you're editing.
2. Merge overlap instead of writing a second description of the same concept.
3. Combine small related sections under one heading; restructure if the reading order has gone disjoint.
4. Cut anything that has drifted into implementation detail back to the mental model.
5. Edit in place — fold new information into the section it belongs in, don't append.

A doc that gains 10 lines of new content should usually shed 5–10 of redundancy.

## Onboarding skill maintenance

`/onboarding [topic]` (`.claude/skills/onboarding/SKILL.md`) bootstraps a session with topic-scoped context in two phases:

- **Phase 1 — always-on core reads:** `CLAUDE.md`, `docs/automation-design.md`, `docs/engineering.md`. The mental model no duet task can safely skip.
- **Phase 2 — topic deep dive:** the design doc(s) and code for the topic. CLAUDE.md indexes the docs, and the `engineering.md` module map is the source of truth for code; the skill's topic table only turns a phrase into a focus.

Keep it lean. Phase 1 is for what an agent *cannot* skip, not what's merely interesting. Litmus: *"Would an agent on a typical duet task produce wrong code without reading this?"* If not, it's Phase 2.

**Update the skill when** a new top-level doc appears that the topic table doesn't route to, a Phase 1 doc is renamed or split, or a deep-dive anchor drifts. Routine edits inside an existing doc don't touch the skill — it already points at the doc.

## Authoring CLAUDE.md

`CLAUDE.md` is unique: Claude Code appends it to *every* request in the repo, and it rides the cached prompt prefix. Every other doc is read on demand — its cost is paid only when relevant; CLAUDE.md's is paid on every operation and dilutes attention on every task. Its bar is the strictest here:

- **Load-bearing facts + roadmap only.** A line earns its place only if an agent on a *typical, arbitrary* task would do worse without it — the cross-cutting invariants that bite across subsystems, the product goals every change is measured against, the conventions, and a map of *where to read the rest*. "Useful when working on X" is not enough; that belongs in X's doc, loaded when the agent goes there.
- **Point, don't re-explain.** It is the index layer. An invariant states its *conclusion* in one line and points to the doc carrying the mechanism; the Map names which doc answers what and defers code detail to `engineering.md` — it never re-lists modules.
- **No enumerations, counts, or status dumps** (§"Spotlight the load-bearing" — sharper here, since it is paid every call). A module map, a tool list, a build-status paragraph all rot and read better in `engineering.md` / the README.

**Edit it only when** a new cross-cutting invariant earns its way in (the bar is high), an existing one's framing rots, or a new top-level doc joins the Map. Implementation-level changes never warrant a CLAUDE.md edit.

## Shipped skill maintenance

The repo ships user-facing skills under `skills/` (distinct from the dev-time `.claude/skills/`): **duet-frame** composes a run's setup and emits the `duet new` command, **duet-concierge** starts and supervises runs. They are **prompts**, not docs — so edits follow `docs/prompting-and-tool-design.md` (a thinking framework with its motivation over bare prohibition, no aggressive emphasis, surface the load-bearing *why*) and each skill's established voice, not the design-doc style.

**The trigger is a user-facing capability, not a prose change.** When a change adds or alters one — a `duet new` flag, a setup or gate-posture choice, a run-management verb — ask whether duet-frame should *surface* it (a new setup choice the user makes before launch) or duet-concierge should *relay or read* it (a new verb, or a changed run shape its supervision reports). A feature can add a flag without touching a single `.md`, so a diff-of-docs mindset misses these; make the capability the trigger, caught while reading the diff, not an afterthought.

**`tests/skill.test.ts` guards coherence, not completeness.** It pins every verb and flag a skill *names* to the live CLI, so a rename fails in five seconds — but it cannot tell you a skill *should* name a capability it currently omits. A green skill test is not evidence the skills are current; the completeness call is the maintainer's. (Worked example: the consultant's `--consultant` flag shipped while duet-frame silently stopped covering a setup choice users now have, and the skill test stayed green throughout.)

## Maintenance cadence

Review this file, the dev skills (onboarding + update-docs), the shipped skills (duet-frame + duet-concierge), and the shape of `docs/` every 3–6 months or after a major Claude model release. Guardrails written for an older model can become friction for a newer one — instructions that kept past models on track can stop newer ones from making coordinated edits they handle fine. Treat removing stale guidance with the same weight as adding new.

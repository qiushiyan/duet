# Vendored methodology lessons (`lessons/`)

These are **vendored snapshots**, not authored here. They are duet's quality
opinion for the PLAN phase — what counts as good design (deep modules, seams,
the deletion test, illegal states) and good implementation (TDD discipline,
mocking strategy, the Vitest toolkit). The three PLAN/RIR snippets in
`snippets.toml` (`start-plan`, `review-plan`, `implement-direct`) cite them by a
`{{lessons_dir}}/…` path that `src/snippets.ts` resolves to this directory at
serve time, so a worker on any install reads the real files, not a path on the
author's machine. They ship in the npm package (`package.json` `files` includes
`lessons`).

## The two topics

- [`codebase-design/`](codebase-design/) — module-design vocabulary and
  structural patterns: `deep-modules.md` (always), `deepening.md` (when
  restructuring), `design-it-twice.md` (when the interface is uncertain).
- [`testing/`](testing/) — test discipline and tooling: `tdd-loop.md` (always),
  `mocking-and-fixtures.md` (always), `vitest.md` (TS-Vitest projects only).

The snippets carry the reading **arc** (which files, in what order, with the
conditional gates); these docs carry the **depth** behind each imperative. Each
opens with a skimmable "## The bar" section, then expands — so `review-plan`
skims the top as a lens while `start-plan` reads deeply.

## Provenance and the re-vendor seam

A three-tier chain, each tier a pinned snapshot of the one above that may diverge
with local edits:

```
mattpocock/skills          ← upstream
   │  (fork: consolidate, headless-tune, add our opinions)
   ▼
~/.config/lessons          ← the author's OWNED source of truth (Stow-managed;
   │                          .upstream/ pins the Matt snapshot it forked from)
   │  (vendor: pin a snapshot)
   ▼
duet/lessons/              ← this vendored, shippable copy ({{lessons_dir}})
```

- **Canonical (authoring) source:** `~/.config/lessons/{codebase-design,testing}`
  — a neutral, tool-agnostic lessons directory the author manages with Stow,
  also read live by tabtype's snippets. Evolved there, not here.
- **This copy:** a frozen snapshot duet packages and workers read at runtime.
  The source's `.upstream/` diff baseline is **not** vendored — it is the
  author's diff anchor, never read by a worker.
- **Refresh:** `pnpm vendor-lessons` (copies the two topic dirs in wholesale;
  `--dry-run` to preview; `DUET_LESSONS_DIR` overrides the source). Re-vendoring
  is a deliberate manual step — the mirror of the `snippets.toml` ⟷ tabtype
  hand-sync, which runs the opposite direction (repo → tabtype). The provenance
  audit is `git diff` on this directory. **Do not hand-edit files here:** edit
  the canonical copy and re-vendor, or the next refresh overwrites the change.

## Not invokable lessons

`lessons/` has no `SKILL.md` of its own, so `scripts/sync-skills.mjs`
(which discovers a skill by a top-level `SKILL.md`) never sees it and never
symlinks the methodology as an invokable Claude skill. This stays reference
material that a worker reads when a snippet points at it — nothing more.

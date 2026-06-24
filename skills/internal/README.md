# Vendored methodology skills (`skills/internal/`)

These are **vendored snapshots**, not authored here. They are duet's quality
opinion for the PLAN phase — what counts as good implementation (TDD discipline)
and good design (deep modules, seams, the deletion test). The two PLAN snippets
in `snippets.toml` (`tdd-plan`, `review-plan`) cite them by a `{{skills_dir}}/…`
path that `src/snippets.ts` resolves to this directory at serve time, so a
worker on any install reads the real files, not a path on the author's machine.
They ship in the npm package (`package.json` `files` includes `skills`).

## Provenance and the re-vendor seam

- **Canonical (authoring) source:** `~/.claude/skills/{tdd,improve-codebase-architecture}`
  — the author's general cross-project toolkit, evolved there, not here.
- **This copy:** a frozen snapshot duet packages and workers read at runtime.
- **Refresh:** `pnpm vendor-skills` (copies the canonical dirs in wholesale;
  `--dry-run` to preview). Re-vendoring is a deliberate manual step — the mirror
  of the `snippets.toml` ⟷ tabtype hand-sync, which runs the opposite direction
  (repo → tabtype). **Do not hand-edit files here:** edit the canonical copy and
  re-vendor, or the next refresh overwrites the change.

## Not invokable skills

`skills/internal/` has no `SKILL.md` of its own, so `scripts/sync-skills.mjs`
(non-recursive, requires a top-level `SKILL.md`) never discovers it and never
symlinks the methodology as an invokable Claude skill. The vendored `SKILL.md`s
also carry `disable-model-invocation: true`. This stays reference material that a
worker reads when a snippet points at it — nothing more.

## Known dangling links (intentional)

`improve-codebase-architecture/SKILL.md` links to two files in a sibling skill
that is **not** vendored: `../grill-with-docs/CONTEXT-FORMAT.md` and
`../grill-with-docs/ADR-FORMAT.md`. These sit in tangential "offer an ADR"
asides, not the deep-modules lens `review-plan` invokes, so they are left as-is
(the snapshot is vendored whole, never forked by editing). A worker that follows
one finds it missing and reports it (the `smart-adapt-skills` net) rather than
the snippet silently losing its discipline.

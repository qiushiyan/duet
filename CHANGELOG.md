# greenflag

## 0.1.6

### Patch Changes

- `compare-notes` now settles the goal before comparing approaches: when the two analyses named a different real problem or underlying goal, that disagreement is resolved first, since every approach below it is being weighed against a different target. Re-vendors `collaboration/review-lens.md` with the matching guidance.

## 0.1.5

### Patch Changes

- 5276aef: Interview questions are asked in one batch, clustered by topic, deferring only a follow-up that a pending answer would decide or reshape — replacing the one-question-at-a-time rhythm in `think-holistic` and `write-spec`.

## 0.1.4

### Patch Changes

- 7f45e52: Interview questions must be decidable from their text alone: `think-holistic`'s and `write-spec`'s interview steps now compose each question with why it matters, what it means in plain product terms, the options with their implications for the real user, and a recommendation — the human answers from the question's words, not from the worker's context.

## 0.1.3

### Patch Changes

- 3b6a2a7: Add `homepage` and `bugs` so the npm page links back to the repo and its issues.
- The build-phase review snippets (`review-implementation`, `review-direct`, `review-and-fix`) now open by reading the vendored `collaboration/review-lens.md` — the shared reviewer stance: step back before judging locally, the additive-bias bar for requested tests, right-sizing, Chesterton's fence — and keep only run-specific wiring in their bodies. Ships the new `lessons/collaboration` topic in the package.

## 0.1.2

### Patch Changes

- Fix `greenflag --version`, which reported a hardcoded `0.1.0` regardless of the
  installed version.

  The CLI carried the version as a literal that no release step could see, so
  changesets bumped `package.json` while `--version` kept answering 0.1.0. The
  version is now read from `package.json` at startup through a single `VERSION`
  export, which `--version`, the corpus era stamp, and the generated workflow
  `.d.ts` header all share — the same one-owner rule that fixed asset resolution.

## 0.1.1

### Patch Changes

- Fix the published binary, which pointed at the TypeScript dev entry.

  `publishConfig.bin` (→ `dist/cli.mjs`) is a pnpm-only rewrite, so publishing with
  `npm publish` shipped `bin` → `src/surfaces/cli.ts` instead. npm force-includes a
  bin target even when `files` excludes it, and Node refuses to strip types inside
  `node_modules` — so `greenflag@0.1.0` failed with
  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` on the first command of every
  install. Releases now go through `pnpm`, enforced by `prepublishOnly`.

  Also fixes shipped-asset resolution: `snippets/`, `lessons/`, and the
  orchestrator identity prompt were located by counted `..` hops from
  `import.meta.url`, which is correct in the dev tree but resolves above the
  package once bundled flat into `dist/`. They now anchor on a single
  `PACKAGE_ROOT` that walks to the nearest `package.json`, correct in both.

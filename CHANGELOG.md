# greenflag

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

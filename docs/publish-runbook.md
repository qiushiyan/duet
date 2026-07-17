# Publish runbook

The commands to cut a greenflag release. Why it works this way — the `bin` split, the pnpm rule, `PACKAGE_ROOT` — is `docs/engineering.md` §"Build & publish"; this file is the sequence.

**One rule: publish with pnpm, never npm.** `npm publish` ignores `publishConfig.bin` and ships a broken binary. `prepublishOnly` refuses it, so the wrong command fails instead of shipping.

## Release

```bash
pnpm changeset            # describe the change; pick patch / minor / major
pnpm changeset version    # applies the bump + writes CHANGELOG.md
git commit -am "release: <version>"
pnpm release              # = changeset publish — publishes + git-tags
git push --follow-tags
```

`pnpm release` skips any version already on npm, and runs `prepack` first (typecheck → tests → build), so a broken tree can't ship.

## Check before you push

```bash
pnpm pack                                        # build the tarball
tar xzOf greenflag-*.tgz package/package.json    # bin MUST be dist/cli.mjs
tar tzf greenflag-*.tgz | grep src/              # MUST be empty
rm greenflag-*.tgz
```

Then the real test — install it the way a stranger does:

```bash
cd $(mktemp -d) && npm init -y >/dev/null
npm install greenflag@<version>
npx greenflag --version
```

## Deprecate a bad version

npm never lets you republish a version. A broken one is fixed forward — bump, publish, then:

```bash
npm deprecate greenflag@<bad-version> "<reason>; use <good-version>+"
```

## First release from a fresh machine

```bash
npm whoami || npm login
pnpm install
```

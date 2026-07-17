// Refuse to publish from anything but pnpm.
//
// `publishConfig.bin` (-> dist/cli.mjs) is the one thing standing between the
// published tarball and a dev-only entry point, and rewriting `bin` from
// publishConfig is a PNPM feature. `npm publish` silently ignores it: the
// tarball's bin stays src/surfaces/cli.ts, npm force-includes that file (a bin
// target bypasses `files`), and Node then refuses to type-strip it inside
// node_modules — ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING on the user's very
// first command. greenflag@0.1.0 shipped exactly this way and crashed on every
// install; the version is burned, since npm never allows republishing one.
//
// This runs from `prepublishOnly`, which both package managers honor.

const agent = process.env.npm_config_user_agent ?? '';

if (!agent.startsWith('pnpm')) {
  console.error(
    [
      '',
      '  greenflag: refusing to publish — use `pnpm publish`, not `npm publish`.',
      '',
      `  detected: ${agent || '(no npm_config_user_agent)'}`,
      '',
      '  Why: the published bin comes from publishConfig.bin (dist/cli.mjs), and only',
      '  pnpm applies that rewrite. Under npm the tarball ships bin -> src/surfaces/cli.ts,',
      '  which Node cannot type-strip inside node_modules. Every install crashes on the',
      '  first command (this is how 0.1.0 shipped broken).',
      '',
      '  Verify a tarball before pushing it:  pnpm pack  &&  tar xzOf *.tgz package/package.json',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

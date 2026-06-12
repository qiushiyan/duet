import { defineConfig } from 'tsdown';

// Publish-only bundle (`pnpm build`, run automatically by `prepack`).
// Dev and the global `duet` link run src/cli.ts directly — never dist/.
// Output is dist/cli.mjs — publishConfig.bin must match.
export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  platform: 'node',
  // No dts: nothing imports duet as a library; the CLI is the whole surface.
  publint: true,
});

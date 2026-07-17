import { defineConfig } from 'tsdown';

// Publish-only bundle (`pnpm build`, run automatically by `prepack`).
// Dev and the global `greenflag` link run src/cli.ts directly — never dist/.
// Output is dist/cli.mjs — publishConfig.bin must match. The workflows entry is
// the SDK subpath external workflow files import through the loader hook.
export default defineConfig({
  entry: { cli: 'src/surfaces/cli.ts', workflows: 'src/workflows.ts' },
  format: ['esm'],
  platform: 'node',
  dts: true,
  publint: true,
});

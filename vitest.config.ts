import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Isolate $HOME at an empty dir so snippet user-override resolution never
    // picks up the developer's real ~/.config/duet/snippets.toml.
    setupFiles: ['tests/helpers/home-isolation.ts'],
    // Mock hygiene baked into config so individual tests never think about it.
    restoreMocks: true,
    clearMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});

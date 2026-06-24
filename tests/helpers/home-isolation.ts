import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Global test isolation for the OS home — a vitest setup file (wired in
 * vitest.config.ts), run before each test file's module graph imports.
 *
 * The snippet user-override layer resolves from `<home>/.config/duet/snippets.toml`
 * via `runtimeLibraryContext` → `os.homedir()`, which honors `$HOME` on POSIX.
 * Without this, any test that serves `list_snippets` (in-process registries AND
 * the `_mcp` subprocess, which inherits this env) would pick up the developer's
 * real `~/.config/duet/snippets.toml` and diverge from a shipped-only baseline.
 *
 * Pointing `$HOME` at a fresh EMPTY dir makes every such resolution hermetic: no
 * user override exists, so the user layer is empty. A test that wants to exercise
 * the user layer plants a file under this dir or stubs `$HOME` itself (restored
 * by `unstubEnvs`). Set directly (not via `vi.stubEnv`) so it persists for the
 * whole file rather than being torn down per test.
 */
const EMPTY_HOME = mkdtempSync(join(tmpdir(), 'duet-test-home-'));
process.env.HOME = EMPTY_HOME;
process.env.USERPROFILE = EMPTY_HOME; // the Windows equivalent os.homedir() consults

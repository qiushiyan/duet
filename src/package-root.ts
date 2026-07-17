import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The installed package's root — the one anchor every shipped asset resolves
 * from (snippets/, lessons/, prompts/, and the package's own version).
 *
 * Why a walk rather than a counted `..` hop: this code runs in two shapes of
 * differing depth. In dev, a module sits wherever it lives under `src/`
 * (`src/orchestrator/library.ts` is two below the root); published, tsdown
 * bundles every module flat into `dist/cli.mjs`, one below the root. A hop
 * count is therefore correct in exactly one shape — the published build used to
 * resolve one level ABOVE the package and could not find `snippets/` at all.
 * Walking to the nearest `package.json` is correct in both, and stays correct
 * when a module moves.
 *
 * A leaf: node builtins only, so any layer may import it (the trust gradient's
 * import direction is unaffected). It is the single owner of this question —
 * the hop counts it replaced had drifted to four different answers, three wrong.
 */
export const PACKAGE_ROOT = findPackageRoot(dirname(fileURLToPath(import.meta.url)));

function findPackageRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`greenflag: no package.json found above ${from}`);
    dir = parent;
  }
}

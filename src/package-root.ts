import { existsSync, readFileSync } from 'node:fs';
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

/**
 * The running package's version — read from `package.json`, never written down
 * a second time. `--version`, the corpus era stamp, and the generated workflow
 * `.d.ts` header all report this one value.
 *
 * The rule exists because the alternative shipped: `cli.ts` carried a literal
 * `.version('0.1.0')` that no release step knew about, so `greenflag --version`
 * kept reporting 0.1.0 from an installed 0.1.1. A version string that changesets
 * cannot see is a version string that will be wrong.
 */
export const VERSION = readVersion();

function findPackageRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`greenflag: no package.json found above ${from}`);
    dir = parent;
  }
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

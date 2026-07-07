import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';

/**
 * The repository-identity probe. Runs start in git worktrees, and a worktree's
 * path (the run's `cwd`) dies at merge — so a record grouped by cwd loses its
 * project the day the worktree is deleted. The durable identity is derived
 * once, at `createRun`, from git itself:
 *
 * - `root` — the PRIMARY checkout path: the parent of the git COMMON dir
 *   (`git rev-parse --path-format=absolute --git-common-dir`). For a linked
 *   worktree the common dir is the main checkout's `.git`, so `root` names the
 *   MAIN checkout — which is the point: every worktree of one project derives
 *   the same root.
 * - `remote` — the `origin` URL when one exists (two separate clones of one
 *   project share it where their roots differ).
 *
 * Fail-soft is absolute: any git failure (no git, no repo, an old git without
 * `--path-format`) returns undefined and the stamp is simply absent — deriving
 * an identity must never block or delay run creation, so each call also
 * carries a short wall-clock timeout.
 */

export interface RepoIdentity {
  /** The primary checkout path (parent of the git common dir). */
  root: string;
  /** The `origin` remote URL, when one exists. */
  remote?: string;
}

/** One fail-soft git read: trimmed stdout on success, undefined on any failure. */
function git(cwd: string, args: string[]): string | undefined {
  try {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 2_000 });
    if (result.status !== 0) return undefined;
    const out = result.stdout.trim();
    return out === '' ? undefined : out;
  } catch {
    return undefined;
  }
}

/** Derive the durable repository identity of `cwd`, or undefined (fail-soft). */
export function deriveRepoIdentity(cwd: string): RepoIdentity | undefined {
  const commonDir = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!commonDir) return undefined;
  const remote = git(cwd, ['remote', 'get-url', 'origin']);
  return { root: dirname(commonDir), ...(remote ? { remote } : {}) };
}

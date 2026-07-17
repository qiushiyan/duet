import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { PACKAGE_ROOT } from '../package-root.ts';
import type { RunState } from './store.ts';

/**
 * The corpus is an opt-in sidecar archive. Every operation here is fail-soft:
 * the local run dir remains the source of truth, and a corpus write must never
 * change the run's behavior.
 */

const CORPUS_STAMP = 'corpus.json';
const TRANSCRIPTS_DIR = 'transcripts';
// Resolved from greenflag's own package.json so the era stamp can't drift from
// the released version. Anchored on PACKAGE_ROOT, which is correct in both the
// dev tree and the published bundle (src/package-root.ts).
const GREENFLAG_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

type CorpusState = Pick<RunState, 'runId' | 'cwd' | 'corpusDir'>;

function runDirOfState(state: Pick<RunState, 'cwd' | 'runId'>): string {
  return join(state.cwd, '.greenflag', 'runs', state.runId);
}

function sameRecord(path: string, runId: string, cwd: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(join(path, 'state.json'), 'utf8')) as { runId?: string; cwd?: string };
    return raw.runId === runId && raw.cwd === cwd;
  } catch {
    return false;
  }
}

export function allocateCorpusRecordDir(root: string, runId: string, cwd: string): string {
  try {
    const base = join(root, runId);
    if (!existsSync(base) || sameRecord(base, runId, cwd)) return base;
    for (let i = 2; i < 1000; i += 1) {
      const candidate = join(root, `${runId}-${i}`);
      if (!existsSync(candidate) || sameRecord(candidate, runId, cwd)) return candidate;
    }
  } catch {
    // Fall through to the unsuffixed path; later writes are best-effort too.
  }
  return join(root, runId);
}

export function ensureCorpusRecord(state: CorpusState): string | undefined {
  if (!state.corpusDir) return undefined;
  try {
    mkdirSync(state.corpusDir, { recursive: true });
    // The stamp is written once — it marks the record's creation era, not the
    // last write (and a per-append rewrite would churn a synced corpus dir).
    const stamp = join(state.corpusDir, CORPUS_STAMP);
    if (!existsSync(stamp)) {
      writeFileSync(
        stamp,
        JSON.stringify(
          {
            greenflagVersion: GREENFLAG_VERSION,
            runId: state.runId,
            sourceCwd: state.cwd,
            mirroredAt: new Date().toISOString(),
          },
          null,
          2,
        ) + '\n',
      );
    }
    return state.corpusDir;
  } catch {
    return undefined;
  }
}

function localPath(state: Pick<RunState, 'cwd' | 'runId'>, relativePath: string): string {
  return join(runDirOfState(state), relativePath);
}

function corpusPath(recordDir: string, relativePath: string): string {
  return join(recordDir, relativePath);
}

export function mirrorAppend(state: CorpusState, relativePath: string, content: string): void {
  try {
    const recordDir = ensureCorpusRecord(state);
    if (!recordDir) return;
    const path = corpusPath(recordDir, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, content);
  } catch {
    // Best-effort telemetry only.
  }
}

export function mirrorFile(state: CorpusState, relativePath: string): void {
  try {
    const recordDir = ensureCorpusRecord(state);
    if (!recordDir) return;
    const src = localPath(state, relativePath);
    if (!existsSync(src)) return;
    const dst = corpusPath(recordDir, relativePath);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  } catch {
    // Best-effort telemetry only.
  }
}

function isIncludedTopLevelFile(name: string): boolean {
  return (
    name === 'state.json' ||
    name === 'machine.json' ||
    name === 'workflow.json' ||
    name === 'notes.md' ||
    name === 'framing.md' ||
    name.endsWith('.log')
  );
}

/**
 * Reconcile the corpus record to the run dir's included artifacts at a
 * quiescent point. Live mechanics and scratch are deliberately excluded; the
 * transcript archive is owned by the voices layer and preserved here. `srcDir`
 * defaults to the run's live dir but is passed explicitly by backfill, which
 * mirrors from wherever it swept the dir (never a state.cwd-derived guess).
 */
export function reconcileRecord(state: CorpusState, srcDir: string = runDirOfState(state)): void {
  try {
    const recordDir = ensureCorpusRecord(state);
    if (!recordDir) return;
    if (!existsSync(srcDir)) return;

    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      if (entry.isFile() && isIncludedTopLevelFile(entry.name)) {
        cpSync(join(srcDir, entry.name), join(recordDir, entry.name), { recursive: true });
        continue;
      }
      if (entry.isDirectory() && entry.name === 'steers') {
        const dst = join(recordDir, entry.name);
        rmSync(dst, { recursive: true, force: true });
        cpSync(join(srcDir, entry.name), dst, { recursive: true });
      }
    }
  } catch {
    // Best-effort telemetry only.
  }
}

export function transcriptArchiveDir(state: CorpusState): string | undefined {
  try {
    const recordDir = ensureCorpusRecord(state);
    if (!recordDir) return undefined;
    const dir = join(recordDir, TRANSCRIPTS_DIR);
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return undefined;
  }
}

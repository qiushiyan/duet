import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { UnloadableRunError, loadRunStateFromDir } from '../../src/run/store.ts';
import type { RunState } from '../../src/run/store.ts';
import { workflowForRunDir } from '../../src/run/workflow.ts';
import type { CompiledWorkflow } from '../../src/registry/workflows.ts';
import { resolveConfiguredCorpusRoot } from '../../src/voices/bindings.ts';

export interface CorpusRecord {
  runDir: string;
  state: RunState;
  workflow: CompiledWorkflow;
  source: 'corpus' | 'sweep';
}

export interface LoadSummary {
  records: CorpusRecord[];
  skippedUnloadable: number;
  skippedForeign: number;
  source: 'corpus' | 'sweep';
  /** Set when a configured (not explicit) corpus was empty and we swept instead. */
  fallbackNote?: string;
}

export interface CorpusCliOptions {
  corpusDir?: string;
  sweepRoots: string[];
  json: boolean;
}

export function parseCorpusCliArgs(argv: string[]): CorpusCliOptions {
  const sweepRoots: string[] = [];
  let corpusDir: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--corpus') {
      const next = argv[++i];
      if (!next) throw new Error('--corpus needs a directory');
      corpusDir = resolvePath(next);
      continue;
    }
    if (arg === '--sweep') {
      const next = argv[++i];
      if (!next) throw new Error('--sweep needs a directory');
      sweepRoots.push(resolvePath(next));
      continue;
    }
    throw new Error(`unknown argument ${arg}`);
  }
  return { ...(corpusDir ? { corpusDir } : {}), sweepRoots, json };
}

export function resolvePath(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return resolve(path);
}

export function configuredCorpusDir(): string | undefined {
  return resolveConfiguredCorpusRoot();
}

export function defaultSweepRoots(): string[] {
  const dev = join(homedir(), 'dev');
  return [existsSync(dev) ? dev : process.cwd()];
}

function corpusRecordDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .filter((dir) => existsSync(join(dir, 'state.json')));
}

function isLiveRunDir(path: string): boolean {
  return basename(dirname(path)) === 'runs' && basename(dirname(dirname(path))) === '.duet' && existsSync(join(path, 'state.json'));
}

function walkForRunDirs(root: string): string[] {
  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (isLiveRunDir(dir)) {
      found.push(dir);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
      stack.push(join(dir, entry.name));
    }
  }
  return found;
}

export function findLiveRunDirs(roots: readonly string[]): string[] {
  return [...new Set(roots.flatMap((root) => walkForRunDirs(root)))].sort();
}

function loadOne(runDir: string, source: 'corpus' | 'sweep'): CorpusRecord | { unloadable: true } | { foreign: true } {
  try {
    const state = loadRunStateFromDir(runDir);
    return { runDir, state, workflow: workflowForRunDir(state, runDir), source };
  } catch (err) {
    if (err instanceof UnloadableRunError) return { unloadable: true };
    return { foreign: true };
  }
}

export function loadCorpusRecords(opts: { corpusDir?: string; sweepRoots?: readonly string[] } = {}): LoadSummary {
  const explicit = opts.corpusDir; // an explicit --corpus is authoritative
  const corpusDir = explicit ?? configuredCorpusDir();
  const corpusDirs = corpusDir ? corpusRecordDirs(corpusDir) : [];

  let source: 'corpus' | 'sweep';
  let dirs: string[];
  let fallbackNote: string | undefined;
  if (corpusDirs.length > 0) {
    source = 'corpus';
    dirs = corpusDirs;
  } else if (explicit) {
    // An explicit --corpus that is empty means empty — never silently sweep ~/dev.
    source = 'corpus';
    dirs = [];
  } else {
    // No explicit corpus: fall back to a live sweep (the young-archive convenience),
    // but announce it when a configured archive was simply empty.
    source = 'sweep';
    const roots = opts.sweepRoots?.length ? opts.sweepRoots : defaultSweepRoots();
    dirs = findLiveRunDirs(roots);
    if (corpusDir) fallbackNote = `corpus ${corpusDir} has no records yet — swept ${roots.join(', ')} instead`;
  }

  const records: CorpusRecord[] = [];
  let skippedUnloadable = 0;
  let skippedForeign = 0;
  for (const dir of dirs) {
    const loaded = loadOne(dir, source);
    if ('unloadable' in loaded) skippedUnloadable += 1;
    else if ('foreign' in loaded) skippedForeign += 1;
    else records.push(loaded);
  }
  records.sort((a, b) => b.state.createdAt.localeCompare(a.state.createdAt));
  return { records, skippedUnloadable, skippedForeign, source, ...(fallbackNote ? { fallbackNote } : {}) };
}

export function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

export function readLog(record: CorpusRecord, voice: string): string | undefined {
  return readText(join(record.runDir, `${voice}.log`));
}

export function workerLogNames(record: CorpusRecord): string[] {
  try {
    return readdirSync(record.runDir)
      .filter((name) => name.endsWith('.log'))
      .filter((name) => name !== 'orchestrator.log' && name !== 'driver.log')
      .map((name) => name.slice(0, -'.log'.length))
      .sort();
  } catch {
    return [];
  }
}

export function printLoadSummary(summary: LoadSummary): void {
  if (summary.fallbackNote) console.error(summary.fallbackNote);
  console.error(
    `loaded ${summary.records.length} ${summary.source} record(s); skipped unloadable=${summary.skippedUnloadable}, foreign=${summary.skippedForeign}`,
  );
}

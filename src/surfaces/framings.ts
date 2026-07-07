import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { loadRunStateFromDir, runDirOf, scanRuns } from '../run/store.ts';
import type { RunState } from '../run/store.ts';
import { deriveRepoIdentity } from '../run/repo.ts';
import type { RepoIdentity } from '../run/repo.ts';
import { resolveConfiguredCorpusRoot } from '../voices/bindings.ts';
import { parseFramingFile } from './framing.ts';
import { localStamp } from '../view/timefmt.ts';

/**
 * `duet framings` — the framings browser. A run's framing is the one document
 * the human writes per run; its archive copy lives in the git-ignored run dir
 * (`.duet/runs/<id>/framing.md`) and dies with the worktree, while the opt-in
 * corpus archive (docs/corpus-runbook.md) keeps a durable copy. This surface
 * merges the two — the configured corpus archive plus the current project's
 * local runs, deduped by runId with the corpus copy winning — and scopes the
 * list to the current repo by default: each record's `repo` identity stamp is
 * matched against this checkout's own derived identity (same primary-checkout
 * root, or same origin remote), falling back to cwd equality for unstamped
 * records. `--all` lifts the scope; `show <runId>` prints one archived
 * framing verbatim.
 *
 * The structural sibling of `stats.ts`: a fail-soft model builder plus
 * separate renderers, `--json` emitting the model verbatim (raw UTC
 * timestamps, raw paths — localization and ~-shortening are view-time only,
 * and the JSON schema is additive-only). Corpus reads are read-only and never
 * required: an unconfigured or missing corpus degrades to the local-runs list
 * with one plain note naming the `[corpus] dir` config key, and a record the
 * codecs refuse is skipped with a count, never an abort (the corpus-reader
 * convention).
 */

export interface FramingRecordModel {
  runId: string;
  /** Raw UTC ISO — the text renderer localizes; `--json` keeps it raw. */
  createdAt: string;
  workflow: string;
  /** The creating checkout (may be a dead worktree path). */
  cwd: string;
  /** The durable repo stamp, when the run recorded one. */
  repo?: RepoIdentity;
  source: 'corpus' | 'local';
  /** Where this record (and its framing.md) lives. */
  runDir: string;
  /** First markdown heading of the framing body, else its first non-empty line; absent when no framing was archived. */
  title?: string;
}

export interface FramingsModel {
  scope: 'repo' | 'all';
  /** The resolved corpus archive root, when configured. */
  corpusDir?: string;
  /** One plain note when the corpus contributes nothing (unconfigured, missing dir, unreadable config). */
  note?: string;
  /** Records recognized but refused by the load boundary (mixed eras, foreign dirs) — counted, never an abort. */
  skipped: number;
  records: FramingRecordModel[];
}

const CORPUS_KEY_HINT = '[corpus] dir in ~/.config/duet/config.toml (docs/corpus-runbook.md)';

/**
 * Resolve the configured corpus root, fail-soft. The corpus is never required:
 * every degraded outcome (no key, unreadable config, a configured dir that
 * doesn't exist — the silently-off mirror trap the runbook names) yields a
 * plain note and the listing carries on with local runs alone.
 */
function resolveCorpus(configPath?: string): { corpusDir?: string; note?: string } {
  let corpusDir: string | undefined;
  try {
    corpusDir = configPath === undefined ? resolveConfiguredCorpusRoot() : resolveConfiguredCorpusRoot(configPath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { note: `corpus archive skipped — config unreadable (${detail}); it is set via ${CORPUS_KEY_HINT}` };
  }
  if (!corpusDir) {
    return { note: `no corpus archive configured — listing this project's local runs only; set ${CORPUS_KEY_HINT} to keep records beyond the worktree` };
  }
  if (!existsSync(corpusDir)) {
    return { corpusDir, note: `corpus dir ${corpusDir} does not exist — the mirror has been silently off; create it (${CORPUS_KEY_HINT})` };
  }
  return { corpusDir };
}

interface GatheredRecord {
  state: RunState;
  runDir: string;
  source: 'corpus' | 'local';
}

/**
 * The merged record set: corpus records first, then the local `.duet/runs`
 * scan, deduped by runId (the corpus copy wins — it is the durable one),
 * newest first. Unloadable records count into `skipped` on both sides.
 */
function gatherRecords(cwd: string, corpusDir: string | undefined): { records: GatheredRecord[]; skipped: number } {
  const byRunId = new Map<string, GatheredRecord>();
  let skipped = 0;
  if (corpusDir && existsSync(corpusDir)) {
    for (const entry of readdirSync(corpusDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(corpusDir, entry.name);
      if (!existsSync(join(dir, 'state.json'))) continue;
      try {
        const state = loadRunStateFromDir(dir);
        if (!byRunId.has(state.runId)) byRunId.set(state.runId, { state, runDir: dir, source: 'corpus' });
      } catch {
        skipped += 1; // a refused era or foreign record — skip with a count, never abort
      }
    }
  }
  const local = scanRuns(cwd);
  skipped += local.unloadable.length;
  for (const state of local.runs) {
    if (!byRunId.has(state.runId)) byRunId.set(state.runId, { state, runDir: runDirOf(cwd, state.runId), source: 'local' });
  }
  const records = [...byRunId.values()].sort((a, b) => b.state.createdAt.localeCompare(a.state.createdAt));
  return { records, skipped };
}

/**
 * Whether a record belongs to the checkout at `self.cwd`. A stamped record
 * matches on the durable identity — same primary-checkout root (every worktree
 * of one project derives the same root), or same origin remote (two clones of
 * one project) — compared against this checkout's own derived identity. An
 * unstamped record (pre-stamp era, a git-less project) falls back to cwd
 * equality, which also covers the degenerate case where the current dir
 * derives no identity. Pure — both identities are derived by the caller.
 */
export function matchesRepo(
  record: { cwd: string; repo?: RepoIdentity },
  self: { cwd: string; identity?: RepoIdentity },
): boolean {
  if (record.repo && self.identity) {
    if (record.repo.root === self.identity.root) return true;
    if (record.repo.remote !== undefined && record.repo.remote === self.identity.remote) return true;
  }
  return record.cwd === self.cwd;
}

/**
 * The framing's display title: the first markdown heading of the body (the
 * frontmatter comes off through the real parser, `parseFramingFile` — never a
 * hand-rolled regex), else the body's first non-empty line. A framing whose
 * frontmatter no longer parses degrades to scanning the raw content rather
 * than failing the listing.
 */
export function framingTitle(content: string): string | undefined {
  let body: string;
  try {
    body = parseFramingFile(content).body;
  } catch {
    body = content;
  }
  let firstNonEmpty: string | undefined;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const heading = /^#{1,6}\s+(\S.*)$/.exec(trimmed);
    if (heading) return heading[1]!.trim();
    firstNonEmpty ??= trimmed;
  }
  return firstNonEmpty;
}

function toRecordModel({ state, runDir, source }: GatheredRecord): FramingRecordModel {
  const framingPath = join(runDir, 'framing.md');
  let title: string | undefined;
  try {
    if (existsSync(framingPath)) title = framingTitle(readFileSync(framingPath, 'utf8'));
  } catch {
    // An unreadable framing leaves the title absent — it never breaks the list.
  }
  return {
    runId: state.runId,
    createdAt: state.createdAt,
    workflow: state.workflow,
    cwd: state.cwd,
    ...(state.repo ? { repo: state.repo } : {}),
    source,
    runDir,
    ...(title !== undefined ? { title } : {}),
  };
}

/** Build the `duet framings` model. `configPath` is injectable for tests; the CLI takes the account default. */
export function buildFramingsModel(cwd: string, opts: { all?: boolean; configPath?: string } = {}): FramingsModel {
  const { corpusDir, note } = resolveCorpus(opts.configPath);
  const { records, skipped } = gatherRecords(cwd, corpusDir);
  // Self-identity is derived only when scoping — `--all` skips the git probe.
  const scoped = opts.all
    ? records
    : (() => {
        const self = { cwd, identity: deriveRepoIdentity(cwd) };
        return records.filter((r) => matchesRepo({ cwd: r.state.cwd, ...(r.state.repo ? { repo: r.state.repo } : {}) }, self));
      })();
  return {
    scope: opts.all ? 'all' : 'repo',
    ...(corpusDir ? { corpusDir } : {}),
    ...(note ? { note } : {}),
    skipped,
    records: scoped.map(toRecordModel),
  };
}

/**
 * `duet framings show <runId>` — the archived framing, verbatim (the caller
 * writes the exact bytes to stdout: no color, no added newline — it is for
 * piping and reference). Searches the same merged set the list draws from,
 * unscoped — an explicit run id is its own scope — with the corpus copy
 * winning as in the list.
 */
export function readArchivedFraming(
  cwd: string,
  runId: string,
  opts: { configPath?: string } = {},
): { content: string } | { error: string } {
  const { corpusDir } = resolveCorpus(opts.configPath);
  const record = gatherRecords(cwd, corpusDir).records.find((r) => r.state.runId === runId);
  if (!record) {
    return { error: `no record of run ${runId} in the corpus archive or this project's .duet/runs — duet framings --all lists every known record` };
  }
  const path = join(record.runDir, 'framing.md');
  if (!existsSync(path)) {
    return { error: `run ${runId} archived no framing.md (a spec-entry run records none)` };
  }
  try {
    return { content: readFileSync(path, 'utf8') };
  } catch (err) {
    return { error: `could not read ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** `$HOME` → `~` for a rendered path — view-time only; the JSON model keeps raw paths. */
export function shortenHome(path: string, home: string = homedir()): string {
  if (path === home) return '~';
  return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/** The human listing: a summary line, the fail-soft notes, then one aligned row per record. */
export function renderFramingsList(model: FramingsModel, home: string = homedir()): string {
  const lines: string[] = [];
  const scopeLabel = model.scope === 'repo' ? "this repo's records (--all for every record)" : 'all records';
  const sourceLabel = model.corpusDir ? `corpus ${shortenHome(model.corpusDir, home)} + local .duet/runs` : 'local .duet/runs only';
  lines.push(`${model.records.length} framing record(s) — ${scopeLabel}; ${sourceLabel}`);
  if (model.note) lines.push(model.note);
  if (model.skipped > 0) lines.push(`(${model.skipped} record(s) skipped — refused era or foreign dir)`);
  if (model.records.length === 0) return lines.join('\n');

  const rows = model.records.map((r) => ({
    runId: r.runId,
    created: localStamp(r.createdAt),
    workflow: r.workflow,
    repo: shortenHome(r.repo?.root ?? r.cwd, home),
    title: r.title ?? '(no framing)',
  }));
  const width = (header: string, values: string[]): number => Math.max(header.length, ...values.map((v) => v.length));
  const w = {
    runId: width('run', rows.map((r) => r.runId)),
    created: width('created', rows.map((r) => r.created)),
    workflow: width('workflow', rows.map((r) => r.workflow)),
    repo: width('repo', rows.map((r) => r.repo)),
  };
  lines.push('');
  lines.push(`${'run'.padEnd(w.runId)}  ${'created'.padEnd(w.created)}  ${'workflow'.padEnd(w.workflow)}  ${'repo'.padEnd(w.repo)}  title`);
  for (const r of rows) {
    const title = r.title.length > 72 ? `${r.title.slice(0, 71)}…` : r.title;
    lines.push(`${r.runId.padEnd(w.runId)}  ${r.created.padEnd(w.created)}  ${r.workflow.padEnd(w.workflow)}  ${r.repo.padEnd(w.repo)}  ${title}`);
  }
  lines.push('');
  lines.push('read one verbatim: duet framings show <runId>');
  return lines.join('\n');
}

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PhaseName } from '../registry/workflows.ts';
import { appendVoiceLog, runDirOf } from './store.ts';
import type { RunState } from './store.ts';

/**
 * The steer store — the human's mid-phase notes (`greenflag steer`), staged for
 * delivery to the orchestrator. A different crash contract from `state.json`:
 * append-once, deliver-by-rename. Steers live OUTSIDE state.json because they
 * arrive while a driver is live and holds its in-memory RunState (saving at
 * every tool call), so a CLI write into the state file would race those saves
 * and get clobbered. One file per steer under `steers/`; consuming renames into
 * `steers/delivered/` — append and drain never collide. Needs only
 * `runDirOf`/`appendVoiceLog` from the run store, hence its own module.
 */
export interface Steer {
  /** Filename under steers/ — the rename handle. Lexicographic = staging order. */
  file: string;
  /** The human's words, verbatim. */
  text: string;
  stagedAt: string;
  /** Best-effort provenance: the phase that was running (or down) at staging time. */
  stagedDuring?: PhaseName;
}

function steersDir(state: RunState): string {
  return join(runDirOf(state.cwd, state.runId), 'steers');
}

/**
 * Stage a steer: an atomic file create (`wx` — never clobbers), logged into
 * the orchestrator voice log so staging is auditable end to end. The name's
 * hrtime suffix keeps same-millisecond stages in order within a process;
 * across processes the timestamp's resolution is already the ordering.
 */
export function stageSteer(state: RunState, text: string, stagedDuring?: PhaseName): Steer {
  const dir = steersDir(state);
  mkdirSync(dir, { recursive: true });
  const stagedAt = new Date().toISOString();
  const stamp = stagedAt.replace(/[-:]/g, '');
  const file = `${stamp}-${String(process.hrtime.bigint()).padStart(20, '0')}.json`;
  const body = { text, stagedAt, ...(stagedDuring ? { stagedDuring } : {}) };
  const steer: Steer = { file, ...body };
  writeFileSync(join(dir, file), JSON.stringify(body, null, 2) + '\n', { flag: 'wx' });
  appendVoiceLog(state, 'orchestrator', `human steer staged${stagedDuring ? ` (during ${stagedDuring})` : ''}`, text);
  return steer;
}

/** Undelivered steers in staging order. Unparseable files are skipped, like listRuns skips corrupt run dirs. */
export function listPendingSteers(state: RunState): Steer[] {
  const dir = steersDir(state);
  if (!existsSync(dir)) return [];
  const steers: Steer[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const body = JSON.parse(readFileSync(join(dir, entry.name), 'utf8')) as Omit<Steer, 'file'>;
      steers.push({ file: entry.name, ...body });
    } catch {
      // Half-written or foreign file — skip rather than break delivery.
    }
  }
  return steers.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Every staged steer this run has seen — BOTH the undelivered ones (`steers/`)
 * and the already-delivered audit trail (`steers/delivered/`), in staging order.
 * The trace's history reader: unlike `listPendingSteers` (staging only), a "what
 * happened" timeline must include a steer that was already consumed. Fail-soft
 * (a missing dir, an unparseable file, or valid JSON of the WRONG SHAPE is
 * skipped, never thrown) and tolerant of a mid-scan delivery rename: a file that
 * moves between the two dirs while we read appears once (deduped by filename) or
 * neither (skipped on ENOENT), never twice. Shape validation matters because the
 * trace derives `Date.parse(stagedAt)` and renders it — a `NaN` stamp would throw
 * at render; a malformed steer is dropped here instead. Scoped to this reader:
 * `listPendingSteers` (the live delivery path) is deliberately left untouched.
 */
function isValidSteerBody(body: unknown): body is Omit<Steer, 'file'> {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.text === 'string' &&
    typeof b.stagedAt === 'string' &&
    !Number.isNaN(Date.parse(b.stagedAt)) &&
    (b.stagedDuring === undefined || typeof b.stagedDuring === 'string')
  );
}

export function listStagedSteersForTrace(state: RunState): Steer[] {
  const dir = steersDir(state);
  const steers: Steer[] = [];
  const seen = new Set<string>();
  // Staging first, then delivered — a file that renamed staging→delivered mid-scan
  // is missed in staging (ENOENT on read) and picked up in the delivered pass.
  for (const scanDir of [dir, join(dir, 'delivered')]) {
    if (!existsSync(scanDir)) continue;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(scanDir, { withFileTypes: true });
    } catch {
      continue; // the dir vanished between existsSync and readdir — skip, don't throw
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || seen.has(entry.name)) continue;
      try {
        const body: unknown = JSON.parse(readFileSync(join(scanDir, entry.name), 'utf8'));
        if (!isValidSteerBody(body)) continue; // valid JSON, wrong shape — skip (a NaN stamp would throw at render)
        steers.push({ file: entry.name, ...body });
        seen.add(entry.name);
      } catch {
        // Half-written, foreign, or moved mid-scan — skip rather than break the trace.
      }
    }
  }
  return steers.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Consume delivered steers: rename into steers/delivered/ (kept, not deleted —
 * the audit trail). ENOENT is swallowed: the orchestrator may issue tool
 * calls in parallel, and a steer the other drain already moved is delivered,
 * not missing.
 */
export function markSteersDelivered(state: RunState, steers: Steer[]): void {
  const dir = steersDir(state);
  const delivered = join(dir, 'delivered');
  mkdirSync(delivered, { recursive: true });
  for (const steer of steers) {
    try {
      renameSync(join(dir, steer.file), join(delivered, steer.file));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { phasesOf } from './phases.ts';
import type { PhaseName } from './phases.ts';
import { workerRolesFor } from './roles.ts';
import { runDirOf, workflowOf } from './run-store.ts';
import type { RunState, Voice } from './run-store.ts';
import { formatDuration } from './timefmt.ts';

/**
 * `duet stats` — effort per phase, derived at VIEW TIME from the voice logs (the
 * truth), never from new run-state and never through the status model (status
 * stays cheap and `.duet/`-local; this reaches into the logs like `doctor`
 * reaches into transcripts). Two derivations:
 *
 *  - phase windows from the orchestrator log: `◀ harness prompt (phase=X)` opens
 *    a window, `advance_phase (X)` closes it. A phase re-entered after a gate
 *    reject opens a fresh window, so its windows SUM and the gate-wait between an
 *    advance and the next re-entry is excluded; a flag-then-resume keeps the first
 *    open (the flag-wait inside one window is a small known overcount).
 *  - worker turns from each worker log: `◀ prompt (tag=Y)` to the next terminal
 *    line (`▶ response` / a budget stop / a turn failure), attributed to the phase
 *    whose window contains the turn's start.
 *
 * Fail-soft like `doctor`: a missing or interactive-only log degrades to a note,
 * never a thrown command. The parse core is pure (operates on log strings) so it
 * is testable without the filesystem; `buildStatsModel` is the thin fs composer.
 */

// The voice-log markers, anchored on the full ISO stamp `appendVoiceLog` writes
// (src/run-store.ts) so a prompt body line can't masquerade as a header.
const TS = String.raw`\[(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)\]`;
const PHASE_OPEN = new RegExp(`^${TS} ◀ harness prompt \\(phase=(\\w+)\\)`);
const PHASE_CLOSE = new RegExp(`^${TS} advance_phase \\((\\w+)\\)`);
const TURN_START = new RegExp(`^${TS} ◀ prompt \\(tag=([^,)]+)`);
const TURN_END = new RegExp(`^${TS} (?:▶ response|◼ budget-control stop|✗ turn failed)`);

interface Window {
  phase: string;
  startMs: number;
  endMs: number;
}
interface Turn {
  tag: string;
  startMs: number;
  endMs: number;
}

export interface PhaseStat {
  phase: string;
  /** Summed orchestration windows for this phase (gate-reject re-entries add up). */
  windowMs: number;
  /** Summed worker-turn time attributed to this phase. */
  workerMs: number;
  /** Worker turns attributed to this phase. */
  turns: number;
}
export interface TagStat {
  tag: string;
  totalMs: number;
  turns: number;
}
export interface StatsModel {
  runId: string;
  /** Phases that ran, in arc order (any unknown-to-the-arc phase appended after). */
  phases: PhaseStat[];
  /** Worker turns aggregated by snippet tag, longest first. */
  tags: TagStat[];
  totalWindowMs: number;
  /** Fail-soft degradation notes (missing log, interactive run, unattributed turns). */
  notes: string[];
}

/** Parse the orchestrator log into phase windows. `sawOpen` distinguishes "no
 *  headless phases" (an interactive run) from "no log". */
function parsePhaseWindows(log: string): { windows: Window[]; sawOpen: boolean } {
  const windows: Window[] = [];
  const openByPhase = new Map<string, number>();
  let sawOpen = false;
  for (const line of log.split('\n')) {
    const open = PHASE_OPEN.exec(line);
    if (open) {
      sawOpen = true;
      const ms = Date.parse(open[1]!);
      // First open of a still-open phase wins: a flag-then-resume re-logs the
      // header, but the window is from the original entry to the advance.
      if (!Number.isNaN(ms) && !openByPhase.has(open[2]!)) openByPhase.set(open[2]!, ms);
      continue;
    }
    const close = PHASE_CLOSE.exec(line);
    if (close) {
      const phase = close[2]!;
      const start = openByPhase.get(phase);
      const ms = Date.parse(close[1]!);
      if (start !== undefined && !Number.isNaN(ms) && ms >= start) {
        windows.push({ phase, startMs: start, endMs: ms });
        openByPhase.delete(phase); // a later re-entry opens a fresh window
      }
    }
  }
  return { windows, sawOpen };
}

/**
 * Parse one worker log into completed turns (start → next terminal line).
 * `dangling` counts prompts left without a terminal line — an in-flight turn (the
 * log read mid-turn) or a truncated log; the caller notes it rather than letting
 * the turn silently vanish from the totals.
 */
function parseTurns(log: string): { turns: Turn[]; dangling: number } {
  const turns: Turn[] = [];
  let pending: { tag: string; startMs: number } | undefined;
  let dangling = 0;
  for (const line of log.split('\n')) {
    const start = TURN_START.exec(line);
    if (start) {
      // A new prompt with a prior turn still open means that turn never logged a
      // terminal line (the log ended mid-turn) — count it as dangling, not dropped.
      if (pending) dangling++;
      const ms = Date.parse(start[1]!);
      pending = Number.isNaN(ms) ? undefined : { tag: start[2]!, startMs: ms };
      continue;
    }
    const end = TURN_END.exec(line);
    if (end && pending) {
      const ms = Date.parse(end[1]!);
      if (!Number.isNaN(ms) && ms >= pending.startMs) turns.push({ tag: pending.tag, startMs: pending.startMs, endMs: ms });
      pending = undefined;
    }
  }
  if (pending) dangling++; // open at EOF — in flight, or the log ends mid-turn
  return { turns, dangling };
}

/**
 * Assemble the stats model from already-read log strings — the pure core. The
 * orchestrator log may be undefined (no log). Each worker is role-tagged so a
 * missing-but-EXPECTED log (`log` undefined) becomes a note rather than a silent
 * undercount, and a role's in-flight/truncated turns are named; the composer
 * decides which absent logs are expected (it omits never-run workers entirely).
 * `arcOrder` is the workflow's phase order for the display sort.
 */
export function buildStats(
  runId: string,
  orchestratorLog: string | undefined,
  workers: Array<{ role: string; log?: string }>,
  arcOrder: readonly PhaseName[],
): StatsModel {
  const notes: string[] = [];
  const { windows, sawOpen } = orchestratorLog ? parsePhaseWindows(orchestratorLog) : { windows: [], sawOpen: false };
  if (orchestratorLog === undefined) notes.push('no orchestrator log yet — phase windows unavailable.');
  else if (!sawOpen) notes.push('no headless phase windows found — this run may have been orchestrated interactively.');

  const turns: Turn[] = [];
  for (const { role, log } of workers) {
    if (log === undefined) {
      notes.push(`${role} log missing — its turns aren't counted.`);
      continue;
    }
    const parsed = parseTurns(log);
    turns.push(...parsed.turns);
    if (parsed.dangling > 0) {
      notes.push(`${role}: ${parsed.dangling} turn(s) still open (in flight, or a truncated log) — not counted.`);
    }
  }

  const windowMs = new Map<string, number>();
  for (const w of windows) windowMs.set(w.phase, (windowMs.get(w.phase) ?? 0) + (w.endMs - w.startMs));

  const workerMs = new Map<string, number>();
  const turnCount = new Map<string, number>();
  const tagAgg = new Map<string, { totalMs: number; turns: number }>();
  let unattributed = 0;
  for (const t of turns) {
    const dur = t.endMs - t.startMs;
    const phase = windows.find((w) => t.startMs >= w.startMs && t.startMs <= w.endMs)?.phase;
    if (phase) {
      workerMs.set(phase, (workerMs.get(phase) ?? 0) + dur);
      turnCount.set(phase, (turnCount.get(phase) ?? 0) + 1);
    } else {
      unattributed++;
    }
    const tg = tagAgg.get(t.tag) ?? { totalMs: 0, turns: 0 };
    tg.totalMs += dur;
    tg.turns += 1;
    tagAgg.set(t.tag, tg);
  }
  if (unattributed > 0) {
    notes.push(`${unattributed} worker turn(s) fell outside any phase window (a phase still in progress) — counted under tags, not a phase.`);
  }

  // Phases in arc order first, then any phase the log named that the current arc
  // doesn't (e.g. a run started before an arc change) in first-seen order.
  const seen = [...windowMs.keys()];
  const ordered = [...arcOrder.filter((p) => windowMs.has(p)), ...seen.filter((p) => !arcOrder.includes(p as PhaseName))];
  const phases: PhaseStat[] = ordered.map((phase) => ({
    phase,
    windowMs: windowMs.get(phase) ?? 0,
    workerMs: workerMs.get(phase) ?? 0,
    turns: turnCount.get(phase) ?? 0,
  }));
  const tags: TagStat[] = [...tagAgg.entries()]
    .map(([tag, v]) => ({ tag, totalMs: v.totalMs, turns: v.turns }))
    .sort((a, b) => b.totalMs - a.totalMs);
  const totalWindowMs = phases.reduce((sum, p) => sum + p.windowMs, 0);
  return { runId, phases, tags, totalWindowMs, notes };
}

/** The fs composer: read the voice logs for a run and build the model. */
export function buildStatsModel(state: RunState): StatsModel {
  const dir = runDirOf(state.cwd, state.runId);
  const read = (voice: Voice): string | undefined => {
    const path = join(dir, `${voice}.log`);
    if (!existsSync(path)) return undefined;
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined; // fail-soft: a disappearing log degrades to a note, never throws
    }
  };
  // A worker with a session but no log is an EXPECTED-missing log (a real
  // undercount → buildStats notes it); a never-prompted worker (no session) is
  // simply absent and omitted, so the note fires only when it means something.
  const workers = workerRolesFor(state).flatMap((role) => {
    const log = read(role);
    if (log !== undefined) return [{ role, log }];
    return state.workerSessions[role] ? [{ role }] : [];
  });
  const arcOrder = phasesOf(workflowOf(state)).map((p) => p.name);
  return buildStats(state.runId, read('orchestrator'), workers, arcOrder);
}

/** The human one-screen render — a phase table, a tag breakdown, and any notes. */
export function renderStats(model: StatsModel): string {
  const lines: string[] = [];
  lines.push(`\n━━━ duet stats ${model.runId} ━━━`);
  if (model.phases.length === 0) {
    lines.push('no phase activity recorded yet.');
  } else {
    lines.push(`  ${'phase'.padEnd(10)} ${'elapsed'.padEnd(9)} worker (turns)`);
    for (const p of model.phases) {
      lines.push(`  ${p.phase.padEnd(10)} ${formatDuration(p.windowMs).padEnd(9)} ${formatDuration(p.workerMs)} (${p.turns})`);
    }
    lines.push(`  ${'total'.padEnd(10)} ${formatDuration(model.totalWindowMs)}`);
  }
  if (model.tags.length > 0) {
    lines.push('\nby tag:');
    for (const t of model.tags) {
      lines.push(`  ${t.tag.padEnd(26)} ${formatDuration(t.totalMs)} (${t.turns})`);
    }
  }
  for (const note of model.notes) lines.push(`\nnote: ${note}`);
  return lines.join('\n');
}

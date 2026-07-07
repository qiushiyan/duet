import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CLAUDE_MODEL, voiceBindingFor } from '../voices/bindings.ts';
import type { VoiceBindings } from '../voices/bindings.ts';
import { DUTIES, makerDutyOf, phasesOf, stageOf, stageOfDutyLane } from '../registry/workflows.ts';
import type { Duty, PhaseName, WorkflowRef } from '../registry/workflows.ts';
import { countsReviewRound, sessionKeyFor, voicesFor } from '../voices/policy.ts';
import { runDirOf } from '../run/store.ts';
import type { RunState, Voice } from '../run/store.ts';
import { workflowFor } from '../run/workflow.ts';
import { probeRunPosition } from '../run/position.ts';
import type { RunPosition } from '../run/position.ts';
import { listStagedSteersForTrace } from '../run/steers.ts';
import type { VoiceAddress } from '../voices/providers/types.ts';
import { formatDuration, localTime } from '../view/timefmt.ts';
import {
  HEARTBEAT_LINE,
  PHASE_CLOSE_LINE,
  PHASE_OPEN_LINE,
  TURN_END_LINE,
  TURN_START_LINE,
} from '../run/voice-log.ts';

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

export interface PhaseWindow {
  phase: string;
  startMs: number;
  endMs: number;
  inferred?: true;
}
export type TurnStatus = 'ok' | 'budget' | 'failed' | 'timeout';

export interface ParsedTurn {
  voice: string;
  tag: string;
  startMs: number;
  endMs: number;
  status: TurnStatus;
  terminal: string;
}

export interface PhaseStat {
  phase: string;
  /** Summed orchestration windows for this phase (gate-reject re-entries add up). */
  windowMs: number;
  /** Summed worker-turn time attributed to this phase. */
  workerMs: number;
  /** Worker turns attributed to this phase. */
  turns: number;
  /**
   * The maker model that ran this phase (the per-phase model dimension the
   * corpus timing needs) — re-derived from the run's frozen bindings by the
   * same pure resolver, so it needs no new recorded state. Absent for a phase
   * outside the run's workflow (no confident resolution); a codex maker labels
   * as "codex".
   */
  makerModel?: string;
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
 *  headless phases" (an interactive run) from "no log"; `inferred` counts the
 *  windows synthesized from a bare gate crossing (below). */
export function parsePhaseWindows(
  log: string,
  runStartMs = 0,
  /**
   * When set, ALSO emit the OPEN window for the still-running current phase (no
   * `advance_phase` closes it yet), so a live trace attributes its turns instead
   * of orphaning them. Its start is real for a headless phase (the recorded
   * `◀`-open), inferred for an interactive one (`lastClose ?? runStartMs`, exactly
   * as closed interactive windows infer); its end is the injected `now` (tests
   * pass a fixed clock — no wall-clock read here). The aggregate `stats` path
   * omits this, so its behavior is byte-for-byte unchanged.
   */
  open?: { now: number; currentPhase: string },
): { windows: PhaseWindow[]; sawOpen: boolean; inferred: number } {
  const windows: PhaseWindow[] = [];
  const openByPhase = new Map<string, number>();
  let sawOpen = false;
  let inferred = 0;
  // The end of the last closed window — the inferred start of a phase whose
  // entry was never logged (below). The run's creation time floors the first
  // such window, so its elapsed span is honest, not epoch-anchored.
  let lastCloseMs: number | undefined;
  for (const line of log.split('\n')) {
    const open = PHASE_OPEN_LINE.exec(line);
    if (open) {
      sawOpen = true;
      const ms = Date.parse(open[1]!);
      // First open of a still-open phase wins: a flag-then-resume re-logs the
      // header, but the window is from the original entry to the advance.
      if (!Number.isNaN(ms) && !openByPhase.has(open[2]!)) openByPhase.set(open[2]!, ms);
      continue;
    }
    const close = PHASE_CLOSE_LINE.exec(line);
    if (close) {
      const phase = close[2]!;
      const ms = Date.parse(close[1]!);
      if (Number.isNaN(ms)) continue;
      let start = openByPhase.get(phase);
      // A close with no open: the phase ran on the INTERACTIVE host, whose tool
      // events voice-log the advance but no harness-prompt header. The phases
      // are sequential, so the crossing that ended the previous phase bounds
      // this one from below — infer the window from there (from the beginning
      // of time for the run's first phase), so the phase's worker turns
      // attribute instead of orphaning. Elapsed spans stay approximate; the
      // caller notes it.
      const wasInferred = start === undefined;
      if (wasInferred) {
        start = lastCloseMs ?? runStartMs;
        inferred++;
      }
      const startMs = start;
      if (startMs !== undefined && ms >= startMs) {
        windows.push({ phase, startMs, endMs: ms, ...(wasInferred ? { inferred: true } : {}) });
        openByPhase.delete(phase); // a later re-entry opens a fresh window
        lastCloseMs = ms;
      }
    }
  }
  // The open current-phase window (P1b): the phase that never logged a close. Its
  // start is the recorded headless open when present (real), else inferred from
  // the last close / run start (an interactively-orchestrated phase logs no entry
  // header). End = the injected now. Emitted last, so a turn attributes to an
  // earlier closed window first (the shared phaseForTurn rule).
  if (open) {
    const headlessStart = openByPhase.get(open.currentPhase);
    const wasInferred = headlessStart === undefined;
    const startMs = headlessStart ?? lastCloseMs ?? runStartMs;
    if (open.now >= startMs) {
      windows.push({ phase: open.currentPhase, startMs, endMs: open.now, ...(wasInferred ? { inferred: true } : {}) });
      if (wasInferred) inferred++;
    }
  }
  return { windows, sawOpen, inferred };
}

/**
 * Parse one worker log into completed turns (start → next terminal line).
 * `dangling` counts prompts left without a terminal line — an in-flight turn (the
 * log read mid-turn) or a truncated log; the caller notes it rather than letting
 * the turn silently vanish from the totals.
 */
function statusForTerminal(marker: string, detail: string | undefined): TurnStatus {
  if (marker.startsWith('▶')) return 'ok';
  if (marker.startsWith('◼')) return 'budget';
  // A `⚠` abort is a resumable cut — wall-clock cap, context cap, or an aborted
  // `/compact` — none of which arrive as `✗ turn failed`, so they land here.
  if (marker.startsWith('⚠')) return 'timeout';
  // Word-boundaried so "timed out"/"timeout" match but "runtime"/"timestamp" don't.
  return /timed?[\s-]?out/i.test(detail ?? marker) ? 'timeout' : 'failed';
}

export function parseVoiceLogTurns(voice: string, log: string): { turns: ParsedTurn[]; dangling: number } {
  const turns: ParsedTurn[] = [];
  let pending: { tag: string; startMs: number } | undefined;
  let dangling = 0;
  for (const line of log.split('\n')) {
    const start = TURN_START_LINE.exec(line);
    if (start) {
      // A new prompt with a prior turn still open means that turn never logged a
      // terminal line (the log ended mid-turn) — count it as dangling, not dropped.
      if (pending) dangling++;
      const ms = Date.parse(start[1]!);
      pending = Number.isNaN(ms) ? undefined : { tag: start[2]!, startMs: ms };
      continue;
    }
    const end = TURN_END_LINE.exec(line);
    if (end && pending) {
      const ms = Date.parse(end[1]!);
      if (!Number.isNaN(ms) && ms >= pending.startMs) {
        turns.push({
          voice,
          tag: pending.tag,
          startMs: pending.startMs,
          endMs: ms,
          status: statusForTerminal(end[2]!, end[3]),
          terminal: end[2]!,
        });
      }
      pending = undefined;
    }
  }
  if (pending) dangling++; // open at EOF — in flight, or the log ends mid-turn
  return { turns, dangling };
}

export function unionDurationMs(intervals: Array<{ startMs: number; endMs: number }>): number {
  const sorted = intervals
    .filter((i) => Number.isFinite(i.startMs) && Number.isFinite(i.endMs) && i.endMs >= i.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  let total = 0;
  let open: { startMs: number; endMs: number } | undefined;
  for (const interval of sorted) {
    if (!open) {
      open = { ...interval };
      continue;
    }
    if (interval.startMs <= open.endMs) {
      open.endMs = Math.max(open.endMs, interval.endMs);
      continue;
    }
    total += open.endMs - open.startMs;
    open = { ...interval };
  }
  if (open) total += open.endMs - open.startMs;
  return total;
}

export interface TurnGap {
  startMs: number;
  endMs: number;
  durationMs: number;
  before: ParsedTurn;
  after: ParsedTurn;
}

export function gapsBetweenTurns(turns: readonly ParsedTurn[], thresholdMs: number): TurnGap[] {
  const sorted = [...turns].sort((a, b) => a.startMs - b.startMs);
  const gaps: TurnGap[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const before = sorted[i - 1]!;
    const after = sorted[i]!;
    const durationMs = after.startMs - before.endMs;
    if (durationMs >= thresholdMs) gaps.push({ startMs: before.endMs, endMs: after.startMs, durationMs, before, after });
  }
  return gaps;
}

export interface Heartbeat {
  atMs: number;
  elapsedMinutes: number;
}

/**
 * Parse the `⏳ … Nm elapsed` heartbeat cadence out of a log. Reads from a
 * voice log, whose heartbeats carry the ISO stamp `HEARTBEAT_LINE` anchors on — the
 * driver log's copy is `[send_prompt]`-prefixed with no stamp, so it never
 * matches. Same 5-minute interval either way, so the worker log is the honest
 * (and parseable) source for "how many heartbeats fired inside this turn".
 */
export function parseHeartbeats(log: string): Heartbeat[] {
  const heartbeats: Heartbeat[] = [];
  for (const line of log.split('\n')) {
    const match = HEARTBEAT_LINE.exec(line);
    if (!match) continue;
    const atMs = Date.parse(match[1]!);
    const elapsedMinutes = Number(match[2]);
    if (!Number.isNaN(atMs) && Number.isFinite(elapsedMinutes)) heartbeats.push({ atMs, elapsedMinutes });
  }
  return heartbeats;
}

export function heartbeatCountBetween(heartbeats: readonly Heartbeat[], startMs: number, endMs: number): number {
  return heartbeats.filter((h) => h.atMs >= startMs && h.atMs <= endMs).length;
}

/**
 * The one turn→phase attribution rule, shared by `buildStats` and the corpus
 * scripts so their numbers can't drift: a turn belongs to the FIRST window
 * (chronological push order) whose closed span contains its start, so a turn
 * that starts on a shared window boundary attributes once, to the earlier phase.
 */
export function phaseForTurn(windows: readonly PhaseWindow[], startMs: number): string | undefined {
  return windows.find((w) => startMs >= w.startMs && startMs <= w.endMs)?.phase;
}

/**
 * Assemble the stats model from already-read log strings — the pure core. The
 * orchestrator log may be undefined (no log). Each worker is voice-tagged so a
 * missing-but-EXPECTED log (`log` undefined) becomes a note rather than a silent
 * undercount, and a voice's in-flight/truncated turns are named; the composer
 * decides which absent logs are expected (it omits never-run workers entirely).
 * `arcOrder` is the workflow's phase order for the display sort.
 */
export function buildStats(
  runId: string,
  orchestratorLog: string | undefined,
  workers: Array<{ voice: string; log?: string }>,
  arcOrder: readonly PhaseName[],
  /** The maker model that ran a phase — the composer supplies the resolver; default (none) keeps the aggregate rows unlabeled. */
  makerModelForPhase: (phase: string) => string | undefined = () => undefined,
  /** The run's creation time — floors the first inferred window (interactive phases log no entry header). */
  runStartMs = 0,
): StatsModel {
  const notes: string[] = [];
  const { windows, sawOpen, inferred } = orchestratorLog
    ? parsePhaseWindows(orchestratorLog, runStartMs)
    : { windows: [], sawOpen: false, inferred: 0 };
  if (orchestratorLog === undefined) notes.push('no orchestrator log yet — phase windows unavailable.');
  else if (!sawOpen && windows.length === 0) notes.push('no headless phase windows found — this run may have been orchestrated interactively.');
  if (inferred > 0) {
    notes.push(`${inferred} phase window(s) inferred from gate crossings (interactively orchestrated phases log no entry header) — those elapsed spans are approximate.`);
  }

  const turns: ParsedTurn[] = [];
  for (const { voice, log } of workers) {
    if (log === undefined) {
      notes.push(`${voice} log missing — its turns aren't counted.`);
      continue;
    }
    const parsed = parseVoiceLogTurns(voice, log);
    turns.push(...parsed.turns);
    if (parsed.dangling > 0) {
      notes.push(`${voice}: ${parsed.dangling} turn(s) still open (in flight, or a truncated log) — not counted.`);
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
    const phase = phaseForTurn(windows, t.startMs);
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
  const phases: PhaseStat[] = ordered.map((phase) => {
    const makerModel = makerModelForPhase(phase);
    return {
      phase,
      windowMs: windowMs.get(phase) ?? 0,
      workerMs: workerMs.get(phase) ?? 0,
      turns: turnCount.get(phase) ?? 0,
      ...(makerModel !== undefined ? { makerModel } : {}),
    };
  });
  const tags: TagStat[] = [...tagAgg.entries()]
    .map(([tag, v]) => ({ tag, totalMs: v.totalMs, turns: v.turns }))
    .sort((a, b) => b.totalMs - a.totalMs);
  const totalWindowMs = phases.reduce((sum, p) => sum + p.windowMs, 0);
  return { runId, phases, tags, totalWindowMs, notes };
}

/**
 * The maker model label for a phase — the stage's maker duty looked up in the
 * frozen manifest: its model when set, or the provider name ("codex") when the
 * binding defers to provider config. The single view-time reuse of
 * `voiceBindingFor` for the stats column, so the label can never drift from
 * what actually ran.
 */
function makerModelLabel(bindings: VoiceBindings, workflow: WorkflowRef, phase: PhaseName): string {
  const binding = voiceBindingFor(bindings, makerDutyOf(workflow, stageOf(workflow, phase)));
  const model = binding.provider === 'claude' ? binding.model ?? DEFAULT_CLAUDE_MODEL : binding.model ?? binding.provider;
  return binding.effort ? `${model}@${binding.effort}` : model;
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
  const hasSession = (voice: VoiceAddress): boolean =>
    Boolean(voice === 'consultant' ? state.sessions['consultant'] : state.sessions[sessionKeyFor(voice)]);
  const workflow = workflowFor(state);
  const workers = voicesFor(state)
    .filter((v): v is VoiceAddress => v !== 'orchestrator')
    .flatMap((voice) => {
      const log = read(voice);
      if (log !== undefined) return [{ voice, log }];
      return hasSession(voice) ? [{ voice }] : [];
    });
  const phaseOrder = phasesOf(workflow).map((p) => p.name);
  // Label only phases of THIS run's workflow — a foreign phase (a run predating
  // a workflow change) has no confident resolution, so it stays unlabeled rather
  // than force the labeler to resolve a phase its workflow doesn't own.
  const ownPhases = new Set<string>(phaseOrder);
  const runStartMs = Date.parse(state.createdAt);
  return buildStats(
    state.runId,
    read('orchestrator'),
    workers,
    phaseOrder,
    (phase) => (ownPhases.has(phase) ? makerModelLabel(state.bindings, workflow, phase as PhaseName) : undefined),
    Number.isNaN(runStartMs) ? 0 : runStartMs,
  );
}

/** The human one-screen render — a phase table, a tag breakdown, and any notes. */
export function renderStats(model: StatsModel): string {
  const lines: string[] = [];
  lines.push(`\n━━━ duet stats ${model.runId} ━━━`);
  if (model.phases.length === 0) {
    lines.push('no phase activity recorded yet.');
  } else {
    lines.push(`  ${'phase'.padEnd(10)} ${'elapsed'.padEnd(9)} ${'worker (turns)'.padEnd(16)} maker model`);
    for (const p of model.phases) {
      const worker = `${formatDuration(p.workerMs)} (${p.turns})`;
      lines.push(`  ${p.phase.padEnd(10)} ${formatDuration(p.windowMs).padEnd(9)} ${worker.padEnd(16)} ${p.makerModel ?? ''}`);
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

/**
 * `duet stats --trace` — the interleaved execution timeline. A third KIND of
 * thing from the aggregate stats model (a log timeline, not a structural
 * projection), so it lives here (stats owns the log format) rather than as a
 * third GraphModel mode. It reuses the existing parse cores — no new graph-owned
 * regexes — and adds three things over them: the open current-phase window (so a
 * live trace never drops its most-relevant phase), interventions overlaid at
 * their timestamps, and a conservative ordering-drift heuristic.
 */

export interface TraceTurn {
  voice: string;
  tag: string;
  startMs: number;
  endMs: number;
  status: TurnStatus;
}

/** A non-turn event on the timeline — a context intervention, an auto-retry, or a staged steer. */
export interface TraceEvent {
  kind: string;
  atMs: number;
  at: string;
  voice?: string;
  detail?: string;
}

/** Two consecutive checker review-family turns in a phase with no maker turn between them — the ordering bug the feature targets. */
export interface OrderingFlag {
  phase: string;
  first: { voice: string; tag: string; atMs: number };
  second: { voice: string; tag: string; atMs: number };
}

export interface TracePhase {
  phase: string;
  /** The phase window was inferred (interactively orchestrated / open current phase) — its elapsed span is approximate. */
  inferredWindow: boolean;
  turns: TraceTurn[];
  interventions: TraceEvent[];
  drift: OrderingFlag[];
}

export interface TraceModel {
  runId: string;
  phases: TracePhase[];
  notes: string[];
}

/** Whether a turn's voice is a MAKER duty — the ordering rule's "a real maker response". Guarded: the consultant and any non-duty voice are not makers (stageOfDutyLane takes a Duty). */
function isMakerTurn(voice: string): boolean {
  if (voice === 'consultant' || !DUTIES.includes(voice as Duty)) return false;
  return stageOfDutyLane(voice as Duty) === 'maker';
}

/**
 * The ordering-drift rule (P2b), stated narrowly: flag two consecutive checker
 * review-family turns in the same phase with NO maker turn started between them.
 * Review-family is `countsReviewRound` (catalog-driven, consultant-safe — never
 * `tag.startsWith('review')`); a consultant turn between two reviews is NOT a
 * maker interleave, so drift still fires. Anything broader (a full expected
 * partial-order) is the deferred choreography validator, out of scope.
 */
export function detectOrderingDrift(
  phase: string,
  turns: readonly { voice: string; tag: string; startMs: number }[],
): OrderingFlag[] {
  const sorted = [...turns].sort((a, b) => a.startMs - b.startMs);
  const flags: OrderingFlag[] = [];
  let lastReview: { voice: string; tag: string; startMs: number } | undefined;
  let makerSince = false;
  for (const t of sorted) {
    if (countsReviewRound(t.voice as VoiceAddress, t.tag)) {
      if (lastReview && !makerSince) {
        flags.push({
          phase,
          first: { voice: lastReview.voice, tag: lastReview.tag, atMs: lastReview.startMs },
          second: { voice: t.voice, tag: t.tag, atMs: t.startMs },
        });
      }
      lastReview = t;
      makerSince = false;
    } else if (isMakerTurn(t.voice)) {
      makerSince = true;
    }
  }
  return flags;
}

/**
 * The phase whose window is genuinely OPEN (still running) at this position — the
 * one the trace synthesizes an open current-phase window for. A `gate` position
 * has already `advance_phase`d, so its window is CLOSED (synthesizing one would
 * mark a precisely-windowed phase `inferred` and misattribute gate-wait events);
 * `done`/`abandoned` carry no phase. Only running / interactive / crashed / flag
 * (flag = parked mid-phase, not advanced) name a phase whose window never closed.
 */
export function openPhaseFor(position: RunPosition): PhaseName | undefined {
  switch (position.kind) {
    case 'running':
    case 'interactive':
    case 'crashed':
    case 'flag':
      return position.phase;
    case 'gate':
    case 'done':
    case 'abandoned':
      return undefined;
  }
}

/**
 * The trace composer — the fs+state sibling of `buildStatsModel`. Reads the
 * orchestrator + worker logs (fail-soft), attributes turns and interventions to
 * phases through the shared cores, and detects ordering drift per phase. `now`
 * is INJECTED (the CLI passes `Date.now()`, tests a fixed clock) so the open
 * current-phase window — and thus the JSON — is deterministic.
 */
export function buildTraceModel(state: RunState, now: number): TraceModel {
  const dir = runDirOf(state.cwd, state.runId);
  const read = (voice: Voice): string | undefined => {
    const path = join(dir, `${voice}.log`);
    if (!existsSync(path)) return undefined;
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  };
  const workflow = workflowFor(state);
  const arcOrder = phasesOf(workflow).map((p) => p.name) as string[];
  const position = probeRunPosition(state);
  const currentPhase = openPhaseFor(position);
  const runStartMs = Number.isNaN(Date.parse(state.createdAt)) ? 0 : Date.parse(state.createdAt);
  const notes: string[] = [];

  const orchLog = read('orchestrator');
  const { windows, inferred } = orchLog !== undefined
    ? parsePhaseWindows(orchLog, runStartMs, currentPhase ? { now, currentPhase } : undefined)
    : { windows: [] as PhaseWindow[], inferred: 0 };
  if (orchLog === undefined) notes.push('no orchestrator log yet — phase windows unavailable.');
  if (inferred > 0) {
    notes.push(`${inferred} phase window(s) inferred (interactively orchestrated or still-open phases log no closing header) — those elapsed spans are approximate.`);
  }
  const inferredPhases = new Set(windows.filter((w) => w.inferred).map((w) => w.phase));

  const hasSession = (voice: VoiceAddress): boolean =>
    Boolean(voice === 'consultant' ? state.sessions['consultant'] : state.sessions[sessionKeyFor(voice)]);
  const turns: ParsedTurn[] = [];
  for (const voice of voicesFor(state).filter((v): v is VoiceAddress => v !== 'orchestrator')) {
    const log = read(voice);
    if (log === undefined) {
      if (hasSession(voice)) notes.push(`${voice} log missing — its turns aren't shown.`);
      continue;
    }
    turns.push(...parseVoiceLogTurns(voice, log).turns);
  }

  const byPhase = new Map<string, TracePhase>();
  const ensure = (phase: string): TracePhase => {
    let tp = byPhase.get(phase);
    if (!tp) {
      tp = { phase, inferredWindow: inferredPhases.has(phase), turns: [], interventions: [], drift: [] };
      byPhase.set(phase, tp);
    }
    return tp;
  };

  let unattributed = 0;
  for (const t of turns) {
    const phase = phaseForTurn(windows, t.startMs);
    if (!phase) {
      unattributed++;
      continue;
    }
    ensure(phase).turns.push({ voice: t.voice, tag: t.tag, startMs: t.startMs, endMs: t.endMs, status: t.status });
  }
  if (unattributed > 0) notes.push(`${unattributed} worker turn(s) fell outside any phase window — omitted from the timeline.`);

  // Interventions overlaid at their recorded timestamps. Context events attribute
  // to a phase by WINDOW (the one honest place, because here windows exist);
  // auto-retries already carry their phase; steers render at STAGING time (both
  // dirs, so an already-delivered steer isn't lost), labeled — not delivery time.
  for (const e of state.contextEvents ?? []) {
    const phase = phaseForTurn(windows, Date.parse(e.at));
    if (phase) ensure(phase).interventions.push({ kind: e.kind, atMs: Date.parse(e.at), at: e.at, voice: e.voice });
  }
  for (const r of state.autoRetries ?? []) {
    ensure(r.phase).interventions.push({ kind: 'auto-retry', atMs: Date.parse(r.at), at: r.at, detail: `${r.errorClass} (attempt ${r.attempt})` });
  }
  for (const s of listStagedSteersForTrace(state)) {
    if (s.stagedDuring) ensure(s.stagedDuring).interventions.push({ kind: 'steer-staged', atMs: Date.parse(s.stagedAt), at: s.stagedAt, detail: s.text });
  }

  for (const tp of byPhase.values()) {
    tp.turns.sort((a, b) => a.startMs - b.startMs);
    tp.interventions.sort((a, b) => a.atMs - b.atMs);
    tp.drift = detectOrderingDrift(tp.phase, tp.turns);
  }

  const seen = [...byPhase.keys()];
  const ordered = [...arcOrder.filter((p) => byPhase.has(p)), ...seen.filter((p) => !arcOrder.includes(p))];
  return { runId: state.runId, phases: ordered.map((p) => byPhase.get(p)!), notes };
}

/** The human render — per phase, the interleaved turn/intervention timeline in chronological order, then any ordering drift. */
export function renderTrace(model: TraceModel): string {
  const stamp = (ms: number): string => localTime(new Date(ms).toISOString());
  const lines: string[] = [`\n━━━ duet trace ${model.runId} ━━━`];
  if (model.phases.length === 0) lines.push('no phase activity recorded yet.');
  for (const p of model.phases) {
    lines.push(`\n${p.phase}${p.inferredWindow ? '  (window inferred — elapsed approximate)' : ''}`);
    const items = [
      ...p.turns.map((t) => ({
        atMs: t.startMs,
        line: `  ${stamp(t.startMs)}  ${t.voice} · ${t.tag} (${formatDuration(t.endMs - t.startMs)}${t.status !== 'ok' ? `, ${t.status}` : ''})`,
      })),
      ...p.interventions.map((e) => ({
        atMs: e.atMs,
        line: `  ${stamp(e.atMs)}  ⋯ ${e.kind}${e.voice ? ` ${e.voice}` : ''}${e.detail ? `: ${e.detail}` : ''}`,
      })),
    ].sort((a, b) => a.atMs - b.atMs);
    for (const it of items) lines.push(it.line);
    for (const d of p.drift) lines.push(`  ⚠ ordering drift: ${d.first.tag} then ${d.second.tag} with no maker turn between`);
  }
  for (const note of model.notes) lines.push(`\nnote: ${note}`);
  return lines.join('\n');
}

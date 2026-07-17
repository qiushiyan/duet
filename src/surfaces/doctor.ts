import { allBindings, voiceBindingFor } from '../voices/bindings.ts';
import { entryOf } from '../registry/workflows.ts';
import { aliveDriverPid, probeRunPosition } from '../run/position.ts';
import { sessionRecordFor, voicesFor } from '../voices/policy.ts';
import { readTranscriptTailForSession } from '../voices/sessions.ts';
import type { RunState, Voice } from '../run/store.ts';
import type { PhaseName } from '../registry/workflows.ts';
import { workflowFor } from '../run/workflow.ts';
import { localStamp } from '../view/timefmt.ts';
import {
  RETRY_WINDOW_MS,
  formatAge,
  probeRole,
  type Schema,
  type TerminalError,
  type Verdict,
} from '../voices/health.ts';

/**
 * `greenflag doctor` — the health/liveness/connectivity view, the ONE composer that
 * reads transcripts and the network (status stays cheap and `.greenflag/`-local).
 * It joins three sources: the cheap session map (`resolveSessions`), each role's
 * transcript tail + probe (`worker-health`, via `sessions.readRoleTranscriptTail`),
 * and the greenflag-side liveness (`aliveDriverPid` + `probeRunPosition`). Only
 * `cli.ts` imports this module, so importing `lifecycle` here closes no cycle —
 * the composition lives here precisely to keep `worker-health.ts` pure.
 *
 * Two liveness sources, by design (#6): the two WORKERS' in-flight signal is the
 * persisted `activeTurns` hint reconciled against driver liveness (a hint under a
 * dead driver is an interrupted turn, not a live one); the ORCHESTRATOR has no
 * per-turn marker, so its liveness is driver+phase state, with an approximate
 * recency window and — crucially — `retriesSince` omitted, so it can read
 * working/long-inference/idle but never a false `retrying` (#3).
 *
 * Every transcript read is fail-soft: a missing/disappearing transcript yields an
 * idle/elapsed row, never a thrown health command.
 */

export interface VoiceHealthRow {
  voice: Voice;
  provider: Schema;
  /** The resolved transcript path the probe read (absent when no session yet / unlocatable). */
  sessionPath?: string;
  verdict: Verdict;
  lastActivityAgeMs?: number;
  retries: number;
  recentErrors: TerminalError[];
  /** Whether greenflag believes this voice is mid-turn right now (drives the verdict). */
  inFlight: boolean;
}

export type Connectivity =
  | { target: 'api.anthropic.com'; status: 'reachable' | 'reachable-but-auth-rejected' | 'down' }
  | { target: 'api.anthropic.com'; status: 'probe failed' }
  | { target: 'none'; status: 'not probed' };

export interface DoctorModel {
  runId: string;
  branch?: string;
  orchestrationHost: 'headless' | 'interactive';
  /** The run-state machine label (display hint) and the live position kind. */
  machineState?: string;
  position: string;
  driverPid?: number;
  voices: VoiceHealthRow[];
  connectivity: Connectivity;
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ status: number }>;

/** Probe the Anthropic API: reachable / auth-rejected / down, best-effort with a ~6s timeout. */
async function probeAnthropic(fetchFn: FetchLike, timeoutMs = 6_000): Promise<Connectivity> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn('https://api.anthropic.com/v1/models', { signal: ctrl.signal });
    const status = res.status === 401 || res.status === 403 ? 'reachable-but-auth-rejected' : 'reachable';
    return { target: 'api.anthropic.com', status };
  } catch {
    // No response / timeout / network error — can't reach the API.
    return { target: 'api.anthropic.com', status: 'down' };
  } finally {
    clearTimeout(timer);
  }
}

/** The in-flight anchors for one role, or undefined fields when it isn't mid-turn. */
function inFlightFor(
  role: Voice,
  state: RunState,
  now: number,
  driverAlive: boolean,
  phaseMidFlight: boolean,
): { inFlightSince?: number; retriesSince?: number } {
  if (role === 'orchestrator') {
    // No per-turn marker — use a recency window when the phase is truly
    // mid-flight (NOT merely "a pid exists"), and OMIT retriesSince so a stale
    // window-local api_retry can never read as retrying.
    return phaseMidFlight ? { inFlightSince: now - RETRY_WINDOW_MS } : {};
  }
  // Workers: the persisted hint, reconciled against driver liveness — a hint
  // under a dead driver is an interrupted turn, not one in flight.
  const hint = state.activeTurns?.[role];
  if (!driverAlive || !hint) return {};
  const startedAt = Date.parse(hint.startedAt);
  if (!Number.isFinite(startedAt)) return {};
  return { inFlightSince: startedAt, retriesSince: startedAt };
}

function voiceRow(role: Voice, state: RunState, opts: { now: number; home?: string; driverAlive: boolean; phaseMidFlight: boolean; phase: PhaseName }): VoiceHealthRow {
  // The session a voice's next turn would continue at the run's current
  // position — the duty's own record or its live continuity edge's
  // (sessionRecordFor); the phase-effective binding is only the fallback
  // provider before a first record exists.
  const known = role === 'orchestrator'
    ? state.orchestratorSessionId
      ? { provider: state.bindings.orchestrator.provider, id: state.orchestratorSessionId }
      : undefined
    : sessionRecordFor(state, role);
  const provider = known?.provider ?? voiceBindingFor(state.bindings, role).provider;
  const { inFlightSince, retriesSince } = inFlightFor(role, state, opts.now, opts.driverAlive, opts.phaseMidFlight);
  const inFlight = inFlightSince !== undefined;

  if (!known) {
    // No session id yet — nothing to read; report idle (or working-by-turn-age
    // if somehow mid-flight with no transcript, which probeRole handles below).
    const health = probeRole('', { schema: provider, now: opts.now, ...(inFlightSince !== undefined ? { inFlightSince } : {}), ...(retriesSince !== undefined ? { retriesSince } : {}) });
    return { voice: role, provider, verdict: health.verdict, retries: health.retries, recentErrors: health.recentErrors, inFlight };
  }

  // Fail-soft: a disappearing transcript degrades to an empty read, never throws.
  let tail: ReturnType<typeof readTranscriptTailForSession>;
  try {
    tail = readTranscriptTailForSession(known.provider, known.id, opts.home !== undefined ? { home: opts.home } : {});
  } catch {
    tail = undefined;
  }
  const health = probeRole(tail?.jsonl ?? '', {
    schema: tail?.schema ?? provider,
    now: opts.now,
    ...(inFlightSince !== undefined ? { inFlightSince } : {}),
    ...(retriesSince !== undefined ? { retriesSince } : {}),
  });
  return {
    voice: role,
    provider,
    ...(tail?.path ? { sessionPath: tail.path } : {}),
    verdict: health.verdict,
    ...(health.lastActivityAgeMs !== undefined ? { lastActivityAgeMs: health.lastActivityAgeMs } : {}),
    retries: health.retries,
    recentErrors: health.recentErrors,
    inFlight,
  };
}

/**
 * Build the full health model for a run. `now`/`home`/`fetch` are injected (the
 * clock + environment seams) so the whole thing is deterministic under test.
 */
export async function buildDoctorModel(
  state: RunState,
  opts: { now: number; home?: string; fetch?: FetchLike },
): Promise<DoctorModel> {
  const pid = aliveDriverPid(state);
  const driverAlive = pid !== undefined;
  const position = probeRunPosition(state);
  // A phase is truly mid-flight when a driver is executing it (headless) or the
  // interactive session is driving it — not merely because a pid file exists.
  const phaseMidFlight = position.kind === 'running' || position.kind === 'interactive';

  const voices = voicesFor(state);
  const phase = 'phase' in position ? position.phase : entryOf(workflowFor(state)).firstPhase;
  const rows = voices.map((voice) => voiceRow(voice, state, { now: opts.now, ...(opts.home !== undefined ? { home: opts.home } : {}), driverAlive, phaseMidFlight, phase }));

  const hasClaude = allBindings(state.bindings).some((b) => b.binding.provider === 'claude');
  let connectivity: Connectivity;
  try {
    connectivity = hasClaude ? await probeAnthropic(opts.fetch ?? (globalThis.fetch as unknown as FetchLike)) : { target: 'none', status: 'not probed' };
  } catch {
    connectivity = { target: 'api.anthropic.com', status: 'probe failed' };
  }

  return {
    runId: state.runId,
    ...(state.branch ? { branch: state.branch } : {}),
    orchestrationHost: state.orchestrationHost === 'interactive' ? 'interactive' : 'headless',
    ...(state.machineState ? { machineState: state.machineState } : {}),
    position: position.kind,
    ...(pid !== undefined ? { driverPid: pid } : {}),
    voices: rows,
    connectivity,
  };
}

const VERDICT_MARK: Record<Verdict, string> = {
  crashed: '⛔',
  retrying: '↻',
  working: '✅',
  'long-inference': '🜂',
  'silent/stuck': '⚠',
  idle: '·',
};

function connectivityLine(c: Connectivity): string {
  return c.target === 'none' ? 'not probed (no claude-bound role)' : `${c.target}: ${c.status}`;
}

/** The human one-screen render — mirrors the doctor.py prototype's shape. */
export function renderDoctor(model: DoctorModel): string {
  const lines: string[] = [];
  lines.push(`\n━━━ doctor: ${model.runId}${model.branch ? `  branch=${model.branch}` : ''}  host=${model.orchestrationHost} ━━━`);
  lines.push(`phase:    ${model.machineState ?? '(not started)'} — ${model.position}${model.driverPid ? ` (driver pid ${model.driverPid})` : ''}`);
  lines.push(`network:  ${connectivityLine(model.connectivity)}`);
  lines.push(`voices:`);
  for (const r of model.voices) {
    const age = r.lastActivityAgeMs !== undefined ? `last ${formatAge(r.lastActivityAgeMs)} ago` : 'no activity';
    const retries = r.retries > 0 ? ` · ${r.retries} retries` : '';
    lines.push(`  ${VERDICT_MARK[r.verdict]} ${r.voice.padEnd(12)} (${r.provider})  ${r.verdict.padEnd(14)} ${age}${retries}`);
    if (r.sessionPath) lines.push(`      ${r.sessionPath}`);
    for (const e of r.recentErrors.slice(-2)) {
      lines.push(`      ⛔ ${localStamp(e.ts)}  ${e.errorClass}: ${e.text.slice(0, 70)}`);
    }
  }
  return lines.join('\n');
}

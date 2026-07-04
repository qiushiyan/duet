import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Provider } from './config.ts';
import { stagesOf } from './phases.ts';
import { sessionKeyFor } from './roles.ts';
// Type-only — run-store.ts value-imports THIS module, so a value import back
// would close a runtime cycle. RunState/SessionKey are erased at build.
import type { RunState, SessionKey } from './run-store.ts';

/**
 * Locating the providers' standard-location session transcripts for a run.
 *
 * This is the ONE place duet reaches OUTSIDE `.duet/` into the user's own
 * `~/.claude` and `~/.codex` — `duet abandon --purge` deletes what it finds
 * here (src/run-store.ts `purgeRun`). Everything else duet writes lives under
 * the self-ignored `.duet/`; these transcripts are the user's normal CLI
 * artifacts (augmentation principle), so deletion is opt-in and location is by
 * EXACT session-id match — never a directory sweep that could catch an
 * unrelated session.
 *
 * `home` is a parameter (the environment seam) so tests point it at a tmp dir
 * instead of mutating `$HOME`.
 */


/**
 * Claude transcripts live at `~/.claude/projects/<encoded-cwd>/<id>.jsonl`.
 * The cwd-encoding isn't a public contract, so rather than reconstruct the
 * directory name we scan the project dirs for the exact `<id>.jsonl` filename
 * (session ids are unique) — robust to whatever encoding the CLI uses.
 */
function claudeTranscripts(sessionId: string, home: string): string[] {
  const projectsRoot = join(home, '.claude', 'projects');
  if (!existsSync(projectsRoot)) return [];
  const matches: string[] = [];
  for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(projectsRoot, entry.name, `${sessionId}.jsonl`);
    if (existsSync(candidate)) matches.push(candidate);
  }
  return matches;
}

/**
 * Codex rollouts live date-bucketed at
 * `~/.codex/sessions/<y>/<m>/<d>/rollout-<ts>-<id>.jsonl`. Match by the
 * `-<id>.jsonl` suffix — the same scan src/providers/codex.ts uses to find a
 * rollout for its context probe.
 */
function codexRollouts(sessionId: string, home: string): string[] {
  const sessionsRoot = join(home, '.codex', 'sessions');
  if (!existsSync(sessionsRoot)) return [];
  return readdirSync(sessionsRoot, { recursive: true })
    .map(String)
    .filter((p) => p.endsWith(`-${sessionId}.jsonl`))
    .map((p) => join(sessionsRoot, p));
}

/** The on-disk transcript(s) for one (provider, session id), if present. */
export function locateSessionTranscripts(provider: Provider, sessionId: string, home: string = homedir()): string[] {
  return provider === 'claude' ? claudeTranscripts(sessionId, home) : codexRollouts(sessionId, home);
}

export interface SessionRef {
  /** The persisted slot: 'orchestrator', a duty's "stage.duty", or 'consultant'. */
  key: 'orchestrator' | SessionKey;
  provider: Provider;
  sessionId: string;
}

/**
 * The cheap exact session map — the enabler (#1), a pure state-only read
 * enumerating every persisted session slot in run order: the orchestrator,
 * each stage's duties, then the consultant. NO fs, NO scan: it is the field
 * `status --json` exposes on the hot path (`sessions[]`), so the polled path
 * never touches a transcript. KNOWN sessions only — a slot whose record is
 * still absent (until its first turn settles) is OMITTED, never a null-id
 * entry. Each record is its own provider source (a stage-boundary provider
 * switch makes any binding wrong for locating the transcript tree). The
 * resolved *path* and any transcript reads live below / in
 * `worker-health.ts`, off the hot path.
 */
export function resolveSessions(state: RunState): SessionRef[] {
  const out: SessionRef[] = [];
  if (state.orchestratorSessionId) {
    out.push({ key: 'orchestrator', provider: state.bindings.orchestrator.provider, sessionId: state.orchestratorSessionId });
  }
  const keys: SessionKey[] = [
    ...stagesOf(state.workflow ?? 'full').flatMap((s) => [sessionKeyFor(s.duties.maker), sessionKeyFor(s.duties.checker)]),
    'consultant',
  ];
  for (const key of keys) {
    const record = state.sessions[key];
    if (record) out.push({ key, provider: record.provider, sessionId: record.id });
  }
  return out;
}

/**
 * Read the tail of a transcript for an EXPLICIT (provider, session id) — the
 * locate-by-exact-id reader every tail consumer routes through (doctor via
 * the resolved session record, the driver's orchestrator read, the
 * live-activity poll by THIS turn's announced id, which is not yet in a
 * settled session slot on a first turn). Still an exact `<id>.jsonl` match
 * (never a directory sweep), so the purge contract above is unchanged. On
 * multiple located paths it picks the NEWEST by mtime; unlocatable → undefined.
 */
export function readTranscriptTailForSession(
  provider: Provider,
  sessionId: string,
  opts: { home?: string; maxBytes?: number } = {},
): { jsonl: string; schema: Provider; path: string } | undefined {
  const home = opts.home ?? homedir();
  const maxBytes = opts.maxBytes ?? 262_144;
  const paths = locateSessionTranscripts(provider, sessionId, home);
  const chosen = paths.map((p) => ({ p, mtime: statSync(p).mtimeMs })).sort((a, b) => b.mtime - a.mtime)[0];
  if (!chosen) return undefined;
  return readTranscriptTailAtPath(chosen.p, provider, maxBytes);
}

/**
 * Read the tail of a transcript at an ALREADY-LOCATED path — the locate-free
 * variant, so a fast repeated reader (the 30s heartbeat
 * activity poll) can skip the directory scan after the first tick. Returns
 * undefined when the path has vanished, so the caller re-locates. The partial
 * leading line is discarded only when the read seeked past the file start, same
 * as the locating reader.
 */
export function readTranscriptTailAtPath(
  path: string,
  schema: Provider,
  maxBytes = 262_144,
): { jsonl: string; schema: Provider; path: string } | undefined {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return undefined; // the path disappeared (e.g. a purge) — caller re-locates
  }
  const start = size > maxBytes ? size - maxBytes : 0;
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    if (buf.length > 0) readSync(fd, buf, 0, buf.length, start);
    let jsonl = buf.toString('utf8');
    if (start > 0) {
      const nl = jsonl.indexOf('\n');
      jsonl = nl === -1 ? '' : jsonl.slice(nl + 1);
    }
    return { jsonl, schema, path };
  } finally {
    closeSync(fd);
  }
}

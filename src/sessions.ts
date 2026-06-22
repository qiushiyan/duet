import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RoleBinding } from './config.ts';
// Type-only — run-store.ts value-imports THIS module, so a value import back
// would close a runtime cycle. RunState/Voice are erased at build.
import type { RunState, Voice } from './run-store.ts';

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

type Provider = RoleBinding['provider'];

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
  role: Voice;
  provider: Provider;
  sessionId: string;
}

/**
 * The cheap exact session map — the enabler (#1), a pure state-only read joining
 * each voice's persisted session id with its bound provider. NO fs, NO scan: it
 * is the field `status --json` exposes on the hot path (`sessions[]`), so the
 * polled path never touches a transcript. KNOWN sessions only — a role whose id
 * is still absent (optional until its first turn completes) is OMITTED, never a
 * null-id entry. The resolved *path* and any transcript reads live below /in
 * `worker-health.ts`, off the hot path.
 */
export function resolveSessions(state: RunState): SessionRef[] {
  const out: SessionRef[] = [];
  if (state.orchestratorSessionId) {
    out.push({ role: 'orchestrator', provider: state.bindings.orchestrator.provider, sessionId: state.orchestratorSessionId });
  }
  for (const role of ['implementer', 'reviewer'] as const) {
    const sessionId = state.workerSessions[role];
    if (sessionId) out.push({ role, provider: state.bindings[role].provider, sessionId });
  }
  return out;
}

/**
 * Read the TAIL of a role's transcript — the thin fs wrapper over
 * `locateSessionTranscripts` that `doctor`/the heartbeat read through (never
 * `status`). It returns the chosen `path` so `doctor` doesn't locate twice.
 *
 * Reads the last `maxBytes` (default 256 KiB) so a multi-MB JSONL is never read
 * whole. The partial leading line is discarded ONLY when the read seeked past
 * the file start (a file ≤ maxBytes is read from offset 0 with NO discard — so a
 * small transcript keeps its first record). On multiple located paths it picks
 * the NEWEST by mtime; a missing/unlocatable transcript returns undefined.
 */
export function readRoleTranscriptTail(
  state: RunState,
  role: Voice,
  opts: { home?: string; maxBytes?: number } = {},
): { jsonl: string; schema: Provider; path: string } | undefined {
  const home = opts.home ?? homedir();
  const maxBytes = opts.maxBytes ?? 262_144;
  const session = resolveSessions(state).find((s) => s.role === role);
  if (!session) return undefined;

  const paths = locateSessionTranscripts(session.provider, session.sessionId, home);
  const chosen = paths.map((p) => ({ p, mtime: statSync(p).mtimeMs })).sort((a, b) => b.mtime - a.mtime)[0];
  if (!chosen) return undefined;
  return readTranscriptTailAtPath(chosen.p, session.provider, maxBytes);
}

/**
 * Read the tail of a transcript at an ALREADY-LOCATED path — the locate-free
 * half of `readRoleTranscriptTail`, so a fast repeated reader (the 30s heartbeat
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

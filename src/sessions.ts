import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RoleBinding } from './config.ts';

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

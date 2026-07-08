import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { test as base } from './fixtures.ts';

/**
 * Shared scaffolding for the replay suite (tests/replay-*.test.ts): the
 * voice-log line builders every file feeds parseProtocolTrace, the kernel-tool
 * lookup pair, the "this tree was untouched" snapshot, and the two fixtures —
 * a disposable replay output dir and the provider-store sentinel that proves a
 * replay never writes into the user's real ~/.claude.
 */

/** A fixed-date ISO stamp at 10:<minute>, millisecond-precise for fan-out proximity cases. */
export const stamp = (minute: number, ms = 0): string =>
  `2026-07-07T10:${String(minute).padStart(2, '0')}:00.${String(ms).padStart(3, '0')}Z`;

/** One voice-log entry exactly as the harness writes it: `[stamp] header`, optional body block. */
export const entry = (minute: number, header: string, body?: string, ms = 0): string =>
  body === undefined ? `[${stamp(minute, ms)}] ${header}\n` : `[${stamp(minute, ms)}] ${header}\n${body}\n\n`;

/** Find a tool by name on any tool-carrying surface, throwing when the replay surface is missing it. */
export function tool<T extends { name: string }>(tools: readonly T[], name: string): T {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

/** Join a tool result's text blocks — the assertable prose of a refusal or brief. */
export function toolText(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  return result.content.map((block) => ('text' in block && block.text !== undefined ? block.text : '')).join('\n');
}

/**
 * Full recursive file snapshot (size + mtime + body) — compare before/after to
 * assert a tree (the record dir, the provider store) was byte-for-byte untouched.
 */
export function snapshotTree(root: string): Record<string, { size: number; mtimeMs: number; body: string }> {
  const snapshot: Record<string, { size: number; mtimeMs: number; body: string }> = {};
  const walk = (dir: string, prefix = ''): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = statSync(path);
      if (stat.isDirectory()) {
        walk(path, rel);
        continue;
      }
      snapshot[rel] = { size: stat.size, mtimeMs: stat.mtimeMs, body: readFileSync(path, 'utf8') };
    }
  };
  walk(root);
  return snapshot;
}

export interface ReplayFixtures {
  /** A disposable output dir for prepared/replayed runs (`--out`). */
  replayOutDir: string;
  /**
   * A sentinel provider store: HOME / CLAUDE_CONFIG_DIR / CLAUDE_HOME stubbed
   * (restored by the config's unstubEnvs) at dirs seeded with sentinel files —
   * snapshotTree it before and after to prove a replay wrote nothing there.
   */
  providerStoreSentinel: string;
}

export const test = base.extend<ReplayFixtures>({
  replayOutDir: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'duet-replay-'));
    await use(dir);
    rmSync(dir, { recursive: true, force: true });
  },
  providerStoreSentinel: async ({}, use) => {
    const root = mkdtempSync(join(tmpdir(), 'duet-provider-store-'));
    const configDir = join(root, 'claude-config-sentinel');
    const claudeHome = join(root, 'claude-home-sentinel');
    mkdirSync(join(root, '.claude'), { recursive: true });
    mkdirSync(configDir, { recursive: true });
    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(root, '.claude', 'sentinel.jsonl'), 'do not touch\n');
    writeFileSync(join(configDir, 'sentinel.jsonl'), 'do not touch\n');
    writeFileSync(join(claudeHome, 'sentinel.jsonl'), 'do not touch\n');
    vi.stubEnv('HOME', root);
    vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
    vi.stubEnv('CLAUDE_HOME', claudeHome);
    await use(root);
    rmSync(root, { recursive: true, force: true });
  },
});

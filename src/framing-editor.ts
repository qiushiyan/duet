import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execa } from 'execa';
import { ensureDuetDir } from './run-state.ts';

/**
 * The bare `duet new` entry: no --spec, no --framing — open the user's
 * editor on a draft framing file under .duet/, and start the run from
 * whatever they save. On run creation the draft is archived into the run
 * dir as framing.md (duet runtime artifacts live under .duet, never at the
 * repo root); an aborted edit leaves the draft in place for next time.
 */

export const DEFAULT_FRAMING_FILE = join('.duet', 'framing-draft.md');

export const FRAMING_TEMPLATE = `---
# Machine-parsed options (fixed values the harness acts on; judgment-weighed
# detail belongs in the prose below). Uncomment to use.
# gates_at: frame, spec   — phases whose gates you attend; the rest are
#                           pre-authorized and auto-cross with packets
#                           recorded. Preset: overnight = frame,spec.
#                           pr is always attended. Default: every gate.
# spec: path/to/draft.md  — enter at the spec review loop (skips FRAME).
---

# Problem
<what to build or change, why, and the scope boundaries — what's explicitly out>

# Onboarding
<skill to invoke (e.g. /onboarding <topic>) or files each worker should read first>
<park any assets the framing references (screenshots, mocks) under .duet/ —
 paths like ~/Desktop rot out from under old runs>

# Conventions
- Specs live at: <e.g. docs/specs/YYYY-MM-DD-<slug>.md>
- Plans live at: <path or directory convention — required>
- Branch: <"this worktree's branch is the run's branch", or a naming convention>
- Commit style: <conventional commits / your norm>

# Verification
- Typecheck: <command>
- Tests: <command>
- Environment-only actions (migrations, deploys): flag me — never attempt.

# Docs
<docs-update skill name if one exists, else where docs live and what usually needs updating>

# Planning style
<tdd-plan vs start-plan preference, or let the orchestrator judge>
`;

/** GUI editors that detach by default and need a wait flag to block. */
const NEEDS_WAIT_FLAG = new Set(['code', 'code-insiders', 'cursor', 'windsurf', 'subl', 'zed']);

function resolveEditor(): { command: string; args: string[] } {
  const raw = process.env['VISUAL'] || process.env['EDITOR'] || 'vi';
  const parts = raw.split(/\s+/).filter(Boolean);
  const command = parts[0] ?? 'vi';
  const args = parts.slice(1);
  if (NEEDS_WAIT_FLAG.has(basename(command)) && !args.includes('--wait') && !args.includes('-w')) {
    args.push('--wait');
  }
  return { command, args };
}

/**
 * Open the editor on the project's framing file (seeding the template when
 * the file doesn't exist), block until it closes, and return the file name
 * to run with. Throws when the user wrote nothing — an empty or untouched
 * template means "don't start the run".
 */
export async function editFramingForRun(cwd: string): Promise<string> {
  ensureDuetDir(cwd);
  const path = join(cwd, DEFAULT_FRAMING_FILE);
  if (!existsSync(path)) writeFileSync(path, FRAMING_TEMPLATE);

  const { command, args } = resolveEditor();
  console.log(`no --spec/--framing given — opening ${DEFAULT_FRAMING_FILE} in ${basename(command)}; write the framing, save, and close to start the run`);
  try {
    await execa(command, [...args, path], { stdio: 'inherit' });
  } catch (err) {
    const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
    throw new Error(`editor exited with an error (${detail}) — run not started; anything you saved is in ${DEFAULT_FRAMING_FILE}`);
  }

  const content = readFileSync(path, 'utf8');
  if (!content.trim()) {
    throw new Error(`run not started: ${DEFAULT_FRAMING_FILE} is empty`);
  }
  if (content.trim() === FRAMING_TEMPLATE.trim()) {
    throw new Error(`run not started: ${DEFAULT_FRAMING_FILE} is still the untouched template — fill it in (it's saved for next time)`);
  }
  return DEFAULT_FRAMING_FILE;
}

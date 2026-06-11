import { join } from 'node:path';
import { execa } from 'execa';
import { runDirOf } from './run-state.ts';
import type { RunState, Voice } from './run-state.ts';

/**
 * The --tmux viewer (docs/automation-design.md §"Visualization: tmux is a
 * viewer, never the runtime"). Three panes, one per voice, each running
 * `tail -n +1 -F` on that voice's log — `-n +1` replays the full transcript
 * in a late-opened pane, and BSD tail's -F waits for logs that don't exist
 * yet (verified on this machine). Duet never lives inside tmux: killing the
 * viewer doesn't touch agents, killing duet leaves the panes tailing.
 *
 * Same philosophy as notify.ts — best-effort, never allowed to affect the
 * run. Every failure degrades to a one-line note; the logs themselves are
 * the artifact.
 */

async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execa('tmux', args, { timeout: 10_000 });
  return stdout.trim();
}

function tailCommand(state: RunState, voice: Voice): string {
  const path = join(runDirOf(state.cwd, state.runId), `${voice}.log`);
  return `tail -n +1 -F '${path.replaceAll("'", String.raw`'\''`)}'`;
}

/** Split the first pane into the three-voice layout and title the panes. */
async function layoutPanes(state: RunState, firstPane: string): Promise<void> {
  const implementer = await tmux('split-window', '-d', '-t', firstPane, '-P', '-F', '#{pane_id}', tailCommand(state, 'implementer'));
  const reviewer = await tmux('split-window', '-d', '-t', firstPane, '-P', '-F', '#{pane_id}', tailCommand(state, 'reviewer'));
  await tmux('select-layout', '-t', firstPane, 'even-horizontal');
  await tmux('set-option', '-w', '-t', firstPane, 'pane-border-status', 'top');
  await tmux('select-pane', '-t', firstPane, '-T', 'orchestrator');
  await tmux('select-pane', '-t', implementer, '-T', 'implementer');
  await tmux('select-pane', '-t', reviewer, '-T', 'reviewer');
}

export async function openTmuxView(state: RunState): Promise<void> {
  const name = `duet-${state.runId}`;
  try {
    if (process.env['TMUX']) {
      // Inside tmux: a new window in the current session, created without
      // stealing focus. Reuse the existing viewer on re-invocations.
      const windows = await tmux('list-windows', '-F', '#{window_name}');
      if (!windows.split('\n').includes(name)) {
        const first = await tmux('new-window', '-d', '-n', name, '-P', '-F', '#{pane_id}', tailCommand(state, 'orchestrator'));
        await layoutPanes(state, first);
      }
      console.log(`tmux viewer: window "${name}" (tmux select-window -t '=${name}')`);
    } else {
      // Outside tmux: a detached session the human attaches to from any
      // terminal; sized explicitly since detached sessions default to 80×24.
      const has = await execa('tmux', ['has-session', '-t', `=${name}`], { reject: false, timeout: 10_000 });
      if (has.exitCode !== 0) {
        const first = await tmux('new-session', '-d', '-s', name, '-x', '220', '-y', '50', '-P', '-F', '#{pane_id}', tailCommand(state, 'orchestrator'));
        await layoutPanes(state, first);
      }
      console.log(`tmux viewer: attach with  tmux attach -t '=${name}'`);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
    console.log(`tmux viewer unavailable (${detail}) — the same lines stream here and live in .duet/runs/${state.runId}/`);
  }
}

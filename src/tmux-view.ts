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

/**
 * Split the first pane (reviewer) into the three-voice layout: full-width
 * rows, because the logs are prose and prose wants width. Reviewer on top
 * (40%) and implementer below it (40%) carry the bulk — critique and
 * revision alternate through every loop — while the orchestrator's
 * narration is short, high-signal lines that read like a status bar, so it
 * gets a thin always-visible strip at the bottom (20%).
 */
async function layoutPanes(state: RunState, reviewerPane: string): Promise<void> {
  // New pane sizes are percentages of the pane being split: 60% of the
  // window for implementer+orchestrator, then 33% of that for orchestrator.
  const implementer = await tmux('split-window', '-d', '-v', '-l', '60%', '-t', reviewerPane, '-P', '-F', '#{pane_id}', tailCommand(state, 'implementer'));
  const orchestrator = await tmux('split-window', '-d', '-v', '-l', '33%', '-t', implementer, '-P', '-F', '#{pane_id}', tailCommand(state, 'orchestrator'));
  await tmux('set-option', '-w', '-t', reviewerPane, 'pane-border-status', 'top');
  await tmux('select-pane', '-t', reviewerPane, '-T', 'reviewer');
  await tmux('select-pane', '-t', implementer, '-T', 'implementer');
  await tmux('select-pane', '-t', orchestrator, '-T', 'orchestrator');
}

export async function openTmuxView(state: RunState): Promise<void> {
  const name = `duet-${state.runId}`;
  try {
    if (process.env['TMUX']) {
      // Inside tmux: a new window in the current session, created without
      // stealing focus. Reuse the existing viewer on re-invocations.
      const windows = await tmux('list-windows', '-F', '#{window_name}');
      if (!windows.split('\n').includes(name)) {
        const first = await tmux('new-window', '-d', '-n', name, '-P', '-F', '#{pane_id}', tailCommand(state, 'reviewer'));
        await layoutPanes(state, first);
      }
      console.log(`tmux viewer: window "${name}" (tmux select-window -t '=${name}')`);
    } else {
      // Outside tmux: a detached session the human attaches to from any
      // terminal; sized explicitly since detached sessions default to 80×24.
      const has = await execa('tmux', ['has-session', '-t', `=${name}`], { reject: false, timeout: 10_000 });
      if (has.exitCode !== 0) {
        const first = await tmux('new-session', '-d', '-s', name, '-x', '220', '-y', '50', '-P', '-F', '#{pane_id}', tailCommand(state, 'reviewer'));
        await layoutPanes(state, first);
      }
      console.log(`tmux viewer: attach with  tmux attach -t '=${name}'`);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
    console.log(`tmux viewer unavailable (${detail}) — the same lines stream here and live in .duet/runs/${state.runId}/`);
  }
}

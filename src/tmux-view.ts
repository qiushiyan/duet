import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { ROLE_GLYPH, ROLE_TMUX_COLOR } from './colorize.ts';
import { voicesFor } from './roles.ts';
import { runDirOf } from './run-store.ts';
import type { RunState, Voice } from './run-store.ts';

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

function shq(s: string): string {
  return `'${s.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * tail the (plain-text) voice log through the view-time colorizer — the log
 * files stay clean artifacts; color exists only in the pane.
 */
function tailCommand(state: RunState, voice: Voice): string {
  const path = join(runDirOf(state.cwd, state.runId), `${voice}.log`);
  const cli = resolve(process.argv[1] ?? 'src/cli.ts');
  return `tail -n +1 -F ${shq(path)} | ${shq(process.execPath)} ${shq(cli)} _colorize ${voice}`;
}

/**
 * Split the first pane (orchestrator) into the three-voice layout:
 *
 * ```
 * ┌──────────────┬──────────────┐
 * │ orchestrator │              │
 * │     55%      │ implementer  │
 * ├──────────────┤ full height  │
 * │ reviewer 45% │              │
 * └──────────────┴──────────────┘
 * ```
 *
 * The implementer produces the longest content (slice reports, revisions),
 * so it gets a full-height column; the left half pairs the orchestrator's
 * narration (the run's control plane, on top) with the reviewer's critiques
 * below it.
 */
/**
 * A nested tmux `#{?match-glyph, then, else}` chain over the bound voices, the
 * last voice as the terminal else — so the 3-voice layout and the 4-voice
 * (consultant-bound) layout share one builder, and the 3-voice output is
 * byte-for-byte the prior hand-written format.
 */
function paneBranch(voices: Voice[], then: (v: Voice) => string): string {
  const [head, ...rest] = voices;
  if (head === undefined) return '';
  if (rest.length === 0) return then(head);
  return `#{?#{m:${ROLE_GLYPH[head]}*,#{pane_title}},${then(head)},${paneBranch(rest, then)}}`;
}

async function layoutPanes(state: RunState, orchestratorPane: string): Promise<void> {
  // New pane sizes are percentages of the pane being split: -h 50% peels
  // the right column off the window, then -v 45% peels the reviewer off
  // the left column's height.
  const implementer = await tmux('split-window', '-d', '-h', '-l', '50%', '-t', orchestratorPane, '-P', '-F', '#{pane_id}', tailCommand(state, 'implementer'));
  const reviewer = await tmux('split-window', '-d', '-v', '-l', '45%', '-t', orchestratorPane, '-P', '-F', '#{pane_id}', tailCommand(state, 'reviewer'));
  const panes: Array<[Voice, string]> = [
    ['orchestrator', orchestratorPane],
    ['implementer', implementer],
    ['reviewer', reviewer],
  ];
  // The consultant is a fourth voice when bound: split the implementer's column
  // to give it a pane. Unbound, the three-pane layout is byte-for-byte today's.
  if (state.bindings.consultant) {
    const consultant = await tmux('split-window', '-d', '-v', '-l', '45%', '-t', implementer, '-P', '-F', '#{pane_id}', tailCommand(state, 'consultant'));
    panes.push(['consultant', consultant]);
  }
  await tmux('set-option', '-w', '-t', orchestratorPane, 'pane-border-status', 'top');
  for (const [voice, pane] of panes) {
    await tmux('select-pane', '-t', pane, '-T', `${ROLE_GLYPH[voice]} ${voice}`);
  }
  // Color each border title by role, keyed on the title's leading glyph —
  // tmux has no per-pane border-style, but the border format can branch.
  // The context suffix is a #(cat) of the role's plain-text sidecar
  // (.duet/runs/<id>/context/<voice>, e.g. "41%"), written by the harness at
  // each turn boundary and re-read by tmux at its status refresh interval —
  // a cat per interval, nothing parsed at view time. Missing file = no
  // reading yet = empty.
  const ctxFor = (voice: Voice) => `#(cat ${shq(join(runDirOf(state.cwd, state.runId), 'context', voice))} 2>/dev/null)`;
  const voices = voicesFor(state);
  const colorBranch = paneBranch(voices, (v) => `#[fg=${ROLE_TMUX_COLOR[v]}]`);
  const ctxBranch = paneBranch(voices, ctxFor);
  const fmt = ` ${colorBranch}#{pane_title}#[default] ${ctxBranch} `;
  await tmux('set-option', '-w', '-t', orchestratorPane, 'pane-border-format', fmt);
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

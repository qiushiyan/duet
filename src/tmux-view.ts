import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { ROLE_GLYPH, ROLE_TMUX_COLOR } from './colorize.ts';
import { voicesFor, workerRolesFor } from './roles.ts';
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
 * The wide-anchor (2-column) arrangement, built by `columnLayout` below:
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

/** The anchor pane's current cell width, or +Infinity when it can't be read — fail wide, so a measurement hiccup keeps the 2-column layout. */
async function anchorWidth(pane: string): Promise<number> {
  const out = await tmux('display-message', '-p', '-t', pane, '#{pane_width}');
  const n = Number.parseInt(out, 10);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

/**
 * Below this anchor width the 2-column split leaves each voice too few columns
 * to read a log line (~80 readable columns per voice → ~160 total), so the
 * panes stack full-width instead. Width is the binding constraint; height is
 * not — the tail shows the latest lines regardless of pane height.
 */
const TWO_COLUMN_MIN_WIDTH = 160;

/**
 * The wide-anchor arrangement (diagrammed above): orchestrator over reviewer on
 * the left, implementer full-height on the right (+ consultant in its column
 * when bound). New pane sizes are percentages of the pane being split — -h 50%
 * peels the right column off the anchor, -v 45% peels the reviewer off the left.
 */
async function columnLayout(state: RunState, anchor: string): Promise<Array<[Voice, string]>> {
  const implementer = await tmux('split-window', '-d', '-h', '-l', '50%', '-t', anchor, '-P', '-F', '#{pane_id}', tailCommand(state, 'implementer'));
  const reviewer = await tmux('split-window', '-d', '-v', '-l', '45%', '-t', anchor, '-P', '-F', '#{pane_id}', tailCommand(state, 'reviewer'));
  const panes: Array<[Voice, string]> = [
    ['orchestrator', anchor],
    ['implementer', implementer],
    ['reviewer', reviewer],
  ];
  if (state.bindings.consultant) {
    const consultant = await tmux('split-window', '-d', '-v', '-l', '45%', '-t', implementer, '-P', '-F', '#{pane_id}', tailCommand(state, 'consultant'));
    panes.push(['consultant', consultant]);
  }
  return panes;
}

/**
 * The narrow-anchor arrangement: every voice full-width, stacked top-to-bottom
 * in voice order (orchestrator, implementer, reviewer[, consultant]) and evened
 * by `select-layout even-vertical`. Each pane splits off the previous so the
 * stack order is deterministic; trading width for height keeps log lines wide
 * enough to read in a half-window pane.
 */
async function stackLayout(state: RunState, anchor: string): Promise<Array<[Voice, string]>> {
  const panes: Array<[Voice, string]> = [['orchestrator', anchor]];
  let prev = anchor;
  for (const voice of workerRolesFor(state)) {
    prev = await tmux('split-window', '-d', '-v', '-t', prev, '-P', '-F', '#{pane_id}', tailCommand(state, voice));
    panes.push([voice, prev]);
  }
  await tmux('select-layout', '-t', anchor, 'even-vertical');
  return panes;
}

/**
 * Lay the voices out around the anchor (orchestrator) pane, choosing the
 * arrangement from the anchor's measured width: wide keeps the 2-column layout,
 * narrow stacks full-width. The choice keys on the *available* width, so one
 * path serves all three anchor targets — a full window, a fixed-width detached
 * session (always wide), or an inline pane (often narrow). Titles and the
 * role-colored border format are arrangement-independent and shared.
 */
async function layoutPanes(state: RunState, orchestratorPane: string): Promise<void> {
  const panes =
    (await anchorWidth(orchestratorPane)) >= TWO_COLUMN_MIN_WIDTH
      ? await columnLayout(state, orchestratorPane)
      : await stackLayout(state, orchestratorPane);
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

export async function openTmuxView(state: RunState, opts: { here?: boolean } = {}): Promise<void> {
  const name = `duet-${state.runId}`;
  try {
    if (opts.here && process.env['TMUX'] && process.env['TMUX_PANE']) {
      // --here: replace the current pane with the viewer (ephemeral, no new
      // window or session). Split the OTHER voices off the current pane first —
      // all the fallible layout work — so a failure here leaves the pane intact
      // (duet view just exits to its shell). Then respawn the current pane into
      // the orchestrator tail LAST: respawn-pane -k replaces THIS process, and
      // by then every other pane is already placed, so the self-kill races
      // nothing. layoutPanes splits off and titles the anchor regardless of the
      // command it currently runs, and the manual title survives the respawn.
      const anchor = process.env['TMUX_PANE'];
      await layoutPanes(state, anchor);
      await tmux('respawn-pane', '-k', '-t', anchor, tailCommand(state, 'orchestrator'));
      return;
    }
    if (opts.here) {
      console.log('duet view --here needs a current tmux pane to replace — opening the usual viewer instead');
    }
    if (process.env['TMUX']) {
      // Inside tmux: a new window in the current session, created without
      // stealing focus (-d). `-a` inserts it immediately after the current
      // window rather than at the end of the list, so the viewer for this run
      // sits next to where you're working. (`-a` finds the next free index
      // after the current window; with `renumber-windows on` later indices
      // shift — cosmetic, the window is named and -d.) Reuse on re-invocations.
      const windows = await tmux('list-windows', '-F', '#{window_name}');
      if (!windows.split('\n').includes(name)) {
        const first = await tmux('new-window', '-d', '-a', '-n', name, '-P', '-F', '#{pane_id}', tailCommand(state, 'orchestrator'));
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

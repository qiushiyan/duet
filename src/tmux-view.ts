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

/** The detached-session viewer is created at this fixed width (no client to size it), so it always lands in the wide/2-column branch. */
const DETACHED_SESSION_WIDTH = 220;

/**
 * Below this DISPLAY width the 2-column split gives each voice too few columns
 * to read comfortably (~45 per column at the threshold), so the panes stack
 * full-width instead. A normal full terminal window clears this easily; the
 * stack is really for a deliberately narrow inline (--here) split. Width is the
 * binding constraint; height is not — the tail shows the latest lines regardless
 * of pane height.
 */
const TWO_COLUMN_MIN_WIDTH = 90;

/**
 * Parse a tmux width query (cells), failing wide (+Infinity) so a measurement
 * hiccup keeps the 2-column layout. The width MUST be read from a surface a
 * client is already displaying — the current window, or the current --here pane
 * — never a freshly-created `-d` window, which reports a stale background size
 * until a client first shows it (that was the always-stacks bug). Splits are
 * percentage-based, so they rescale when the window is displayed; only the
 * arrangement choice needs the true display width.
 */
function parseWidth(out: string): number {
  const n = Number.parseInt(out, 10);
  return Number.isFinite(n) && n > 0 ? n : Number.POSITIVE_INFINITY;
}

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
 * The narrow-anchor arrangement: every voice full-width stacked top-to-bottom
 * in voice order (orchestrator, implementer, reviewer[, consultant]), confined
 * to the anchor's own region. Each voice splits off the previous so the order
 * is deterministic, with an explicit per-split percentage that evens the stack
 * — NOT `select-layout even-vertical`, which is window-global and would restack
 * the user's OTHER panes too (e.g. an interactive session beside a `--here`
 * viewer). The k-th of the N-1 splits hands its new pane (N-k)/(N-k+1) of the
 * space being divided, leaving the current voice an equal share on top: N=3 →
 * 67%, 50%; N=4 → 75%, 67%, 50%. Trading width for height keeps log lines
 * readable in a half-window pane.
 */
async function stackLayout(state: RunState, anchor: string): Promise<Array<[Voice, string]>> {
  const workers = workerRolesFor(state);
  const total = workers.length + 1; // + orchestrator (the anchor)
  const panes: Array<[Voice, string]> = [['orchestrator', anchor]];
  let prev = anchor;
  for (const [i, voice] of workers.entries()) {
    const pct = Math.round((100 * (total - i - 1)) / (total - i));
    prev = await tmux('split-window', '-d', '-v', '-l', `${pct}%`, '-t', prev, '-P', '-F', '#{pane_id}', tailCommand(state, voice));
    panes.push([voice, prev]);
  }
  return panes;
}

/**
 * Lay the voices out around the anchor (orchestrator) pane, choosing the
 * arrangement from the `displayWidth` the caller measured: wide keeps the
 * 2-column layout, narrow stacks full-width. The caller passes the width of a
 * displayed surface (the current window for a new window, the current pane for
 * --here, the fixed -x size for a detached session) — not the anchor's own
 * pane_width, which lies for a not-yet-shown `-d` window. Titles and the
 * role-colored border format are arrangement-independent and shared.
 */
async function layoutPanes(state: RunState, orchestratorPane: string, displayWidth: number): Promise<void> {
  const panes =
    displayWidth >= TWO_COLUMN_MIN_WIDTH
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
  // reading yet = empty. The orchestrator pane additionally prepends the
  // run's current phase (context/phase, written at phase entry) — it is the
  // control-plane pane, so the run-level phase belongs there.
  const ctxCat = (name: string) => `#(cat ${shq(join(runDirOf(state.cwd, state.runId), 'context', name))} 2>/dev/null)`;
  const ctxFor = (voice: Voice) => (voice === 'orchestrator' ? `${ctxCat('phase')} ${ctxCat(voice)}` : ctxCat(voice));
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
      const paneWidth = parseWidth(await tmux('display-message', '-p', '-t', anchor, '#{pane_width}'));
      await layoutPanes(state, anchor, paneWidth);
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
        // The new window will be displayed at the current client's width; read
        // it from the current (displayed) window, since the `-d` window's own
        // pane_width is a stale background size until a client first shows it.
        const winWidth = parseWidth(await tmux('display-message', '-p', '#{window_width}'));
        const first = await tmux('new-window', '-d', '-a', '-n', name, '-P', '-F', '#{pane_id}', tailCommand(state, 'orchestrator'));
        await layoutPanes(state, first, winWidth);
      }
      console.log(`tmux viewer: window "${name}" (tmux select-window -t '=${name}')`);
    } else {
      // Outside tmux: a detached session the human attaches to from any
      // terminal; sized explicitly since detached sessions default to 80×24.
      const has = await execa('tmux', ['has-session', '-t', `=${name}`], { reject: false, timeout: 10_000 });
      if (has.exitCode !== 0) {
        const first = await tmux('new-session', '-d', '-s', name, '-x', String(DETACHED_SESSION_WIDTH), '-y', '50', '-P', '-F', '#{pane_id}', tailCommand(state, 'orchestrator'));
        await layoutPanes(state, first, DETACHED_SESSION_WIDTH);
      }
      console.log(`tmux viewer: attach with  tmux attach -t '=${name}'`);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
    console.log(`tmux viewer unavailable (${detail}) — the same lines stream here and live in .duet/runs/${state.runId}/`);
  }
}

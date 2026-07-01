import { randomBytes } from 'node:crypto';
import { execa } from 'execa';

/**
 * PaneController — the injection / process-driving SUB-SEAM, and the ergonomic
 * migration lever. A SEMANTIC interface: no terminal mechanics leak through it,
 * so a future owned-pty adapter satisfies it without contortion and the
 * transport-independent transcript parser is reused unchanged. The dependency
 * arrow that matters: InteractiveClaudeWorker depends on this abstraction, never
 * on tmux.
 *
 * Adapters: `TmuxPane` (today, here), `FakePane` (tests/helpers), and the
 * owned-pty adapter the production path slots in next. The seam is earned twice
 * over (docs/engineering.md §Seams): a test needs it now, and pty is the named
 * second adapter.
 */
export interface PaneController {
  /** Launch the interactive claude session (fresh, or resuming the prior session). */
  open(): Promise<void>;
  /** Atomically deliver the whole prompt text AND submit it — one logical send. */
  submitPrompt(text: string): Promise<void>;
  /** Ready to receive a prompt? Polled by the worker, bounded by the per-turn deadline. */
  pollReady(): Promise<boolean>;
  /** Best-effort teardown — must never raise a new hang (a wedged kill can't become one). */
  kill(): Promise<void>;
}

export interface PaneConfig {
  model: string;
  /** Resume this session id when set (turn 2+); omit for a fresh session (turn 1). */
  sessionId?: string;
  cwd?: string;
}

export type PaneFactory = (config: PaneConfig) => PaneController;

/**
 * The interactive-claude launch command tmux runs, as a token array — extracted
 * as a pure builder so the load-bearing watchdog env is verifiable by test (the
 * tmux-driving glue around it stays untested).
 *
 * It carries `API_FORCE_IDLE_TIMEOUT=1` as a shell env-assignment PREFIX, so the
 * native byte-stream idle watchdog is forced on for THIS launched `claude` —
 * set on the exact command sh runs, NOT inherited from the tmux server env
 * (which may be a stale reuse). `bypassPermissions` is the unattended
 * implementer posture (P4), the same one the headless implementer uses.
 */
export function claudePaneLaunchCommand(config: PaneConfig): string[] {
  const launch = [
    'API_FORCE_IDLE_TIMEOUT=1',
    'claude',
    '--model',
    config.model,
    '--permission-mode',
    'bypassPermissions',
  ];
  if (config.sessionId) launch.push('--resume', config.sessionId);
  return launch;
}

/**
 * The tmux driver adapter — thin, deliberately untested glue, the same boundary
 * as src/tmux-view.ts (a subprocess to tmux). ALL the driving logic lives above
 * it in InteractiveClaudeWorker and is tested via FakePane; this class only owns
 * the terminal mechanics. Its run-scoped session is distinct from the viewer's
 * `duet-<run_id>` — a separate failure domain by design.
 *
 * The exact interactive-claude launch flags, the readiness marker, and the paste
 * mechanics are confirmable only against a real session (the plan's Slice 5):
 * this is a plausible first cut, corrected there.
 */
export class TmuxPane implements PaneController {
  private readonly session = `duet-iclaude-${randomBytes(3).toString('hex')}`;
  private readonly config: PaneConfig;

  constructor(config: PaneConfig) {
    this.config = config;
  }

  private async tmux(...args: string[]): Promise<string> {
    const { stdout } = await execa('tmux', args, { timeout: 10_000 });
    return stdout;
  }

  async open(): Promise<void> {
    // The launch command (incl. the forced watchdog env prefix) comes from the
    // pinned claudePaneLaunchCommand builder; tmux runs the joined string via sh.
    const launch = claudePaneLaunchCommand(this.config);
    const args = ['new-session', '-d', '-s', this.session];
    if (this.config.cwd) args.push('-c', this.config.cwd);
    args.push(launch.join(' '));
    await this.tmux(...args);
  }

  async pollReady(): Promise<boolean> {
    // Heuristic, screen-based — a named spike limitation: the TUI shows its
    // input box once it's ready for a prompt.
    const screen = await this.tmux('capture-pane', '-p', '-t', this.session);
    return screen.includes('│ >') || /\n>\s/.test(screen);
  }

  async submitPrompt(text: string): Promise<void> {
    // Bracketed paste so a multi-line body (often a whole artifact) can't submit
    // a line at a time: load the text into a tmux buffer, paste it with -p, then
    // a separate Enter submits.
    await execa('tmux', ['load-buffer', '-'], { input: text, timeout: 10_000 });
    await this.tmux('paste-buffer', '-p', '-d', '-t', this.session);
    await this.tmux('send-keys', '-t', this.session, 'Enter');
  }

  async kill(): Promise<void> {
    // Best-effort and bounded: a kill that itself wedges must not become a hang.
    await execa('tmux', ['kill-session', '-t', this.session], { timeout: 10_000, reject: false });
  }
}

import type { PaneConfig, PaneController } from '../../src/providers/pane.ts';

/**
 * A scriptable PaneController — the test adapter on the PaneController sub-seam,
 * beside TmuxPane (real) and the owned-pty adapter (later). It records driving
 * at the SEMANTIC level the seam exposes — the submitted text, the readiness
 * polls, the order of open/ready/submit/kill — and never any terminal mechanics
 * (those live inside TmuxPane and are not the worker's contract).
 */
export interface FakePaneOptions {
  /** pollReady returns true once it has been called more than `readyAfter` times (default 0 = ready at once). */
  readyAfter?: number;
  /** Invoked with the exact submitted text — the test grows the transcript here. */
  onSubmit?: (text: string) => void;
  throwOnOpen?: Error;
  throwOnSubmit?: Error;
}

export class FakePane implements PaneController {
  readonly config: PaneConfig;
  /** open / ready:false / ready:true / submit / kill — for ordering assertions. */
  readonly events: string[] = [];
  /** Every submitted body, in order (length asserts "exactly once"). */
  readonly submitted: string[] = [];
  private polls = 0;
  private readonly opts: FakePaneOptions;

  constructor(config: PaneConfig, opts: FakePaneOptions = {}) {
    this.config = config;
    this.opts = opts;
  }

  async open(): Promise<void> {
    this.events.push('open');
    if (this.opts.throwOnOpen) throw this.opts.throwOnOpen;
  }

  async pollReady(): Promise<boolean> {
    const ready = this.polls >= (this.opts.readyAfter ?? 0);
    this.polls += 1;
    this.events.push(`ready:${ready}`);
    return ready;
  }

  async submitPrompt(text: string): Promise<void> {
    this.events.push('submit');
    if (this.opts.throwOnSubmit) throw this.opts.throwOnSubmit;
    this.submitted.push(text);
    this.opts.onSubmit?.(text);
  }

  async kill(): Promise<void> {
    this.events.push('kill');
  }

  get killed(): boolean {
    return this.events.includes('kill');
  }
}

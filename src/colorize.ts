import pc from 'picocolors';
import type { Voice } from './run-store.ts';

/**
 * View-time colorizing for the run logs. The log files themselves stay plain
 * text (they are inspectable-without-duet artifacts — docs/automation-design.md
 * §"Visualization"); color is applied only where a human is watching: the
 * tmux panes (`tail … | duet _colorize <voice>`) and `duet logs`. picocolors
 * auto-disables on non-TTY stdout, NO_COLOR, and TERM=dumb, so piping the
 * colorized streams onward degrades to plain text by itself.
 */

export const ROLE_GLYPH: Record<Voice, string> = {
  orchestrator: '◆',
  implementer: '■',
  reviewer: '●',
};

/** tmux color names for pane borders — same hues the colorizer uses. */
export const ROLE_TMUX_COLOR: Record<Voice, string> = {
  orchestrator: 'cyan',
  implementer: 'blue',
  reviewer: 'yellow',
};

const ROLE_PAINT: Record<Voice, (s: string) => string> = {
  orchestrator: pc.cyan,
  implementer: pc.blue,
  reviewer: pc.yellow,
};

/** `[ISO-timestamp] header` lines as appendVoiceLog writes them. */
const VOICE_HEADER = /^(\[\d{4}-\d{2}-\d{2}T[^\]]+\])\s?(.*)$/;

/**
 * Colorize one line of a voice log: timestamps dimmed, header text in the
 * voice's color (errors red, heartbeats dim). Body lines pass through
 * untouched — only the structural `[timestamp] header` lines are styled.
 */
export function colorizeVoiceLine(voice: Voice, line: string): string {
  const match = VOICE_HEADER.exec(line);
  if (!match) return line;
  const stamp = match[1] ?? '';
  const header = match[2] ?? '';
  const paint = header.startsWith('✗')
    ? pc.red
    : header.startsWith('⏳')
      ? pc.dim
      : ROLE_PAINT[voice];
  return `${pc.dim(stamp)} ${paint(header)}`;
}

/** Driver-narration `[tag]` prefixes — the one palette every view applies. */
const DRIVER_TAG_PAINT: Record<string, (s: string) => string> = {
  '[orchestrator]': pc.cyan,
  '[send_prompt]': pc.green,
  '[ask_human]': pc.yellow,
  '[advance_phase]': pc.yellow,
  '[create_branch]': pc.yellow,
  '[propose_snippet_edit]': pc.yellow,
  '[gate]': pc.magenta,
  '[driver]': pc.red, // infrastructure failures (the runPhase crash backstop)
};

/** Colorize one line of driver narration (`duet logs`): known `[tag]` prefixes only. */
export function colorizeDriverLine(line: string): string {
  for (const [tag, paint] of Object.entries(DRIVER_TAG_PAINT)) {
    if (line.startsWith(tag)) return `${paint(tag)}${line.slice(tag.length)}`;
  }
  return line;
}

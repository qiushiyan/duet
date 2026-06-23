import pc from 'picocolors';
import type { Voice } from './run-store.ts';
import { localClock, relativeAge } from './timefmt.ts';

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
  consultant: '▲',
};

/** tmux color names for pane borders — same hues the colorizer uses. */
export const ROLE_TMUX_COLOR: Record<Voice, string> = {
  orchestrator: 'cyan',
  implementer: 'blue',
  reviewer: 'yellow',
  consultant: 'magenta',
};

const ROLE_PAINT: Record<Voice, (s: string) => string> = {
  orchestrator: pc.cyan,
  implementer: pc.blue,
  reviewer: pc.yellow,
  consultant: pc.magenta,
};

/** `[ISO-timestamp] header` lines as appendVoiceLog writes them (the stored
 *  stamp is always raw UTC ISO — the log artifact; localization is view-time). */
const VOICE_HEADER = /^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]\s?(.*)$/;

/** The activity marker (a producer/colorizer contract — worker-activity.ts
 *  writes it, this keys on it) and the verb→tag map for the promoted line. */
const ACTIVITY_MARKER = '⋯';
const ACTIVITY_TAG: Record<string, string> = { reading: 'read', editing: 'edit', searching: 'search', running: 'run' };

/**
 * Colorize one line of a voice log. Two shapes of header line:
 *   - the `⋯` live-activity line is PROMOTED to `[tag] subject 3m ago` — the
 *     action tag in the voice's color (the most emphasis), the path/subject in
 *     the default fg (secondary), the relative age dimmed (quietest), and the
 *     leading clock dropped (the age IS the time). Promoted on purpose: unlike
 *     the content-free `⏳` heartbeat, an activity line names a concrete action.
 *   - every other header keeps a dim LOCAL clock prefix + the voice's color
 *     (errors red; the `⏳` heartbeat stays dim — ambient telemetry).
 * Body lines pass through untouched. The stored line is unchanged (raw UTC,
 * plain) — this is the view. One caveat: a line is colorized once as it streams
 * through `tail -F | _colorize`, so a relative age is correct when the line
 * lands and does NOT tick afterward; live-ticking would be a larger change.
 */
export function colorizeVoiceLine(voice: Voice, line: string): string {
  const match = VOICE_HEADER.exec(line);
  if (!match) return line;
  const iso = match[1] ?? '';
  const header = match[2] ?? '';
  if (header.startsWith(ACTIVITY_MARKER)) return colorizeActivity(voice, iso, header);
  const paint = header.startsWith('✗') ? pc.red : header.startsWith('⏳') ? pc.dim : ROLE_PAINT[voice];
  return `${pc.dim(localClock(iso))} ${paint(header)}`;
}

/** The promoted activity line render (see colorizeVoiceLine). An unrecognized
 *  verb falls back to the ambient dim form, so a format drift never throws. */
function colorizeActivity(voice: Voice, iso: string, header: string): string {
  const rest = header.slice(ACTIVITY_MARKER.length).trimStart(); // "reading src/foo.ts"
  const sp = rest.indexOf(' ');
  const verb = sp === -1 ? rest : rest.slice(0, sp);
  const subject = sp === -1 ? '' : rest.slice(sp + 1);
  const tag = ACTIVITY_TAG[verb];
  if (tag === undefined) return `${pc.dim(localClock(iso))} ${pc.dim(header)}`;
  return `${ROLE_PAINT[voice](`[${tag}]`)} ${subject} ${pc.dim(relativeAge(iso))}`;
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

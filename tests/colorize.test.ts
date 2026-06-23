import { describe, expect, test } from 'vitest';
import { ROLE_GLYPH, ROLE_TMUX_COLOR, colorizeVoiceLine } from '../src/colorize.ts';

/**
 * View-time colorizing. The consultant is a fourth voice, so the exhaustive
 * Record<Voice> maps (and the line painter) must carry it — a cheap pure guard
 * that the widening reached the view bits.
 */
describe('colorize carries the consultant voice', () => {
  test('the Record<Voice> maps have a consultant entry, distinct from the other voices', () => {
    expect.soft(ROLE_GLYPH.consultant).toBeTruthy();
    expect.soft(ROLE_TMUX_COLOR.consultant).toBeTruthy();
    // A distinct glyph so the panes/logs are visually separable.
    const glyphs = new Set([ROLE_GLYPH.orchestrator, ROLE_GLYPH.implementer, ROLE_GLYPH.reviewer, ROLE_GLYPH.consultant]);
    expect.soft(glyphs.size).toBe(4);
  });

  test('colorizeVoiceLine handles a consultant header line (ROLE_PAINT.consultant resolves)', () => {
    // The load-bearing guard: an undefined ROLE_PAINT[voice] would throw on a
    // header line, so a clean return proves the paint map gained the entry.
    // (picocolors no-ops under vitest's non-TTY, so the exact escapes aren't
    // asserted — colorization is verified TTY-side, not here.)
    const line = '[2026-06-22T12:00:00.000Z] ◀ prompt (tag=consultant-spec, from orchestrator)';
    let painted!: string;
    expect.soft(() => (painted = colorizeVoiceLine('consultant', line))).not.toThrow();
    expect.soft(painted).toContain('◀ prompt');
  });
});

/**
 * The view-time render. picocolors no-ops under vitest's non-TTY, so the escapes
 * aren't asserted — the structure is: the activity line is PROMOTED to
 * `[tag] subject HH:MM` (leading clock dropped, the trailing HH:MM is the
 * action's local time); every other header keeps a LOCAL clock prefix and its
 * painted text. The stored line (raw UTC, plain) is the artifact; this is only
 * how a pane shows it.
 */
describe('colorizeVoiceLine — promoted activity lines', () => {
  // The trailing time is the action's local HH:MM — confirmed via an independent
  // Intl path so the test is timezone-robust and not a tautology of the getters.
  const hm = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date('2026-06-20T12:00:00.000Z'));

  test.for<[string, string]>([
    ['⋯ reading src/foo.ts', `[read] src/foo.ts ${hm}`],
    ['⋯ editing src/foo.ts', `[edit] src/foo.ts ${hm}`],
    ['⋯ searching docs', `[search] docs ${hm}`],
    ['⋯ running git diff', `[run] git diff ${hm}`],
  ])('promotes %s to a tag + subject + local time', ([header, expected]) => {
    const out = colorizeVoiceLine('implementer', `[2026-06-20T12:00:00.000Z] ${header}`);
    expect.soft(out).toBe(expected);
    expect.soft(out).not.toContain('⋯'); // the marker is replaced by the tag
    expect.soft(out).not.toContain('2026-06-20T'); // the raw stamp isn't shown
  });

  test('an unrecognized activity verb falls back to the ambient form, never throws', () => {
    const out = colorizeVoiceLine('implementer', '[2026-06-20T12:00:00.000Z] ⋯ frobnicating x');
    expect.soft(out).toContain('⋯ frobnicating x'); // left as-is under a local clock
    expect.soft(out).not.toContain('2026-06-20T12:00:00.000Z'); // stamp still localized
  });
});

describe('colorizeVoiceLine — non-activity headers get a local clock', () => {
  test('a response header keeps its text and localizes the stamp (no raw UTC)', () => {
    const out = colorizeVoiceLine('implementer', '[2026-06-20T12:34:56.000Z] ▶ response (session impl-1)');
    expect.soft(out).toContain('▶ response (session impl-1)');
    expect.soft(out).not.toContain('2026-06-20T12:34:56.000Z'); // localized, not raw ISO
    const localClock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date('2026-06-20T12:34:56.000Z'));
    expect.soft(out.startsWith(localClock)).toBe(true);
  });

  test('the ⏳ heartbeat stays ambient (text preserved) with a local clock', () => {
    const out = colorizeVoiceLine('orchestrator', '[2026-06-20T12:34:56.000Z] ⏳ awaiting implementer — 5m');
    expect.soft(out).toContain('⏳ awaiting implementer — 5m');
    expect.soft(out).not.toContain('2026-06-20T12:34:56.000Z');
  });

  test('a non-header body line passes through untouched', () => {
    expect(colorizeVoiceLine('implementer', '    some indented body text')).toBe('    some indented body text');
  });
});

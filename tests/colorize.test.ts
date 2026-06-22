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

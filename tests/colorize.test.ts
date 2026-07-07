import { describe, expect, test } from 'vitest';
import { colorizeVoiceLine } from '../src/view/colorize.ts';

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
    const out = colorizeVoiceLine('architect', `[2026-06-20T12:00:00.000Z] ${header}`);
    expect.soft(out).toBe(expected);
    expect.soft(out).not.toContain('⋯'); // the marker is replaced by the tag
    expect.soft(out).not.toContain('2026-06-20T'); // the raw stamp isn't shown
  });

  test('an unrecognized activity verb falls back to the ambient form, never throws', () => {
    const out = colorizeVoiceLine('architect', '[2026-06-20T12:00:00.000Z] ⋯ frobnicating x');
    expect.soft(out).toContain('⋯ frobnicating x'); // left as-is under a local clock
    expect.soft(out).not.toContain('2026-06-20T12:00:00.000Z'); // stamp still localized
  });
});

describe('colorizeVoiceLine — non-activity headers get a local clock', () => {
  test('a response header keeps its text and localizes the stamp (no raw UTC)', () => {
    const out = colorizeVoiceLine('architect', '[2026-06-20T12:34:56.000Z] ▶ response (session impl-1)');
    expect.soft(out).toContain('▶ response (session impl-1)');
    expect.soft(out).not.toContain('2026-06-20T12:34:56.000Z'); // localized, not raw ISO
    const localClock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date('2026-06-20T12:34:56.000Z'));
    expect.soft(out.startsWith(localClock)).toBe(true);
  });

  test('the ⏳ heartbeat stays ambient (text preserved) with a local clock', () => {
    const out = colorizeVoiceLine('orchestrator', '[2026-06-20T12:34:56.000Z] ⏳ awaiting architect — 5m');
    expect.soft(out).toContain('⏳ awaiting architect — 5m');
    expect.soft(out).not.toContain('2026-06-20T12:34:56.000Z');
  });

  test('a non-header body line passes through untouched', () => {
    expect(colorizeVoiceLine('architect', '    some indented body text')).toBe('    some indented body text');
  });
});

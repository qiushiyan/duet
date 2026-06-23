import { describe, expect, test } from 'vitest';
import { localClock, localStamp, localTime } from '../src/timefmt.ts';

/**
 * View-time timestamp helpers. The stored artifact stays UTC ISO; these only
 * render it for a human. Localness is asserted against an INDEPENDENT path
 * (Intl, runtime-local zone) so the test isn't a tautology of the same getters,
 * and is timezone-robust (no hardcoded offset).
 */

const ISO = '2026-06-20T12:34:56.789Z';

describe('localClock — local time-of-day for the dense voice log', () => {
  test('renders local HH:MM:SS (independently confirmed via Intl)', () => {
    const expected = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(ISO));
    expect(localClock(ISO)).toBe(expected);
  });

  test('drops the raw ISO markers (not a UTC slice)', () => {
    const out = localClock(ISO);
    expect.soft(out).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect.soft(out).not.toContain('T');
    expect.soft(out).not.toContain('Z');
  });

  test('a malformed timestamp passes through unchanged (never throws at view time)', () => {
    expect(localClock('not-a-date')).toBe('not-a-date');
  });
});

describe('localStamp — local date+minute for the status/doctor lists', () => {
  test('renders YYYY-MM-DD HH:MM in local time, no ISO markers', () => {
    const out = localStamp(ISO);
    expect.soft(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect.soft(out).not.toContain('T');
    expect.soft(out).not.toContain('Z');
    // The HH:MM portion matches the local clock (independent Intl path).
    const localHm = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ISO));
    expect.soft(out.endsWith(localHm)).toBe(true);
  });

  test('a malformed timestamp passes through unchanged', () => {
    expect(localStamp('whenever')).toBe('whenever');
  });
});

describe('localTime — short local HH:MM for the promoted activity line', () => {
  test('renders local HH:MM (independently confirmed via Intl)', () => {
    const expected = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ISO));
    expect(localTime(ISO)).toBe(expected);
  });

  test('drops the seconds and the raw ISO markers', () => {
    const out = localTime(ISO);
    expect.soft(out).toMatch(/^\d{2}:\d{2}$/);
    expect.soft(out).not.toContain('T');
    expect.soft(out).not.toContain('Z');
  });

  test('a malformed timestamp passes through unchanged', () => {
    expect(localTime('whenever')).toBe('whenever');
  });
});

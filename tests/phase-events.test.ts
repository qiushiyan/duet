import { describe, expect, test } from 'vitest';
import { markerToEvent } from '../src/harness/phase-events.ts';

/**
 * The pure read-side of the cross-process terminal channel. The phase guard is
 * load-bearing: it is what makes a marker re-delivered by a crash (after the
 * snapshot already moved on) a harmless no-op instead of a foreign phase's
 * decision replayed onto the current one.
 */
describe('markerToEvent (phase-guarded terminal channel)', () => {
  test('a marker for the running phase maps to its event', () => {
    expect(markerToEvent({ phase: 'frame', kind: 'advance' }, 'frame')).toEqual({ type: 'phase.advance' });
    expect(markerToEvent({ phase: 'spec', kind: 'flag' }, 'spec')).toEqual({ type: 'phase.flag' });
  });

  test('a marker whose phase does not match the running phase is stale — null', () => {
    expect(markerToEvent({ phase: 'frame', kind: 'advance' }, 'spec')).toBeNull();
    expect(markerToEvent({ phase: 'plan', kind: 'flag' }, 'impl')).toBeNull();
  });

  test('an absent marker is null (the normal continue/crash path writes none)', () => {
    expect(markerToEvent(undefined, 'frame')).toBeNull();
  });
});

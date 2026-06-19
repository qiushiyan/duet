import type { PhaseName } from '../phases.ts';
import type { TerminalMarker } from '../run-store.ts';

/**
 * The machine's internal phase-completion vocabulary — fired by the phase
 * driver (or the stdio host runner) when an orchestrator session reaches its
 * terminal tool call. Valid only from phase states; a gate or flag-wait has no
 * handler for them, so "advance_phase parks but cannot cross" is a property of
 * the vocabulary, not a prompt. Distinct from the `human.*` authority events,
 * which are the only ones a gate transitions on.
 */
export type PhaseEvent = { type: 'phase.advance' } | { type: 'phase.flag' };

/**
 * Map a persisted terminal marker to the phase event it represents — the one
 * place advance/flag is read back from the cross-process channel. Honored ONLY
 * when the marker belongs to `currentPhase`: a marker whose phase no longer
 * matches is stale (a crash re-delivered it after the snapshot already moved
 * on), and returning null routes the caller to its own continue/nudge/flag
 * resolution instead of replaying a foreign phase's decision. Returns null for
 * an absent marker too — the normal continue/crash path writes none.
 */
export function markerToEvent(marker: TerminalMarker | undefined, currentPhase: PhaseName): PhaseEvent | null {
  if (!marker || marker.phase !== currentPhase) return null;
  return marker.kind === 'advance' ? { type: 'phase.advance' } : { type: 'phase.flag' };
}

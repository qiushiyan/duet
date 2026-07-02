import { parseRecords } from './worker-health.ts';

/**
 * Context-pressure policy — the pure substrate behind the mid-turn fill
 * sampler, the context deadline, and the send-gate/nudge guards. The sibling
 * of `worker-health.ts` in both shape and discipline: string/value in, value
 * out, no fs, no clock, no lifecycle imports — the fs tail-read stays in
 * `sessions.ts` and the wiring in `harness/tools.ts` / the claude provider.
 *
 * Why it exists (the 20260701 wedge): a claude session grew 17% → 98% of its
 * 1M window inside one two-hour turn and wedged — every subsequent send
 * bounced off "Prompt is too long" and the run parked ten hours for a
 * mechanical recovery. Headless claude never auto-compacts, so duet owns the
 * bands that keep a persistent session away from its ceiling. Claude-only by
 * design: codex auto-compacts and is never sent `/compact`.
 *
 * The bands (percent of the model's context window, against the HIGH-WATER
 * reading — `contextSafetyPercent`, never the display percent):
 *
 *  - `ok`        < 75%  — no pressure.
 *  - `caution`   ≥ 75%  — compaction is due: still cheap here (it gets slower
 *                         and its post-compact floor higher the longer it
 *                         waits), and the next long turn could reach the
 *                         ceiling. Guards steer (warn-once); nothing blocks.
 *  - `emergency` ≥ 85%  — a non-compact send is refused and a running turn is
 *                         cut: past this line a single burst round (one big
 *                         tool result) can jump the session into over-window
 *                         rejection territory, and the margin also absorbs the
 *                         30s sampling lag and nominal-vs-effective window
 *                         slack (the wedge session was rejected at ~97.8% of
 *                         its NOMINAL window).
 *
 * Constants, not config: tuned from run evidence (the ledger), not per-run
 * knobs.
 */

export const CONTEXT_CAUTION_PERCENT = 75;
export const CONTEXT_EMERGENCY_PERCENT = 85;

export type ContextBand = 'ok' | 'caution' | 'emergency';

/** The band a safety percent falls in (undefined — no reading — is `ok`: guards stand down without telemetry). */
export function contextBand(safetyPercent: number | undefined): ContextBand {
  if (safetyPercent === undefined || safetyPercent < CONTEXT_CAUTION_PERCENT) return 'ok';
  return safetyPercent < CONTEXT_EMERGENCY_PERCENT ? 'caution' : 'emergency';
}

/**
 * The latest request's token total from a CLAUDE transcript tail — the
 * mid-turn half of the context reading, parsed with the same honesty rule as
 * the settle-time extractor (`claudeContextUsage`): the last assistant record
 * whose usage actually billed tokens wins, and a zero-sum usage (the CLI's
 * error echo) is skipped, never taken as "0". The window half is NOT in the
 * transcript — the caller joins this with the last settle's `windowTokens`.
 * Returns undefined when no real usage exists (a fresh or foreign tail).
 */
export function latestTranscriptUsageTokens(jsonl: string): number | undefined {
  let latest: number | undefined;
  for (const record of parseRecords(jsonl)) {
    if (record['type'] !== 'assistant') continue;
    const usage = (record['message'] as { usage?: unknown } | undefined)?.usage;
    if (!usage || typeof usage !== 'object') continue;
    const u = usage as Record<string, unknown>;
    const total =
      (typeof u['input_tokens'] === 'number' ? u['input_tokens'] : 0) +
      (typeof u['cache_read_input_tokens'] === 'number' ? u['cache_read_input_tokens'] : 0) +
      (typeof u['cache_creation_input_tokens'] === 'number' ? u['cache_creation_input_tokens'] : 0) +
      (typeof u['output_tokens'] === 'number' ? u['output_tokens'] : 0);
    if (total > 0) latest = total;
  }
  return latest;
}

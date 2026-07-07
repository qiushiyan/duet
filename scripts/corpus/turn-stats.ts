#!/usr/bin/env node
import { gapsBetweenTurns, parsePhaseWindows, parseVoiceLogTurns, phaseForTurn } from '../../src/surfaces/stats.ts';
import type { ParsedTurn } from '../../src/surfaces/stats.ts';
import { formatDuration } from '../../src/view/timefmt.ts';
import { loadCorpusRecords, parseCorpusCliArgs, printLoadSummary, readLog, workerLogNames } from './lib.ts';

interface Group {
  key: string;
  durations: number[];
  totalMs: number;
}

interface CorpusTurn extends ParsedTurn {
  runId: string;
  workflow: string;
  phase?: string;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index]!;
}

function allTurns(): { turns: CorpusTurn[]; skippedUnloadable: number; skippedForeign: number } {
  const opts = parseCorpusCliArgs(process.argv.slice(2));
  const summary = loadCorpusRecords({ ...(opts.corpusDir ? { corpusDir: opts.corpusDir } : {}), sweepRoots: opts.sweepRoots });
  if (!opts.json) printLoadSummary(summary);
  const turns = summary.records.flatMap((record) =>
    {
      const runStartMs = Date.parse(record.state.createdAt);
      const windows = parsePhaseWindows(readLog(record, 'orchestrator') ?? '', Number.isNaN(runStartMs) ? 0 : runStartMs).windows;
      return workerLogNames(record).flatMap((voice) => {
        const log = readLog(record, voice);
        if (!log) return [];
        return parseVoiceLogTurns(voice, log).turns.map((turn) => {
          const phase = phaseForTurn(windows, turn.startMs);
          return {
            ...turn,
            runId: record.state.runId,
            workflow: record.state.workflow,
            ...(phase ? { phase } : {}),
          };
        });
      });
    },
  );
  if (opts.json) {
    console.log(JSON.stringify({ turns, skippedUnloadable: summary.skippedUnloadable, skippedForeign: summary.skippedForeign }, null, 2));
    return { turns: [], skippedUnloadable: summary.skippedUnloadable, skippedForeign: summary.skippedForeign };
  }
  return { turns, skippedUnloadable: summary.skippedUnloadable, skippedForeign: summary.skippedForeign };
}

function groupedByVoiceTag(turns: readonly ParsedTurn[]): Group[] {
  const groups = new Map<string, Group>();
  for (const turn of turns) {
    const key = `${turn.voice}:${turn.tag}`;
    const group = groups.get(key) ?? { key, durations: [], totalMs: 0 };
    const duration = turn.endMs - turn.startMs;
    group.durations.push(duration);
    group.totalMs += duration;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.totalMs - a.totalMs);
}

function loopCostBucket(turn: CorpusTurn): 'spec-loop' | 'plan-loop' | 'impl-build' | 'impl-review' | undefined {
  if (turn.workflow !== 'full') return undefined;
  if (turn.phase === 'spec') return 'spec-loop';
  if (turn.phase === 'plan') return 'plan-loop';
  if (turn.phase === 'implement') return turn.voice === 'builder' ? 'impl-build' : 'impl-review';
  return undefined;
}

function main(): void {
  const { turns } = allTurns();
  if (turns.length === 0) return;

  console.log('\nduration by voice:tag');
  for (const group of groupedByVoiceTag(turns).slice(0, 40)) {
    const max = Math.max(...group.durations);
    console.log(
      `  ${group.key.padEnd(36)} n=${String(group.durations.length).padStart(3)} median=${formatDuration(percentile(group.durations, 50)).padEnd(6)} p90=${formatDuration(percentile(group.durations, 90)).padEnd(6)} max=${formatDuration(max).padEnd(6)} total=${formatDuration(group.totalMs)}`,
    );
  }

  console.log('\ncompute share by voice');
  const byVoice = new Map<string, number>();
  for (const turn of turns) byVoice.set(turn.voice, (byVoice.get(turn.voice) ?? 0) + (turn.endMs - turn.startMs));
  for (const [voice, ms] of [...byVoice.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${voice.padEnd(16)} ${formatDuration(ms)}`);
  }

  const waste = turns.filter((t) => t.status === 'failed' || t.status === 'timeout');
  console.log('\nfailed / timed-out turns');
  if (waste.length === 0) console.log('  none');
  for (const turn of waste.sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs)).slice(0, 40)) {
    console.log(`  ${turn.status.padEnd(7)} ${turn.voice}:${turn.tag}  ${formatDuration(turn.endMs - turn.startMs)}`);
  }

  console.log('\nreview-loop cost per full run');
  const loopCosts = new Map<string, Record<'spec-loop' | 'plan-loop' | 'impl-build' | 'impl-review', number>>();
  for (const turn of turns) {
    const bucket = loopCostBucket(turn);
    if (!bucket) continue;
    const row = loopCosts.get(turn.runId) ?? { 'spec-loop': 0, 'plan-loop': 0, 'impl-build': 0, 'impl-review': 0 };
    row[bucket] += turn.endMs - turn.startMs;
    loopCosts.set(turn.runId, row);
  }
  if (loopCosts.size === 0) console.log('  none');
  for (const [runId, row] of [...loopCosts.entries()].sort()) {
    console.log(
      `  ${runId} spec-loop=${formatDuration(row['spec-loop']).padEnd(6)} plan-loop=${formatDuration(row['plan-loop']).padEnd(6)} impl-build=${formatDuration(row['impl-build']).padEnd(6)} impl-review=${formatDuration(row['impl-review'])}`,
    );
  }

  // Gaps are within-run idle, so group by run before diffing consecutive turns —
  // a global sort would report the wall-clock span between two separate runs as a gap.
  const byRun = new Map<string, CorpusTurn[]>();
  for (const turn of turns) {
    const list = byRun.get(turn.runId);
    if (list) list.push(turn);
    else byRun.set(turn.runId, [turn]);
  }
  const gaps = [...byRun.values()]
    .flatMap((runTurns) => gapsBetweenTurns(runTurns, 25 * 60_000))
    .sort((a, b) => b.durationMs - a.durationMs);
  console.log('\nbig gaps >25m between worker turns (within a run)');
  if (gaps.length === 0) console.log('  none');
  for (const gap of gaps.slice(0, 40)) {
    console.log(`  ${formatDuration(gap.durationMs).padEnd(6)} after ${gap.before.voice}:${gap.before.tag} → ${gap.after.voice}:${gap.after.tag}`);
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}

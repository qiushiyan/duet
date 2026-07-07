#!/usr/bin/env node
import {
  heartbeatCountBetween,
  parseHeartbeats,
  parseVoiceLogTurns,
} from '../../src/surfaces/stats.ts';
import type { ParsedTurn } from '../../src/surfaces/stats.ts';
import { formatDuration } from '../../src/view/timefmt.ts';
import { loadCorpusRecords, parseCorpusCliArgs, printLoadSummary, readLog, workerLogNames } from './lib.ts';

interface CompactionTurn extends ParsedTurn {
  runId: string;
  heartbeats: number;
}

function isCompactionLike(turn: ParsedTurn): boolean {
  return /compact|reread|recover/i.test(turn.tag);
}

function main(): void {
  const opts = parseCorpusCliArgs(process.argv.slice(2));
  const summary = loadCorpusRecords({ ...(opts.corpusDir ? { corpusDir: opts.corpusDir } : {}), sweepRoots: opts.sweepRoots });
  const turns: CompactionTurn[] = [];
  for (const record of summary.records) {
    for (const voice of workerLogNames(record)) {
      const log = readLog(record, voice);
      if (!log) continue;
      // Heartbeats come from the WORKER log (ISO-stamped `⏳ … elapsed`), not
      // driver.log — whose `[send_prompt]`-prefixed copy carries no timestamp to
      // parse. Same 5-minute cadence, so the count inside a turn window is the
      // machine-awake cross-check (few heartbeats in a long turn ⇒ a suspend).
      const heartbeats = parseHeartbeats(log);
      for (const turn of parseVoiceLogTurns(voice, log).turns.filter(isCompactionLike)) {
        turns.push({
          ...turn,
          runId: record.state.runId,
          heartbeats: heartbeatCountBetween(heartbeats, turn.startMs, turn.endMs),
        });
      }
    }
  }
  turns.sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs));
  if (opts.json) {
    console.log(JSON.stringify({ turns, skippedUnloadable: summary.skippedUnloadable, skippedForeign: summary.skippedForeign }, null, 2));
    return;
  }
  printLoadSummary(summary);
  console.log('\ncompaction / reread / recover turns');
  if (turns.length === 0) {
    console.log('  none');
    return;
  }
  for (const turn of turns) {
    const duration = turn.endMs - turn.startMs;
    const outlier = duration > 10 * 60_000 ? '  !>10m' : '';
    console.log(
      `  ${formatDuration(duration).padEnd(6)} hb=${String(turn.heartbeats).padStart(2)} ${turn.runId} ${turn.voice}:${turn.tag}${outlier}`,
    );
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}

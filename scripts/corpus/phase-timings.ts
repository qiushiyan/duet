#!/usr/bin/env node
import { parseCorpusCliArgs, loadCorpusRecords, printLoadSummary, readLog, workerLogNames } from './lib.ts';
import {
  parsePhaseWindows,
  parseVoiceLogTurns,
  unionDurationMs,
} from '../../src/surfaces/stats.ts';
import { formatDuration } from '../../src/view/timefmt.ts';

interface PhaseTimingRow {
  runId: string;
  phase: string;
  spanMs: number;
  busyMs: number;
  orchGapMs: number;
  turns: number;
  failed: number;
  timeout: number;
}

function rowsForRecord(record: ReturnType<typeof loadCorpusRecords>['records'][number]): { rows: PhaseTimingRow[]; idleAtGatesMs: number } {
  const orchestratorLog = readLog(record, 'orchestrator');
  if (!orchestratorLog) return { rows: [], idleAtGatesMs: 0 };
  const runStartMs = Date.parse(record.state.createdAt);
  const windows = parsePhaseWindows(orchestratorLog, Number.isNaN(runStartMs) ? 0 : runStartMs).windows;
  const turns = workerLogNames(record).flatMap((voice) => {
    const log = readLog(record, voice);
    return log ? parseVoiceLogTurns(voice, log).turns : [];
  });
  // Attribute each turn to its FIRST containing window, so a turn starting on a
  // boundary shared by two windows counts once — matching stats.ts phaseForTurn.
  const windowIndexOf = (startMs: number): number =>
    windows.findIndex((w) => startMs >= w.startMs && startMs <= w.endMs);
  const rows = windows.map((w, i) => {
    const phaseTurns = turns.filter((t) => windowIndexOf(t.startMs) === i);
    const spanMs = w.endMs - w.startMs;
    const busyMs = unionDurationMs(phaseTurns);
    return {
      runId: record.state.runId,
      phase: w.phase,
      spanMs,
      busyMs,
      orchGapMs: Math.max(0, spanMs - busyMs),
      turns: phaseTurns.length,
      failed: phaseTurns.filter((t) => t.status === 'failed').length,
      timeout: phaseTurns.filter((t) => t.status === 'timeout').length,
    };
  });
  const sorted = [...windows].sort((a, b) => a.startMs - b.startMs);
  let idleAtGatesMs = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    idleAtGatesMs += Math.max(0, sorted[i]!.startMs - sorted[i - 1]!.endMs);
  }
  return { rows, idleAtGatesMs };
}

function main(): void {
  const opts = parseCorpusCliArgs(process.argv.slice(2));
  const summary = loadCorpusRecords({ ...(opts.corpusDir ? { corpusDir: opts.corpusDir } : {}), sweepRoots: opts.sweepRoots });
  const perRun = summary.records.map((record) => ({ record, ...rowsForRecord(record) }));
  const rows = perRun.flatMap((r) => r.rows);
  if (opts.json) {
    console.log(JSON.stringify({ rows, skippedUnloadable: summary.skippedUnloadable, skippedForeign: summary.skippedForeign }, null, 2));
    return;
  }
  printLoadSummary(summary);
  for (const { record, rows: runRows, idleAtGatesMs } of perRun) {
    if (runRows.length === 0) continue;
    console.log(`\n${record.state.runId}  ${record.state.workflow}  idle@gates=${formatDuration(idleAtGatesMs)}`);
    for (const row of runRows) {
      const flags = row.timeout || row.failed ? `  !${row.timeout}TO/${row.failed}fail` : '';
      console.log(
        `  ${row.phase.padEnd(10)} span=${formatDuration(row.spanMs).padEnd(6)} busy=${formatDuration(row.busyMs).padEnd(6)} orchGap=${formatDuration(row.orchGapMs).padEnd(6)} turns=${String(row.turns).padStart(2)}${flags}`,
      );
    }
  }
  const span = rows.reduce((sum, r) => sum + r.spanMs, 0);
  const busy = rows.reduce((sum, r) => sum + r.busyMs, 0);
  const idle = perRun.reduce((sum, r) => sum + r.idleAtGatesMs, 0);
  console.log(`\naggregate: span=${formatDuration(span)} busy=${formatDuration(busy)} orchGap=${formatDuration(Math.max(0, span - busy))} idle@gates=${formatDuration(idle)}`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}

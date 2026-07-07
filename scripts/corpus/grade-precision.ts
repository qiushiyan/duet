#!/usr/bin/env node
import { decisionPoints } from '../../src/surfaces/decision-points.ts';
import type { DecisionPoint } from '../../src/surfaces/decision-points.ts';
import type { Grade } from '../../src/run/store.ts';
import { loadCorpusRecords, parseCorpusCliArgs, printLoadSummary, readLog } from './lib.ts';

interface Agg {
  group: string;
  key: string;
  graded: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  missed: number;
}

interface Row extends Agg {
  overFlagRate?: number;
  underFlagRate?: number;
}

function empty(group: string, key: string): Agg {
  return { group, key, graded: 0, tp: 0, fp: 0, tn: 0, fn: 0, missed: 0 };
}

function cell(point: DecisionPoint, grade: Grade): 'tp' | 'fp' | 'tn' | 'fn' {
  if (point.polarity === 'stopped') return grade.verdict === 'right' ? 'tp' : 'fp';
  return grade.verdict === 'right' ? 'tn' : 'fn';
}

function monthOf(grade: Grade): string {
  return grade.gradedAt.slice(0, 7) || 'unknown';
}

function add(groups: Map<string, Agg>, group: string, key: string, cellName: 'tp' | 'fp' | 'tn' | 'fn', missed = false): void {
  const id = `${group}:${key}`;
  const agg = groups.get(id) ?? empty(group, key);
  agg.graded += 1;
  agg[cellName] += 1;
  if (missed) agg.missed += 1;
  groups.set(id, agg);
}

function rows(): { rows: Row[]; skippedUnloadable: number; skippedForeign: number } {
  const opts = parseCorpusCliArgs(process.argv.slice(2));
  const summary = loadCorpusRecords({ ...(opts.corpusDir ? { corpusDir: opts.corpusDir } : {}), sweepRoots: opts.sweepRoots });
  if (!opts.json) printLoadSummary(summary);
  const groups = new Map<string, Agg>();

  for (const record of summary.records) {
    if (!record.state.grades?.length) continue;
    const discovery = decisionPoints(record.state, readLog(record, 'orchestrator'));
    const byKey = new Map<string, DecisionPoint>(discovery.points.map((point) => [point.key, point]));
    for (const grade of record.state.grades) {
      const missed = grade.key.startsWith('missed:');
      const point = byKey.get(grade.key);
      const cellName = missed ? 'fn' : point ? cell(point, grade) : undefined;
      if (!cellName) continue;
      const phase = missed ? (grade.key.split(':')[1] ?? 'unknown') : point!.phase;
      const kind = missed ? 'missed' : point!.kind;
      for (const [group, key] of [
        ['all', 'all'],
        ['workflow', record.state.workflow],
        ['phase', phase],
        ['kind', kind],
        ['month', monthOf(grade)],
      ] as const) {
        add(groups, group, key, cellName, missed);
      }
    }
  }

  return {
    rows: [...groups.values()]
      .map((agg) => {
        const stopped = agg.tp + agg.fp;
        const didNotStop = agg.tn + agg.fn;
        return {
          ...agg,
          ...(stopped > 0 ? { overFlagRate: agg.fp / stopped } : {}),
          ...(didNotStop > 0 ? { underFlagRate: agg.fn / didNotStop } : {}),
        };
      })
      .sort((a, b) => a.group.localeCompare(b.group) || b.graded - a.graded || a.key.localeCompare(b.key)),
    skippedUnloadable: summary.skippedUnloadable,
    skippedForeign: summary.skippedForeign,
  };
}

function pct(value: number | undefined): string {
  return value === undefined ? '—' : `${Math.round(value * 100)}%`;
}

function main(): void {
  const opts = parseCorpusCliArgs(process.argv.slice(2));
  const result = rows();
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log('\ndecision grade precision');
  if (result.rows.length === 0) {
    console.log('  none');
    return;
  }
  for (const row of result.rows) {
    console.log(
      `  ${row.group}:${row.key}`.padEnd(28) +
        ` graded=${String(row.graded).padStart(3)} TP=${row.tp} FP=${row.fp} TN=${row.tn} FN=${row.fn} missed=${row.missed} over=${pct(row.overFlagRate)} under=${pct(row.underFlagRate)}`,
    );
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}

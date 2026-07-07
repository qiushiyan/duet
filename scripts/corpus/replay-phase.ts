#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { basename } from 'node:path';
import { budgetFor } from '../../src/run/store.ts';
import type { PhaseName } from '../../src/registry/workflows.ts';
import type { RunOrchestratorTurn } from '../../src/orchestrator/hosts/driver.ts';
import { prepareReplayPhase, runReplayPhase } from '../../src/replay/run.ts';
import type { ReplayPhaseResult } from '../../src/replay/run.ts';
import { loadCorpusRecords, printLoadSummary, resolvePath } from './lib.ts';
import type { CorpusRecord, LoadSummary } from './lib.ts';

interface ReplayPhaseCliOptions {
  readonly corpusDir?: string;
  readonly record: string;
  readonly phase: PhaseName;
  readonly outDir: string;
  readonly json: boolean;
  readonly yes: boolean;
  readonly dryRun: boolean;
}

export interface ReplayPhaseCliDeps {
  readonly loadRecords?: (opts: { corpusDir?: string }) => LoadSummary;
  readonly runTurn?: RunOrchestratorTurn;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

export async function runReplayPhaseCli(argv: readonly string[], deps: ReplayPhaseCliDeps = {}): Promise<ReplayPhaseResult | { dryRun: true } | { gated: true }> {
  const out = deps.stdout ?? console.log;
  const opts = parseReplayPhaseArgs(argv);
  const summary = (deps.loadRecords ?? loadCorpusRecords)({ ...(opts.corpusDir ? { corpusDir: opts.corpusDir } : {}) });
  if (!opts.json) printLoadSummary(summary);
  const record = selectRecord(summary.records, opts.record);
  const outDir = resolvePath(opts.outDir);
  if (!opts.dryRun && !opts.yes) {
    printCostGate(record, opts.phase, outDir, out);
    return { gated: true };
  }
  if (opts.dryRun) {
    const prepared = prepareReplayPhase({
      record,
      phase: opts.phase,
      outputDir: outDir,
    });
    if (opts.json) {
      out(
        JSON.stringify(
          {
            dryRun: true,
            record: prepared.recordId,
            phase: prepared.phase,
            outputDir: prepared.outputDir,
            replayRunDir: prepared.runDir,
            reconstructionNotes: prepared.reconstructionNotes,
          },
          null,
          2,
        ),
      );
    } else {
      out(`dry-run: ${prepared.recordId} ${prepared.phase}`);
      out(`output: ${prepared.outputDir}`);
      out(`replay run dir: ${prepared.runDir}`);
      out('reconstruction notes:');
      for (const note of prepared.reconstructionNotes) out(`- ${note}`);
    }
    return { dryRun: true };
  }
  printCostGate(record, opts.phase, outDir, out);
  const result = await runReplayPhase({
    record,
    phase: opts.phase,
    outputDir: outDir,
    ...(deps.runTurn ? { runTurn: deps.runTurn } : {}),
  });
  if (opts.json) out(JSON.stringify(result.report, null, 2));
  else {
    out(`text report: ${result.textReportPath}`);
    out(`json report: ${result.jsonReportPath}`);
  }
  return result;

  function selectRecord(records: readonly CorpusRecord[], selector: string): CorpusRecord {
    const selected = records.find((candidate) => candidate.state.runId === selector || basename(candidate.runDir) === selector || candidate.runDir === resolvePath(selector));
    if (!selected) throw new Error(`record ${selector} not found`);
    return selected;
  }

  function printCostGate(record: CorpusRecord, phase: PhaseName, outputDir: string, write: (line: string) => void): void {
    const binding = record.state.bindings.orchestrator;
    const budget = budgetFor(record.state, phase);
    write(`record: ${record.state.runId}`);
    write(`phase: ${phase}`);
    write(`output: ${outputDir}`);
    write(`orchestrator: ${binding.provider}${binding.model ? `:${binding.model}` : ''}${binding.effort ? `@${binding.effort}` : ''}`);
    write(`budget: ${budget.orchestrator === undefined ? 'uncapped' : `$${budget.orchestrator.toFixed(2)}`}`);
    write('This replay runs a fresh live orchestrator SDK session and spends real orchestrator tokens. Re-run with --yes to proceed.');
  }
}

export function parseReplayPhaseArgs(argv: readonly string[]): ReplayPhaseCliOptions {
  let corpusDir: string | undefined;
  let record: string | undefined;
  let phase: PhaseName | undefined;
  let outDir: string | undefined;
  let json = false;
  let yes = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') throw new Error(usage());
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--yes') {
      yes = true;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--corpus') {
      const next = argv[++i];
      if (!next) throw new Error('--corpus needs a directory');
      corpusDir = resolvePath(next);
      continue;
    }
    if (arg === '--record') {
      const next = argv[++i];
      if (!next) throw new Error('--record needs a run id or record directory');
      record = next;
      continue;
    }
    if (arg === '--phase') {
      const next = argv[++i];
      if (!next) throw new Error('--phase needs a phase name');
      phase = next as PhaseName;
      continue;
    }
    if (arg === '--out') {
      const next = argv[++i];
      if (!next) throw new Error('--out needs a directory');
      outDir = next;
      continue;
    }
    throw new Error(`unknown argument ${arg}\n${usage()}`);
  }
  if (!record) throw new Error(`--record is required\n${usage()}`);
  if (!phase) throw new Error(`--phase is required\n${usage()}`);
  if (!outDir) throw new Error(`--out is required\n${usage()}`);
  return { ...(corpusDir ? { corpusDir } : {}), record, phase, outDir, json, yes, dryRun };
}

function usage(): string {
  return [
    'usage: replay-phase --record <run-id> --phase <phase> --out <dir> [--corpus <dir>] [--dry-run] [--json] [--yes]',
    '',
    '--yes is required for a live replay because it spends real orchestrator tokens.',
    '--dry-run does not invoke the SDK, but it does write the isolated replay workspace under --out.',
  ].join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runReplayPhaseCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

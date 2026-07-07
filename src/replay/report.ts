import type { ReplayDiff, SendComparison, TerminalComparison } from './diff.ts';

export interface ReplayReport {
  readonly record: {
    readonly id: string;
    readonly phase: string;
  };
  readonly outputDir: string;
  readonly reconstructionNotes: readonly string[];
  readonly freshRuns: readonly FreshReplayRunReport[];
}

export interface FreshReplayRunReport {
  readonly id: string;
  readonly outcome?: string;
  readonly diff: ReplayDiff;
}

export interface BuildReplayReportInput {
  readonly recordId: string;
  readonly phase: string;
  readonly outputDir: string;
  readonly reconstructionNotes: readonly string[];
  readonly freshRun: FreshReplayRunReport;
}

export function buildReplayReport(input: BuildReplayReportInput): ReplayReport {
  return {
    record: { id: input.recordId, phase: input.phase },
    outputDir: input.outputDir,
    reconstructionNotes: [...input.reconstructionNotes],
    freshRuns: [input.freshRun],
  };
}

export function renderReplayReportJson(report: ReplayReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderReplayReportText(report: ReplayReport): string {
  const lines: string[] = [];
  lines.push(`# Corpus Replay: ${report.record.id} ${report.record.phase}`);
  lines.push('');
  lines.push(`Output: ${report.outputDir}`);
  lines.push('');
  lines.push('## Reconstruction');
  if (report.reconstructionNotes.length === 0) {
    lines.push('- none');
  } else {
    for (const note of report.reconstructionNotes) lines.push(`- ${note}`);
  }
  for (const run of report.freshRuns) {
    lines.push('');
    lines.push(`## Fresh Run: ${run.id}`);
    if (run.outcome) lines.push(`Outcome: ${run.outcome}`);
    lines.push(`First structural divergence: ${run.diff.firstStructuralDivergence ?? 'none'}`);
    lines.push('');
    lines.push('### Snippet Routing');
    if (run.diff.sends.length === 0) {
      lines.push('- no worker sends');
    } else {
      for (const send of run.diff.sends) lines.push(...renderSend(send));
    }
    lines.push('');
    lines.push('### Terminal');
    lines.push(...renderTerminal(run.diff.terminal));
  }
  return `${lines.join('\n')}\n`;
}

function renderSend(send: SendComparison): string[] {
  const lines: string[] = [];
  const original = send.original ? `${send.original.duties.join('+')} ${send.original.tag} #${formatOrdinals(send.original.ordinalsByDuty)}` : 'missing';
  const fresh = send.fresh ? `${send.fresh.duties.join('+')} ${send.fresh.tag} #${formatOrdinals(send.fresh.ordinalsByDuty)}` : 'missing';
  const status = send.unanchored ? 'post-divergence, not comparable' : send.structural ? `structural: ${send.structural}` : send.adaptation ? 'adaptation drift' : 'aligned';
  lines.push(`- [${send.index}] ${status}`);
  lines.push(`  original: ${original}`);
  lines.push(`  fresh: ${fresh}`);
  if (send.compactCascade) lines.push('  note: compact-bodied turn; later ordinal shifts may cascade');
  if (send.adaptation && !send.unanchored) {
    lines.push(`  original body: ${oneLine(send.adaptation.originalBody)}`);
    lines.push(`  fresh body: ${oneLine(send.adaptation.freshBody)}`);
  }
  return lines;
}

function renderTerminal(terminal: TerminalComparison): string[] {
  const original = terminal.original ? `${terminal.original.verb}: ${oneLine(terminal.original.body)}` : 'missing';
  const fresh = terminal.fresh ? `${terminal.fresh.verb}: ${oneLine(terminal.fresh.body)}` : 'missing';
  return [`- status: ${terminal.structural ? `structural: ${terminal.structural}` : 'aligned'}`, `- original: ${original}`, `- fresh: ${fresh}`];
}

function formatOrdinals(ordinalsByDuty: Readonly<Record<string, number>>): string {
  return Object.entries(ordinalsByDuty)
    .map(([duty, ordinal]) => `${duty}:${ordinal}`)
    .join(',');
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

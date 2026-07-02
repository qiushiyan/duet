/**
 * Context-accuracy probe — executable evidence (src/spike/ house pattern) that
 * the context-guard readers match REAL Claude Code transcripts on this machine,
 * re-runnable after a CLI upgrade the way the other pinned facts are re-verified.
 *
 * What it checks, against ~/.claude/projects (read-only):
 *
 *  1. GROUND TRUTH REPLAY — on a transcript containing a `compact_boundary`
 *     record, the CLI's own `compactMetadata.preTokens` is its accounting of
 *     the pre-compact fill. Our parser, run over the records BEFORE that
 *     boundary, should land within a few percent of it.
 *  2. ERROR-ECHO SHAPE — the zero-skip rule assumes an `isApiErrorMessage`
 *     assistant record carries zero/absent usage. Dump the real shapes.
 *  3. SIDECHAIN RISK — subagent (isSidechain) assistant records carry the
 *     SUBAGENT's usage, not the session's. Count them and measure how far the
 *     naive last-usage read diverges from a mainline-only read.
 *  4. TAIL-WINDOW COVERAGE — within the final 256KB (the sessions.ts tail
 *     read), is there a usage-bearing mainline assistant record? Plus the max
 *     single-record size seen.
 *  5. EFFECTIVE CEILING — the last accepted fill before a "Prompt is too long"
 *     rejection, as percent of the nominal window (the margin evidence).
 *
 * Usage: node src/spike/context-probe.ts [transcript.jsonl ...]
 * With no args it scans every *.jsonl under ~/.claude/projects modified in the
 * last 14 days (bounded, newest first, max 40 files).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { latestTranscriptUsageTokens } from '../context-guard.ts';
import { parseRecords } from '../worker-health.ts';
import type { JsonRecord } from '../worker-health.ts';

const TAIL_BYTES = 262_144; // sessions.ts readTranscriptTailAtPath default

function usageTotal(record: JsonRecord): number | undefined {
  const usage = (record['message'] as { usage?: unknown } | undefined)?.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const n = (k: string): number => (typeof u[k] === 'number' ? (u[k] as number) : 0);
  return n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens') + n('output_tokens');
}

function lastMainlineUsage(records: JsonRecord[]): number | undefined {
  let latest: number | undefined;
  for (const r of records) {
    if (r['type'] !== 'assistant' || r['isSidechain'] === true) continue;
    const total = usageTotal(r);
    if (total !== undefined && total > 0) latest = total;
  }
  return latest;
}

function probe(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  const records = parseRecords(raw);
  if (records.length === 0) return;

  const assistants = records.filter((r) => r['type'] === 'assistant');
  const sidechainAssistants = assistants.filter((r) => r['isSidechain'] === true);
  const usageBearing = assistants.filter((r) => (usageTotal(r) ?? 0) > 0);
  const zeroUsage = assistants.filter((r) => usageTotal(r) === 0);
  const apiErrors = records.filter((r) => r['isApiErrorMessage'] === true);

  const lines = raw.split('\n').filter((l) => l.trim().startsWith('{'));
  const maxRecordBytes = Math.max(0, ...lines.map((l) => Buffer.byteLength(l)));

  // What the REAL tail read would see (mirror sessions.ts: cut at the first
  // newline after the byte offset), parsed by the REAL production parser.
  const size = Buffer.byteLength(raw);
  let tailJsonl = raw;
  if (size > TAIL_BYTES) {
    const tailBuf = Buffer.from(raw).subarray(size - TAIL_BYTES);
    const s = tailBuf.toString('utf8');
    const nl = s.indexOf('\n');
    tailJsonl = nl === -1 ? '' : s.slice(nl + 1);
  }
  const tailNaive = latestTranscriptUsageTokens(tailJsonl);
  const tailMainline = lastMainlineUsage(parseRecords(tailJsonl));
  const fullMainline = lastMainlineUsage(records);

  console.log(`\n=== ${path}`);
  console.log(
    `  records=${records.length} assistants=${assistants.length} usage-bearing=${usageBearing.length} zero-usage=${zeroUsage.length} sidechain-assistants=${sidechainAssistants.length} api-errors=${apiErrors.length} maxRecordBytes=${maxRecordBytes}`,
  );
  console.log(
    `  last-usage: naive(tail)=${tailNaive ?? '—'} mainline(tail)=${tailMainline ?? '—'} mainline(full)=${fullMainline ?? '—'}${
      tailNaive !== undefined && tailMainline !== undefined && tailNaive !== tailMainline
        ? '  ⚠ SIDECHAIN DIVERGENCE in the tail window'
        : ''
    }${tailMainline === undefined && fullMainline !== undefined ? '  ⚠ TAIL WINDOW MISSED every mainline usage record' : ''}`,
  );

  // (2) error-echo usage shapes — the zero-skip rule's real-world evidence.
  for (const e of apiErrors.slice(-3)) {
    const total = usageTotal(e);
    const text = JSON.stringify((e['message'] as { content?: unknown } | undefined)?.content ?? '').slice(0, 90);
    console.log(`  api-error record: ts=${String(e['timestamp'] ?? '?')} usageTotal=${total ?? 'ABSENT'} content≈${text}`);
  }

  // (1)+(5) ground truth: compact boundaries and over-window rejections.
  let beforeBoundary: number | undefined;
  for (const r of records) {
    if (r['type'] === 'assistant' && r['isSidechain'] !== true) {
      const t = usageTotal(r);
      if (t !== undefined && t > 0) beforeBoundary = t;
    }
    if (r['subtype'] === 'compact_boundary') {
      const meta = r['compactMetadata'] as { preTokens?: number; trigger?: string } | undefined;
      const pre = meta?.preTokens;
      const drift = pre && beforeBoundary ? (((beforeBoundary - pre) / pre) * 100).toFixed(2) : '—';
      console.log(
        `  compact_boundary (${meta?.trigger ?? '?'}): CLI preTokens=${pre ?? '?'} vs our last mainline usage before it=${beforeBoundary ?? '—'} (drift ${drift}%)`,
      );
    }
    const isOverflow =
      r['isApiErrorMessage'] === true &&
      JSON.stringify((r['message'] as { content?: unknown } | undefined)?.content ?? '').toLowerCase().includes('prompt is too long');
    if (isOverflow && beforeBoundary !== undefined) {
      console.log(`  "Prompt is too long" rejected with last accepted fill=${beforeBoundary} (${((beforeBoundary / 1_000_000) * 100).toFixed(1)}% of a 1M window)`);
    }
  }
}

const args = process.argv.slice(2);
if (args.length > 0) {
  for (const p of args) probe(p);
} else {
  const root = join(homedir(), '.claude', 'projects');
  const cutoff = Date.now() - 14 * 24 * 3_600_000;
  const found: Array<{ p: string; mtime: number }> = [];
  for (const dir of readdirSync(root)) {
    let entries: string[];
    try {
      entries = readdirSync(join(root, dir));
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(root, dir, f);
      try {
        const st = statSync(p);
        if (st.mtimeMs >= cutoff && st.size > 10_000) found.push({ p, mtime: st.mtimeMs });
      } catch {
        // unreadable — skip
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  for (const { p } of found.slice(0, 40)) probe(p);
}

import { describe, expect, test } from 'vitest';
import { buildReplayReport, renderReplayReportJson, renderReplayReportText } from '../src/replay/report.ts';
import type { ReplayDiff } from '../src/replay/diff.ts';

const diff: ReplayDiff = {
  firstStructuralDivergence: 'send_prompt[1]: snippet tag changed from review-design to update-design',
  unanchoredFromIndex: 1,
  sends: [
    {
      index: 0,
      original: { duties: ['architect'], tag: 'write-design', body: 'write original', compact: false, ordinalsByDuty: { architect: 1 } },
      fresh: { duties: ['architect'], tag: 'write-design', body: 'write fresh', compact: false, ordinalsByDuty: { architect: 1 } },
      adaptation: { originalBody: 'write original', freshBody: 'write fresh' },
    },
    {
      index: 1,
      original: { duties: ['analyst'], tag: 'review-design', body: '/compact\nreview', compact: true, ordinalsByDuty: { analyst: 1 } },
      fresh: { duties: ['analyst'], tag: 'update-design', body: '/compact\nreview', compact: true, ordinalsByDuty: { analyst: 1 } },
      structural: 'snippet tag changed from review-design to update-design',
      compactCascade: true,
    },
    {
      index: 2,
      original: { duties: ['architect'], tag: 'update-design', body: 'original tail', compact: false, ordinalsByDuty: { architect: 2 } },
      fresh: { duties: ['architect'], tag: 'update-design', body: 'fresh tail', compact: false, ordinalsByDuty: { architect: 2 } },
      unanchored: true,
    },
  ],
  terminal: {
    original: { verb: 'advance_phase', body: 'original summary' },
    fresh: { verb: 'ask_human', body: 'Need a call?' },
    structural: 'terminal verb changed from advance_phase to ask_human',
  },
};

describe('replay report rendering', () => {
  test('renders text with reconstruction notes, structural drift, adaptation drift, unanchored tail, and terminal diff', () => {
    const report = buildReplayReport({
      recordId: '20260707-0647-0dbb',
      phase: 'design',
      outputDir: '/tmp/replay',
      reconstructionNotes: ['list_snippets served from current snippet library'],
      freshRun: { id: 'fresh-1', outcome: 'flagged', diff },
    });

    const text = renderReplayReportText(report);
    expect.soft(text).toContain('# Corpus Replay: 20260707-0647-0dbb design');
    expect.soft(text).toContain('- list_snippets served from current snippet library');
    expect.soft(text).toContain('First structural divergence: send_prompt[1]: snippet tag changed from review-design to update-design');
    expect.soft(text).toContain('- [0] adaptation drift');
    expect.soft(text).toContain('- [1] structural: snippet tag changed from review-design to update-design');
    expect.soft(text).toContain('- [2] post-divergence, not comparable');
    expect.soft(text).toContain('note: compact-bodied turn; later ordinal shifts may cascade');
    expect.soft(text).toContain('- status: structural: terminal verb changed from advance_phase to ask_human');
  });

  test('renders JSON with a repeat-friendly freshRuns array', () => {
    const report = buildReplayReport({
      recordId: 'record-a',
      phase: 'design',
      outputDir: '/tmp/replay',
      reconstructionNotes: [],
      freshRun: { id: 'fresh-1', diff },
    });

    const parsed = JSON.parse(renderReplayReportJson(report));
    expect.soft(parsed.freshRuns).toHaveLength(1);
    expect.soft(parsed.freshRuns[0].diff.firstStructuralDivergence).toBe(diff.firstStructuralDivergence);
    expect.soft(parsed.record).toEqual({ id: 'record-a', phase: 'design' });
  });
});

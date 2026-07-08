import { describe, expect, test } from 'vitest';
import { buildReplayReport, renderReplayReportJson, renderReplayReportText } from '../src/replay/report.ts';
import type { ReplayDiff } from '../src/replay/diff.ts';

const diff: ReplayDiff = {
  firstStructuralDivergence: 'send_prompt[1]: snippet tag changed from review-spec to update-spec',
  unanchoredFromIndex: 1,
  sends: [
    {
      index: 0,
      original: { duties: ['architect'], tag: 'write-spec', body: 'write original', compact: false, ordinalsByDuty: { architect: 1 } },
      fresh: { duties: ['architect'], tag: 'write-spec', body: 'write fresh', compact: false, ordinalsByDuty: { architect: 1 } },
      adaptation: { originalBody: 'write original', freshBody: 'write fresh' },
    },
    {
      index: 1,
      original: { duties: ['analyst'], tag: 'review-spec', body: '/compact\nreview', compact: true, ordinalsByDuty: { analyst: 1 } },
      fresh: { duties: ['analyst'], tag: 'update-spec', body: '/compact\nreview', compact: true, ordinalsByDuty: { analyst: 1 } },
      structural: 'snippet tag changed from review-spec to update-spec',
      compactCascade: true,
    },
    {
      index: 2,
      original: { duties: ['architect'], tag: 'update-spec', body: 'original tail', compact: false, ordinalsByDuty: { architect: 2 } },
      fresh: { duties: ['architect'], tag: 'update-spec', body: 'fresh tail', compact: false, ordinalsByDuty: { architect: 2 } },
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
      phase: 'spec',
      outputDir: '/tmp/replay',
      reconstructionNotes: ['raw historical list_snippets tool output is not recorded; replay serves the current snippet library if list_snippets is called'],
      freshRun: { id: 'fresh-1', outcome: 'flagged', diff },
    });

    const text = renderReplayReportText(report);
    expect.soft(text).toContain('# Corpus Replay: 20260707-0647-0dbb spec');
    expect
      .soft(text)
      .toContain('- raw historical list_snippets tool output is not recorded; replay serves the current snippet library if list_snippets is called');
    expect.soft(text).toContain('First structural divergence: send_prompt[1]: snippet tag changed from review-spec to update-spec');
    expect.soft(text).toContain('- [0] adaptation drift');
    expect.soft(text).toContain('- [1] structural: snippet tag changed from review-spec to update-spec');
    expect.soft(text).toContain('- [2] post-divergence, not comparable');
    expect.soft(text).toContain('note: compact-bodied turn; later ordinal shifts may cascade');
    expect.soft(text).toContain('- status: structural: terminal verb changed from advance_phase to ask_human');
  });

  test('renders JSON with a repeat-friendly freshRuns array', () => {
    const report = buildReplayReport({
      recordId: 'record-a',
      phase: 'spec',
      outputDir: '/tmp/replay',
      reconstructionNotes: [],
      freshRun: { id: 'fresh-1', diff },
    });

    const parsed = JSON.parse(renderReplayReportJson(report));
    expect.soft(parsed.freshRuns).toHaveLength(1);
    expect.soft(parsed.freshRuns[0].diff.firstStructuralDivergence).toBe(diff.firstStructuralDivergence);
    expect.soft(parsed.record).toEqual({ id: 'record-a', phase: 'spec' });
  });

  test('renders terminal post-divergence status without presenting a structural terminal verdict', () => {
    const report = buildReplayReport({
      recordId: 'record-a',
      phase: 'spec',
      outputDir: '/tmp/replay',
      reconstructionNotes: [],
      freshRun: {
        id: 'fresh-1',
        diff: {
          sends: [],
          terminal: {
            original: { verb: 'advance_phase', body: 'original summary' },
            fresh: { verb: 'ask_human', body: 'fresh question' },
            unanchored: true,
          },
        },
      },
    });

    const text = renderReplayReportText(report);
    expect.soft(text).toContain('- status: post-divergence, not comparable');
    expect.soft(text).not.toContain('terminal verb changed');
  });
});

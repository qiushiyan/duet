import { describe, expect, test } from 'vitest';
import { getSnippet, loadSnippets, renderSnippetLibrary } from '../src/snippets.ts';

/**
 * Guards the real snippets.toml — the file is hand-edited (approved
 * propose_snippet_edit diffs apply here), and a broken library should fail
 * a five-second test run, not a real orchestrated run.
 */

describe('the snippet library', () => {
  test('loads, and every snippet has a key and a body', () => {
    const snippets = loadSnippets();
    expect(snippets.length).toBeGreaterThan(0);
    for (const s of snippets) {
      expect.soft(s.key, `snippet ${JSON.stringify(s.key)}`).toBeTruthy();
      expect.soft(s.expand.trim(), `snippet "${s.key}" body`).toBeTruthy();
    }
  });

  test('carries the templates the orchestrator prompts name', () => {
    // Entry prompts reference these by name (src/harness/orchestrator-prompts.ts);
    // a library missing them would strand the orchestrator mid-phase.
    for (const key of [
      'think-holistic',
      'compare-notes',
      'write-spec',
      'review-spec',
      'update-spec',
      'tdd-plan',
      'start-plan',
      'review-plan',
      'update-plan',
      'midpoint-status',
      'review-midpoint',
      'respond-midpoint',
      'implementation-handoff',
      'review-implementation',
      'respond-review',
      'compact-for-plan',
      'compact-for-review',
      'reread-context',
      'ceo-summary',
      'pr-description',
    ]) {
      expect.soft(getSnippet(key), `snippet "${key}"`).toBeDefined();
    }
  });

  test('renders as the XML-tagged menu the orchestrator reads', () => {
    const rendered = renderSnippetLibrary();
    expect(rendered.startsWith('<snippet_library>')).toBe(true);
    expect(rendered.endsWith('</snippet_library>')).toBe(true);
    expect(rendered).toContain('<snippet key="review-spec">');
  });
});

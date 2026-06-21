import { describe, expect, test } from 'vitest';
import { ANYTIME_SNIPPETS, UNLISTED_SNIPPETS, WORKFLOWS } from '../src/phases.ts';
import type { WorkflowName } from '../src/phases.ts';
import { getSnippet, loadSnippets, renderSnippetLibrary } from '../src/snippets.ts';

const WORKFLOW_NAMES = Object.keys(WORKFLOWS) as WorkflowName[];

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
      'review-plan',
      'update-plan',
      'midpoint-status',
      'review-midpoint',
      'respond-midpoint',
      'implementation-handoff',
      'review-implementation',
      'respond-review',
      'compact-for-plan',
      'compact-for-impl',
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

  test('every snippet is classified, and the three buckets stay disjoint (cross-workflow sharing allowed)', () => {
    // The phase-aware list_snippets default shows phase templates + anytime
    // helpers in full and indexes the rest; a snippet in no bucket would be
    // invisible unless the orchestrator passes all=true. With two workflows,
    // a phase snippet may be SHARED across workflows (think-holistic lives in
    // both Full's frame and RIR's research) — so the guard is no longer
    // "exactly one bucket" but: every snippet has a home; the three bucket
    // KINDS (phase-bound / anytime / unlisted) are pairwise disjoint; and no
    // snippet repeats within a single workflow's phase lists.
    const phaseSet = new Set(WORKFLOW_NAMES.flatMap((wf) => WORKFLOWS[wf].phases.flatMap((p) => p.snippets)));
    const anytime = new Set(ANYTIME_SNIPPETS);
    const unlisted = new Set(UNLISTED_SNIPPETS);

    // (a) every library snippet has a home — none invisible in the default view.
    const homes = new Set([...phaseSet, ...anytime, ...unlisted]);
    for (const { key } of loadSnippets()) {
      expect
        .soft(homes.has(key), `library snippet "${key}" is in no phase, ANYTIME, or UNLISTED — invisible in the default list_snippets view`)
        .toBe(true);
    }

    // (b) the three bucket kinds are pairwise disjoint — a snippet is
    // phase-bound OR a helper OR archived, never two.
    for (const key of phaseSet) {
      expect.soft(anytime.has(key), `"${key}" is both phase-bound and an anytime helper`).toBe(false);
      expect.soft(unlisted.has(key), `"${key}" is both phase-bound and unlisted`).toBe(false);
    }
    for (const key of anytime) {
      expect.soft(unlisted.has(key), `"${key}" is both an anytime helper and unlisted`).toBe(false);
    }

    // (c) no snippet appears twice within one workflow's own phase lists.
    for (const wf of WORKFLOW_NAMES) {
      const within = WORKFLOWS[wf].phases.flatMap((p) => p.snippets);
      expect.soft(new Set(within).size, `workflow "${wf}" lists a snippet under more than one of its phases`).toBe(within.length);
    }

    // (d) every classified key resolves to a real library entry.
    for (const key of homes) {
      expect.soft(getSnippet(key), `classified snippet "${key}" is missing from the library`).toBeDefined();
    }
  });

  test('the five RIR snippets exist with non-empty bodies; review-direct keeps the review- prefix', () => {
    for (const key of ['use-latest-docs', 'implement-direct', 'handoff-direct', 'review-direct', 'apply-review']) {
      const snippet = getSnippet(key);
      expect.soft(snippet, `snippet "${key}"`).toBeDefined();
      expect.soft(snippet?.expand.trim(), `snippet "${key}" body`).toBeTruthy();
    }
    // Load-bearing: tools.ts counts a review round by tag.startsWith('review').
    expect(getSnippet('review-direct')).toBeDefined();
    expect('review-direct'.startsWith('review')).toBe(true);
  });

  test('the phase-grouped view renders a RIR phase against the RIR arc', () => {
    const rendered = renderSnippetLibrary({ phase: 'research', workflow: 'rir' });
    expect.soft(rendered.startsWith('<snippet_library phase="research">')).toBe(true);
    // research's own templates, in full
    expect.soft(rendered).toContain('<snippet key="use-latest-docs">');
    // anytime helper, in full
    expect.soft(rendered).toContain('<snippet key="reread-context">');
    // implement comes next in the RIR arc — indexed by key, not body
    expect.soft(rendered).toContain('<phase name="implement">');
    expect.soft(rendered).not.toContain('<snippet key="implement-direct">');
    // no Full-only phase leaks into the RIR slice
    expect.soft(rendered).not.toContain('<phase name="plan">');
  });

  test('the phase-grouped view shows current-phase bodies and indexes other phases by key', () => {
    const rendered = renderSnippetLibrary({ phase: 'spec' });
    expect(rendered.startsWith('<snippet_library phase="spec">')).toBe(true);
    // current phase: full body
    expect(rendered).toContain('<snippet key="review-spec">');
    // anytime helper: full body
    expect(rendered).toContain('<snippet key="reread-context">');
    // a later phase: key-only index, not a body
    expect(rendered).toContain('<phase name="plan">');
    expect(rendered).not.toContain('<snippet key="tdd-plan">');
    // an earlier phase: listed under done
    expect(rendered).toContain('<already_done>');
    expect(rendered).toContain('think-holistic');
    // the escape hatch is advertised
    expect(rendered).toContain('all=true');
  });

  test('all=true renders every body, ungrouped', () => {
    const rendered = renderSnippetLibrary({ phase: 'spec', all: true });
    expect(rendered.startsWith('<snippet_library all="true">')).toBe(true);
    expect(rendered).toContain('<snippet key="tdd-plan">'); // a non-spec template, in full
    expect(rendered).toContain('<snippet key="compact-for-plan">'); // even the unlisted one
  });
});

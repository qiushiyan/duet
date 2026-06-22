import { describe, expect, test } from 'vitest';
import { ANYTIME_SNIPPETS, CONSULTANT_SNIPPETS, UNLISTED_SNIPPETS, WORKFLOWS, consultantSnippetFor } from '../src/phases.ts';
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

  test('snippet paths are project-neutral: no foreign spec path, skill roots unified on ~/.claude (F7)', () => {
    const bodies = loadSnippets()
      .map((s) => s.expand)
      .join('\n');
    expect.soft(bodies).not.toContain('docs/superpowers/'); // the tabtype-port's foreign spec path
    expect.soft(bodies).not.toContain('~/.agents/skills/'); // the outlier skill root
    // The skill references that remain all sit under the single ~/.claude/skills root.
    expect.soft(bodies).toContain('~/.claude/skills/tdd/');
    expect.soft(bodies).toContain('~/.claude/skills/improve-codebase-architecture/');
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
    // The consultant checkpoint snippets are a FOURTH bucket — registry data
    // enabled per-run, never in a phase's always-on `snippets` list. Classifying
    // them here (rather than forcing them into phaseSet, which is what leaked
    // them onto unbound runs through list_snippets) is the finding-1 fix.
    const consultant = CONSULTANT_SNIPPETS;

    // (a) every library snippet has a home — none invisible in the default view.
    const homes = new Set([...phaseSet, ...anytime, ...unlisted, ...consultant]);
    for (const { key } of loadSnippets()) {
      expect
        .soft(homes.has(key), `library snippet "${key}" is in no phase, ANYTIME, UNLISTED, or the consultant bucket — invisible in the default list_snippets view`)
        .toBe(true);
    }

    // (b) the four bucket kinds are pairwise disjoint — a snippet is phase-bound
    // OR a helper OR archived OR a consultant checkpoint, never two.
    for (const key of phaseSet) {
      expect.soft(anytime.has(key), `"${key}" is both phase-bound and an anytime helper`).toBe(false);
      expect.soft(unlisted.has(key), `"${key}" is both phase-bound and unlisted`).toBe(false);
      expect.soft(consultant.has(key), `"${key}" is both phase-bound and a consultant checkpoint snippet — checkpoint snippets must stay out of the always-on phase lists`).toBe(false);
    }
    for (const key of anytime) {
      expect.soft(unlisted.has(key), `"${key}" is both an anytime helper and unlisted`).toBe(false);
      expect.soft(consultant.has(key), `"${key}" is both an anytime helper and a consultant checkpoint snippet`).toBe(false);
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

  test('the three consultant snippets exist, are checkpoint-classified (never in a base phase list), and never carry a review- prefix', () => {
    const phaseSet = new Set<string>(WORKFLOW_NAMES.flatMap((wf) => WORKFLOWS[wf].phases.flatMap((p) => p.snippets)));
    for (const key of ['consultant-frame', 'consultant-spec', 'consultant-impl']) {
      const snippet = getSnippet(key);
      expect.soft(snippet, `snippet "${key}"`).toBeDefined();
      expect.soft(snippet?.expand.trim(), `snippet "${key}" body`).toBeTruthy();
      // Finding 1 regression guard: a checkpoint snippet must be classified
      // through the consultant bucket and NOT through a phase's always-on
      // `snippets` list — the latter is exactly what leaked it onto an unbound
      // run's list_snippets (registry data, gated per-run by phaseSnippetsFor).
      expect.soft(CONSULTANT_SNIPPETS.has(key), `"${key}" is a consultant checkpoint snippet`).toBe(true);
      expect.soft(phaseSet.has(key), `"${key}" must NOT sit in any base phase snippets list`).toBe(false);
      // Load-bearing: a consultant tag must NOT start with "review" — tools.ts
      // counts a review round by tag.startsWith('review'), so a review-prefixed
      // consultant tag would consume a round (and pollute the telemetry).
      expect.soft(key.startsWith('review'), `"${key}" must not start with review`).toBe(false);
    }
    // The checkpoint→snippet mapping is the single source the registry exposes:
    // each phase that carries a checkpoint resolves to its snippet, and the
    // arcs map the modes onto their own phases (Full: frame/spec/impl; RIR:
    // research/implement — no spec phase).
    expect.soft(consultantSnippetFor('frame')).toBe('consultant-frame');
    expect.soft(consultantSnippetFor('spec')).toBe('consultant-spec');
    expect.soft(consultantSnippetFor('impl')).toBe('consultant-impl');
    expect.soft(consultantSnippetFor('research')).toBe('consultant-frame');
    expect.soft(consultantSnippetFor('implement')).toBe('consultant-impl');
    expect.soft(consultantSnippetFor('plan'), 'plan carries no consultant checkpoint').toBeUndefined();
  });

  test('information hiding: no worker-directed snippet names the consultant (only the consultant-* snippets may)', () => {
    // The cohort lives only in the orchestrator/registry — the embedded reviewer
    // and the consultant are blind to each other, and the implementer is blind to
    // reviewer identity. So every snippet a WORKER could receive must read
    // identically with or without a consultant bound and never name it; the
    // consultant's OWN snippets (orchestrator→consultant) legitimately do.
    for (const s of loadSnippets()) {
      if (s.key.startsWith('consultant')) continue;
      expect.soft(s.expand.toLowerCase(), `snippet "${s.key}" names the consultant`).not.toContain('consultant');
      expect.soft(s.expand.toLowerCase(), `snippet "${s.key}" names "a third voice"`).not.toContain('third voice');
    }
  });

  test('the RIR arc snippets + the shared doc-currency helper exist with non-empty bodies; review-direct keeps the review- prefix', () => {
    for (const key of ['use-latest-docs', 'implement-direct', 'handoff-direct', 'review-direct', 'apply-review']) {
      const snippet = getSnippet(key);
      expect.soft(snippet, `snippet "${key}"`).toBeDefined();
      expect.soft(snippet?.expand.trim(), `snippet "${key}" body`).toBeTruthy();
    }
    // Load-bearing: tools.ts counts a review round by tag.startsWith('review').
    expect(getSnippet('review-direct')).toBeDefined();
    expect('review-direct'.startsWith('review')).toBe(true);
  });

  test('a phase given without a workflow infers its owning arc (no Full default crash)', () => {
    // Finding #3: renderSnippetLibrary({phase}) used to default to Full and
    // dereference undefined for a RIR-only phase. It now infers the workflow
    // from the globally-unique phase name.
    const rendered = renderSnippetLibrary({ phase: 'research' });
    expect.soft(rendered.startsWith('<snippet_library phase="research">')).toBe(true);
    expect.soft(rendered).toContain('<snippet key="use-latest-docs">');
    expect.soft(rendered).toContain('<phase name="implement">');
  });

  test('the phase-grouped view renders a RIR phase against the RIR arc', () => {
    const rendered = renderSnippetLibrary({ phase: 'research', workflow: 'rir' });
    expect.soft(rendered.startsWith('<snippet_library phase="research">')).toBe(true);
    // anytime doc-currency helper, in full (reclassified from RIR-only)
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

  // ── Finding 1: default-off gating on every render path ──
  // An unbound run's library must read byte-for-byte as today's — the consultant
  // checkpoint snippets never appear, by body or by key, anywhere.
  describe('consultant snippets are gated on the render path (default-off)', () => {
    test('unbound: the phase view exposes no consultant snippet — current, coming_next, or already_done', () => {
      // frame owns consultant-frame; impl/spec own theirs later in the arc — none
      // may surface on an unbound run.
      const atFrame = renderSnippetLibrary({ phase: 'frame', workflow: 'full' });
      expect.soft(atFrame).not.toContain('consultant-frame');
      expect.soft(atFrame).not.toContain('consultant-spec');
      expect.soft(atFrame).not.toContain('consultant-impl');
      // impl is past spec, so spec's checkpoint would land in already_done if it leaked.
      const atImpl = renderSnippetLibrary({ phase: 'impl', workflow: 'full' });
      expect.soft(atImpl).not.toContain('consultant');
    });

    test('unbound: all=true exposes no consultant body', () => {
      const rendered = renderSnippetLibrary({ phase: 'spec', all: true });
      expect.soft(rendered).not.toContain('<snippet key="consultant-frame">');
      expect.soft(rendered).not.toContain('<snippet key="consultant-spec">');
      expect.soft(rendered).not.toContain('<snippet key="consultant-impl">');
    });

    test('unbound render is byte-for-byte the same with consultantBound omitted vs false', () => {
      // The default-off invariant at the render layer: an absent flag and an
      // explicit false produce identical output.
      for (const phase of ['frame', 'spec', 'impl'] as const) {
        expect
          .soft(renderSnippetLibrary({ phase, workflow: 'full' }))
          .toBe(renderSnippetLibrary({ phase, workflow: 'full', consultantBound: false }));
      }
    });

    test('bound: the owning phase shows its checkpoint snippet in full; other phases index theirs by key', () => {
      const atFrame = renderSnippetLibrary({ phase: 'frame', workflow: 'full', consultantBound: true });
      // frame owns consultant-frame → rendered as a full body in phase_templates.
      expect.soft(atFrame).toContain('<snippet key="consultant-frame">');
      // spec and impl own theirs later → indexed by key in coming_next, not as bodies.
      expect.soft(atFrame).toContain('consultant-spec');
      expect.soft(atFrame).not.toContain('<snippet key="consultant-spec">');
      expect.soft(atFrame).toContain('consultant-impl');
      expect.soft(atFrame).not.toContain('<snippet key="consultant-impl">');
    });

    test('bound: all=true exposes the consultant bodies', () => {
      const rendered = renderSnippetLibrary({ phase: 'spec', all: true, consultantBound: true });
      expect.soft(rendered).toContain('<snippet key="consultant-frame">');
      expect.soft(rendered).toContain('<snippet key="consultant-spec">');
      expect.soft(rendered).toContain('<snippet key="consultant-impl">');
    });

    test('bound: a RIR phase shows only its arc’s checkpoints (no spec checkpoint — RIR has no spec)', () => {
      const atResearch = renderSnippetLibrary({ phase: 'research', workflow: 'rir', consultantBound: true });
      expect.soft(atResearch).toContain('<snippet key="consultant-frame">'); // research owns frame mode
      expect.soft(atResearch).toContain('consultant-impl'); // implement owns implGate → indexed
      expect.soft(atResearch).not.toContain('consultant-spec'); // RIR has no spec checkpoint
    });
  });
});

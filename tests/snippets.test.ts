import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ANYTIME_SNIPPETS, CONSULTANT_SNIPPETS, UNLISTED_SNIPPETS, WORKFLOWS, consultantSnippetFor, phasesOf } from '../src/registry/workflows.ts';
import { ACTION_CATALOG } from '../src/voices/policy.ts';
import type { WorkflowName } from '../src/registry/workflows.ts';
import {
  LESSONS_DIR,
  getEffectiveSnippet,
  getSnippet,
  loadEffectiveSnippets,
  loadSnippets,
  mergeSnippetLayers,
  renderSnippetLibrary,
  runtimeLibraryContext,
} from '../src/orchestrator/library.ts';
import type { Snippet, SnippetOverrideLayer, SnippetRenderOpts } from '../src/orchestrator/library.ts';

const WORKFLOW_NAMES = Object.keys(WORKFLOWS) as WorkflowName[];

/**
 * Guards the real snippets/ library — the block-named TOML files are
 * hand-edited (approved propose_snippet_edit diffs apply there), and a broken
 * library should fail a five-second test run, not a real orchestrated run.
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

  // The PLAN snippets and the RIR build snippet (implement-direct) cite greenflag's
  // methodology by a {{lessons_dir}}/… token that resolves to the vendored
  // lessons/ copy at serve time — so the discipline ships with the package
  // instead of pointing at the author's machine. These five layers guard that the
  // the resolution is invisible at the run surface (a worker never sees a token,
  // a personal path never re-enters the library). The earlier F7 guard asserted
  // the *opposite* state (~/.claude paths present); this supersedes it.
  describe('the PLAN methodology ships with the package (vendored lessons resolve)', () => {
    const rawBodies = (): string => loadSnippets().map((s) => s.expand).join('\n');

    test('layer 1 — no personal or foreign path remains in any stored snippet body', () => {
      const bodies = rawBodies();
      expect.soft(bodies, 'a ~/.claude path leaked back into the library').not.toContain('~/.claude');
      expect.soft(bodies, 'the outlier ~/.agents skill root').not.toContain('~/.agents/skills/');
      expect.soft(bodies, "the tabtype-port's foreign spec path").not.toContain('docs/superpowers/');
    });

    test('layer 2 — every {{lessons_dir}} reference resolves to a vendored file', () => {
      const refs: string[] = [];
      for (const m of rawBodies().matchAll(/\{\{lessons_dir\}\}\/([\w./-]+)/g)) if (m[1]) refs.push(m[1]);
      expect(refs.length, 'no {{lessons_dir}} references found — the snippets stopped citing the methodology').toBeGreaterThan(0);
      // the two always-read lesson roots the lighter snippets (review-plan,
      // implement-direct) name explicitly — one per topic.
      expect.soft(refs).toContain('codebase-design/deep-modules.md');
      expect.soft(refs).toContain('testing/tdd-loop.md');
      for (const rel of refs) {
        expect.soft(existsSync(join(LESSONS_DIR, rel)), `{{lessons_dir}}/${rel} is cited but not vendored — re-run \`pnpm vendor-lessons\``).toBe(true);
      }
    });

    test('layer 3 — the served library resolves the placeholder (invisible at the run surface)', () => {
      // every path a body reaches a worker funnels through renderSnippetLibrary;
      // the token must be gone and an absolute path present, with no ~/.claude.
      for (const rendered of [renderSnippetLibrary({ all: true }), renderSnippetLibrary({ phase: 'plan', workflow: 'full' })]) {
        expect.soft(rendered, 'an unresolved {{lessons_dir}} token reached the served library').not.toContain('{{lessons_dir}}');
        expect.soft(rendered, 'a ~/.claude path reached the served library').not.toContain('~/.claude');
      }
      expect(renderSnippetLibrary({ all: true }), 'the resolved absolute path a worker actually receives').toContain(join(LESSONS_DIR, 'codebase-design/deep-modules.md'));
    });

    test('layer 4 — no vendored lesson file hardcodes a personal path (the bug must not move one level down)', () => {
      // Derive the topic dirs from the vendored tree, never a hardcoded list, so
      // a newly-vendored topic is scanned automatically — the whole point of this
      // guard is that the leak must not move one level down, and a fixed list goes
      // blind exactly when a new topic ships. The dir filter also excludes the
      // top-level lessons/README.md (a file), greenflag-authored provenance that
      // legitimately names the source.
      const topics = readdirSync(LESSONS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      expect(topics.length, 'no vendored topic dirs under LESSONS_DIR — vendoring is broken').toBeGreaterThan(0);
      for (const topic of topics) {
        const dir = join(LESSONS_DIR, topic);
        for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
          const full = join(dir, rel);
          if (!statSync(full).isFile()) continue;
          const text = readFileSync(full, 'utf8');
          expect.soft(text, `${topic}/${rel} hardcodes a ~/.claude path`).not.toContain('~/.claude');
          expect.soft(text, `${topic}/${rel} hardcodes a ~/.agents path`).not.toContain('~/.agents');
        }
      }
    });

    test('layer 5 — lessons/ has no SKILL.md of its own (sync-skills never symlinks it as an invokable skill)', () => {
      expect(existsSync(join(LESSONS_DIR, 'SKILL.md'))).toBe(false);
    });
  });

  /**
   * `docs/snippets.md` is the customization MAP, not a copy of the library.
   * It used to reproduce nine bodies verbatim; nothing pinned them, so they
   * silently rotted — the doc described a `write-design` snippet months after
   * the artifact merged into `write-spec`. The bodies now live in exactly two
   * places (`snippets/*.toml`, and `greenflag snippets show <key>` for the effective
   * one), and these guards keep it that way: a snippet the doc names must exist,
   * and a pasted body announces itself by the token only bodies carry.
   */
  describe('docs/snippets.md stays a map, not a second source of truth', () => {
    const doc = (): string => readFileSync(join(import.meta.dirname, '..', 'docs', 'snippets.md'), 'utf8');

    // The override table IS the map, so every key in it must resolve. A leading
    // `| \`key\` |` cell is unambiguous — unlike a backtick anywhere in prose,
    // which also catches lesson filenames like `design-it-twice`.
    test('every snippet in the override table exists in the library', () => {
      const known = new Set(loadSnippets().map((s) => s.key));
      const rows = Array.from(doc().matchAll(/^\| `([a-z][a-z0-9-]+)` \|/gm), (m) => m[1]!);
      expect(rows.length, 'the override table lost its rows — it is what makes this doc a map').toBeGreaterThan(5);
      for (const key of rows) {
        expect.soft(known.has(key), `docs/snippets.md's table names "${key}", which is not a snippet`).toBe(true);
      }
    });

    test('the doc reproduces no shipped snippet body (the rot mechanism, removed)', () => {
      const text = doc();
      // The precise guard: a shipped body's opening line, verbatim. The doc's
      // worked example is a USER's override, so it must stay allowed.
      for (const s of loadSnippets()) {
        const firstLine = s.expand.trim().split('\n')[0]!;
        if (firstLine.length < 40) continue;
        expect.soft(text, `docs/snippets.md reproduces the shipped body of "${s.key}" — cite \`greenflag snippets show ${s.key}\` instead`).not.toContain(
          firstLine,
        );
      }
      // A `{{lessons_dir}}` token inside a fenced block is a pasted body; naming
      // the token in prose (to explain the convention) is the doc's job.
      for (const block of Array.from(text.matchAll(/```[\s\S]*?```/g), (m) => m[0])) {
        expect.soft(block, 'a fenced block in docs/snippets.md carries a {{lessons_dir}} token — that is a snippet body').not.toContain(
          '{{lessons_dir}}',
        );
      }
    });
  });

  test('carries the templates the orchestrator prompts name', () => {
    // Entry prompts reference these by name (src/orchestrator/briefs.ts);
    // a library missing them would strand the orchestrator mid-phase.
    for (const key of [
      'think-holistic',
      'compare-notes',
      'write-spec',
      'review-spec',
      'update-spec',
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
      'compact-for-impl',
      'compact-for-review',
      'compact-inflight',
      'reread-context',
      'ceo-summary',
      'pr-description',
      'reconcile-docs',
    ]) {
      expect.soft(getSnippet(key), `snippet "${key}"`).toBeDefined();
    }
  });

  test('the review-loop polish contract: reviewers batch wording fixes as replacements, updaters apply without re-analysis', () => {
    // The polish revision: a review
    // template ends with an "Optional polish" section of exact before → after
    // replacements, and the matching update template licenses applying them
    // without re-analysis (the measured 7-minute reread was a conscientious
    // implementer re-deriving each wording suggestion). Pinned lightly — the
    // section name and the no-re-analysis license — not verbatim.
    for (const key of ['review-spec', 'review-plan', 'review-spec-again', 'review-plan-again']) {
      const body = getSnippet(key)?.expand ?? '';
      expect.soft(body, `${key} carries the polish output contract`).toContain('Optional polish');
      expect.soft(body, `${key} demands exact replacements`).toMatch(/before → after/);
    }
    // The empty case has a skip (round-1 templates carry the full contract; the
    // -agains inherit it in-session): a mandated section with no skip gets
    // filled — a reviewer with nothing to polish would manufacture items.
    for (const key of ['review-spec', 'review-plan']) {
      const body = getSnippet(key)?.expand ?? '';
      expect.soft(body, `${key} licenses an empty polish section`).toMatch(/nothing qualifies/);
    }
    for (const key of ['update-spec', 'update-plan', 'update-spec-again', 'update-plan-again']) {
      const body = getSnippet(key)?.expand ?? '';
      expect.soft(body, `${key} names the polish section`).toContain('Optional polish');
      expect.soft(body, `${key} licenses applying polish without re-analysis`).toMatch(/re-analysis/i);
    }
  });

  test('renders as the XML-tagged menu the orchestrator reads', () => {
    const rendered = renderSnippetLibrary();
    expect(rendered.startsWith('<snippet_library>')).toBe(true);
    expect(rendered.endsWith('</snippet_library>')).toBe(true);
    expect(rendered).toContain('<snippet key="review-spec">');
  });

  test('S7: recover-context is an ANYTIME helper that names its narrow post-compact trigger (distinct from reread-context)', () => {
    expect.soft(ANYTIME_SNIPPETS).toContain('recover-context');
    const body = loadSnippets().find((s) => s.key === 'recover-context')?.expand ?? '';
    expect.soft(body).not.toBe(''); // it resolves to a real body
    // It frames a post-compact fresh-session recovery and contrasts itself with a
    // routine reread — so it isn't used as a generic one. The distinction is stated
    // in plain terms, NOT by naming the sibling snippet key: that key is
    // orchestrator vocabulary the worker recipient of this body doesn't share (the
    // orchestrator picks recover-context-vs-reread from the catalog/brief, not from
    // the text it sends the worker), so naming it here is a familiar-term leak.
    expect.soft(body).toMatch(/compact/i);
    expect.soft(body).toMatch(/not a routine reread/i);
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
    const phaseSet = new Set(WORKFLOW_NAMES.flatMap((wf) => phasesOf(wf).flatMap((p) => p.snippets)));
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
      const within = phasesOf(wf).flatMap((p) => p.snippets);
      expect.soft(new Set(within).size, `workflow "${wf}" lists a snippet under more than one of its phases`).toBe(within.length);
    }

    // (d) every classified key resolves to a real library entry.
    for (const key of homes) {
      expect.soft(getSnippet(key), `classified snippet "${key}" is missing from the library`).toBeDefined();
    }
  });

  test('the five consultant snippets exist, are checkpoint-classified (never in a base phase list), and never carry a review- prefix', () => {
    const phaseSet = new Set<string>(WORKFLOW_NAMES.flatMap((wf) => phasesOf(wf).flatMap((p) => p.snippets)));
    for (const key of ['consultant-frame', 'consultant-spec', 'consultant-impl', 'consultant-contract', 'consultant-verify']) {
      const snippet = getSnippet(key);
      expect.soft(snippet, `snippet "${key}"`).toBeDefined();
      expect.soft(snippet?.expand.trim(), `snippet "${key}" body`).toBeTruthy();
      // Finding 1 regression guard: a checkpoint snippet must be classified
      // through the consultant bucket and NOT through a phase's always-on
      // `snippets` list — the latter is exactly what leaked it onto an unbound
      // run's list_snippets (registry data, gated per-run by phaseSnippetsFor).
      expect.soft(CONSULTANT_SNIPPETS.has(key), `"${key}" is a consultant checkpoint snippet`).toBe(true);
      expect.soft(phaseSet.has(key), `"${key}" must NOT sit in any base phase snippets list`).toBe(false);
      // A consultant snippet must never be cataloged as a review round —
      // round counting is catalog-driven (ACTION_CATALOG, T3), and a
      // consultant turn is additive, never substitutive. The old prefix
      // hygiene stays as naming clarity.
      expect.soft(ACTION_CATALOG[key]?.countsReviewRound ?? false, `"${key}" must not count a review round`).toBe(false);
      expect.soft(key.startsWith('review'), `"${key}" must not start with review`).toBe(false);
    }
    // The checkpoint→snippet mapping is the single source the registry exposes:
    // each phase that carries a checkpoint resolves to its snippet, and the
    // arcs map the modes onto their own phases. Full's plan AUTHORS the contract
    // and its impl VERIFIES it (supplanting the open-ended impl bet-audit); RIR
    // keeps the open-ended consultant-impl (no plan phase, no contract to verify).
    expect.soft(consultantSnippetFor('full', 'frame')).toBe('consultant-frame');
    expect.soft(consultantSnippetFor('full', 'spec')).toBe('consultant-spec');
    expect.soft(consultantSnippetFor('full', 'plan')).toBe('consultant-contract');
    expect.soft(consultantSnippetFor('full', 'implement')).toBe('consultant-verify');
  });

  test('the action catalog pins to the library: every catalog key ships, every review-family key is cataloged (T3)', () => {
    // (a) A catalog entry for a snippet the library doesn't ship is dead
    // metadata — or worse, a typo silently detached from its snippet.
    for (const key of Object.keys(ACTION_CATALOG)) {
      expect.soft(getSnippet(key), `catalog key "${key}" is missing from the library`).toBeDefined();
    }
    // (b) Every review-family key a phase actually serves must be cataloged —
    // counting is catalog-driven now, so an uncataloged review snippet would
    // silently stop counting toward the round cap.
    const served = new Set(WORKFLOW_NAMES.flatMap((wf) => phasesOf(wf).flatMap((p) => p.snippets)));
    for (const key of served) {
      if (!key.startsWith('review')) continue;
      expect.soft(ACTION_CATALOG[key], `review-family snippet "${key}" is not in the action catalog`).toBeDefined();
    }
    expect.soft(consultantSnippetFor('short', 'research')).toBe('consultant-frame');
    expect.soft(consultantSnippetFor('short', 'implement')).toBe('consultant-impl');
    expect.soft(consultantSnippetFor('full', 'finish'), 'finish carries no consultant checkpoint').toBeUndefined();
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

  // The spec is every workflow's design document, so its reading list is a
  // DECISION, not a union: read a lesson deeply where its decisions get made,
  // skim its bar where they are only constrained. The exclusions are as
  // load-bearing as the inclusions — a future "just cite them all" edit is
  // exactly what this pins against.
  test('write-spec reads the design lessons deeply and the testing lessons as a lens', () => {
    const body = getSnippet('write-spec')?.expand ?? '';

    // Read deeply — the spec commits the module structure, the interface, and the
    // seam placement, and design-it-twice is the discipline for choosing them.
    expect.soft(body, 'write-spec stopped citing the architecture methodology').toContain('{{lessons_dir}}/codebase-design/deep-modules.md');
    expect.soft(body, 'write-spec stopped citing design-it-twice — the interface is chosen here and nowhere later').toContain(
      '{{lessons_dir}}/codebase-design/design-it-twice.md',
    );
    expect.soft(body, 'write-spec stopped citing deepening — its dependency categories decide whether a seam needs a port').toContain(
      '{{lessons_dir}}/codebase-design/deepening.md',
    );

    // Skimmed as a lens — the spec names WHICH behaviors matter and what gets
    // faked at which boundary; how to write the tests is the plan's or build's.
    expect.soft(body, 'write-spec stopped citing the TDD methodology').toContain('{{lessons_dir}}/testing/tdd-loop.md');
    expect.soft(body, 'write-spec stopped citing the mocking boundary rule').toContain('{{lessons_dir}}/testing/mocking-and-fixtures.md');
    expect.soft(body, 'the testing lessons are a lens at spec altitude, not a deep read').toMatch(/skim the `## The bar`/i);

    // Deliberately NOT read: a spec never writes an assertion, and 440 lines of
    // tool reference at design altitude buys nothing.
    expect.soft(body, 'write-spec pulled in the Vitest API reference — the spec writes no assertions').not.toContain('testing/vitest.md');

    // design-it-twice's bar, made operational: three shapes, independence, and a
    // recommendation rather than a menu. Assert the tokens each rule turns on, not
    // the sentence around them — emphasis and wording move, the discipline doesn't.
    expect.soft(body, 'write-spec dropped the three-shapes bar').toMatch(/three shapes/i);
    expect.soft(body, 'write-spec no longer demands the shapes differ in kind').toMatch(/different in kind/i);
    expect.soft(body, 'write-spec dropped the constraint axes that pull the shapes apart').toMatch(/ports and adapters/i);
  });

  // "Shapes considered" is the one phrase with real callers: write-spec produces the
  // note, review-spec audits it, implement-spec is told the alternatives are already
  // weighed. Rename it in one place and the other two silently stop finding it — so
  // the token is pinned, and the prose around it is free to move.
  test('the "Shapes considered" note is one token across the snippets that produce, audit, and read it', () => {
    for (const key of ['write-spec', 'review-spec', 'implement-spec']) {
      expect.soft(getSnippet(key)?.expand ?? '', `snippet "${key}" lost the "Shapes considered" token`).toContain('Shapes considered');
    }
  });

  // The methodology write-spec reads is also owed to the maker on a `--spec` draft
  // entry, where write-spec never runs: review-spec still asks whether the shape was
  // chosen or merely first, and update-spec is the only turn that can answer.
  test('update-spec reaches design-it-twice, the lesson review-spec holds the shape to', () => {
    expect.soft(getSnippet('update-spec')?.expand ?? '').toContain('codebase-design/design-it-twice.md');
  });

  // Binding convention 7 (docs/prompting-and-tool-design.md): a worker reads its
  // prompt cold and holds none of greenflag's vocabulary. The doc-loop family is the
  // one place that vocabulary keeps trying to creep back in — "the builder" reads
  // as plain English to whoever wrote it and as a stranger to whoever reads it.
  // The leak's actual shape is the NOUN — "the builder starts out holding your
  // mental model", which read as plain English to whoever wrote it and as a
  // stranger to the worker reading it cold. Match on the article so the guard
  // catches that and leaves the English verbs alone ("judge it there", "review
  // critically", "if architectural, say so").
  test("the spec doc-loop snippets carry none of greenflag's duty names", () => {
    const DUTY_NOUN = /\b(?:the|a|an|your|its)\s+(architect|analyst|builder|critic|judge|orchestrator|consultant)s?\b/i;
    for (const key of ['write-spec', 'review-spec', 'update-spec', 'review-spec-again', 'update-spec-again']) {
      const body = getSnippet(key)?.expand ?? '';
      const hit = DUTY_NOUN.exec(body);
      expect.soft(hit?.[1], `snippet "${key}" names a greenflag duty — a worker reads its prompt cold`).toBeUndefined();
    }
  });

  test('review-spec holds each tier to its own altitude and checks the shape was chosen, not first', () => {
    const body = getSnippet('review-spec')?.expand ?? '';
    expect.soft(body, 'review-spec reviews product sections at their own altitude').toMatch(/product sections/i);
    expect.soft(body, 'review-spec reviews technical sections at design altitude').toMatch(/technical sections/i);
    expect.soft(body, 'review-spec dropped the pre-mortem').toMatch(/pre-mortem/i);
    expect.soft(body, 'review-spec dropped the over-building check').toMatch(/over-building/i);
  });

  // The plan is the tactics the spec deferred. Its design-it-twice gate moved
  // upstream to write-spec, where the interface is actually still open — leaving
  // it here would fire it after start-plan says "follow the settled spec".
  test('start-plan defers the design methodology to the spec and keeps the test discipline', () => {
    const body = getSnippet('start-plan')?.expand ?? '';
    expect.soft(body, 'start-plan re-grew the design-it-twice gate the spec now owns').not.toContain('design-it-twice.md');
    expect.soft(body, 'start-plan stopped citing the TDD methodology').toContain('{{lessons_dir}}/testing/tdd-loop.md');
    expect.soft(body, 'start-plan stopped citing the mocking/fixtures methodology').toContain('{{lessons_dir}}/testing/mocking-and-fixtures.md');
    expect.soft(body, 'start-plan no longer says the spec settled the shape').toMatch(/spec settled/i);
    // The claim that bit: on a --spec draft entry no write-spec turn ever ran, so
    // the plan may not assert the architect read the design lessons at the spec stage.
    expect.soft(body, 'start-plan asserts a lesson-read that a --spec entry never performed').not.toMatch(/you read the design lessons/i);
  });

  test('implement-spec seeds a cold build from the committed spec, carrying the full methodology', () => {
    const body = getSnippet('implement-spec')?.expand ?? '';
    expect.soft(body, 'snippet "implement-spec" body').toBeTruthy();
    // Cold-safe by contract: relay's fresh builder reads it with no planning
    // session, so the document plus these lessons are its whole seed.
    for (const lesson of ['codebase-design/deep-modules.md', 'testing/tdd-loop.md', 'testing/mocking-and-fixtures.md', 'testing/vitest.md']) {
      expect.soft(body, `implement-spec stopped citing ${lesson}`).toContain(`{{lessons_dir}}/${lesson}`);
    }
    expect.soft(body, 'implement-spec still names a "design doc" — the artifact is a spec').not.toMatch(/design doc/i);
  });

  test('the RIR arc snippets exist with non-empty bodies; review-direct keeps the review- prefix', () => {
    for (const key of ['implement-direct', 'handoff-direct', 'review-direct', 'apply-review']) {
      const snippet = getSnippet(key);
      expect.soft(snippet, `snippet "${key}"`).toBeDefined();
      expect.soft(snippet?.expand.trim(), `snippet "${key}" body`).toBeTruthy();
    }
    // Load-bearing: tools.ts counts a review round by tag.startsWith('review').
    expect(getSnippet('review-direct')).toBeDefined();
    expect('review-direct'.startsWith('review')).toBe(true);

    // implement-direct carries the PLAN-stage methodology into the no-plan arc by
    // citing the two always-read lesson roots (layer 2 above guards they resolve).
    // Pin it here so a future edit can't silently strip the citations while
    // start-plan keeps the all-bodies scan green.
    const implDirect = getSnippet('implement-direct')?.expand ?? '';
    expect.soft(implDirect, 'implement-direct stopped citing the architecture methodology').toContain('{{lessons_dir}}/codebase-design/deep-modules.md');
    expect.soft(implDirect, 'implement-direct stopped citing the TDD methodology').toContain('{{lessons_dir}}/testing/tdd-loop.md');
  });

  test('a phase-scoped render requires the workflow — phase names are workflow-scoped', () => {
    // Phase identity is workflow-scoped now (both arcs share `implement`/`finish`),
    // so a phase alone can't resolve its arc. The render throws at the one boundary
    // rather than guessing an arc (the real caller, list_snippets, always supplies
    // state.workflow); rendering a phase against its actual arc is covered below.
    expect(() => renderSnippetLibrary({ phase: 'research' })).toThrow(/needs the run workflow/);
  });

  test('the phase-grouped view renders a RIR phase against the RIR arc', () => {
    const rendered = renderSnippetLibrary({ phase: 'research', workflow: 'short' });
    expect.soft(rendered.startsWith('<snippet_library phase="research">')).toBe(true);
    // anytime helper, in full
    expect.soft(rendered).toContain('<snippet key="reread-context">');
    // implement comes next in the RIR arc — indexed by key, not body
    expect.soft(rendered).toContain('<phase name="implement">');
    expect.soft(rendered).not.toContain('<snippet key="implement-direct">');
    // no Full-only phase leaks into the RIR slice
    expect.soft(rendered).not.toContain('<phase name="plan">');
  });

  test('the phase-grouped view shows current-phase bodies and indexes other phases by key', () => {
    const rendered = renderSnippetLibrary({ phase: 'spec', workflow: 'full' });
    expect(rendered.startsWith('<snippet_library phase="spec">')).toBe(true);
    // current phase: full body
    expect(rendered).toContain('<snippet key="review-spec">');
    // anytime helper: full body
    expect(rendered).toContain('<snippet key="reread-context">');
    // a later phase: key-only index, not a body
    expect(rendered).toContain('<phase name="plan">');
    expect(rendered).not.toContain('<snippet key="start-plan">');
    // an earlier phase: listed under done
    expect(rendered).toContain('<already_done>');
    expect(rendered).toContain('think-holistic');
    // the escape hatch is advertised
    expect(rendered).toContain('all=true');
  });

  test('all=true renders every body, ungrouped', () => {
    const rendered = renderSnippetLibrary({ phase: 'spec', all: true });
    expect(rendered.startsWith('<snippet_library all="true">')).toBe(true);
    expect(rendered).toContain('<snippet key="start-plan">'); // a non-spec template, in full
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
      const atImpl = renderSnippetLibrary({ phase: 'implement', workflow: 'full' });
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
      for (const phase of ['frame', 'spec', 'implement'] as const) {
        expect
          .soft(renderSnippetLibrary({ phase, workflow: 'full' }))
          .toBe(renderSnippetLibrary({ phase, workflow: 'full', consultantBound: false }));
      }
    });

    test('bound: the owning phase shows its checkpoint snippet in full; other phases index theirs by key', () => {
      const atFrame = renderSnippetLibrary({ phase: 'frame', workflow: 'full', consultantBound: true });
      // frame owns consultant-frame → rendered as a full body in phase_templates.
      expect.soft(atFrame).toContain('<snippet key="consultant-frame">');
      // spec/plan/impl own theirs later (consultant-spec, the contract author, the
      // verify checkpoint) → indexed by key in coming_next, not as bodies.
      expect.soft(atFrame).toContain('consultant-spec');
      expect.soft(atFrame).not.toContain('<snippet key="consultant-spec">');
      expect.soft(atFrame).toContain('consultant-contract');
      expect.soft(atFrame).not.toContain('<snippet key="consultant-contract">');
      expect.soft(atFrame).toContain('consultant-verify');
      expect.soft(atFrame).not.toContain('<snippet key="consultant-verify">');
    });

    test('bound: all=true exposes every consultant body', () => {
      const rendered = renderSnippetLibrary({ phase: 'spec', all: true, consultantBound: true });
      for (const key of ['consultant-frame', 'consultant-spec', 'consultant-impl', 'consultant-contract', 'consultant-verify']) {
        expect.soft(rendered).toContain(`<snippet key="${key}">`);
      }
    });

    test('bound: a RIR phase shows only its arc’s checkpoints (no spec checkpoint — RIR has no spec)', () => {
      const atResearch = renderSnippetLibrary({ phase: 'research', workflow: 'short', consultantBound: true });
      expect.soft(atResearch).toContain('<snippet key="consultant-frame">'); // research owns frame mode
      expect.soft(atResearch).toContain('consultant-impl'); // implement owns implGate → indexed
      expect.soft(atResearch).not.toContain('consultant-spec'); // RIR has no spec checkpoint
    });

    test('gateless: all=true keeps the generative frame + backstop, hides the bet-audit body', () => {
      // A gateless run drops the consultant's holding bet audit, so its bet-audit
      // checkpoint snippets never surface — even bound, even at all=true; the
      // non-holding generative frame and the correctness backstop do surface.
      const all = renderSnippetLibrary({ phase: 'plan', workflow: 'full', all: true, consultantBound: true, gateless: true });
      expect.soft(all).not.toContain('<snippet key="consultant-spec">'); // bet audit — hidden
      expect.soft(all).not.toContain('<snippet key="consultant-impl">');
      // The generative frame survives, and so does the backstop (contract + verify).
      expect.soft(all).toContain('<snippet key="consultant-frame">');
      expect.soft(all).toContain('<snippet key="consultant-contract">');
      expect.soft(all).toContain('<snippet key="consultant-verify">');
    });

    test('gateless: the phase view shows the generative frame + backstop, never a bet-audit', () => {
      const atImpl = renderSnippetLibrary({ phase: 'implement', workflow: 'full', consultantBound: true, gateless: true });
      expect.soft(atImpl).toContain('<snippet key="consultant-verify">'); // impl's backstop checkpoint, in full
      const atFrame = renderSnippetLibrary({ phase: 'frame', workflow: 'full', consultantBound: true, gateless: true });
      expect.soft(atFrame).toContain('<snippet key="consultant-frame">'); // generative — survives gateless
      expect.soft(atFrame).not.toContain('consultant-spec'); // bet audit — gone
      expect.soft(atFrame).toContain('consultant-verify'); // backstop still indexed by key
    });

    test('gateless: the no-workflow flat fallback also keeps frame + backstop, no bet-audit leak', () => {
      // The defensive no-workflow flat render must honor gateless too, or it leaks
      // the bet-audit bodies the gateless rule hides (review finding #8).
      const flat = renderSnippetLibrary({ all: true, consultantBound: true, gateless: true });
      expect.soft(flat).toContain('<snippet key="consultant-frame">'); // generative kept
      expect.soft(flat).not.toContain('<snippet key="consultant-spec">'); // bet audit — hidden
      expect.soft(flat).toContain('<snippet key="consultant-contract">'); // backstop kept
      expect.soft(flat).toContain('<snippet key="consultant-verify">');
    });
  });
});

// ── Custom snippet override layers (feat/custom-snippets) ──────────────────
// A user (`~/.config/greenflag/snippets.toml`) and a project (`<cwd>/.greenflag/snippets.toml`)
// override file may replace individual snippet BODIES, stacked on the shipped
// base, project winning. Whole-body per key, fail-closed on unknown keys, and —
// with no override file present — byte-for-byte today's served library.

/** Build a snippets.toml override body from key→expand entries (basic TOML strings via JSON.stringify). */
function overrideToml(entries: Array<[key: string, expand: string]>): string {
  return entries.map(([key, expand]) => `[[snippets]]\nkey = ${JSON.stringify(key)}\nexpand = ${JSON.stringify(expand)}\n`).join('\n');
}

// Shared real-fs tmpdir plumbing — these suites plant override files and clean up.
const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmpEmpty(): string {
  const d = mkdtempSync(join(tmpdir(), 'greenflag-snip-'));
  tmpDirs.push(d);
  return d;
}
/** A config dir holding a user-layer snippets.toml. */
function withUserSnippets(toml: string): string {
  const d = tmpEmpty();
  writeFileSync(join(d, 'snippets.toml'), toml);
  return d;
}
/** A project root holding a project-layer .greenflag/snippets.toml. */
function withProjectSnippets(toml: string): string {
  const d = tmpEmpty();
  mkdirSync(join(d, '.greenflag'), { recursive: true });
  writeFileSync(join(d, '.greenflag', 'snippets.toml'), toml);
  return d;
}

describe('mergeSnippetLayers — the pure merge core', () => {
  const base: Snippet[] = [
    { key: 'a', expand: 'A-base' },
    { key: 'b', expand: 'B-base' },
    { key: 'c', expand: 'C-base' },
  ];
  const layer = (source: 'user' | 'project', snippets: Snippet[]): SnippetOverrideLayer => ({ source, path: `/fake/${source}.toml`, snippets });

  test('no overrides → base verbatim, every element tagged shipped', () => {
    expect(mergeSnippetLayers(base)).toEqual([
      { key: 'a', expand: 'A-base', source: 'shipped' },
      { key: 'b', expand: 'B-base', source: 'shipped' },
      { key: 'c', expand: 'C-base', source: 'shipped' },
    ]);
  });

  test('an override replaces a key’s WHOLE body and tags it with the layer; siblings stay shipped', () => {
    const merged = mergeSnippetLayers(base, [layer('user', [{ key: 'b', expand: 'B-user' }])]);
    expect.soft(merged.find((s) => s.key === 'b')).toEqual({ key: 'b', expand: 'B-user', source: 'user' });
    expect.soft(merged.find((s) => s.key === 'a')).toEqual({ key: 'a', expand: 'A-base', source: 'shipped' });
  });

  test('whole-body, not partial — the merged body is exactly the override body (no concat/merge)', () => {
    const merged = mergeSnippetLayers(base, [layer('user', [{ key: 'a', expand: 'totally new' }])]);
    expect(merged.find((s) => s.key === 'a')?.expand).toBe('totally new');
  });

  test('precedence: project beats user for the same key (last-wins), source = project', () => {
    const merged = mergeSnippetLayers(base, [
      layer('user', [{ key: 'b', expand: 'B-user' }]),
      layer('project', [{ key: 'b', expand: 'B-project' }]),
    ]);
    expect(merged.find((s) => s.key === 'b')).toEqual({ key: 'b', expand: 'B-project', source: 'project' });
  });

  test('base order is preserved regardless of override order', () => {
    const merged = mergeSnippetLayers(base, [layer('user', [{ key: 'c', expand: 'C2' }, { key: 'a', expand: 'A2' }])]);
    expect(merged.map((s) => s.key)).toEqual(['a', 'b', 'c']);
  });

  test('duplicate key WITHIN one layer → last entry wins', () => {
    const merged = mergeSnippetLayers(base, [layer('user', [{ key: 'a', expand: 'first' }, { key: 'a', expand: 'second' }])]);
    expect(merged.find((s) => s.key === 'a')?.expand).toBe('second');
  });

  test('fail-closed: an override naming an unknown key throws, naming the path and the key', () => {
    const bad = (): unknown => mergeSnippetLayers(base, [layer('project', [{ key: 'nope', expand: 'x' }])]);
    expect.soft(bad).toThrow(/\/fake\/project\.toml/);
    expect.soft(bad).toThrow(/"nope"/);
    expect.soft(bad).toThrow(/Overrides can only replace existing/);
  });

  test('the base array is not mutated (the cached shipped library must stay clean)', () => {
    mergeSnippetLayers(base, [layer('user', [{ key: 'a', expand: 'mutated?' }])]);
    expect(base.find((s) => s.key === 'a')?.expand).toBe('A-base');
  });
});

describe('loadEffectiveSnippets — contextual resolution over real files', () => {
  test('no override files → element-for-element identical to the shipped library, all shipped', () => {
    const effective = loadEffectiveSnippets({ cwd: tmpEmpty(), configDir: tmpEmpty() });
    expect.soft(effective.map((s) => ({ key: s.key, expand: s.expand }))).toEqual(loadSnippets());
    expect.soft(effective.every((s) => s.source === 'shipped')).toBe(true);
  });

  test('a user override changes one body and marks it user; the rest stay shipped', () => {
    const configDir = withUserSnippets(overrideToml([['write-spec', 'USER write-spec body']]));
    const effective = loadEffectiveSnippets({ cwd: tmpEmpty(), configDir });
    expect.soft(effective.find((s) => s.key === 'write-spec')).toEqual({ key: 'write-spec', expand: 'USER write-spec body', source: 'user' });
    expect.soft(effective.find((s) => s.key === 'review-spec')?.source).toBe('shipped');
  });

  test('project beats user when both override the same key', () => {
    const configDir = withUserSnippets(overrideToml([['write-spec', 'USER body']]));
    const cwd = withProjectSnippets(overrideToml([['write-spec', 'PROJECT body']]));
    expect(loadEffectiveSnippets({ cwd, configDir }).find((s) => s.key === 'write-spec')).toEqual({
      key: 'write-spec',
      expand: 'PROJECT body',
      source: 'project',
    });
  });

  test('user and project overriding DIFFERENT keys both apply', () => {
    const configDir = withUserSnippets(overrideToml([['write-spec', 'U']]));
    const cwd = withProjectSnippets(overrideToml([['review-spec', 'P']]));
    const eff = loadEffectiveSnippets({ cwd, configDir });
    expect.soft(eff.find((s) => s.key === 'write-spec')?.source).toBe('user');
    expect.soft(eff.find((s) => s.key === 'review-spec')?.source).toBe('project');
  });

  test('fail-closed: a project override of an unknown key throws naming the project file', () => {
    const cwd = withProjectSnippets(overrideToml([['no-such-key', 'x']]));
    const bad = (): unknown => loadEffectiveSnippets({ cwd, configDir: tmpEmpty() });
    expect.soft(bad).toThrow(/no-such-key/);
    expect.soft(bad).toThrow(/snippets\.toml/);
  });

  test('a schema-invalid override (missing expand) throws the clear library error naming the path', () => {
    const configDir = withUserSnippets('[[snippets]]\nkey = "write-spec"\n'); // valid TOML, missing expand
    const bad = (): unknown => loadEffectiveSnippets({ cwd: tmpEmpty(), configDir });
    expect.soft(bad).toThrow(/not a valid snippet library/);
    expect.soft(bad).toThrow(/snippets\.toml/);
  });

  test('a TOML *syntax* error names the path and the recovery action (not a bare throw)', () => {
    const configDir = withUserSnippets('this is not valid toml [[[');
    const bad = (): unknown => loadEffectiveSnippets({ cwd: tmpEmpty(), configDir });
    expect.soft(bad).toThrow(/is not valid TOML/);
    expect.soft(bad).toThrow(/snippets\.toml/);
    expect.soft(bad).toThrow(/fix or remove the file/i);
  });
});

describe('the contextual API takes explicit dirs — no ambient home read', () => {
  test('an empty context (no fields) is shipped-only, every element shipped (the honest contract)', () => {
    // Point 4: loadEffectiveSnippets({}) must NOT default the config dir to the
    // real ~/.config/greenflag — with neither field it is the shipped base verbatim.
    const eff = loadEffectiveSnippets({});
    expect.soft(eff.map((s) => ({ key: s.key, expand: s.expand }))).toEqual(loadSnippets());
    expect.soft(eff.every((s) => s.source === 'shipped')).toBe(true);
  });

  test('runtimeLibraryContext points configDir at <home>/.config/greenflag and resolves the user layer there', () => {
    // The production path (the ONE place home is read), tested with an explicit
    // home arg — no env mutation needed.
    const home = tmpEmpty();
    mkdirSync(join(home, '.config', 'greenflag'), { recursive: true });
    writeFileSync(join(home, '.config', 'greenflag', 'snippets.toml'), overrideToml([['write-spec', 'HOME user override']]));
    const ctx = runtimeLibraryContext(tmpEmpty(), home);
    expect.soft(ctx.configDir).toBe(join(home, '.config', 'greenflag'));
    expect.soft(loadEffectiveSnippets(ctx).find((s) => s.key === 'write-spec')).toEqual({
      key: 'write-spec',
      expand: 'HOME user override',
      source: 'user',
    });
  });
});

describe('byte-for-byte identity — no override files ⇒ today’s served library', () => {
  // The hard invariant: a libraryContext pointing at EMPTY dirs (no override
  // files) must render byte-identical to the no-context render, across every
  // render mode. This is the no-override author's "nothing changes for me".
  test.for<[string, SnippetRenderOpts]>([
    ['flat menu (no args)', {}],
    ['all=true', { all: true }],
    ['phase: spec', { phase: 'spec', workflow: 'full' }],
    ['phase: plan / full', { phase: 'plan', workflow: 'full' }],
    ['phase: research / rir', { phase: 'research', workflow: 'short' }],
    ['phase: impl / full + all', { phase: 'implement', workflow: 'full', all: true }],
    ['consultant-bound, frame, all', { phase: 'frame', workflow: 'full', consultantBound: true, all: true }],
  ])('%s renders identically with an empty libraryContext', ([, opts]) => {
    const libraryContext = { cwd: tmpEmpty(), configDir: tmpEmpty() };
    expect(renderSnippetLibrary({ ...opts, libraryContext })).toBe(renderSnippetLibrary(opts));
  });
});

describe('overrides serve through the render path (provenance never leaks to workers)', () => {
  test('an overridden body is served; the XML tag keeps its exact shape (no source marker)', () => {
    const cwd = withProjectSnippets(overrideToml([['write-spec', 'PROJECT-OVERRIDDEN write-spec body']]));
    const rendered = renderSnippetLibrary({ phase: 'spec', workflow: 'full', libraryContext: { cwd, configDir: tmpEmpty() } });
    expect.soft(rendered).toContain('PROJECT-OVERRIDDEN write-spec body');
    expect.soft(rendered).toContain('<snippet key="write-spec">'); // tag closes right after key — no provenance attr
    expect.soft(rendered).not.toContain('source="project"'); // the marker we'd emit if provenance leaked
  });

  test('the override actually takes effect — the served library differs from the no-context render', () => {
    const cwd = withProjectSnippets(overrideToml([['write-spec', 'DISTINCT override marker']]));
    expect(renderSnippetLibrary({ phase: 'spec', workflow: 'full', libraryContext: { cwd, configDir: tmpEmpty() } })).not.toBe(
      renderSnippetLibrary({ phase: 'spec', workflow: 'full' }),
    );
  });

  test('{{lessons_dir}} resolves in an OVERRIDDEN body too (uniform across layers)', () => {
    const cwd = withProjectSnippets(overrideToml([['start-plan', 'see {{lessons_dir}}/testing/tdd-loop.md for the method']]));
    const rendered = renderSnippetLibrary({ all: true, libraryContext: { cwd, configDir: tmpEmpty() } });
    expect.soft(rendered).toContain(join(LESSONS_DIR, 'testing/tdd-loop.md'));
    expect.soft(rendered).not.toContain('{{lessons_dir}}');
  });
});

describe('getEffectiveSnippet — the `greenflag snippets show` data path', () => {
  test('returns the effective body + provenance for an overridden key', () => {
    const configDir = withUserSnippets(overrideToml([['review-spec', 'USER review-spec']]));
    expect(getEffectiveSnippet('review-spec', { cwd: tmpEmpty(), configDir })).toEqual({
      key: 'review-spec',
      expand: 'USER review-spec',
      source: 'user',
    });
  });

  test('an un-overridden key resolves from shipped', () => {
    expect(getEffectiveSnippet('write-spec', { cwd: tmpEmpty(), configDir: tmpEmpty() })?.source).toBe('shipped');
  });

  test('unknown key → undefined', () => {
    expect(getEffectiveSnippet('no-such-key', { cwd: tmpEmpty(), configDir: tmpEmpty() })).toBeUndefined();
  });

  test('the {{lessons_dir}} token is left UNRESOLVED in the stored show form (readable, machine-independent)', () => {
    expect(getEffectiveSnippet('start-plan', { cwd: tmpEmpty(), configDir: tmpEmpty() })?.expand).toContain('{{lessons_dir}}');
  });
});

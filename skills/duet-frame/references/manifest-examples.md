# Manifest examples — what the user says, and the frontmatter that says it

A framing's frontmatter is the **run manifest**: the workflow, the gate posture, and any per-voice bindings, riding the same file as the problem. Translating the user's intent into that manifest is this skill's job, so each example below is a sentence a user actually says, followed by the manifest that says it. Two rules generalize across all of them:

- **Omission is part of the grammar.** Every key has a workflow default, and a manifest that says less is usually the better one — each example names what it deliberately leaves out and what the omission means.
- **Precedence is per key: flags > framing > config > shipped defaults.** A framing that binds only the judge leaves every other voice on the user's config or the shipped defaults.

The launch command never changes shape — `duet new --framing .duet/<slug>.md` (plus `--interactive` to drive the planning gates from the user's own session) — everything below rides the file, not the flags.

These framings are parsed by duet's real grammar in `tests/skill.test.ts`, so what you read here is exactly what duet accepts.

## 1 · "A small, well-understood fix — settle the direction with me, then just ship it."

```framing
---
workflow: short
---

# Problem
<the fix and its scope boundary, one tight paragraph>

# Verification
- Typecheck / tests: <commands>
```

`workflow: short` is the one call worth recording: research → implement → PR, no document ceremony. **Omitted:** `gates_at` — short's default attends the Direction gate only: the user approves the research direction, then the build, Ship, and Open-PR auto-cross to a finished run with the PR open (a user who wants to verify before it ships says so — `gates_at: research,implement` returns them for the Ship gate); bindings — the shipped posture (claude makers, codex checkers) stands unless the user says otherwise. The frontmatter could even be empty (the default workflow is `full`) — every key here earns its line by recording a real decision.

## 2 · "Substantial work, but the technical depth can ride with the builder — I'll read one document, tap once, and walk away."

```framing
---
workflow: blueprint
---

# Problem
<what to build and why, with the scope boundary>

# Onboarding
<the files to read first, by path>
```

One committed spec carries the whole design, absorbing the tactics full defers to its plan — blueprint is full minus the plan phase. **Omitted:** `gates_at` — blueprint's default is already attend-`spec`-only, the one-interruption promise this sentence asks for; writing `gates_at: spec` would only restate it. The Direction gate auto-crosses (a contentious direction still stops the run — a high-stakes call at an auto-crossed gate converts it to an attended stop), the user reads the doc, taps once, and the delivery runs to an open PR.

## 3 · The standard relay — "Plan on Claude; codex builds it cheap; a strong judge reviews with write access and owns the PR."

```framing
---
workflow: relay
bind.builder: codex
bind.judge: claude:claude-fable-5
---

# Problem
<work where the spec will be strong enough that the build is labor, not judgment>
```

The two binds are relay's whole economy — a cheap builder under a strong judge — and a duty alone names its stage, so there is no `delivery.` prefix to spell. A bind can pin more than a provider: a model (codex included, `bind.builder: codex:gpt-5-codex`), a reasoning effort (`@high`), or both (`codex:gpt-5-codex@high`); raw provider flags live in config as `claude_args` / `codex_config`, never a `bind.*` key. The judge *fixing* findings directly and owning docs + PR is the workflow's shape, not the binding's: binding it to a stronger model is what makes that shape safe. **Omitted:** the planning duties — `architect` (claude) and `analyst` (codex) stay on defaults; `gates_at` — the same attend-`spec`-only default as blueprint. Relay's delivery is born fresh by design (the builder implements the committed doc cold), so a cross-provider pair like this costs nothing in session continuity.

## 4 · "The direction is settled — run straight to a PR, and keep the correctness net."

```framing
---
workflow: blueprint
gateless: true
bind.consultant: claude
---

# Problem
<a settled direction the user has already decided to bet on>
```

`gateless: true` pre-authorizes **every** gate — the run flows to an open PR with no attended stop — and narrows a bound consultant to its non-holding work: the bet audits that could pause the run mid-flight drop, while the framing third-opinion and the **acceptance contract** survive (authored at the spec gate, verified against the built system before Ship — a contract that stays broken still stops the run, which is the net this sentence keeps). `bind.consultant: claude` binds the outside voice and by itself implies it is on. **Omitted / rejected:** `gates_at` — gateless already answers the posture question, and duet rejects the two side by side; `interactive` — gateless is its opposite (nothing to attend), so they don't combine.

## 5 · "This is a hotfix lane: triage once, patch once, open the PR."

When the shipped names do not describe the process shape cleanly, define a project workflow first — the `hotfix` definition at `.duet/workflows/hotfix.ts` is worked example 3 in [workflow-definitions.md](workflow-definitions.md). Then select it from the framing:

```framing
---
workflow: hotfix
---

# Problem
<a small urgent fix where the user wants one attended triage gate, then a single writable patch pass>
```

`workflow: hotfix` is an open identity, resolved from `.duet/workflows/hotfix.ts` at run creation. The workflow file is compiled and frozen into the run; editing it later does not change the live run. **Omitted:** `gates_at` — the definition's `attend: ['triage']` already says the only attended gate; bindings — the shipped duty defaults stand unless the user asks for a different model.

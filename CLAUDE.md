# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

`duet` began as a documentation-first research project and entered **implementation on 2026-06-11**: the repo root is now also the source code (pnpm + TypeScript, flat structure — no separate `mvp/` directory). The research half (`docs/`, `examples/`, `schemas/`) remains authoritative for *what* to build; the code in `src/` builds it. Node 24 runs `.ts` directly — there is no build step; `pnpm typecheck` is the only check command so far.

The experiment: the human author has a stable manual workflow for developing features with two coding agents — one **implementer**, one **reviewer** — and currently acts as a clipboard router between them, plus as editor-in-chief at a few key gates. The goal is to capture that workflow precisely enough to build a **semi-AFK orchestrator** that automates the routing while leaving the gates to the human.

As of the **2026-06-11 pivot**, the design has three roles: a read-only, intelligent LLM **orchestrator** (drives the snippet protocol, adapts prompts per-turn, judges loop exits, triages questions — never writes, never answers substance) commanding the implementer and reviewer, inside a code-enforced skeleton of three phases (attended PLANNING → AFK IMPLEMENTATION → attended FINAL REVIEW) whose human gates agents cannot cross. Roles are **decoupled from providers**: each binds to the `claude` provider (per-role Anthropic model ID) or the `codex` provider (no model key — the user's own codex config governs) via a minimal role-bindings config file, the one config duet ships (`docs/automation-design.md` §"Roles are decoupled from providers"). This reversed the earlier "dumb state-machine router" design; the rationale is recorded in `docs/automation-design.md` §"Design history" and the strike-through notes on `docs/open-questions.md` Q7/Q8/Q10. Implementation started 2026-06-11 at the repo root (`src/`), beginning with the Q11 substrate spike and the Q14 Slice 1 (orchestrator-driven SPEC loop). Stack: XState v5 (Q15), execa 9, zod 4, commander, `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk` (pinned alongside the codex CLI version).

## What's here, and the reading order

1. `README.md` — one-screen orientation.
2. `docs/observed-pattern.md` — turn-by-turn breakdown of one real session, with timestamps and snippet usage.
3. `docs/workflow-model.md` — the abstracted state machine (phases, snippet vocabulary, loop semantics).
4. `docs/automation-design.md` — what to automate, what to gate on humans, sketch of an MVP.
5. `docs/open-questions.md` — Q1–Q10 resolved (with 2026-06-11 amendment/reversal notes on Q7/Q8/Q10); Q11–Q16 are the pivot's open questions gating implementation. The strike-through structure preserves the historical reasoning behind each decision; read this to understand *why* the design is what it is, and to find the operational conventions (e.g., per-run notes file) that emerged from the answers.
6. `docs/prompting-and-tool-design.md` — the prompt-design and tool-design reference, distilled from Anthropic's published guidance (sources linked inside). **Consult this whenever writing or revising an agent prompt, tool definition, tool result, or error message** — it carries duet's five binding conventions (artifacts-first/XML prompts, thinking-framework-over-prohibition, descriptions-surface-the-implicit, errors-prescribe-recovery, results-nudge-next-step) and the house patterns from the Q11 spike.
7. `examples/` — verbatim copies of the source materials the analysis is built on:
   - `claude-code-session.jsonl` — the implementer's session log.
   - `codex-session.jsonl` — the reviewer's session log.
   - `tabtype-snippets.json` — the snippet vocabulary that defines the protocol.
   - `skills/onboarding/SKILL.md` — verbatim copy of the iTELL `/onboarding` skill.
   - `skills/update-docs/SKILL.md` — verbatim copy of the iTELL `/update-docs` skill.
   - `skills/update-docs/SKILL.orchestrator.md` — proposed orchestrator-aware variant of the same skill. Diff is a single conditional in Step 4. Referenced by `docs/open-questions.md` Q2.
8. `schemas/agent-response.json` — the JSON Schema from the pre-pivot design, empirically verified against both CLIs (`claude --json-schema` / `codex exec --output-schema`). **Demoted 2026-06-11**: exception detection (`needs_human`, `disagree`) is now the orchestrator's judgment; whether a minimal envelope survives is `docs/open-questions.md` Q16.
9. `references/` — shallow clones of external repos kept as design references (added 2026-06-11; not dependencies, not pinned). **Check `references/README.md` before copying any code** — it records each repo's purpose and license boundary: sandcastle and pi-mono are MIT (copy with attribution), the Codex SDK is Apache-2.0 (copy with attribution), claude-squad is AGPL (read-only inspiration), and the Claude Agent SDK is proprietary (consume as an npm dependency; read source only to understand the API).

## Conventions

- **Evidence-backed claims.** When making a claim about the workflow, cite the relevant turn / line in `examples/*.jsonl`, or quote the snippet from `examples/tabtype-snippets.json`. The whole point of keeping the example files in-repo is so claims stay falsifiable.
- **Label generality.** Tag claims as **(observed)** when they come from the single example session, **(general)** when they come from the user's broader description of their workflow. Conflating the two is the main thing to avoid — there is exactly one session of evidence, and the user's described pattern has more variance.
- **Docs lead, code follows.** The design phase concluded with the 2026-06-11 pivot; implementation now lives at the repo root (`src/`). Further doc edits should be in service of the Q11+ spikes, Slice 1 implementation feedback, or new evidence from sampled sessions — not another redesign. When code and docs disagree, treat it as a doc bug or a design regression to resolve explicitly, not silently.
- **No build step.** Node 24 native type stripping runs `src/*.ts` directly; `tsconfig.json` is checker-only (`pnpm typecheck`). Keep syntax erasable (no `enum`/`namespace`/parameter properties) and use explicit `.ts` import extensions.
- **Personal tool, not OSS.** Duet is built for one developer's use across their own projects, not as a product for thousands of users. The CLI itself is project-agnostic — it doesn't ship with skills, doesn't bundle project conventions, doesn't introspect codebases. Project-specific knowledge — which skills to invoke, where specs go, which models to default to — is the user's job to provide in the framing turn for each run. The user knows their projects; the CLI runs the workflow protocol. Don't add fallbacks, project-detection logic, configuration layers, or generalization beyond what the immediate use case requires. "Make it work for the way the author works, don't make it work for everyone."
- **Augmentation, never lock-in.** Everything duet produces must be useful and inspectable without duet itself: JSONL transcripts go to the standard `~/.claude/projects/...` and `~/.codex/sessions/...` locations; branches and commits look like manual ones; the structured output schema is enforced by the CLIs themselves, not by a duet wrapper. The user must be able to stop using duet mid-run, continue manually, and either resume duet later or never — without the state file becoming an obstacle. The state file is a hint; the JSONL transcripts are the source of truth.

## Common edits

The likely classes of edit going forward:

- Adding a new sampled session to `examples/` (per the Q3 sampling plan in `docs/open-questions.md`) and updating `docs/observed-pattern.md` with the phase-presence findings.
- Adding new design questions (Q17+) to `docs/open-questions.md` as Q11–Q16 spikes and Slice 1 operational notes accumulate. The per-run notes-file convention is `.duet/runs/<run_id>.notes.md` (written by both the human and the orchestrator's `write_note` tool).
- Refining `docs/automation-design.md` (e.g. orchestrator tool surface, triage rules) as the spikes reveal friction. If any worker schema survives Q16, edits to `schemas/agent-response.json` must preserve OpenAI-strict compliance (every property in `properties` listed in `required`, optionals via `anyOf null`).
- Porting the proposed `ceo-summary` snippet (documented in `docs/workflow-model.md`) into the tabtype config once adopted, and recording the sync convention per Q12.
- Tightening `docs/workflow-model.md` if additional sessions show that parts currently labeled "stable" are actually variable.

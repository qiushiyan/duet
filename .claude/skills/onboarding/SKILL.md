---
name: onboarding
description: Bootstrap a duet coding session with a topic-scoped mental model — Phase 1 core reads, then a deep dive on the topic — before substantive work on the orchestrator.
user-invocable: true
disable-model-invocation: true
argument-hint: [topic, e.g. "statechart", "providers", "prompts"]
allowed-tools: Read, Bash, Agent, Grep, Glob
---

# Topic-aware onboarding

You're bootstrapping a coding session on duet — the read-only orchestrator that routes a snippet protocol between an implementer and a reviewer inside a code-enforced statechart. Build a focused mental model, scoped to the user's topic, before any code-editing. The topic is in `$ARGUMENTS`; empty means general onboarding.

duet's mental model and conventions live in `CLAUDE.md` (always loaded). Re-internalize it now if it isn't fresh — the trust gradient, the phase table as the single source, and the "invariants that bite if forgotten" are load-bearing.

## Protocol

### 1. Interpret the topic

Map `$ARGUMENTS` to a focus. The `engineering.md` module map is the source of truth for what exists in code (CLAUDE.md indexes the docs); this table only turns a phrase into a focus:

| If the topic mentions…                                                | Focus       |
| --------------------------------------------------------------------- | ----------- |
| statechart, machine, phases, gates, lifecycle, driver, crash / resume, resilience, watchdog, timeout, afk | `harness`   |
| providers, workers, claude, codex, transport, interactive, pane       | `providers` |
| prompts, tools, snippets, orchestrator prompt, tool results, errors   | `prompts`   |
| framing, templates, CLI, status, run-store, steers, persistence, health, doctor, supervision | `surface`   |
| design, product, scope, what-to-build, gate policy, direction         | `design`    |

Ambiguous (no confident match, or several)? Ask one short clarifying question first. Empty `$ARGUMENTS` → step 4.

### 2. Phase 1 — always-on core reads

Regardless of topic, read these three in order. They're the mental model no duet task can skip:

1. `CLAUDE.md` — the what / how summary, the Map, and the invariants. (Re-read if not fresh.)
2. `docs/automation-design.md` — THE design: roles, layers, the phase/gate arc, triage rules, branch policy, what-not-to-build.
3. `docs/engineering.md` — the codebase mental model: the trust gradient, module map, the seams, the patterns that carry the design.

Read them yourself — don't delegate Phase 1 to subagents. They have to be in your working context for the rest of the session.

### 3. Phase 2 — topic deep dive

Open your focus's design doc(s), then its code through the `engineering.md` module map — it holds the full file list with one-line pointers, so this skill names only the way in, not every file. Don't re-read Phase 1. Where each focus starts:

- **`harness`** (statechart & run loop) — `automation-design.md` §"Phases and gates" + §"Invocation and lifecycle"; anchor on `src/phases.ts` (the registry, the single source) and `src/harness/machine.ts`. For the AFK resilience window (timeouts, the forced watchdog, the two recovery planes), read `engineering.md` §"AFK resilience" + `automation-design.md` §"Resilience for the AFK window" (the wall-clock backstop is `src/providers/wall-clock.ts`).
- **`providers`** (worker seam & transports) — `docs/interactive-transport.md`; anchor on `src/providers/types.ts` (the `WorkerProvider` contract).
- **`prompts`** (agent prompts, tools, snippets) — `docs/prompting-and-tool-design.md` (read first); anchor on `src/harness/tools.ts` and `snippets.toml`.
- **`surface`** (CLI, framing, status, persistence) — anchor on `src/run-store.ts` and `src/status.ts`; `src/cli.ts` wires the commands.
- **`design`** (direction & rationale) — `automation-design.md`, then `future-directions.md` (check before proposing a direction) and `open-questions.md` (what's still open).

For a tight cross-cutting question, dispatch one `Explore` subagent with a single extraction question (e.g. "how does a pending steer reach a live driver?") — file refs only, no source pasting. Read the files yourself for a careful audit.

### 4. General onboarding (no topic)

Empty `$ARGUMENTS`: complete Phase 1 only, then ask the user which focus they want before reading further. The focuses are different enough that picking one matters; reading all upfront burns context for no gain.

### 5. Calibration check

Before touching code, report back in ~120 words:

1. The topic in your own words.
2. The two or three load-bearing facts that will shape the work.
3. Anything that contradicted an initial assumption.

Can't write it without hedging? Re-read the weakest section first.

## Guardrails

- **The doc tree is the source of truth, not this skill.** A path here that's wrong or has moved → flag it, don't paper over it. Updating this skill is part of the cadence in `docs/documentation-standards.md`.
- **Never paste source into your reasoning.** Docs describe the contract; code is the implementation. Quote file paths and names, not bodies.
- **Phase 1 always happens.** Even a small change touches the trust gradient or the phase table. Don't skip the core.
- **Docs lead, code follows.** If the code contradicts a doc, that's a finding to surface — not something to silently match.

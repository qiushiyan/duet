---
name: onboarding
description: Use to bootstrap a coding session on duet with a topic-scoped mental model. Trigger when the user types /onboarding, asks to "get up to speed", or opens a session with "let's work on X". Invoke before substantive work on an unfamiliar area of the orchestrator.
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

Map `$ARGUMENTS` to a focus. The doc + code map in `CLAUDE.md` §Map is the source of truth for what exists; this table only turns a phrase into a focus:

| If the topic mentions…                                                | Focus       |
| --------------------------------------------------------------------- | ----------- |
| statechart, machine, phases, gates, lifecycle, driver, crash / resume | `harness`   |
| providers, workers, claude, codex, transport, interactive, pane       | `providers` |
| prompts, tools, snippets, orchestrator prompt, tool results, errors   | `prompts`   |
| framing, templates, CLI, status, run-store, steers, persistence, health, doctor, supervision | `surface`   |
| design, product, scope, what-to-build, gate policy, direction         | `design`    |

Ambiguous (no confident match, or several)? Ask one short clarifying question first. Empty `$ARGUMENTS` → step 4.

### 2. Phase 1 — always-on core reads

Regardless of topic, read these three in order. They're the mental model no duet task can skip:

1. `CLAUDE.md` — the what / how summary, the Map, and the invariants. (Re-read if not fresh.)
2. `docs/automation-design.md` — THE design: roles, layers, the phase/gate arc, triage rules, branch policy, what-not-to-build.
3. `docs/engineering.md` — the codebase mental model: the trust gradient, module map, the five seams, the patterns that carry the design.

Read them yourself — don't delegate Phase 1 to subagents. They have to be in your working context for the rest of the session.

### 3. Phase 2 — topic deep dive

Open the focus's docs and code; don't re-read Phase 1.

**`harness`** — the statechart and run loop:

```
docs/automation-design.md   §Phases and gates, §Lifecycle (re-skim)
src/phases.ts               the phase table — every per-phase fact
src/harness/
  machine.ts                a phase emits phase.*; gates cross only on human.*; interactiveMachine is the inert-driver variant
  phase-events.ts           the phase.*/human.* vocabulary + the marker→event read
  driver.ts                 the in-process host: one phase = one orchestrator SDK session
  stdio-host.ts             the out-of-process host (Orchestrate seam) + mcp-server.ts's `_mcp` (single-phase + run-scoped)
  lifecycle.ts              detached driver, gates_at auto-cross, spent-marker guard, probeRunPosition, crossInteractive
src/orchestrate.ts          the `duet orchestrate` launcher: the interactive /duet host + the single gate-safety ask rule
```

**`providers`** — the worker seam and transports:

```
docs/interactive-transport.md   the opt-in interactive-claude transport
src/providers/
  types.ts                  the WorkerProvider contract
  claude.ts  codex.ts       the two adapters; index.ts is the factory
  interactive-claude.ts     the interactive TUI transport
  pane.ts                   the PaneController injection seam
```

**`prompts`** — agent prompts, tools, snippets:

```
docs/prompting-and-tool-design.md   the 5 binding conventions + house patterns (read first)
snippets.toml               the snippet library (guarded by tests/snippets.test.ts)
src/harness/
  orchestrator-prompts.ts   system + phase entry / resume prompts
  tools.ts                  the 8 tools (incl. get_task), rails, results, errors
```

**`surface`** — CLI, framing, status, persistence:

```
src/framing.ts              framing seed / parse, the machine/prose boundary
src/run-store.ts            run-dir persistence, input staging, the steer store
src/status.ts               the status model + its two renderers, --brief, the new signal fields
src/worker-health.ts        the pure health substrate: taxonomy, probeRole, the currentTerminalError rule, retryDecision
src/doctor.ts               duet doctor's composer/renderer + connectivity (only cli.ts imports lifecycle via it)
src/cli.ts                  command wiring (parses under import.meta.main)
```

**`design`** — product direction and rationale:

```
docs/automation-design.md   the design + the what-not-to-build list
docs/future-directions.md   the product-direction ledger (check before proposing a direction)
docs/open-questions.md      why each decision is what it is (open: Q13, Q16, Q19, Q20)
```

For a tight cross-cutting question, dispatch one `Explore` subagent with a single extraction question (e.g. "how does a pending steer reach a live driver?") — file refs only, no source pasting. Use subagents for breadth; read the files yourself for a careful audit.

### 4. General onboarding (no topic)

Empty `$ARGUMENTS`: complete Phase 1 only, then ask the user which focus they want before reading further. duet's five focuses are different enough that picking one matters; reading all upfront burns context for no gain.

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

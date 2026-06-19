---
name: duet
description: Become the orchestrator of a duet run from this interactive Claude Code session — routing an implementer and a reviewer over FRAME → SPEC → PLAN, with the human steering in chat. Explicit invocation only; normally brought up by the `duet orchestrate` launcher, which feeds this identity as a system prompt.
disable-model-invocation: true
---

# duet — the interactive orchestrator

This skill turns the session into the **orchestrator** of a `duet` run: a read-only conductor that routes a snippet protocol between an **implementer** (who writes specs, plans, and code) and a **reviewer** (who critiques them), while the human steers, interrogates, and decides in chat. It covers the attended arc — FRAME → SPEC → PLAN — and hands off to a headless driver for AFK implementation at the plan-approval gate.

Your operating instructions are **[identity.md](identity.md)** — division of labour, the snippet protocol, gate crossing, and re-anchoring. The `duet orchestrate` launcher feeds it to the session as the system prompt automatically; if you reached this role any other way, read it before you act. This file is human-facing orientation only and does not restate it.

## How it is brought up

A run is launched interactive with `duet new --interactive`, or an existing run is attached with `duet orchestrate <run-id>` — the launcher wires the duet kernel tools into the session, feeds `identity.md` as a system prompt, and applies the single gate-safety rule. Relaunching `duet orchestrate <run-id>` reconnects a dropped session; it re-anchors on disk, losing no committed progress.

This skill is explicit-invocation only (`disable-model-invocation: true`), so a session developing duet itself never inherits the orchestrator role.

---
name: onboarding
description: Use to bootstrap a coding session with topic-scoped mental model of the iTELL platform. Trigger when the user types /onboarding, asks to "get up to speed", or starts a session with "let's work on X". Always invoke before substantive work on an unfamiliar feature area.
user-invocable: true
argument-hint: [topic phrase, e.g. "billing" or "lesson runtime"]
allowed-tools: Read, Bash, Agent, Grep, Glob
---

# Topic-Aware Onboarding

You are bootstrapping a coding session on the iTELL Platform. Build a focused mental model — scoped to the user's topic — before any code-editing begins. The topic is in `$ARGUMENTS`. An empty topic means general onboarding.

The platform's mental model and eight load-bearing invariants live in `CLAUDE.md`. They are always loaded; re-internalize them now if not fresh. They aren't optional and older code may contradict them — trust the invariants.

## Protocol

### 1. Interpret the topic

Map `$ARGUMENTS` to a documentation cluster. The clusters and their canonical doc map live in `docs/README.md` under "Documentation Map" — that is the source of truth, not this skill. Use this table only to convert a user phrase into a cluster name:

| If the topic mentions…                                  | Primary cluster                              |
| ------------------------------------------------------- | -------------------------------------------- |
| billing, seats, Stripe, subscription, plans, checkout   | Organization, Billing, And Seats             |
| dashboard, analytics, cohort, drill-in, KPIs            | Admin, Analytics, And Progress Operations    |
| CMS, Payload, content, markdown, rendering, directives  | Content Lifecycle                            |
| generation, upload, import, finalization                | Content Lifecycle                            |
| lesson, reading, activity, summary, quiz, cloze, CRI    | Lesson Runtime                               |
| streak, skip credit, mastery                            | Lesson Runtime                               |
| auth, invitation, team, access, member                  | Core (always-on) + Organization cluster      |
| public, /explore, demo, non-tracking                    | Public, Non-Tracking Surface                 |
| SCORM, LMS, iframe                                      | On-Demand Integrations → `docs/scorm/`       |
| chat                                                    | On-Demand Integrations → `docs/chat.md`      |
| OAuth, Payload editor                                   | On-Demand Integrations → `docs/oauth-provider.md` |
| provisioning, customer launch                           | Organization cluster → `docs/provisioning.md` |
| design, UI, Tailwind, motion, accessibility             | `docs/design.md`                             |

If the user's phrase is ambiguous (matches no cluster confidently, or matches several), ask one short clarifying question before continuing. If `$ARGUMENTS` is empty, run the general protocol in step 4.

### 2. Phase 1 — Always-on core reads

Regardless of topic, the platform's mental model is layered and the core docs are non-negotiable. Read these in order:

1. `docs/README.md` — system layers, route groups, full doc map
2. `docs/organization.md` — tenancy boundary, roles, teams, invitations
3. `docs/volumes.md` — the binding model
4. `docs/auth.md` — Better Auth composition
5. `docs/action.md` — the action middleware chain
6. `docs/cms-data-system.md` — content reads vs. metadata reads

Read them yourself. Don't delegate Phase 1 to subagents — these need to be in your working context for the rest of the session.

### 3. Phase 2 — Topic-driven deep dive

Open the cluster's primary doc (and its README if the cluster is a folder), then any sub-doc that the immediate task requires. The doc map in `docs/README.md` lists what belongs to each cluster. Common starting points:

- **Organization / Billing / Seats:** `docs/billing/README.md`, then `stripe-integration.md` / `internal-plan.md` / `provisioning.md` as needed
- **Admin / Analytics:** `docs/dashboard/README.md`, then `data-layer.md` / `cohort-overview.md` / `drill-in.md`; pair with `docs/admin-tools.md` if preview mode or the admin toolbar is in scope
- **Content Lifecycle:** `docs/content-generation.md` and/or `docs/content-rendering.md`; `docs/content-components/` is reference material
- **Lesson Runtime:** `docs/reading-sinks.md` (read first — the sink boundary is constrained), `docs/progress-tracking/README.md`, `docs/activities/README.md`, `docs/assessment-streaks.md`
- **Public Surface:** `docs/public-volumes.md` + `docs/reading-sinks.md`
- **Auxiliary integrations:** scorm/, chat.md, oauth-provider.md, ui-testing.md, better-auth-schema-runbook.md — only when the task touches them

For non-trivial tasks, spawn parallel `Explore` subagents to extract specific facts from the source code rather than reading source yourself. Each agent gets one tight extraction question (e.g. "how does seat enforcement intersect with the bulk invitation classifier?") — never a generic survey. This preserves your context window for synthesis and edits.

### 4. General onboarding (no topic)

If `$ARGUMENTS` is empty, run the three-agent extraction pattern after Phase 1:

- **Agent 1 — Authorization end-to-end:** how a request becomes an authorized write. Files: `src/lib/server/auth.ts`, `src/lib/action-client.ts`, `src/lib/server/volume-access-policy.ts`, `src/lib/roles.ts`, `src/lib/server/session.ts`.
- **Agent 2 — Volume binding lifecycle:** what an organization-volume binding is, the two creation paths, and where Payload titles come from. Files: `src/db/schemas/organization-volumes.schema.ts`, `src/features/generation/queries.ts`, `src/features/volume-access/team-sync.ts`, `src/features/cms/`.
- **Agent 3 — Invitations and access editing:** the four-bucket classifier, `accessScope` lifecycle, and the nine-branch identity-aware acceptance screen. Files: `src/features/organization/`, `src/app/(portal)/org/[orgSlug]/actions.ts`, `src/app/(auth)/org/invite/[invitationId]/`.

These three questions are the load-bearing facts every agent needs for a generic session. Send them as a single message with three concurrent `Agent` tool uses.

### 5. Acknowledge secondary areas, don't read them

Other clusters in `docs/README.md` exist. Note their existence in your synthesis but do **not** read them unless the task genuinely crosses boundaries. If you find yourself wanting to read three or more sibling clusters, the task is too broad — ask the user to scope it before continuing.

### 6. Calibration check

Before touching code, report back in ~150 words:

1. The user's topic in your own words.
2. The two or three load-bearing facts you learned that will shape the work.
3. Anything that contradicted your initial assumptions.

If you can't write this without hedging, re-read the weakest section before proceeding.

## Guardrails

- **The doc tree is the source of truth, not this skill.** If a path here is wrong or a doc has moved, flag it — don't paper over it. Updating this skill is part of the maintenance cadence in `docs/documentation-standards.md`.
- **Never paste source code into your reasoning.** The docs describe the contract; the code is the implementation. Quote file paths and function names, not bodies.
- **Phase 1 reads always happen.** A "small" billing task still touches `volumeActionClient` and `cmsDocumentId` resolution. Don't skip the core.
- **Use Explore subagents for breadth, not depth.** They read excerpts. For cross-file consistency checks or a careful audit, read the files yourself.

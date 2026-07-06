# Spec — Inline provider models, normalized effort, and native-arg passthrough

> **For the implementer.** This is a design-complete spec written from an exploration pass; no code has been changed. **Defer all documentation updates** — do not touch `CLAUDE.md`, `docs/automation-design.md`, `docs/engineering.md`, or any other doc as part of this work. The doc reconciliation is a separate, later step (a maintainer will run it or ask you to). Ship the code + tests; leave the prose to the docs pass.

## Summary (for the leader)

**What we're adding.** Three related widenings of the voice **binding**, so a run can tune *how a voice runs* the same way it already picks *which provider*:

1. **Inline codex model** — `--bind analyst=codex:gpt-5-codex`, `bind.builder: codex:gpt-5-codex`, or `[duties.analyst] model = "…"`. Today a codex model is **rejected** (`bindings.ts:148`); claude has had per-model bindings all along. This is the headline of the branch.
2. **Normalized reasoning effort** — a single `effort` knob (`low|medium|high|xhigh|max`) that maps to each provider's native effort setting, inline as `codex:gpt-5-codex@high` / `claude:opus@max` or as an `effort = "high"` config field.
3. **Native-arg passthrough (the escape hatch)** — a per-binding, config-file-only way to hand raw native arguments to the underlying CLI (`claude_args = [...]` appended to the claude argv; `codex_config = { … }` fed to codex's `-c` overrides), for the long tail duet will never model — guarded not by a denylist but by a **preflight** that surfaces bad input at `duet new`, never mid-run.

**The approach.** A binding stops being `{provider, model?, transport?}` and becomes **normalized, provider-agnostic intent** — `{provider, model?, effort?, transport?, native?}` — that each provider adapter *translates into its own launch*. The resolution layer (`resolveRunConfig`, `bindings.ts:358`) keeps its exact per-key precedence shape; only the payload it carries widens, and the scattered `if (provider === 'codex')` rejections collapse into one **capability table** read at validation time (the codebase's own "policy as data, not scattered conditionals" pattern — `voices/policy.ts`, `ACTION_CATALOG`). Two vocabularies, opposite discipline: duet's *own* knobs (model default, effort enum) are **validated fail-closed**; the *native* passthrough is **never parsed or filtered** — duet is a conduit, and the provider is its own judge, asked *early* by a preflight.

**The boundary once it lands.**
- **Covered.** Codex model inline + in config; a normalized `effort` on both providers, inline (`@effort`) + in config, validated per-provider; a config-only native-args escape hatch per worker binding; a `duet new`-time preflight that turns every bad-arg / bad-model mistake into an early, human-present failure (or a native warning), never a mid-phase one; `formatBinding` / `duet stats` / the `duet new` echo showing a codex model + effort.
- **Not covered — by decision.** No denylist / no "duet-owned-flags" enforcement (documented as *guidance* only). No inline (`--bind` / framing) form for the native escape hatch — it is config-file-only, like `transport`. No native-args passthrough for the **orchestrator** (it runs in-process via the Agent SDK, not a spawned CLI — a different launch surface, out of scope). No new provider; still exactly two.
- **Deferred.** A run-level model/effort *default* (today it's per-binding only). A native passthrough for the interactive claude transport beyond what argv naturally allows. These are non-goals for this run.

## Problem

Codex is configured entirely from `~/.codex/config.toml` today — a deliberate default (docs: "codex has no model key by design"), but a hard wall: the workflow syntax can name a specific Anthropic model per voice yet cannot name a specific GPT model, so a run can't say "plan on codex `gpt-5-codex`, review on a cheaper codex model," and a user who wants a different model for one stage must mutate their global config (which then bleeds into every other codex use). The limitation is **not architectural** — it is a single rejection at `parseProviderModel` (`bindings.ts:148`); the `provider[:model]` grammar already parses `codex:gpt-5-codex` fine one layer up (`bindings.ts:125`), and the codex SDK already accepts a per-thread model.

Two adjacent gaps ride along:
- **Effort is unreachable.** Both CLIs support a reasoning-effort setting; neither is expressible through a binding. A user who wants "run the builder harder for this feature" has no knob.
- **The long tail has no door.** duet will never model every native flag. Without an escape hatch, any capability duet hasn't wrapped forces the user out of duet entirely — a violation of the augmentation principle ("no duet mode you're locked into").

### Measured provider facts (the spec hangs on these — re-verify on a CLI upgrade)

Spiked locally against **codex-cli `0.142.5`**, **claude `2.1.201`**, **`@openai/codex-sdk`** (pinned to the CLI release):

| Capability | Codex | Claude |
|---|---|---|
| Inline model | `codex exec -m <model>` → SDK `ThreadOptions.model` | `--model` (already used, `claude.ts:399`) |
| Reasoning effort | `ThreadOptions.modelReasoningEffort` = `minimal\|low\|medium\|high\|xhigh` | `--effort` = `low\|medium\|high\|xhigh\|max` |
| Native escape hatch | `-c key=value` (TOML) → SDK `CodexOptions.config` object (constructor-level) | raw argv (`--fallback-model`, `--append-system-prompt`, `--settings`, …) |

**Effort enums differ.** Union = `minimal`(codex-only), `low|medium|high|xhigh`(both), `max`(claude-only). Claude **fails open** on a bad `--effort` value — it prints `Warning: Unknown --effort value … using the default` and *runs anyway*. A silent-default overnight run is exactly the drift duet refuses, so duet must reject an illegal (provider, effort) pair itself, up front.

**Failure taxonomy of a bad native arg** (this is what makes the preflight the right shape):

| Bad input | Codex | Claude | When it surfaces |
|---|---|---|---|
| Unknown **flag** | `exit=2`, clap error, **no model call** | `exit=1`, commander error, **no model call** | spawn (parse) |
| Bad **model** value | `exit=1` at API | `exit=1`, clean "model may not exist" | first model call |
| Bad `-c` **value** (codex) | coerced to TOML literal — **no error** | — | never (lenient) |
| Unknown `-c` **key** (codex) | **ignored** (only `--strict-config` errors) | — | never (lenient) |
| Bad `--effort` value (claude) | — | **warns + default**, proceeds | never (lenient) |

And two facts that mean the failure cases are *cheap* and *legible*:
- **Failures fail for free.** Every hard-error case above dies **before generating tokens** (parse error, or model-resolution error). Only a *fully valid* set of args reaches a real turn.
- **duet already flags, never retries, a bad arg.** `classifyError` maps any error string outside the transient set (network/server/rate-limit) to `unknown` (`health.ts:108`), and `retryDecision` sends `unknown` **straight to a flag — never auto-retried** (`health.ts:141-144`). So a bad-arg turn is already a legible, non-retried, human-actionable stop with the provider's own message — *if* it happens while someone is watching.

**No zero-cost parse-only preflight exists symmetrically.** `claude … --help` is *help-first* (short-circuits **before** validating other flags — an unknown flag with `--help` exits `0`), so claude cannot be asked to "parse-check without calling." Codex's clap *is* parse-first, but its hatch is `-c` config keys (never arbitrary flags) which are lenient, so there is structurally nothing to parse-fail. Therefore the only mechanism that catches a bad arg **at the start** across both providers is a **live throwaway turn** — which is cheap precisely because the bad cases fail before generating (see §"The preflight").

## Design principles (read before writing a line)

1. **A binding is normalized intent; each provider translates it.** The binding says *what* (model X, effort high, these native extras); the adapter decides *how* (claude `--model`/`--effort`/argv; codex `ThreadOptions`/`-c`). Put translation in the adapters, never provider-conditionals in the resolver. This is the "robust utility layer for resolving conventions and respecting inline overrides" the design calls for.
2. **Two vocabularies, opposite discipline — do not blur them.**
   - **duet's own knobs** (`model` defaulting, `effort` enum): duet invented them, so duet **validates them fail-closed** at freeze. A wrong value errors at `duet new`, never silently at 2am.
   - **provider-native passthrough** (`claude_args`, `codex_config`): the provider's vocabulary, not duet's. **Never parse, filter, normalize, or denylist it.** Hand it over verbatim. duet's only job is to make the provider judge it *early*.
   Same English word — "argument" — opposite treatment. This is the single line a future change most easily drifts across; hold it.
3. **No failure in a middle phase. Ever.** A bad binding must fail (or warn) at `duet new`, while the human is present — not when the builder's first turn runs at 2am. This is what the **preflight** exists for. If a mechanism can't guarantee this for the native hatch, the honest fallback is to *not ship the hatch* — a silent-then-mid-phase failure is worse than no escape hatch.
4. **No denylist, no provider-specific safety net.** duet does not second-guess which native flags are "dangerous." Every misconfiguration already terminates in a legible flag (bad output → envelope parse throws → flag; hung permission prompt → wall-clock cap → flag) — nothing corrupts silently. The preflight replaces the denylist entirely. Duet-owned flags (`--output-format`, `--model`, `--permission-mode`, `--resume`/`--session-id`, `--max-budget-usd`) are named as **documentation guidance** in the config comment, never enforced in code.
5. **Fail-fast at the freeze, materialize once.** All new validation happens in `resolveRunConfig` / `createRun`, the existing manifest-freeze boundary; the frozen binding carries the resolved knobs, and `voiceBindingFor` stays the one read (`bindings.ts:318`). No knob is re-resolved downstream.
6. **Single-world / policy-as-data.** Model/effort/native are mechanical facts; they must not leak into any worker-facing prompt (the single-world rule holds — they change no prose). Provider capability differences live in **one table**, not scattered `if (provider === …)` (there are already several to collapse: `bindings.ts:148`, `:171`).
7. **Augment, don't lock in.** The escape hatch exists so a user is never forced out of duet to reach a native capability. The sessions stay standard (`claude --resume` / `codex exec resume` still work); native args change a launch, never the transcript's shape.

## Current vs. desired

**Preserved, untouched in behavior:**
- `resolveRunConfig` (`bindings.ts:358`) — per-key precedence (flags > framing > config > defaults), resolved once, frozen. Shape unchanged; payload widens.
- `voiceBindingFor` (`bindings.ts:318`) — the one "who runs this turn" resolver, no phase parameter. Unchanged.
- `sessionCompatible` (`bindings.ts:272`) / `degradedEdgesFor` (`:293`) — continuity-edge degrade keys on **provider (+ claude transport) only**. Model and effort are **per-turn** and must **not** enter this check (see gotchas): a `claude:opus` architect → `claude:fable` builder still resumes today, and a `codex` → `codex:gpt-5` edge must stay compatible.
- The default codex binding stays **model-less** (`defaultBindingFor:85`, `{ provider: 'codex' }`): absent model ⇒ *defer to `~/.codex/config.toml`* (do **not** inject `-m`). Absent claude model ⇒ `DEFAULT_CLAUDE_MODEL` (`bindings.ts:64`), as today. The two config philosophies are preserved — inline model is an *override*, not a new default.
- Orchestrator resolution and its claude-only guard (`bindings.ts:409`) — unchanged; no native hatch.

**New:**
- `Binding` grows `effort?` and a `native?` payload; `model` becomes meaningful for **both** providers (the codex rejection at `:148` is deleted, replaced by capability-table validation).
- A `PROVIDER_CAPS` table (new, in `bindings.ts`) — the per-provider truth: does it take a model default, which effort values are legal, does it take `transport`, and which native shape it accepts. Validation reads it.
- An `@effort` suffix in the `provider[:model]` spec grammar (`parseBindingSpec`).
- `claude_args` / `codex_config` config-table fields (`parseBindingTable`), each rejected on the wrong provider (a structural config-schema error, *not* content validation).
- **`src/voices/preflight.ts`** (new) — the throwaway-turn validator; the load-bearing Tier-3 safety mechanism, invoked from the `duet new` flow.
- Each provider adapter consumes the new knobs at construction (`claudeArgs`, `codexThreadOptions`, `CodexWorker`, `InteractiveClaudeWorker`).

## What we're building — the three tiers

### Tier 1 — inline codex model

Delete the codex-model rejection; let a codex binding carry an optional model; thread it to `ThreadOptions.model`.

- `bindings.ts` — remove the throw at `:148`; `PROVIDER_CAPS.codex` declares model *optional, defer-when-absent*. `formatBinding` (`:435`) shows a codex model when present (today it shows claude only).
- `codex.ts` — `codexThreadOptions` (`:73`) gains `model`; when set, include it in the returned `ThreadOptions` (SDK emits `-m`); when absent, omit it (config.toml governs). `CodexWorker` constructor (`:135`) takes an optional `model`.
- `index.ts` — `createWorkers` (`:34`) passes `binding.model` to `CodexWorker` (today it passes only `timeoutMs`).
- `stats.ts` — `makerModelLabel` (`:260`) shows the codex model when set, else the provider name (today: `provider === 'claude' ? model : provider`).

Risk: low. The one thing to **verify by spike before building** (see §"Verification spikes"): codex honors `-m` **on `resume`**, not just on a fresh thread — the continuity edges resume codex threads.

### Tier 2 — normalized effort

A `effort?: Effort` field on the binding, `Effort = 'low'|'medium'|'high'|'xhigh'|'max'|'minimal'` (the union), validated **per provider** at freeze.

- Grammar: an `@effort` suffix on the spec string — `codex:gpt-5-codex@high`, `claude:opus@max`, `codex@low` (effort only, model deferred). Parsed by stripping a trailing `@<token>` **before** the `:` split (a model id contains no `@`). Config field: `effort = "high"`.
- Validation: at `resolveRunConfig`, reject `effort` not in `PROVIDER_CAPS[provider].effort` with a values-naming error (e.g. "codex effort must be one of minimal, low, medium, high, xhigh — got `max`"). **Fail-closed**, because claude fails *open* and would silently run at default.
- Translation: claude → `--effort <level>` appended in `claudeArgs`; codex → `ThreadOptions.modelReasoningEffort`. Effort is per-turn (like model) → **not** part of `sessionCompatible`.

### Tier 3 — native-arg passthrough + the preflight

A **config-file-only** per-binding escape hatch, provider-shaped:

- **claude** = `claude_args: string[]` → appended to the argv `claudeArgs` builds (`:399-414`). True native flags.
- **codex** = `codex_config: table` → fed to the codex client as `new Codex({ config })` (constructor-level `-c` overrides). Codex's SDK exposes **no** arbitrary-argv field, and bypassing the SDK to shell raw `codex exec` would forfeit the stream reconstruction / session-id-on-`thread.started` / wall-clock-abort integration the AFK machinery depends on — so codex's hatch is **config**, which is also more codex-idiomatic (its whole philosophy is "config.toml governs").

This asymmetry is **injection mechanics, not a safety net** — it is *how* each adapter launches, not duet filtering content. duet passes both through verbatim. A `claude_args` field on a codex binding (or vice-versa) is a **config-schema** error at freeze (same class as today's `transport`-on-codex rejection, `:171`) — duet's own grammar being coherent, not judging the provider's args.

The safety comes entirely from the **preflight** (next section), which is why Tier 3 has no denylist and needs none.

## The preflight (Tier 3's — and inline model's — safety mechanism)

**Goal:** every mistake in a provider-validated knob (an explicit `model`, or a `native` override) surfaces at `duet new` while the human is present, or as a native warning — **never** as a mid-phase failure. This is what earns the escape hatch its place (principle 3).

**Trigger.** At `createRun` / the `duet new` flow, after `resolveRunConfig`, **before** freezing the manifest: for each **worker** binding (duties + consultant; not the orchestrator) whose knobs the provider alone can validate — i.e. it carries an **explicit model** or a **native override** — run one preflight. Dedupe identical bindings. A pure-default binding (default model, no native) has nothing the provider must confirm → **skipped**, so a normal run pays nothing.

**Mechanism.** Build the real provider for that binding (the same `createWorkers` path) and run one **throwaway** turn with a trivial prompt (`"Reply with the single word OK."`), an **ephemeral session** whose id is **discarded** — it must never be recorded as the duty's session or pollute a continuity edge. Then **classify the outcome with the existing taxonomy** (`classifyError`, `health.ts`):

- **`unknown` class** (bad flag, bad model/value — the whole point) → **abort `duet new`** and print the provider's own error text. Fail at the start.
- **transient / network / auth** → **do not abort** (the user may be offline at creation); warn "couldn't preflight `<binding>` — <reason>; it will validate at first use" and proceed. Never reject a good binding for a network blip.
- **success** (including a native warning like claude's effort fallback) → proceed; surface any captured warning line.

**Codex leniency + the `--strict-config` advisory.** Codex's runtime is lenient (a typo'd `-c` key is silently ignored), which matches "proceed as codex normally would" but can hide a typo. So for codex, run the preflight in **two probes**: (1) the runtime-faithful lenient turn above (proves it works as it actually will), and (2) an **advisory `--strict-config`** parse/turn that, if it flags an unrecognized key, emits a **warning** (not an abort) so a misspelled `codex_config` key is *visible* at creation — while the real run stays lenient (never pass `--strict-config` to a working turn). Verify how the SDK surfaces `--strict-config` (a `config` key, or a raw `codex exec --strict-config` probe) as a spike.

**Why it's cheap.** The abort cases (bad flag, bad model) die **before generating tokens**; only a fully valid hatch pays for a ~5-token "OK" turn — and that run is *buying* a "this binding launches" guarantee. The preflight fires only when someone opted into a provider-validated knob.

**Placement (trust gradient).** The preflight *primitive* — build-provider + trivial-turn + classify — lives in `src/voices/preflight.ts` (it composes `providers/` + `health.ts`, both on the voices layer). The *orchestration* (loop the Tier-3/model bindings, abort-or-warn, thread into the `duet new` echo) lives in the surface that already composes voices into run creation — the `duet new` action (`cli.ts`) / `surfaces/lifecycle.ts` — so `run/` never imports upward. The result rides the manifest echo `duet new` already prints (`cli.ts:414-427`): each preflighted binding gets a `✓ preflighted` / `⚠ <warning>` marker.

## Target shape

### File/module structure (where the pieces live once this lands)

```
src/voices/
  bindings.ts              # Binding gains effort? + native?; model meaningful for both providers.
                           #   PROVIDER_CAPS — the per-provider capability table (model/effort/transport/native),
                           #   read by validation instead of scattered `if (provider === 'codex')`.
                           #   @effort parse in parseBindingSpec; claude_args/codex_config in parseBindingTable.
  preflight.ts             # NEW — preflightBinding(binding, cwd): throwaway turn + classifyError → verdict.
                           #   The Tier-3 (+ explicit-model) safety mechanism. Pure of run/ imports.
  providers/
    index.ts               # createWorkers threads model/effort/native to each adapter (before the provider branch).
    claude.ts              # claudeArgs consumes model + effort(--effort) + native(argv append).
    codex.ts               # codexThreadOptions consumes model + effort(modelReasoningEffort);
                           #   CodexWorker builds `new Codex({ config })` from codex_config.
    interactive-claude.ts  # same model + effort + native(argv) as headless claude (maker-only transport).
    types.ts               # unchanged shape — the knobs are construction-time (worker config), not RunTurnOptions.
src/surfaces/
  cli.ts / lifecycle.ts    # duet new: after resolveRunConfig, run preflights, abort-or-warn, echo the result.
  framing.ts               # bind.* pre-pass already routes through parseBindingSpec — @effort rides for free.
  stats.ts                 # makerModelLabel shows a codex model + effort.
```

### Public API / syntax (what a user writes)

Spec grammar (flags + framing) — `provider[:model][@effort]`:

```
--bind analyst=codex:gpt-5-codex           # inline codex model
--bind builder=codex:gpt-5-codex@high      # + effort
--bind critic=codex@low                    # effort only, model deferred to ~/.codex/config.toml
--bind architect=claude:opus@max           # claude alias + effort

# framing frontmatter (same grammar):
bind.builder: codex:gpt-5-codex@high
```

Config table (adds `effort` + the config-only native hatch):

```toml
[duties.builder]
provider = "claude"
model    = "claude-opus-4-8"
effort   = "high"
claude_args = ["--fallback-model", "claude-opus-4-6"]   # native passthrough (claude only)

[duties.critic]
provider = "codex"
model    = "gpt-5-codex"        # NEW: inline codex model
effort   = "high"
codex_config = { model_reasoning_summary = "detailed" }  # native passthrough (codex only) → -c

# `codex_config` on a claude binding, or `claude_args` on a codex binding, is a config error.
# duet owns --output-format / --model / --permission-mode / --resume / --session-id / --max-budget-usd
# (claude) — overriding them via claude_args will break the run (guidance, not enforced).
```

### Integration wiring (how it connects)

```
duet new
  └─ resolveRunConfig  (bindings.ts) ── per-key precedence, widened payload, effort validated,
     │                                   native validated structurally (right field for provider)
     ├─ preflightBinding × {bindings with explicit model | native}   (voices/preflight.ts)
     │     unknown → abort duet new (provider's message) · transient → warn+proceed · ok → proceed
     ├─ createRun ── freeze manifest (+ the new knobs) to state.json
     └─ echo manifest (+ ✓ preflighted / ⚠ warning per binding)

per phase:
  createWorkers (providers/index.ts) ── resolves binding, THEN branches provider:
     claude  → ClaudeWorker({ model, effort, nativeArgs, … })   → claudeArgs appends --effort + native argv
     codex   → CodexWorker({ model, effort, nativeConfig, … })  → ThreadOptions{model,modelReasoningEffort}
                                                                   + new Codex({ config: nativeConfig })
```

## Blast radius (files to touch — all small, all contained)

- `src/voices/bindings.ts` — `Binding` type, `PROVIDER_CAPS`, `parseBindingSpec` (`@effort`), `parseProviderModel` (drop codex reject, add effort validation), `parseBindingTable` (`claude_args`/`codex_config`), `formatBinding`. Resolver shape unchanged.
- `src/voices/preflight.ts` — new.
- `src/voices/providers/{index,claude,codex,interactive-claude}.ts` — construction-time knob consumption.
- `src/surfaces/{cli,lifecycle}.ts` — preflight orchestration in `duet new`; echo markers.
- `src/surfaces/stats.ts` — codex model/effort in the maker-model column.
- `src/orchestrator/hosts/driver.ts:184` — unaffected (orchestrator model already threaded; no native hatch).

**No** statechart, brief-renderer, snippet, or worker-facing-prompt change (single-world holds).

## Tips, gotchas, and hard-won lessons

- **Effort/model must NOT enter `sessionCompatible` (`bindings.ts:272`).** They're per-turn (per-request), not session-shaping. Only provider (and claude transport) can break a continuity edge. Adding model/effort here would spuriously degrade `claude:opus`→`claude:fable` (which resumes fine today) to a fresh session. Leave the compatibility rule alone.
- **Codex model absent ≠ codex model empty.** Absent must mean "omit `-m`, defer to config.toml." Do not default a codex model the way claude defaults `DEFAULT_CLAUDE_MODEL`. `PROVIDER_CAPS` should encode `model: defer` for codex vs `model: default` for claude — one place, not a special-case at the call site.
- **`new Codex()` is a field initializer today (`codex.ts:130`).** The `config` hatch is a **constructor** option, so you'll move the client construction into `CodexWorker`'s constructor to pass `{ config: nativeConfig }`. Model/effort stay on `ThreadOptions` (per `startThread`/`resumeThread`), so `codexThreadOptions` grows — keep it the pure, testable builder it already is (`:73`), the way `claudeArgs` is.
- **The knobs are construction-time, not `RunTurnOptions`.** They belong on the worker *constructor* config (like `model`/`maxBudgetUsd` today), not on `RunTurnOptions` (`types.ts:105`) — a binding is fixed for the run, not chosen per turn. Don't widen the per-turn contract.
- **Claude fails OPEN on bad effort; codex is lenient on bad `-c`.** This is *why* Tier 2 is duet-validated (fail-closed at freeze) and *why* Tier 3 needs the preflight (the lenient/warn paths won't stop a bad flag; the hard-error paths would strand a run mid-phase without it).
- **Never pass `--strict-config` to a working codex turn.** It changes runtime behavior (errors on unknown keys) away from "as codex normally runs." It's a *preflight-only advisory* to make a typo visible; the real run stays lenient.
- **Preflight session must be ephemeral.** Discard its session id; never write it to `sessions[…]` or let it seed a continuity edge. A leaked preflight session would corrupt the first real turn's resume.
- **Preflight classifies to decide — reuse `classifyError`, don't hand-roll.** A network error at `duet new` must not reject a good binding; only the `unknown` class aborts. This is the same taxonomy the driver already trusts (`health.ts`), so the two can't drift.
- **`@` is now reserved in the spec grammar.** Document it; a model id may not contain `@`. Parse the effort suffix first, then split `provider:model` on the first `:` (models like `gpt-5-codex` and `claude-opus-4-8` are `@`-free and `:` only separates provider from model).
- **Guidance, not enforcement, on duet-owned flags.** Put the list in the config comment. Do **not** add code that rejects `--output-format` etc. — that's the denylist we deliberately refused; the preflight + envelope-parse-failure already make the consequence legible.
- **Deletion test for `PROVIDER_CAPS`.** If you find yourself writing a second `if (provider === 'codex')` anywhere in validation, it belongs in the table. The pattern to match is `voices/policy.ts` — asymmetries as data, read once.
- **Parity pins.** Model/effort don't appear in worker prompts, so brief/snippet pins shouldn't move. The surfaces that *will* move are `formatBinding`-bearing (the `duet new` echo, `duet stats`, `status --json`'s binding shape — additive-only). Update those pins deliberately, in the feature commit, never incidentally.

## What NOT to do (guardrails against drift)

- **Do not parse, normalize, or denylist native args.** No "is this flag safe" logic. duet is a conduit; the preflight is the whole safety story.
- **Do not bypass the codex SDK** to shell raw `codex exec` for argv-parity — it forfeits stream reconstruction, session-id timing, and the wall-clock abort the AFK window needs.
- **Do not add an inline form for the native hatch.** Config-file only (quoting native argv inside `--bind …` is a footgun; it's an advanced knob). Model + effort get the inline grammar; raw passthrough does not.
- **Do not preflight pure-default bindings** (nothing to validate — don't tax normal runs) and **do not preflight the orchestrator** (in-process Agent SDK, different launch; its model validity surfaces at the attended phase-1 start).
- **Do not let effort/model touch continuity or the single-world prompts.**

## Verification spikes to run first

1. **Codex model on resume.** `codex exec -m <modelA> "reply OK"` → note the thread id → `codex exec resume <id> -m <modelB> "reply OK"` — confirm the resumed turn honors `-m` (the continuity edges resume codex threads; if resume ignores `-m`, the codex-model story is fresh-thread-only and the spec's continuity note needs a caveat).
2. **SDK `--strict-config` surface.** Confirm how `@openai/codex-sdk` exposes strict-config for the preflight advisory (a `config`/option field, or a raw `codex exec --strict-config` probe), and that a lenient runtime turn is unaffected.
3. **Claude effort passthrough end-to-end.** `claude -p --effort xhigh --model <m> "reply OK"` returns cleanly and the effort is accepted (not just parsed) — and re-confirm the fail-open warning wording, since the preflight surfaces it.

## Testing

- **`bindings` / `config` tests** — the codex model now *accepted*; `@effort` parse (all forms + the `@`-in-model rejection); effort per-provider validation (codex `max` rejected, claude `minimal` rejected, portable values on both); `claude_args`/`codex_config` accepted on the right provider and rejected on the wrong one; `formatBinding` renders codex model + effort.
- **Preflight tests** — through the `WorkerProvider` seam (a `FakeWorker` scripted to succeed / throw `unknown` / throw transient): abort on `unknown`, warn-and-proceed on transient, proceed on success, ephemeral session never recorded, skipped for default bindings. No real CLI in tests.
- **Provider adapter tests** — `claudeArgs` includes `--effort` + native argv in order; `codexThreadOptions` carries model + `modelReasoningEffort`; `CodexWorker` builds the client with `config`. These are the pure-builder seams (`codex.ts:73`, `claude.ts:395`) — test the argv/options, not a real spawn.
- **Parity** — update only the `formatBinding`-bearing pins, deliberately; confirm brief/snippet/machine pins are unmoved.
- Follow the repo's behavior-through-interface rule; fake only at the `WorkerProvider` seam.

## Docs (deferred — do not do as part of this work)

When the code lands, the later docs pass will touch: `bindings.ts`'s header comment and the config example in `automation-design.md` §"Voices are decoupled from providers" (the "codex has no model key by design" line becomes "no model key *by default*; inline override supported"), the `engineering.md` module-map lines for `bindings.ts` / a new `preflight.ts`, `CLAUDE.md`'s provider invariant, and the `--bind` help + framing template comment. **Leave all of it for that pass** — this task is code + tests only.

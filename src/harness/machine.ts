import { fromCallback, setup } from 'xstate';
import type { EventObject } from 'xstate';
import { runPhase } from './driver.ts';
import type { DriverInput } from './driver.ts';
import type { PhaseEvent } from './phase-events.ts';
import { WORKFLOWS } from '../phases.ts';
import type { PhaseName, WorkflowName, WorkflowSpecInput } from '../phases.ts';

/**
 * The harness statechart — Layer 1 of the three-layer architecture
 * (docs/automation-design.md). Each phase is a state that runs the
 * orchestrator agent (an invoked actor that emits a phase.* event when its
 * session resolves); each gate and flag-wait is an actor-less state that
 * transitions ONLY on human events. Agent code has no channel to send the
 * human events, so gate-skipping is unrepresentable, not merely forbidden.
 *
 * Two event vocabularies, kept distinct: `phase.advance`/`phase.flag` are
 * internal, valid only from phase states; `human.approve|reject|answer` are
 * authority, valid only from gate/flag-wait states. A gate has no `phase.*`
 * handler, so `advance_phase` parks but cannot cross — a property of the
 * vocabulary, not a prompt (src/harness/phase-events.ts).
 *
 * The states are built from a workflow's phases (`machineFor(workflow)`, over
 * the registry in src/phases.ts) — the arc is a linear chain, so each phase
 * contributes `<name>Loop` + `<name>FlagWait` + its gate state; a gate's approve
 * targets the next phase's loop, its reject re-enters the loop it gates. A
 * gate-less phase advances straight to the next phase's loop (Full's `docs`
 * flows into `pr` with no human stop), or to done when it is the last (Full's
 * `open`). `machineFor('full')` is topology-identical to the original single-arc
 * machine. The full arc:
 *
 * ```
 * route ─(no spec)─▶ frameLoop ──▶ directionGate ─approve─▶ specLoop ──▶ commitSpecGate
 *   └──(spec given)───────────────────────────────────────────▲              │ approve
 *                                                                            ▼
 *               shipGate ◀── implLoop ◀─approve── planApprovalGate ◀── planLoop
 *                  │ approve                                  ▲ (walk away)
 *                  ▼
 *               docsLoop ─advance─▶ prLoop ──▶ openPrGate
 *               (no gate)                          │ approve
 *                                   done ◀── openLoop ◀─────┘
 * ```
 *
 * Persistence guardrail: snapshots are persisted only in `quiescent`-tagged states
 * (no live actors), so a restored snapshot never has to blind-restart an
 * in-flight invoke. The machine's context is the run id + cwd + entry mode —
 * all operational state lives on disk in the run dir, owned by the driver.
 */

export interface MachineInput {
  runId: string;
  cwd: string;
  /** Spec-entry runs (a draft spec exists) skip the frame phase. */
  hasSpec: boolean;
}

/**
 * The machine-state name of a phase's flag-wait. The one place the naming
 * convention lives — the position probe (harness/lifecycle.ts) resolves
 * state values back to phases through it. (Gate state names are domain
 * names, owned by the phase table.)
 */
export function flagWaitStateOf(phase: PhaseName): string {
  return `${phase}FlagWait`;
}

function phaseState(
  phase: PhaseName,
  targets: { advanced: string; flagWait: string },
): object {
  return {
    tags: ['phase'],
    invoke: {
      src: 'phaseDriver',
      input: ({ context }: { context: MachineInput }) => ({
        runId: context.runId,
        cwd: context.cwd,
        phase,
      }),
      // Driver errors are caught inside runPhase (and the actor's own catch)
      // and surfaced as phase.flag; this is the backstop for an error escaping
      // both — e.g. a synchronous throw building the actor input.
      onError: { target: targets.flagWait },
    },
    // The phase driver emits exactly one of these when its session resolves.
    on: {
      'phase.advance': { target: targets.advanced },
      'phase.flag': { target: targets.flagWait },
    },
  };
}

function flagWaitState(resumeTarget: string): object {
  return {
    tags: ['quiescent', 'flag-wait'],
    on: {
      'human.answer': { target: resumeTarget },
    },
  };
}

function gateState(targets: { approve: string; reject: string }): object {
  return {
    tags: ['quiescent', 'gate'],
    on: {
      'human.approve': { target: targets.approve },
      'human.reject': { target: targets.reject },
    },
  };
}

/**
 * Build the chart's states for one workflow's arc. The entry `route` is a
 * transient choice — `specSkipsTo` (when the workflow admits a draft-spec
 * entry) gives a `hasSpec`-guarded shortcut to that phase, else the route wires
 * straight to the first phase's loop.
 */
function buildStates(spec: WorkflowSpecInput): Record<string, object> {
  const phases = spec.phases;
  const states: Record<string, object> = {
    // Transient entry choice — never persisted (not quiescent-tagged), the
    // machine moves through it immediately.
    route: {
      always: spec.entry.specSkipsTo
        ? [
            { guard: 'hasSpec', target: `${spec.entry.specSkipsTo}Loop` },
            { target: `${spec.entry.firstPhase}Loop` },
          ]
        : [{ target: `${spec.entry.firstPhase}Loop` }],
    },
  };
  phases.forEach((p, i) => {
    const name = p.name as PhaseName;
    const loop = `${name}Loop`;
    const flagWait = flagWaitStateOf(name);
    const next = phases[i + 1];
    // A gated phase advances to its gate; a gate-less phase advances to the next
    // phase's loop (Full's `docs` → `pr`, no human stop), or to done when it is
    // the last phase (Full's `open`).
    states[loop] = phaseState(name, {
      advanced: p.gate?.state ?? (next ? `${next.name}Loop` : 'done'),
      flagWait,
    });
    states[flagWait] = flagWaitState(loop);
    if (p.gate) {
      states[p.gate.state] = gateState({ approve: next ? `${next.name}Loop` : 'done', reject: loop });
    }
  });
  states['done'] = { type: 'final', tags: ['quiescent'] };
  return states;
}

/** The shared machine setup — types, the hasSpec guard, the real phase driver. */
const duetSetup = setup({
  types: {} as {
    context: MachineInput;
    input: MachineInput;
    events:
      | { type: 'human.approve' }
      | { type: 'human.reject' }
      | { type: 'human.answer' }
      | PhaseEvent;
  },
  guards: {
    hasSpec: ({ context }) => context.hasSpec,
  },
  actors: {
    // A callback actor, not a promise: it emits a phase.* event to the parent
    // when the session resolves (a cooperative hand-off), rather than resolving
    // an output the parent guards on. The catch is the crash backstop — runPhase
    // already converts infra failure to phase.flag and persists the question, so
    // an exception reaching here is an unexpected escape, still surfaced as a flag.
    phaseDriver: fromCallback<EventObject, DriverInput>(({ input, sendBack }) => {
      runPhase(input)
        .then((event) => sendBack(event))
        .catch(() => sendBack({ type: 'phase.flag' }));
    }),
  },
});

/**
 * The statechart for a given workflow's arc. `buildStates` returns a
 * `Record<string, object>`, so every workflow's machine shares one type (state
 * values are `string`, not a literal union) — the lifecycle hydrates any run
 * through `machineFor(workflowOf(state))` with no per-workflow typing.
 */
export function machineFor(workflow: WorkflowName): ReturnType<typeof createDuetMachine> {
  return createDuetMachine(WORKFLOWS[workflow]);
}

function createDuetMachine(spec: WorkflowSpecInput) {
  return duetSetup.createMachine({
    id: 'duet',
    context: ({ input }) => input,
    initial: 'route',
    states: buildStates(spec),
  });
}

/** The Full arc's machine — the canonical type for `LifecycleDeps.machine` etc. */
export const duetMachine = machineFor('full');

/**
 * The interactive variant — Stage 1's host, where the human's Claude Code
 * session drives each phase by calling kernel tools and `duet continue`
 * (crossInteractive) applies the gate events. The phaseDriver is replaced via
 * the same `machine.provide` seam stdioPhaseMachine and the test scriptedMachine
 * use, but with an INERT actor: it runs no session and never sendBacks a
 * phase.* event. The machine therefore advances only on events sent to it, never
 * on its own.
 *
 * `provide` swaps the actor, it does NOT remove the phase states' `invoke` — so
 * a restored phase-loop snapshot still re-invokes this actor, but harmlessly,
 * because it carries no in-flight work to lose. That is exactly the property the
 * persistence guardrail needs (never blind-restart an actor with live work):
 * here restability comes from the actor being inert, not absent, which makes a
 * phase loop a legitimate RESTING state for an interactive run (for the real
 * driver the same snapshot would be mid-flight, hence never persisted).
 */
export function interactiveMachineFor(workflow: WorkflowName): typeof duetMachine {
  return machineFor(workflow).provide({
    actors: {
      phaseDriver: fromCallback<EventObject, DriverInput>(() => {
        // Inert by design: the interactive session is the driver. No runPhase, no
        // sendBack — the machine waits for the events crossInteractive applies.
      }),
    },
  });
}

/** The Full arc's interactive machine — kept as a named export. */
export const interactiveMachine: typeof duetMachine = interactiveMachineFor('full');

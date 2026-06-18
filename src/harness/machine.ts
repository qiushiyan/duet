import { fromCallback, setup } from 'xstate';
import type { EventObject } from 'xstate';
import { runPhase } from './driver.ts';
import type { DriverInput } from './driver.ts';
import type { PhaseEvent } from './phase-events.ts';
import { PHASES } from '../phases.ts';
import type { PhaseName } from '../phases.ts';

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
 * The states are built from the phase table (src/phases.ts) — the arc is a
 * linear chain, so each phase contributes `<name>Loop` + `<name>FlagWait` +
 * its gate state; a gate's approve targets the next phase's loop, its reject
 * re-enters the loop it gates. `open` has no gate and advances straight to
 * done. The full arc:
 *
 * ```
 * route ─(no spec)─▶ frameLoop ──▶ directionGate ─approve─▶ specLoop ──▶ commitSpecGate
 *   └──(spec given)───────────────────────────────────────────▲              │ approve
 *                                                                            ▼
 *               shipGate ◀── implLoop ◀─approve── planApprovalGate ◀── planLoop
 *                  │ approve                                  ▲ (walk away)
 *                  ▼
 *               docsLoop ──▶ docsPlanGate ─approve─▶ prLoop ──▶ openPrGate
 *                                                                  │ approve
 *                                          done ◀── openLoop ◀─────┘
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

function buildStates(): Record<string, object> {
  const states: Record<string, object> = {
    // Transient entry choice — never persisted (not quiescent-tagged), the
    // machine moves through it immediately.
    route: {
      always: [{ guard: 'hasSpec', target: 'specLoop' }, { target: 'frameLoop' }],
    },
  };
  PHASES.forEach((spec, i) => {
    const loop = `${spec.name}Loop`;
    const flagWait = flagWaitStateOf(spec.name);
    const next = PHASES[i + 1];
    states[loop] = phaseState(spec.name, { advanced: spec.gate?.state ?? 'done', flagWait });
    states[flagWait] = flagWaitState(loop);
    if (spec.gate) {
      states[spec.gate.state] = gateState({ approve: next ? `${next.name}Loop` : 'done', reject: loop });
    }
  });
  states['done'] = { type: 'final', tags: ['quiescent'] };
  return states;
}

export const duetMachine = setup({
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
}).createMachine({
  id: 'duet',
  context: ({ input }) => input,
  initial: 'route',
  states: buildStates(),
});

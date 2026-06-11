import { fromPromise, setup } from 'xstate';
import { runPhase } from './driver.ts';
import type { DriverInput, DriverOutput } from './driver.ts';

/**
 * The harness statechart — Layer 1 of the three-layer architecture
 * (docs/automation-design.md). Each phase is a state that runs the
 * orchestrator agent (an invoked promise actor); each gate and flag-wait is
 * an actor-less state that transitions ONLY on human events. Agent code has
 * no channel to send machine events, so gate-skipping is unrepresentable,
 * not merely forbidden.
 *
 * Q15 guardrail: snapshots are persisted only in `quiescent`-tagged states
 * (no live actors), so a restored snapshot never has to blind-restart an
 * in-flight invoke. The machine's context is just the run id + cwd — all
 * operational state lives on disk in the run dir, owned by the driver.
 *
 * ```
 * specLoop ──advanced──▶ commitSpecGate ──approve──▶ planLoop ──advanced──▶ planApprovalGate
 *   │ ▲ flagged             │ reject ▲                 │ ▲ flagged              │ reject ▲
 *   ▼ │ answer              ▼────────┘                 ▼ │ answer               ▼────────┘
 * specFlagWait                                      planFlagWait                │ approve   ← human walks away
 *                                                                               ▼
 *                                  done ◀──approve── shipGate ◀──advanced── implLoop
 *                                                      │ reject ▲              │ ▲ flagged
 *                                                      ▼────────┘              ▼ │ answer
 *                                                                           implFlagWait
 * ```
 */

export interface MachineInput {
  runId: string;
  cwd: string;
}

export const duetMachine = setup({
  types: {} as {
    context: MachineInput;
    input: MachineInput;
    events: { type: 'human.approve' } | { type: 'human.reject' } | { type: 'human.answer' };
  },
  guards: {
    isAdvanced: (_, params: { output: DriverOutput }) => params.output.outcome === 'advanced',
  },
  actors: {
    phaseDriver: fromPromise<DriverOutput, DriverInput>(({ input }) => runPhase(input)),
  },
}).createMachine({
  id: 'duet',
  context: ({ input }) => input,
  initial: 'specLoop',
  states: {
    specLoop: {
      tags: ['phase'],
      invoke: {
        src: 'phaseDriver',
        input: ({ context }) => ({ runId: context.runId, cwd: context.cwd, phase: 'spec' as const }),
        onDone: [
          {
            guard: { type: 'isAdvanced', params: ({ event }) => ({ output: event.output }) },
            target: 'commitSpecGate',
          },
          { target: 'specFlagWait' },
        ],
        // Driver errors are caught inside runPhase and surfaced as flags; this
        // is the backstop for bugs in the driver itself.
        onError: { target: 'specFlagWait' },
      },
    },
    specFlagWait: {
      tags: ['quiescent', 'flag-wait'],
      on: {
        'human.answer': { target: 'specLoop' },
      },
    },
    commitSpecGate: {
      tags: ['quiescent', 'gate'],
      on: {
        'human.approve': { target: 'planLoop' },
        'human.reject': { target: 'specLoop' },
      },
    },
    planLoop: {
      tags: ['phase'],
      invoke: {
        src: 'phaseDriver',
        input: ({ context }) => ({ runId: context.runId, cwd: context.cwd, phase: 'plan' as const }),
        onDone: [
          {
            guard: { type: 'isAdvanced', params: ({ event }) => ({ output: event.output }) },
            target: 'planApprovalGate',
          },
          { target: 'planFlagWait' },
        ],
        onError: { target: 'planFlagWait' },
      },
    },
    planFlagWait: {
      tags: ['quiescent', 'flag-wait'],
      on: {
        'human.answer': { target: 'planLoop' },
      },
    },
    planApprovalGate: {
      tags: ['quiescent', 'gate'],
      on: {
        'human.approve': { target: 'implLoop' },
        'human.reject': { target: 'planLoop' },
      },
    },
    implLoop: {
      tags: ['phase'],
      invoke: {
        src: 'phaseDriver',
        input: ({ context }) => ({ runId: context.runId, cwd: context.cwd, phase: 'impl' as const }),
        onDone: [
          {
            guard: { type: 'isAdvanced', params: ({ event }) => ({ output: event.output }) },
            target: 'shipGate',
          },
          { target: 'implFlagWait' },
        ],
        onError: { target: 'implFlagWait' },
      },
    },
    implFlagWait: {
      tags: ['quiescent', 'flag-wait'],
      on: {
        'human.answer': { target: 'implLoop' },
      },
    },
    shipGate: {
      tags: ['quiescent', 'gate'],
      on: {
        // FINAL REVIEW is not built yet — approving the Ship gate ends the
        // run; verification/docs/PR happen manually for now.
        'human.approve': { target: 'done' },
        'human.reject': { target: 'implLoop' },
      },
    },
    done: {
      type: 'final',
      tags: ['quiescent'],
    },
  },
});

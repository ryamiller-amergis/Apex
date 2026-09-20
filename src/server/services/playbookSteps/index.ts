/**
 * Step-type dispatch.
 *
 * Two tables live in this directory and it is worth being clear that they are not duplicates.
 * `registry.ts` declares what a step type *is* — whether it suspends, how long it waits, which
 * Skills it may run — and that description is shared with anything that needs to reason about step
 * types. This maps a step type to the function that *runs* it, which is server-only and has no
 * business in a descriptor.
 *
 * They are checked against each other by a test rather than by convention: a descriptor with no
 * adapter is a step type that fails the moment a run reaches it, and a run reaching a step is the
 * worst place to discover a wiring mistake.
 */
import { executeApprovalGateStep } from './approvalGateAdapter';
import { executeCursorAgentStep } from './cursorAgentAdapter';
import { executeNotifyStep } from './notifyAdapter';
import { getStepTypeDescriptor } from './registry';
import type {
  PlaybookStepAdapter,
  PlaybookStepExecutionContext,
  PlaybookStepOutcome,
} from './stepRuns';

const ADAPTERS: Readonly<Record<string, PlaybookStepAdapter>> = {
  'cursor-agent': executeCursorAgentStep,
  'approval-gate': executeApprovalGateStep,
  notify: executeNotifyStep,
};

/** The step types that can actually be executed. Compared against the registry by a test. */
export function adapterStepTypes(): readonly string[] {
  return Object.keys(ADAPTERS);
}

/**
 * Runs one step.
 *
 * Looks the descriptor up first so an unregistered step type is refused by the registry's error,
 * naming what does exist, rather than by an undefined function call.
 */
export async function executeStep(
  context: PlaybookStepExecutionContext
): Promise<PlaybookStepOutcome> {
  getStepTypeDescriptor(context.stepType);

  const adapter = ADAPTERS[context.stepType];
  if (!adapter) {
    throw new Error(
      `Step type "${context.stepType}" is registered but has no adapter. ` +
        'A descriptor without an implementation cannot execute.'
    );
  }

  return adapter(context);
}

export * from './registry';
export * from './stepRuns';

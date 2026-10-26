/**
 * Resolves a step config against the run's input and completed prior steps.
 *
 * Bindings are substituted in memory for adapters. Callers that persist the result keep gate
 * review and later steps from reading the graph's raw `${...}` placeholders.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { playbookRuns, playbookStepRuns } from '../db/schema';
import {
  configHasBindings,
  resolvePlaybookBindings,
} from './playbookBindingResolver';
import { createPlaybookStepOutputStore } from './playbookStepOutputStore';

export async function resolveRunStepConfig(
  runId: string,
  config: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!configHasBindings(config)) return config;

  const [run] = await db
    .select({ runInput: playbookRuns.runInput })
    .from(playbookRuns)
    .where(eq(playbookRuns.id, runId))
    .limit(1);
  const prior = await db
    .select({
      stepId: playbookStepRuns.stepId,
      stepRunId: playbookStepRuns.id,
      output: playbookStepRuns.outputInline,
      outputBlobRef: playbookStepRuns.outputBlobRef,
    })
    .from(playbookStepRuns)
    .where(and(
      eq(playbookStepRuns.runId, runId),
      eq(playbookStepRuns.status, 'completed'),
    ));

  const steps: Record<string, Record<string, unknown>> = {};
  for (const row of prior) {
    if (row.outputBlobRef) {
      const envelope = await createPlaybookStepOutputStore().load(row.outputBlobRef);
      if (
        envelope.runId !== runId
        || envelope.stepRunId !== row.stepRunId
        || envelope.stepId !== row.stepId
      ) {
        throw new Error(`Playbook output reference for step "${row.stepId}" has wrong ownership.`);
      }
      steps[row.stepId] = envelope.output;
    } else {
      steps[row.stepId] = (row.output ?? {}) as Record<string, unknown>;
    }
  }

  return resolvePlaybookBindings(config, {
    input: (run?.runInput ?? {}) as Record<string, unknown>,
    steps,
  });
}

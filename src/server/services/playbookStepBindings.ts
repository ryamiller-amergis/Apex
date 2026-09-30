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
      output: playbookStepRuns.outputInline,
    })
    .from(playbookStepRuns)
    .where(and(
      eq(playbookStepRuns.runId, runId),
      eq(playbookStepRuns.status, 'completed'),
    ));

  const steps: Record<string, Record<string, unknown>> = {};
  for (const row of prior) {
    steps[row.stepId] = (row.output ?? {}) as Record<string, unknown>;
  }

  return resolvePlaybookBindings(config, {
    input: (run?.runInput ?? {}) as Record<string, unknown>,
    steps,
  });
}

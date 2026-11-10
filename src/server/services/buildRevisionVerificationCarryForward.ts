import { eq } from 'drizzle-orm';
import type {
  BuildRequirement,
  BuildRiskDecision,
} from '../../shared/types/build';
import { db } from '../db/drizzle';
import { buildVerificationRows } from '../db/schema';
import {
  deriveRevisionDelta,
  planVerificationRows,
} from './buildRequirementAmendment';

type VerificationExecutor = Pick<typeof db, 'select' | 'insert'>;

export async function seedRevisionVerificationRows(
  executor: VerificationExecutor,
  input: {
    previousRevisionId: string;
    previousRevisionNumber: number;
    nextRevisionId: string;
    previousRequirements: readonly BuildRequirement[];
    previousRiskDecisions: readonly BuildRiskDecision[];
    nextRequirements: readonly BuildRequirement[];
    nextRiskDecisions: readonly BuildRiskDecision[];
  }
): Promise<{ changedAndAddedIds: string[]; carriedCount: number }> {
  const previousRows = await executor
    .select()
    .from(buildVerificationRows)
    .where(eq(buildVerificationRows.buildRevisionId, input.previousRevisionId));
  const delta = deriveRevisionDelta({
    previousRequirements: input.previousRequirements,
    previousRiskDecisions: input.previousRiskDecisions,
    nextRequirements: input.nextRequirements,
    nextRiskDecisions: input.nextRiskDecisions,
  });
  const planned = planVerificationRows({
    previousRevisionNumber: input.previousRevisionNumber,
    previousRows,
    changedIds: delta.changedIds,
    addedIds: delta.addedIds,
    droppedIds: delta.droppedIds,
    nextRequirements: input.nextRequirements,
    nextRiskDecisions: input.nextRiskDecisions,
  });
  const rows = [
    ...planned.copy,
    ...planned.createPending,
    ...planned.closeRetired,
  ];
  if (rows.length > 0) {
    await executor
      .insert(buildVerificationRows)
      .values(
        rows.map((row) => ({
          buildRevisionId: input.nextRevisionId,
          ...row,
        }))
      )
      .onConflictDoNothing();
  }
  return {
    changedAndAddedIds: [...delta.changedIds, ...delta.addedIds],
    carriedCount: planned.copy.length,
  };
}

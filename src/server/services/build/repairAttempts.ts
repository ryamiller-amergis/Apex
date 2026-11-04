/**
 * Atomic repair attempt counter per revision (FEAT-012, TBI-023).
 */
import { and, eq, sql } from 'drizzle-orm';
import {
  MAX_REPAIR_ATTEMPTS,
  type RepairReason,
} from '../../../shared/types/buildFinalCheck';
import { db } from '../../db/drizzle';
import { buildRevisions } from '../../db/schema';

export type DbExecutor = Pick<typeof db, 'update'>;

export async function requestRepairAttempt(
  revisionId: string,
  _reason: RepairReason,
  executor: DbExecutor = db
): Promise<{ granted: boolean; used: number }> {
  const rows = await executor
    .update(buildRevisions)
    .set({
      repairAttempts: sql`${buildRevisions.repairAttempts} + 1`,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(buildRevisions.id, revisionId),
        sql`${buildRevisions.repairAttempts} < ${MAX_REPAIR_ATTEMPTS}`
      )
    )
    .returning({ repairAttempts: buildRevisions.repairAttempts });

  if (rows.length === 0) {
    return { granted: false, used: MAX_REPAIR_ATTEMPTS };
  }

  return {
    granted: true,
    used: Number(rows[0].repairAttempts),
  };
}

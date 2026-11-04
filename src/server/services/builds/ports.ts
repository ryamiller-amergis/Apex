/**
 * Build verification ports (PBI-022, S8).
 *
 * Keeps FEAT-011 decoupled from FEAT-012's repair loop while allowing
 * tests to inject a fake `RepairAttemptPort` and production code to use
 * either the throwing placeholder or the Drizzle-backed counter.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { buildRevisions } from '../../db/schema';
import { BUILD_REPAIR_ATTEMPT_CAP } from '../buildOrchestrator/dispatchStore';

export interface RepairAttemptPort {
  consume(revisionId: string): Promise<{ consumed: boolean; remaining: number }>;
}

/**
 * Default placeholder for `RepairAttemptPort` when no implementation is wired.
 */
export const unconfiguredRepairAttemptPort: RepairAttemptPort = {
  async consume(_revisionId: string): Promise<{ consumed: boolean; remaining: number }> {
    throw new Error('RepairAttemptPort is not configured.');
  },
};

/**
 * Drizzle-backed implementation of `RepairAttemptPort` over `build_revisions.repair_attempts`.
 * Atomically increments `repairAttempts` while `< 2`, returning `{ consumed: true, remaining: 2 - next }`
 * or `{ consumed: false, remaining: 0 }` when the cap is already reached.
 */
export function createDrizzleRepairAttemptPort(): RepairAttemptPort {
  return {
    async consume(revisionId: string): Promise<{ consumed: boolean; remaining: number }> {
      const rows = await db
        .update(buildRevisions)
        .set({
          repairAttempts: sql`${buildRevisions.repairAttempts} + 1`,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(buildRevisions.id, revisionId),
            sql`${buildRevisions.repairAttempts} < ${BUILD_REPAIR_ATTEMPT_CAP}`,
          ),
        )
        .returning({ repairAttempts: buildRevisions.repairAttempts });

      if (rows.length === 0) {
        return { consumed: false, remaining: 0 };
      }
      const next = Number(rows[0].repairAttempts);
      return {
        consumed: true,
        remaining: Math.max(0, BUILD_REPAIR_ATTEMPT_CAP - next),
      };
    },
  };
}

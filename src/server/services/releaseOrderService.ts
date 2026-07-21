import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { releaseEpicOrders } from '../db/schema';
import type { ReleaseEpicOrderEntry, ReleaseOrderData } from '../../shared/types/releaseOrder';

/**
 * Load the saved sort ranks for a project/areaPath scope.
 * Returns an empty orders array when none have been saved yet.
 */
export async function getReleaseOrder(
  project: string,
  areaPath: string,
): Promise<ReleaseOrderData> {
  const rows = await db
    .select({
      adoEpicId: releaseEpicOrders.adoEpicId,
      sortRank: releaseEpicOrders.sortRank,
    })
    .from(releaseEpicOrders)
    .where(
      and(
        eq(releaseEpicOrders.project, project),
        eq(releaseEpicOrders.areaPath, areaPath),
      ),
    )
    .orderBy(releaseEpicOrders.sortRank);

  return { project, areaPath, orders: rows };
}

/**
 * Apply saved Apex order to an ADO-sourced epic list.
 * Epics without a saved rank are appended after ranked ones, sorted by their ADO position.
 */
export function applyOrderToEpics<T extends { id: number }>(
  epics: T[],
  savedOrders: ReleaseEpicOrderEntry[],
): T[] {
  if (savedOrders.length === 0) return epics;

  const rankById = new Map(savedOrders.map((o) => [o.adoEpicId, o.sortRank]));
  const ranked: T[] = [];
  const unranked: T[] = [];

  for (const epic of epics) {
    if (rankById.has(epic.id)) {
      ranked.push(epic);
    } else {
      unranked.push(epic);
    }
  }

  ranked.sort((a, b) => (rankById.get(a.id) ?? 0) - (rankById.get(b.id) ?? 0));
  return [...ranked, ...unranked];
}

/**
 * Bulk-replace the saved order for a project/areaPath scope.
 * The position in `epicIds` becomes the sort_rank (0-based).
 * Removes rows for Epic IDs no longer in the list.
 */
export async function bulkUpdateReleaseOrder(
  project: string,
  areaPath: string,
  epicIds: number[],
  updatedBy: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // Delete rows whose Epic ID is no longer in the ordered list.
    const existingRows = await tx
      .select({ adoEpicId: releaseEpicOrders.adoEpicId })
      .from(releaseEpicOrders)
      .where(
        and(
          eq(releaseEpicOrders.project, project),
          eq(releaseEpicOrders.areaPath, areaPath),
        ),
      );

    const existingIds = existingRows.map((r) => r.adoEpicId);
    const toDelete = existingIds.filter((id) => !epicIds.includes(id));

    if (toDelete.length > 0) {
      await tx
        .delete(releaseEpicOrders)
        .where(
          and(
            eq(releaseEpicOrders.project, project),
            eq(releaseEpicOrders.areaPath, areaPath),
            inArray(releaseEpicOrders.adoEpicId, toDelete),
          ),
        );
    }

    // Upsert a row per Epic ID with the new rank.
    for (let i = 0; i < epicIds.length; i++) {
      await tx
        .insert(releaseEpicOrders)
        .values({
          project,
          areaPath,
          adoEpicId: epicIds[i],
          sortRank: i,
          updatedBy,
        })
        .onConflictDoUpdate({
          target: [
            releaseEpicOrders.project,
            releaseEpicOrders.areaPath,
            releaseEpicOrders.adoEpicId,
          ],
          set: {
            sortRank: i,
            updatedBy,
            updatedAt: new Date().toISOString(),
          },
        });
    }
  });
}

/**
 * Remove all order rows whose ADO Epic IDs are not in `liveEpicIds`.
 * Call this during GET /api/releases/epics to prune deleted epics.
 */
export async function pruneStaleOrders(
  project: string,
  areaPath: string,
  liveEpicIds: number[],
): Promise<void> {
  if (liveEpicIds.length === 0) {
    await db
      .delete(releaseEpicOrders)
      .where(
        and(
          eq(releaseEpicOrders.project, project),
          eq(releaseEpicOrders.areaPath, areaPath),
        ),
      );
    return;
  }

  const rows = await db
    .select({ adoEpicId: releaseEpicOrders.adoEpicId })
    .from(releaseEpicOrders)
    .where(
      and(
        eq(releaseEpicOrders.project, project),
        eq(releaseEpicOrders.areaPath, areaPath),
      ),
    );

  const stale = rows
    .map((r) => r.adoEpicId)
    .filter((id) => !liveEpicIds.includes(id));

  if (stale.length === 0) return;

  await db
    .delete(releaseEpicOrders)
    .where(
      and(
        eq(releaseEpicOrders.project, project),
        eq(releaseEpicOrders.areaPath, areaPath),
        inArray(releaseEpicOrders.adoEpicId, stale),
      ),
    );
}

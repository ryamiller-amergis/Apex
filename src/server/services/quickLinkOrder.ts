import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { ProjectQuickLinkError, type QuickLinkMove } from '../../shared/types/projectQuickLinks';
import { normalizeCategory } from './quickLinkValidation';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface QuickLinkReorder {
  ids: string[];
  move: QuickLinkMove | null;
}

export function parseReorderInput(input: unknown, maxIds: number): QuickLinkReorder {
  const body = (input ?? {}) as { ids?: unknown; move?: unknown };
  const { ids } = body;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !UUID_PATTERN.test(id))) {
    throw new ProjectQuickLinkError('ids must be a list of quick link ids');
  }
  if (ids.length > maxIds) throw new ProjectQuickLinkError(`ids must list at most ${maxIds} links`);
  if (new Set(ids).size !== ids.length) throw new ProjectQuickLinkError('ids must not repeat');
  if (body.move === undefined || body.move === null) return { ids, move: null };

  const move = body.move as { id?: unknown; category?: unknown };
  if (typeof move.id !== 'string' || !ids.includes(move.id)) {
    throw new ProjectQuickLinkError('move.id must be one of ids');
  }
  return { ids, move: { id: move.id, category: normalizeCategory(move.category) } };
}

/** A partial list would leave the other links' positions undefined, so the list must be complete. */
export function assertCompleteOrder(existingIds: string[], ids: string[]): void {
  const requested = new Set(ids);
  if (existingIds.length !== ids.length || existingIds.some((id) => !requested.has(id))) {
    throw new ProjectQuickLinkError('Your links changed since this list loaded. Reload and try again.', 'CONFLICT');
  }
}

/** Position after the last existing link, so new links land at the end even after deletes. */
export function nextSortOrder(rows: { sortOrder: number }[]): number {
  return rows.reduce((highest, row) => Math.max(highest, row.sortOrder), -1) + 1;
}

/** `CASE id WHEN … THEN index END`, so one UPDATE renumbers every link. */
export function sortOrderCase(idColumn: AnyColumn, ids: string[]): SQL<number> {
  const whens = ids.map((id, index) => sql`WHEN ${idColumn} = ${id} THEN ${sql.raw(String(index))}`);
  return sql<number>`CASE ${sql.join(whens, sql` `)} END`;
}

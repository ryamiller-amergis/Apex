import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  BUILD_IN_PROGRESS_STATUSES,
  type BuildListItem,
  type BuildListResponse,
  type BuildRepositoryOption,
} from '../../shared/types/build';
import { db } from '../db/drizzle';
import { appUsers, buildRuns } from '../db/schema';
import { listAllowedRepositoriesForProject } from './buildAccessService';

export interface ListBuildsQuery {
  project: string;
  requesterUserId: string;
  scope: 'project' | 'mine';
  state: 'all' | 'active';
  limit: number;
  offset: number;
}

export function normalizeListQuery(input: {
  scope?: unknown;
  state?: unknown;
  limit?: unknown;
  offset?: unknown;
}): Pick<ListBuildsQuery, 'scope' | 'state' | 'limit' | 'offset'> {
  const limitRaw = Number(input.limit ?? 50);
  const offsetRaw = Number(input.offset ?? 0);
  return {
    scope: input.scope === 'mine' ? 'mine' : 'project',
    state: input.state === 'active' ? 'active' : 'all',
    limit: Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, Math.floor(limitRaw))) : 50,
    offset: Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0,
  };
}

export type BuildQueryExecutor = Pick<typeof db, 'select'>;

export async function listBuilds(
  query: ListBuildsQuery,
  executor: BuildQueryExecutor = db,
): Promise<BuildListResponse> {
  const filters = [eq(buildRuns.project, query.project)];
  if (query.scope === 'mine') filters.push(eq(buildRuns.requestedByUserId, query.requesterUserId));
  if (query.state === 'active') filters.push(inArray(buildRuns.status, [...BUILD_IN_PROGRESS_STATUSES]));
  const where = and(...filters);

  const [countRow] = await executor.select({ n: sql<number>`count(*)::int` }).from(buildRuns).where(where);
  const rows = await executor
    .select({
      id: buildRuns.id,
      repository: buildRuns.repository,
      status: buildRuns.status,
      suspendReason: buildRuns.suspendReason,
      requesterUserId: buildRuns.requestedByUserId,
      requesterDisplayName: appUsers.displayName,
      createdAt: buildRuns.createdAt,
      interviewId: buildRuns.interviewId,
      playbookRunId: buildRuns.playbookRunId,
    })
    .from(buildRuns)
    .leftJoin(appUsers, eq(appUsers.oid, buildRuns.requestedByUserId))
    .where(where)
    .orderBy(desc(buildRuns.createdAt))
    .limit(query.limit)
    .offset(query.offset);

  const ranks = await queueRanks(executor, query.project);
  const builds: BuildListItem[] = rows.map((row) => ({
    id: row.id,
    repository: row.repository,
    status: row.status,
    suspendReason: row.suspendReason,
    requesterUserId: row.requesterUserId,
    requesterDisplayName: row.requesterDisplayName?.trim() || 'Unknown',
    createdAt: row.createdAt,
    queuePosition: ranks.get(row.id) ?? null,
    interviewId: row.interviewId,
    playbookRunId: row.playbookRunId,
  }));

  return {
    builds,
    total: Number(countRow?.n ?? 0),
    limit: query.limit,
    offset: query.offset,
  };
}

async function queueRanks(executor: BuildQueryExecutor, project: string): Promise<Map<string, number>> {
  const queued = await executor
    .select({ id: buildRuns.id })
    .from(buildRuns)
    .where(and(eq(buildRuns.project, project), eq(buildRuns.status, 'queued')))
    .orderBy(buildRuns.queuedAt);
  return new Map(queued.map((row, index) => [row.id, index + 1]));
}

export async function listBuildRepositories(project: string): Promise<BuildRepositoryOption[]> {
  const repositories = await listAllowedRepositoriesForProject(project);
  return repositories.map((repository) => ({ repository, label: repository }));
}

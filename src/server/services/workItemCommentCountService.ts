import type { AzureDevOpsService } from './azureDevOps';
import type { CommentCountResult } from '../../shared/types/workItemCommentCount';

export const COMMENT_COUNT_BADGE_FEATURE = 'CommentCountBadge';

export interface WorkItemCommentCountLogger {
  warn: (message: string, meta: Record<string, unknown>) => void;
}

export interface WorkItemCommentCountServiceDeps {
  createAdoService: (project: string) => AzureDevOpsService;
  logger?: WorkItemCommentCountLogger;
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function getWorkItemCommentCount(
  deps: WorkItemCommentCountServiceDeps,
  project: string,
  workItemId: number,
): Promise<CommentCountResult> {
  try {
    const adoService = deps.createAdoService(project);
    const count = await adoService.getWorkItemCommentCount(workItemId);
    if (count <= 0) {
      return { status: 'unavailable', count: null };
    }
    return { status: 'success', count };
  } catch (err) {
    deps.logger?.warn('ADO comment count fetch failed', {
      workItemId,
      errorSummary: summarizeError(err),
      feature: COMMENT_COUNT_BADGE_FEATURE,
    });
    return { status: 'unavailable', count: null };
  }
}

export async function getWorkItemCommentCounts(
  deps: WorkItemCommentCountServiceDeps,
  project: string,
  workItemIds: readonly number[],
): Promise<Map<number, CommentCountResult>> {
  const results = new Map<number, CommentCountResult>();
  const uniqueIds = [...new Set(workItemIds.filter((id) => Number.isFinite(id) && id > 0))];

  await Promise.all(
    uniqueIds.map(async (workItemId) => {
      const result = await getWorkItemCommentCount(deps, project, workItemId);
      results.set(workItemId, result);
    }),
  );

  return results;
}

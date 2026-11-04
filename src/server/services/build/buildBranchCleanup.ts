/**
 * Cancelled-run integration branch cleanup pass (FEAT-015, TBI-028 / S10).
 *
 * Deletes the integration branch of cancelled runs ended >= 90 days ago
 * whose project has `build-from-prompt` enabled. Never touches accepted runs.
 */
import { and, asc, eq, isNull, lte } from 'drizzle-orm';
import type { BuildRunStatus } from '../../../shared/types/build';
import { BUILD_FROM_PROMPT_FLAG } from '../../../shared/types/featureFlags';
import { db } from '../../db/drizzle';
import { buildRuns } from '../../db/schema';
import { AzureDevOpsService } from '../azureDevOps';
import { appendBuildEvent } from '../buildEventsService';
import { isFeatureEnabled } from '../featureFlagService';

export const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
export const BRANCH_CLEANUP_BATCH_LIMIT = 50;

export interface BranchCleanupCandidateRun {
  id: string;
  project: string;
  repository: string;
  status: BuildRunStatus;
  integrationBranch: string | null;
  endedAt: string | null;
  integrationBranchDeletedAt: string | null;
}

export interface BranchCleanupDeps {
  now: () => Date;
  listEligibleCancelledRuns: (
    cutoffIso: string
  ) => Promise<BranchCleanupCandidateRun[]>;
  isFlagOn: (project: string) => Promise<boolean>;
  deleteBranch: (
    repo: string,
    project: string,
    branch: string
  ) => Promise<void>;
  markBranchDeleted: (runId: string, deletedAtIso: string) => Promise<void>;
  appendEvent: (input: {
    buildRunId: string;
    eventType: 'integration_branch_deleted';
    message: string;
    detail?: Record<string, unknown>;
  }) => Promise<void>;
}

function createDefaultBranchCleanupDeps(): BranchCleanupDeps {
  return {
    now: () => new Date(),
    async listEligibleCancelledRuns(cutoffIso) {
      const rows = await db
        .select({
          id: buildRuns.id,
          project: buildRuns.project,
          repository: buildRuns.repository,
          status: buildRuns.status,
          integrationBranch: buildRuns.integrationBranch,
          endedAt: buildRuns.endedAt,
          integrationBranchDeletedAt: buildRuns.integrationBranchDeletedAt,
        })
        .from(buildRuns)
        .where(
          and(
            eq(buildRuns.status, 'cancelled'),
            isNull(buildRuns.integrationBranchDeletedAt),
            lte(buildRuns.endedAt, cutoffIso)
          )
        )
        .orderBy(asc(buildRuns.endedAt))
        .limit(BRANCH_CLEANUP_BATCH_LIMIT);
      return rows;
    },
    async isFlagOn(project) {
      // @feature-flag:build-from-prompt start winner=enabled
      const on = await isFeatureEnabled(BUILD_FROM_PROMPT_FLAG, {
        userId: 'system',
        project,
      });
      if (on) {
        // @feature-flag:build-from-prompt enabled-start
        return true;
        // @feature-flag:build-from-prompt enabled-end
      }
      // @feature-flag:build-from-prompt disabled-start
      return false;
      // @feature-flag:build-from-prompt disabled-end
      // @feature-flag:build-from-prompt end
    },
    async deleteBranch(repo, project, branch) {
      const svc = new AzureDevOpsService(project);
      await svc.deleteBranch(repo, project, branch);
    },
    async markBranchDeleted(runId, deletedAtIso) {
      await db
        .update(buildRuns)
        .set({
          integrationBranchDeletedAt: deletedAtIso,
          updatedAt: deletedAtIso,
        })
        .where(
          and(
            eq(buildRuns.id, runId),
            isNull(buildRuns.integrationBranchDeletedAt)
          )
        );
    },
    async appendEvent(input) {
      await appendBuildEvent(input);
    },
  };
}

export async function runBranchCleanupPass(
  deps: BranchCleanupDeps = createDefaultBranchCleanupDeps()
): Promise<{ deletedCount: number; skippedFlagOff: number }> {
  const nowDate = deps.now();
  const cutoffIso = new Date(nowDate.getTime() - NINETY_DAYS_MS).toISOString();
  const nowIso = nowDate.toISOString();

  const candidates = await deps.listEligibleCancelledRuns(cutoffIso);
  let deletedCount = 0;
  let skippedFlagOff = 0;

  for (const run of candidates) {
    if (run.status !== 'cancelled' || run.integrationBranchDeletedAt !== null) {
      continue;
    }

    const flagOn = await deps.isFlagOn(run.project);
    if (!flagOn) {
      skippedFlagOff += 1;
      continue;
    }

    const branch = run.integrationBranch ?? `apex/build/${run.id}`;
    await deps.deleteBranch(run.repository, run.project, branch);
    await deps.markBranchDeleted(run.id, nowIso);
    await deps.appendEvent({
      buildRunId: run.id,
      eventType: 'integration_branch_deleted',
      message: `Deleted integration branch ${branch} 90 days after cancellation.`,
      detail: { branch },
    });
    deletedCount += 1;
  }

  return { deletedCount, skippedFlagOff };
}

/**
 * Scheduled sweep for build preview leases and deployment polling (FEAT-013, TBI-024, TBI-025 / S7).
 */
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { buildRevisions, buildRuns } from '../db/schema';
import { defaultBuildDeploymentService } from './buildDeploymentService';
import { pollPipelineBuild, type PolledPipelineBuild } from './buildPipelineClient';
import { defaultPreviewLeaseService } from './buildPreviewLeaseService';

export const STUCK_TRIGGER_MS = 2 * 60_000;
export const POLL_STALE_MS = 90_000;
export const DEFAULT_DEPLOYMENT_DEADLINE_MS = 60 * 60_000;

const DEPLOYMENT_SWEEP_LOCK_KEY = 'apex_build_deployment_sweep';

export interface DeploymentSweepOutcome {
  skipped: boolean;
  expiredLeases: number;
  stuckTriggersFailed: number;
  polledRevisions: number;
}

export interface StaleDeployingRevision {
  revisionId: string;
  buildRunId: string;
  project: string;
  pipelineRunId: string;
  validatedCommit: string;
  ageMs: number;
  deadlineMs: number;
}

export interface BuildDeploymentSweepDeps {
  withSweepLock: <T>(fn: () => Promise<T>) => Promise<T | null>;
  expireLeases: () => Promise<Array<{ project: string; repository: string }>>;
  listPairsWithQueuedRevisions: () => Promise<Array<{ project: string; repository: string }>>;
  grantNext: (project: string, repository: string) => Promise<unknown>;
  listStuckTriggerRevisions: () => Promise<Array<{ revisionId: string; buildRunId: string }>>;
  failStuckTrigger: (revisionId: string, buildRunId: string) => Promise<void>;
  listStaleDeployingRevisions: () => Promise<StaleDeployingRevision[]>;
  pollPipelineBuild: (adoProject: string, pipelineRunId: string) => Promise<PolledPipelineBuild>;
  settleDeployment: (input: {
    pipelineRunId: string;
    commit: string;
    status: 'succeeded' | 'failed';
    failedStage?: string;
    errorText?: string;
    pipelineUrl?: string;
  }) => Promise<unknown>;
}

function createDefaultSweepDeps(): BuildDeploymentSweepDeps {
  return {
    async withSweepLock(fn) {
      return db.transaction(async (tx) => {
        const res = await tx.execute<{ locked: boolean }>(
          sql`SELECT pg_try_advisory_xact_lock(hashtext(${DEPLOYMENT_SWEEP_LOCK_KEY})) AS locked`,
        );
        if (!res.rows[0]?.locked) return null;
        return fn();
      });
    },
    expireLeases: () => defaultPreviewLeaseService.expireLeases(),
    async listPairsWithQueuedRevisions() {
      const rows = await db
        .selectDistinct({
          project: buildRuns.project,
          repository: buildRuns.repository,
        })
        .from(buildRevisions)
        .innerJoin(buildRuns, eq(buildRuns.id, buildRevisions.buildRunId))
        .where(
          and(
            eq(buildRevisions.deploymentStatus, 'queued'),
            eq(buildRuns.status, 'deploying'),
          ),
        );
      return rows;
    },
    grantNext: (project, repository) =>
      defaultBuildDeploymentService.grantNext(project, repository),
    async listStuckTriggerRevisions() {
      return db
        .select({
          revisionId: buildRevisions.id,
          buildRunId: buildRevisions.buildRunId,
        })
        .from(buildRevisions)
        .where(
          and(
            eq(buildRevisions.deploymentStatus, 'deploying'),
            isNull(buildRevisions.pipelineRunId),
            sql`${buildRevisions.updatedAt} < now() - ${`${STUCK_TRIGGER_MS} milliseconds`}::interval`,
          ),
        );
    },
    async failStuckTrigger(revisionId, buildRunId) {
      const now = new Date().toISOString();
      await db
        .update(buildRevisions)
        .set({
          deploymentStatus: 'failed',
          deploymentFailedStage: 'trigger',
          deployedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(buildRevisions.id, revisionId),
            eq(buildRevisions.deploymentStatus, 'deploying'),
            isNull(buildRevisions.pipelineRunId),
          ),
        );
      await db
        .update(buildRuns)
        .set({ status: 'deployment_failed', updatedAt: now })
        .where(and(eq(buildRuns.id, buildRunId), eq(buildRuns.status, 'deploying')));
      await defaultPreviewLeaseService.releaseLease({
        buildRunId,
        reason: 'failure',
      });
    },
    async listStaleDeployingRevisions() {
      const rows = await db
        .select({
          revisionId: buildRevisions.id,
          buildRunId: buildRevisions.buildRunId,
          project: buildRuns.project,
          pipelineRunId: buildRevisions.pipelineRunId,
          validatedCommit: buildRevisions.validatedCommit,
          updatedAt: buildRevisions.updatedAt,
        })
        .from(buildRevisions)
        .innerJoin(buildRuns, eq(buildRuns.id, buildRevisions.buildRunId))
        .where(
          and(
            eq(buildRevisions.deploymentStatus, 'deploying'),
            isNotNull(buildRevisions.pipelineRunId),
            sql`${buildRevisions.updatedAt} < now() - ${`${POLL_STALE_MS} milliseconds`}::interval`,
          ),
        );
      const nowMs = Date.now();
      return rows.map((r) => ({
        revisionId: r.revisionId,
        buildRunId: r.buildRunId,
        project: r.project,
        pipelineRunId: r.pipelineRunId!,
        validatedCommit: r.validatedCommit ?? '',
        ageMs: nowMs - new Date(r.updatedAt).getTime(),
        deadlineMs: DEFAULT_DEPLOYMENT_DEADLINE_MS,
      }));
    },
    pollPipelineBuild,
    settleDeployment: (input) =>
      defaultBuildDeploymentService.settleFromCallback(input),
  };
}

export function createBuildDeploymentSweepPass(
  deps: BuildDeploymentSweepDeps = createDefaultSweepDeps(),
): () => Promise<DeploymentSweepOutcome> {
  return async () => {
    const outcome: DeploymentSweepOutcome = {
      skipped: false,
      expiredLeases: 0,
      stuckTriggersFailed: 0,
      polledRevisions: 0,
    };

    const ran = await deps.withSweepLock(async () => {
      const freedPairs = await deps.expireLeases();
      outcome.expiredLeases = freedPairs.length;

      for (const pair of freedPairs) {
        await deps.grantNext(pair.project, pair.repository);
      }

      const stuck = await deps.listStuckTriggerRevisions();
      for (const item of stuck) {
        await deps.failStuckTrigger(item.revisionId, item.buildRunId);
        outcome.stuckTriggersFailed += 1;
      }

      const stale = await deps.listStaleDeployingRevisions();
      for (const rev of stale) {
        outcome.polledRevisions += 1;
        if (rev.ageMs >= rev.deadlineMs) {
          await deps.settleDeployment({
            pipelineRunId: rev.pipelineRunId,
            commit: rev.validatedCommit,
            status: 'failed',
            failedStage: 'timeout',
            errorText: 'Deployment exceeded the deadline.',
          });
          continue;
        }
        try {
          const polled = await deps.pollPipelineBuild(rev.project, rev.pipelineRunId);
          if (!polled.completed) continue;
          if (polled.succeeded) {
            await deps.settleDeployment({
              pipelineRunId: rev.pipelineRunId,
              commit: rev.validatedCommit,
              status: 'succeeded',
              ...(polled.pipelineUrl ? { pipelineUrl: polled.pipelineUrl } : {}),
            });
          } else {
            await deps.settleDeployment({
              pipelineRunId: rev.pipelineRunId,
              commit: rev.validatedCommit,
              status: 'failed',
              failedStage: polled.failedStage ?? 'deploy',
              errorText: polled.errorText ?? 'Pipeline run failed.',
              ...(polled.pipelineUrl ? { pipelineUrl: polled.pipelineUrl } : {}),
            });
          }
        } catch (err) {
          console.warn(
            '[buildDeploymentScheduler] poll failed:',
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      const queuedPairs = await deps.listPairsWithQueuedRevisions();
      for (const pair of queuedPairs) {
        await deps.grantNext(pair.project, pair.repository);
      }

      return true;
    });

    if (ran === null) {
      outcome.skipped = true;
    }
    return outcome;
  };
}

export const BUILD_DEPLOYMENT_SWEEP_INTERVAL_MS = 30_000;

let deploymentSweepTimer: ReturnType<typeof setInterval> | null = null;

export function startBuildDeploymentScheduler(): void {
  if (deploymentSweepTimer) return;
  const pass = createBuildDeploymentSweepPass();
  deploymentSweepTimer = setInterval(() => {
    void pass().catch((error: unknown) => {
      console.warn(
        '[buildDeploymentScheduler] sweep failed:',
        error instanceof Error ? error.message : String(error),
      );
    });
  }, BUILD_DEPLOYMENT_SWEEP_INTERVAL_MS);
  deploymentSweepTimer.unref?.();
}

export function stopBuildDeploymentScheduler(): void {
  if (!deploymentSweepTimer) return;
  clearInterval(deploymentSweepTimer);
  deploymentSweepTimer = null;
}

/**
 * Build deployment orchestration service (FEAT-013, TBI-025, PBI-026, PBI-028, PBI-029 / S5).
 *
 * Owns `enqueueRevisionDeployment`, `grantNext`, `settleFromCallback`,
 * `retryDeployment`, `assertMayRetry`, and `buildPreviewsList`.
 */
import { and, eq, inArray } from 'drizzle-orm';
import {
  type BuildDeploymentCallbackRequest,
  type BuildDeploymentCallbackResponse,
  type BuildDeploymentStatus,
  type BuildPreviewEntry,
  type BuildRunStatus,
  type BuildSupportContact,
  type RetryDeploymentResponse,
} from '../../shared/types/build';
import { BUILD_FROM_PROMPT_FLAG } from '../../shared/types/featureFlags';
import { db } from '../db/drizzle';
import { buildRevisions, buildRuns } from '../db/schema';
import { defaultBuildDeploymentNotifier } from './buildDeploymentNotifier';
import { appendBuildEvent } from './buildEventsService';
import {
  queuePipelineBuild,
  type QueuePipelineBuildInput,
  type QueuedPipelineBuild,
} from './buildPipelineClient';
import { defaultPreviewLeaseService } from './buildPreviewLeaseService';
import { redactText } from './buildRedactionService';
import { isFeatureEnabled } from './featureFlagService';
import { loadSettingsForRepository } from './buildProfileService';

export interface DeploymentRunRecord {
  id: string;
  project: string;
  repository: string;
  status: BuildRunStatus;
  requesterUserId: string;
  integrationBranch: string | null;
  currentRevisionNumber: number;
  supportContacts: BuildSupportContact[];
  defaultPreviewUrl?: string | null;
  deployPipelineId?: number | null;
}

export interface DeploymentRevisionRecord {
  id: string;
  buildRunId: string;
  revisionNumber: number;
  validatedCommit: string | null;
  pipelineRunId: string | null;
  deploymentStatus: BuildDeploymentStatus;
  deploymentQueuedAt: string | null;
  deployedAt: string | null;
  deploymentFailedStage: string | null;
  deploymentError: string | null;
  deploymentPipelineUrl: string | null;
  previewUrl: string | null;
}

export interface RetryActor {
  userId: string;
  isProjectAdmin: boolean;
  isSuperAdmin: boolean;
}

export function assertMayRetry(
  actor: RetryActor,
  run: Pick<DeploymentRunRecord, 'supportContacts'>,
): boolean {
  if (actor.isSuperAdmin || actor.isProjectAdmin) return true;
  if (!actor.userId) return false;
  return run.supportContacts.some((c) => c.userId === actor.userId);
}

export function buildPreviewsList(input: {
  revisions: Array<{
    id: string;
    revisionNumber: number;
    validatedCommit: string | null;
    deploymentStatus: BuildDeploymentStatus;
    deployedAt: string | null;
    previewUrl: string | null;
  }>;
  activeLeaseRevisionId: string | null;
}): BuildPreviewEntry[] {
  return [...input.revisions]
    .sort((a, b) => b.revisionNumber - a.revisionNumber)
    .map((rev) => {
      const isLive =
        rev.deploymentStatus === 'succeeded'
        && input.activeLeaseRevisionId !== null
        && rev.id === input.activeLeaseRevisionId;
      return {
        revisionNumber: rev.revisionNumber,
        commit: rev.validatedCommit ?? '',
        deploymentStatus: rev.deploymentStatus,
        finishedAt: rev.deployedAt ?? null,
        previewUrl: isLive ? rev.previewUrl ?? null : null,
        isLive,
      };
    });
}

export interface BuildDeploymentServiceDeps {
  now: () => Date;
  isFlagEnabled: (project: string, userId: string) => Promise<boolean>;
  loadByPipelineRunId: (
    pipelineRunId: string,
  ) => Promise<{ run: DeploymentRunRecord; revision: DeploymentRevisionRecord } | null>;
  loadRunAndCurrentRevision: (
    buildRunId: string,
  ) => Promise<{ run: DeploymentRunRecord; revision: DeploymentRevisionRecord } | null>;
  casSettleRevision: (
    pipelineRunId: string,
    update: {
      deploymentStatus: 'succeeded' | 'failed';
      previewUrl?: string | null;
      deployedAt?: string | null;
      failedStage?: string | null;
      errorText?: string | null;
      pipelineUrl?: string | null;
    },
  ) => Promise<boolean>;
  setRunStatus: (runId: string, status: BuildRunStatus) => Promise<void>;
  extendLease: (runId: string, finishedAtIso: string) => Promise<void>;
  releaseLease: (runId: string, reason: 'failure' | 'cancel' | 'accept') => Promise<void>;
  tryClaimNextWaiting: (
    project: string,
    repository: string,
  ) => Promise<{ run: DeploymentRunRecord; revision: DeploymentRevisionRecord } | null>;
  storePipelineRun: (
    revisionId: string,
    pipelineRunId: string,
    pipelineUrl: string | null,
  ) => Promise<void>;
  casRetryRevision: (revisionId: string, queuedAtIso: string) => Promise<boolean>;
  getQueuePosition: (revisionId: string) => Promise<number | null>;
  queuePipelineBuild: (input: QueuePipelineBuildInput) => Promise<QueuedPipelineBuild>;
  notifyPreviewReady: (input: {
    buildRunId: string;
    revisionId: string;
    revisionNumber: number;
    pipelineRunId: string;
    requesterUserId: string;
  }) => Promise<void>;
  notifyDeploymentFailed: (input: {
    buildRunId: string;
    revisionId: string;
    pipelineRunId: string;
    commit: string;
    failedStage: string | null;
    errorText: string | null;
    pipelineUrl: string | null;
    supportContacts: readonly BuildSupportContact[];
  }) => Promise<void>;
  appendEvent: (input: {
    buildRunId: string;
    buildRevisionId: string;
    eventType: string;
    severity?: 'info' | 'warn' | 'error';
    message: string;
    detail?: Record<string, unknown>;
    actorUserId?: string | null;
  }) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  casEnqueueRevision: (
    revisionId: string,
    buildRunId: string,
    queuedAtIso: string,
  ) => Promise<boolean>;
}

function isRetryableTriggerError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { statusCode?: number; status?: number }).statusCode
    ?? (err as { status?: number }).status;
  if (typeof code === 'number') {
    return code >= 500;
  }
  return true;
}

function createDefaultDeploymentDeps(): BuildDeploymentServiceDeps {
  const mapRow = (
    run: typeof buildRuns.$inferSelect,
    rev: typeof buildRevisions.$inferSelect,
  ): { run: DeploymentRunRecord; revision: DeploymentRevisionRecord } => ({
    run: {
      id: run.id,
      project: run.project,
      repository: run.repository,
      status: run.status,
      requesterUserId: run.requestedByUserId,
      integrationBranch: run.integrationBranch ?? null,
      currentRevisionNumber: run.currentRevisionNumber,
      supportContacts: run.supportContacts ?? [],
      defaultPreviewUrl: null,
      deployPipelineId: null,
    },
    revision: {
      id: rev.id,
      buildRunId: rev.buildRunId,
      revisionNumber: rev.revisionNumber,
      validatedCommit: rev.validatedCommit ?? null,
      pipelineRunId: rev.pipelineRunId ?? null,
      deploymentStatus: rev.deploymentStatus,
      deploymentQueuedAt: rev.deploymentQueuedAt ?? null,
      deployedAt: rev.deployedAt ?? null,
      deploymentFailedStage: rev.deploymentFailedStage ?? null,
      deploymentError: null,
      deploymentPipelineUrl: rev.deploymentPipelineUrl ?? null,
      previewUrl: rev.previewUrl ?? null,
    },
  });

  return {
    now: () => new Date(),
    async isFlagEnabled(project, userId) {
      // @feature-flag:build-from-prompt start winner=enabled
      const enabled = await isFeatureEnabled(BUILD_FROM_PROMPT_FLAG, {
        project,
        userId,
      });
      if (enabled) {
        // @feature-flag:build-from-prompt enabled-start
        return true;
        // @feature-flag:build-from-prompt enabled-end
      }
      // @feature-flag:build-from-prompt disabled-start
      return false;
      // @feature-flag:build-from-prompt disabled-end
      // @feature-flag:build-from-prompt end
    },
    async loadByPipelineRunId(pipelineRunId) {
      const [row] = await db
        .select({ rev: buildRevisions, run: buildRuns })
        .from(buildRevisions)
        .innerJoin(buildRuns, eq(buildRuns.id, buildRevisions.buildRunId))
        .where(eq(buildRevisions.pipelineRunId, pipelineRunId))
        .limit(1);
      if (!row) return null;
      return mapRow(row.run, row.rev);
    },
    async loadRunAndCurrentRevision(buildRunId) {
      const [row] = await db
        .select({ rev: buildRevisions, run: buildRuns })
        .from(buildRuns)
        .innerJoin(
          buildRevisions,
          and(
            eq(buildRevisions.buildRunId, buildRuns.id),
            eq(buildRevisions.revisionNumber, buildRuns.currentRevisionNumber),
          ),
        )
        .where(eq(buildRuns.id, buildRunId))
        .limit(1);
      if (!row) return null;
      return mapRow(row.run, row.rev);
    },
    async casSettleRevision(pipelineRunId, update) {
      const rows = await db
        .update(buildRevisions)
        .set({
          deploymentStatus: update.deploymentStatus,
          ...(update.previewUrl !== undefined ? { previewUrl: update.previewUrl } : {}),
          ...(update.deployedAt !== undefined ? { deployedAt: update.deployedAt } : {}),
          ...(update.failedStage !== undefined
            ? { deploymentFailedStage: update.failedStage }
            : {}),
          ...(update.pipelineUrl !== undefined
            ? { deploymentPipelineUrl: update.pipelineUrl }
            : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(buildRevisions.pipelineRunId, pipelineRunId),
            eq(buildRevisions.deploymentStatus, 'deploying'),
          ),
        )
        .returning({ id: buildRevisions.id });
      return rows.length > 0;
    },
    async setRunStatus(runId, status) {
      await db
        .update(buildRuns)
        .set({ status, updatedAt: new Date().toISOString() })
        .where(eq(buildRuns.id, runId));
    },
    async extendLease(runId, finishedAtIso) {
      await defaultPreviewLeaseService.extendLease(runId, finishedAtIso);
    },
    async releaseLease(runId, reason) {
      await defaultPreviewLeaseService.releaseLease({ buildRunId: runId, reason });
    },
    async tryClaimNextWaiting(project, repository) {
      const lease = await defaultPreviewLeaseService.claimNextWaitingLease(
        project,
        repository,
      );
      if (!lease) return null;
      const now = new Date().toISOString();
      await db
        .update(buildRevisions)
        .set({ deploymentStatus: 'deploying', updatedAt: now })
        .where(eq(buildRevisions.id, lease.buildRevisionId));
      const [row] = await db
        .select({ rev: buildRevisions, run: buildRuns })
        .from(buildRevisions)
        .innerJoin(buildRuns, eq(buildRuns.id, buildRevisions.buildRunId))
        .where(eq(buildRevisions.id, lease.buildRevisionId))
        .limit(1);
      if (!row) return null;
      return mapRow(row.run, row.rev);
    },
    async storePipelineRun(revisionId, pipelineRunId, pipelineUrl) {
      await db
        .update(buildRevisions)
        .set({
          pipelineRunId,
          deploymentPipelineUrl: pipelineUrl,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(buildRevisions.id, revisionId));
    },
    async casRetryRevision(revisionId, queuedAtIso) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(buildRevisions)
          .set({
            deploymentStatus: 'queued',
            deploymentQueuedAt: queuedAtIso,
            pipelineRunId: null,
            deploymentFailedStage: null,
            updatedAt: queuedAtIso,
          })
          .where(
            and(
              eq(buildRevisions.id, revisionId),
              eq(buildRevisions.deploymentStatus, 'failed'),
            ),
          )
          .returning({ buildRunId: buildRevisions.buildRunId });
        if (rows.length === 0) return false;
        await tx
          .update(buildRuns)
          .set({ status: 'deploying', updatedAt: queuedAtIso })
          .where(eq(buildRuns.id, rows[0].buildRunId));
        return true;
      });
    },
    getQueuePosition: (revisionId) =>
      defaultPreviewLeaseService.getQueuePosition(revisionId),
    queuePipelineBuild,
    notifyPreviewReady: (input) =>
      defaultBuildDeploymentNotifier.notifyPreviewReady(input),
    notifyDeploymentFailed: (input) =>
      defaultBuildDeploymentNotifier.notifyDeploymentFailed(input),
    async appendEvent(input) {
      await appendBuildEvent(input);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    async casEnqueueRevision(revisionId, buildRunId, queuedAtIso) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(buildRevisions)
          .set({
            deploymentStatus: 'queued',
            deploymentQueuedAt: queuedAtIso,
            updatedAt: queuedAtIso,
          })
          .where(
            and(
              eq(buildRevisions.id, revisionId),
              inArray(buildRevisions.deploymentStatus, ['not_started', 'failed']),
            ),
          )
          .returning({ id: buildRevisions.id });
        if (rows.length === 0) return false;
        await tx
          .update(buildRuns)
          .set({ status: 'deploying', updatedAt: queuedAtIso })
          .where(
            and(
              eq(buildRuns.id, buildRunId),
              inArray(buildRuns.status, [
                'checking',
                'building',
                'deploying',
                'preview_ready',
                'deployment_failed',
              ]),
            ),
          );
        return true;
      });
    },
  };
}

export function createBuildDeploymentService(
  deps: BuildDeploymentServiceDeps = createDefaultDeploymentDeps(),
) {
  const service = {
    async settleFromCallback(
      input: BuildDeploymentCallbackRequest,
    ): Promise<
      | { kind: 'ok'; response: BuildDeploymentCallbackResponse }
      | { kind: 'not_found' }
      | { kind: 'commit_mismatch' }
    > {
      const found = await deps.loadByPipelineRunId(input.pipelineRunId);
      if (!found) {
        return { kind: 'not_found' };
      }

      const { run, revision } = found;
      if (revision.validatedCommit && revision.validatedCommit !== input.commit) {
        await deps.appendEvent({
          buildRunId: run.id,
          buildRevisionId: revision.id,
          eventType: 'callback_commit_mismatch',
          severity: 'warn',
          message: 'Deployment callback commit did not match the revision validated commit.',
          detail: {
            pipelineRunId: input.pipelineRunId,
            expectedCommit: revision.validatedCommit,
            receivedCommit: input.commit,
          },
        });
        return { kind: 'commit_mismatch' };
      }

      if (run.status === 'cancelled' || run.status === 'failed' || run.status === 'accepted') {
        return {
          kind: 'ok',
          response: { applied: false, reason: 'run_not_deploying' },
        };
      }

      const finishedAt = deps.now().toISOString();

      if (input.status === 'succeeded') {
        const previewUrl =
          input.previewUrl
          ?? revision.previewUrl
          ?? run.defaultPreviewUrl
          ?? null;
        if (!previewUrl) {
          await deps.appendEvent({
            buildRunId: run.id,
            buildRevisionId: revision.id,
            eventType: 'deployment_failed',
            severity: 'error',
            message: 'Preview deployment succeeded without a preview URL.',
            detail: { pipelineRunId: input.pipelineRunId, failedStage: 'preview_url' },
          });
          await deps.casSettleRevision(input.pipelineRunId, {
            deploymentStatus: 'failed',
            deployedAt: finishedAt,
            failedStage: 'preview_url',
            errorText: 'Preview URL was missing when the deployment completed.',
            pipelineUrl: input.pipelineUrl ?? revision.deploymentPipelineUrl,
          });
          if (run.status === 'deploying') {
            await deps.setRunStatus(run.id, 'deployment_failed');
          }
          await deps.releaseLease(run.id, 'failure');
          return { kind: 'ok', response: { applied: true } };
        }

        const won = await deps.casSettleRevision(input.pipelineRunId, {
          deploymentStatus: 'succeeded',
          previewUrl,
          deployedAt: finishedAt,
          pipelineUrl: input.pipelineUrl ?? revision.deploymentPipelineUrl,
        });
        if (!won) {
          return {
            kind: 'ok',
            response: { applied: false, reason: 'duplicate' },
          };
        }

        if (run.status === 'deploying') {
          await deps.setRunStatus(run.id, 'preview_ready');
        }
        await deps.extendLease(run.id, finishedAt);
        await deps.appendEvent({
          buildRunId: run.id,
          buildRevisionId: revision.id,
          eventType: 'deployment_succeeded',
          message: `Preview deployed for revision ${revision.revisionNumber}.`,
          detail: {
            pipelineRunId: input.pipelineRunId,
            revisionNumber: revision.revisionNumber,
          },
        });
        await deps.notifyPreviewReady({
          buildRunId: run.id,
          revisionId: revision.id,
          revisionNumber: revision.revisionNumber,
          pipelineRunId: input.pipelineRunId,
          requesterUserId: run.requesterUserId,
        });

        return { kind: 'ok', response: { applied: true } };
      }

      // Failed outcome
      const redactedStage = redactText(input.failedStage?.trim() || 'deploy').slice(0, 200);
      const redactedError = redactText(input.errorText?.trim() || 'Deployment failed').slice(0, 4000);
      const pipelineUrl = input.pipelineUrl ?? revision.deploymentPipelineUrl ?? null;

      const won = await deps.casSettleRevision(input.pipelineRunId, {
        deploymentStatus: 'failed',
        deployedAt: finishedAt,
        failedStage: redactedStage,
        errorText: redactedError,
        pipelineUrl,
      });
      if (!won) {
        return {
          kind: 'ok',
          response: { applied: false, reason: 'duplicate' },
        };
      }

      if (run.status === 'deploying') {
        await deps.setRunStatus(run.id, 'deployment_failed');
      }
      await deps.releaseLease(run.id, 'failure');
      await deps.appendEvent({
        buildRunId: run.id,
        buildRevisionId: revision.id,
        eventType: 'deployment_failed',
        severity: 'error',
        message: `Preview deployment failed at stage ${redactedStage}.`,
        detail: {
          pipelineRunId: input.pipelineRunId,
          failedStage: redactedStage,
          pipelineUrl,
          errorExcerpt: redactedError.slice(0, 500),
        },
      });
      await deps.notifyDeploymentFailed({
        buildRunId: run.id,
        revisionId: revision.id,
        pipelineRunId: input.pipelineRunId,
        commit: input.commit,
        failedStage: redactedStage,
        errorText: redactedError,
        pipelineUrl,
        supportContacts: run.supportContacts,
      });

      return { kind: 'ok', response: { applied: true } };
    },

    async grantNext(project: string, repository: string): Promise<boolean> {
      const flagOnForProject = await deps.isFlagEnabled(project, '');
      if (!flagOnForProject) {
        return false;
      }

      const claimed = await deps.tryClaimNextWaiting(project, repository);
      if (!claimed) return false;

      const { run, revision } = claimed;

      const commit = revision.validatedCommit ?? '';
      const branch = run.integrationBranch ?? `apex/build/${run.id}`;
      let pipelineDefinitionId = run.deployPipelineId ?? null;
      if (pipelineDefinitionId == null) {
        const settings = await loadSettingsForRepository(run.project, run.repository);
        pipelineDefinitionId = settings?.buildProfile?.deployPipelineId ?? null;
      }
      const pipelineId = pipelineDefinitionId ?? 1;

      const retryDelays = [1_000, 4_000];
      let lastError: unknown = null;
      let queued: QueuedPipelineBuild | null = null;

      for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
        try {
          queued = await deps.queuePipelineBuild({
            adoProject: run.project,
            pipelineDefinitionId: pipelineId,
            sourceBranch: branch,
            commit,
            buildRunId: run.id,
            revisionId: revision.id,
            revisionNumber: revision.revisionNumber,
          });
          break;
        } catch (err) {
          lastError = err;
          if (!isRetryableTriggerError(err) || attempt === retryDelays.length) {
            break;
          }
          await deps.sleep(retryDelays[attempt]);
        }
      }

      if (!queued) {
        const errMsg = redactText(
          lastError instanceof Error ? lastError.message : 'Pipeline trigger failed',
        ).slice(0, 4000);
        const SyntheticRunId = `trigger-failed:${revision.id}`;
        await deps.storePipelineRun(revision.id, SyntheticRunId, null);
        await deps.casSettleRevision(SyntheticRunId, {
          deploymentStatus: 'failed',
          deployedAt: deps.now().toISOString(),
          failedStage: 'trigger',
          errorText: errMsg,
          pipelineUrl: null,
        });
        await deps.setRunStatus(run.id, 'deployment_failed');
        await deps.releaseLease(run.id, 'failure');
        await deps.appendEvent({
          buildRunId: run.id,
          buildRevisionId: revision.id,
          eventType: 'deployment_failed',
          severity: 'error',
          message: 'Preview deployment failed at stage trigger.',
          detail: { failedStage: 'trigger', errorExcerpt: errMsg.slice(0, 500) },
        });
        await deps.notifyDeploymentFailed({
          buildRunId: run.id,
          revisionId: revision.id,
          pipelineRunId: SyntheticRunId,
          commit,
          failedStage: 'trigger',
          errorText: errMsg,
          pipelineUrl: null,
          supportContacts: run.supportContacts,
        });
        return false;
      }

      await deps.storePipelineRun(
        revision.id,
        queued.pipelineRunId,
        queued.pipelineUrl,
      );
      await deps.appendEvent({
        buildRunId: run.id,
        buildRevisionId: revision.id,
        eventType: 'deployment_started',
        message: `Triggered deployment pipeline run ${queued.pipelineRunId}.`,
        detail: {
          pipelineRunId: queued.pipelineRunId,
          pipelineUrl: queued.pipelineUrl,
        },
      });
      return true;
    },

    async enqueueRevisionDeployment(buildRunId: string): Promise<
      | { kind: 'ok' }
      | { kind: 'not_found' }
      | { kind: 'skipped'; reason: 'not_validated' }
    > {
      const loaded = await deps.loadRunAndCurrentRevision(buildRunId);
      if (!loaded) return { kind: 'not_found' };

      const { run, revision } = loaded;
      if (!revision.validatedCommit) {
        return { kind: 'skipped', reason: 'not_validated' };
      }

      if (
        revision.deploymentStatus === 'queued'
        || revision.deploymentStatus === 'deploying'
        || revision.deploymentStatus === 'succeeded'
      ) {
        await service.grantNext(run.project, run.repository);
        return { kind: 'ok' };
      }

      const queuedAt = deps.now().toISOString();
      const changed = await deps.casEnqueueRevision(revision.id, run.id, queuedAt);
      if (changed) {
        await deps.appendEvent({
          buildRunId: run.id,
          buildRevisionId: revision.id,
          eventType: 'deployment_queued',
          message: `Preview deployment queued for revision ${revision.revisionNumber}.`,
          detail: {
            revisionNumber: revision.revisionNumber,
            commit: revision.validatedCommit,
          },
        });
      }

      await service.grantNext(run.project, run.repository);
      return { kind: 'ok' };
    },

    async retryDeployment(input: {
      buildRunId: string;
      actor: RetryActor;
    }): Promise<
      | { kind: 'ok'; response: RetryDeploymentResponse }
      | { kind: 'not_found' }
      | { kind: 'forbidden' }
      | { kind: 'not_retryable'; message: string }
    > {
      const loaded = await deps.loadRunAndCurrentRevision(input.buildRunId);
      if (!loaded) return { kind: 'not_found' };

      const { run, revision } = loaded;
      if (!assertMayRetry(input.actor, run)) {
        return { kind: 'forbidden' };
      }

      if (
        run.status !== 'deployment_failed'
        && !(run.status === 'deploying' && revision.deploymentStatus === 'queued')
      ) {
        return {
          kind: 'not_retryable',
          message: 'Deployment can only be retried when the build is in Deployment failed.',
        };
      }

      const queuedAt = deps.now().toISOString();
      const changed = await deps.casRetryRevision(revision.id, queuedAt);

      if (changed) {
        await deps.appendEvent({
          buildRunId: run.id,
          buildRevisionId: revision.id,
          eventType: 'deployment_retry_requested',
          message: `Deployment retry queued for commit ${(revision.validatedCommit ?? '').slice(0, 7)}.`,
          detail: {
            revisionNumber: revision.revisionNumber,
            commit: revision.validatedCommit,
          },
          actorUserId: input.actor.userId,
        });
      }

      const queuePosition = await deps.getQueuePosition(revision.id);
      return {
        kind: 'ok',
        response: {
          deploymentStatus: 'queued',
          queuePosition,
          changed,
        },
      };
    },
  };
  return service;
}

export const defaultBuildDeploymentService = createBuildDeploymentService();

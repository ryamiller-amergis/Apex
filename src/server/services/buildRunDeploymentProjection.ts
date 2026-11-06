/**
 * Deployment and preview fields for the build run detail API (FEAT-013).
 */
import type {
  BuildDeploymentView,
  BuildPreviewEntry,
  BuildSupportContact,
} from '../../shared/types/build';
import {
  assertMayRetry,
  buildPreviewsList,
} from './buildDeploymentService';
import { defaultPreviewLeaseService } from './buildPreviewLeaseService';
import type { ProjectionRevisionRow, ProjectionRunRow } from './buildRunProjectionService';

export interface BuildDetailViewer {
  userId: string;
  isProjectAdmin: boolean;
  isSuperAdmin: boolean;
}

function formatSupportContactNames(contacts: readonly BuildSupportContact[]): string[] {
  return contacts.map((c) =>
    c.email ? `${c.displayName} (${c.email})` : c.displayName,
  );
}

function mayViewDeploymentDiagnostics(
  viewer: BuildDetailViewer | undefined,
  supportContacts: readonly BuildSupportContact[],
): boolean {
  if (!viewer) return false;
  if (viewer.isSuperAdmin || viewer.isProjectAdmin) return true;
  return supportContacts.some((c) => c.userId === viewer.userId);
}

export async function projectBuildDeploymentFields(input: {
  run: ProjectionRunRow;
  currentRevision: ProjectionRevisionRow | null;
  viewer?: BuildDetailViewer;
}): Promise<{
  lease: { state: 'waiting' | 'held' | 'none'; queuePosition: number | null };
  deployment: BuildDeploymentView | undefined;
  previews: BuildPreviewEntry[];
  viewer: { canRetryDeployment: boolean } | undefined;
  deployStartedAt: string | null;
  deployFinishedAt: string | null;
  deploymentTimesKnown: boolean;
}> {
  const { run, currentRevision } = input;
  const activeLease = await defaultPreviewLeaseService.getActiveLease(
    run.project,
    run.repository,
  );

  let queuePosition: number | null = null;
  if (currentRevision && currentRevision.deploymentStatus === 'queued') {
    queuePosition = await defaultPreviewLeaseService.getQueuePosition(currentRevision.id);
  }

  const leaseState: 'waiting' | 'held' | 'none' = (() => {
    if (activeLease && activeLease.buildRunId === run.id) return 'held';
    if (run.status === 'deploying' && currentRevision?.deploymentStatus === 'queued') {
      return 'waiting';
    }
    return 'none';
  })();

  const previews = buildPreviewsList({
    revisions: run.revisions.map((rev) => ({
      id: rev.id,
      revisionNumber: rev.revisionNumber,
      validatedCommit: rev.validatedCommit ?? null,
      deploymentStatus: rev.deploymentStatus,
      deployedAt: rev.deployedAt ?? null,
      previewUrl: rev.previewUrl ?? null,
    })),
    activeLeaseRevisionId: activeLease?.buildRevisionId ?? null,
  });

  const livePreview = previews.find((entry) => entry.isLive) ?? null;
  const showDiagnostics = mayViewDeploymentDiagnostics(input.viewer, run.supportContacts);

  let deployment: BuildDeploymentView | undefined;
  if (currentRevision && currentRevision.deploymentStatus !== 'not_started') {
    deployment = {
      status: currentRevision.deploymentStatus,
      queuePosition,
      previewUrl: livePreview?.previewUrl ?? null,
      leaseExpiresAt:
        activeLease && activeLease.buildRunId === run.id ? activeLease.expiresAt : null,
      failedStage:
        showDiagnostics && currentRevision.deploymentStatus === 'failed'
          ? currentRevision.deploymentFailedStage ?? null
          : null,
      errorExcerpt: null,
      pipelineUrl:
        showDiagnostics ? currentRevision.deploymentPipelineUrl ?? null : null,
      supportContactNames: formatSupportContactNames(run.supportContacts),
    };
  }

  const deployStartedAt = currentRevision?.deploymentQueuedAt ?? null;
  const deployFinishedAt = currentRevision?.deployedAt ?? null;
  const deploymentTimesKnown = Boolean(deployStartedAt || deployFinishedAt);

  const viewerProjection = input.viewer
    ? {
        canRetryDeployment: assertMayRetry(input.viewer, {
          supportContacts: run.supportContacts,
        }),
      }
    : undefined;

  return {
    lease: { state: leaseState, queuePosition },
    deployment,
    previews,
    viewer: viewerProjection,
    deployStartedAt,
    deployFinishedAt,
    deploymentTimesKnown,
  };
}

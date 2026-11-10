import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import type {
  BuildPreviewEvidenceStatus,
  BuildPreviewInstanceState,
  BuildPreviewRolloutMode,
} from '../../../shared/types/build';
import { db } from '../../db/drizzle';
import {
  buildPreviewArtifacts,
  buildPreviewBrowserChecks,
  buildPreviewInstances,
  buildRevisions,
  buildRuns,
} from '../../db/schema';
import type {
  BuildPreviewCompletionEvidence,
  BuildPreviewCompletionPort,
} from './buildPreviewCompletionInvariant';

interface PreviewRevisionRow {
  id: string;
  validatedCommit: string | null;
  previewRolloutMode: BuildPreviewRolloutMode;
}

interface PreviewArtifactRow {
  id: string;
  buildRevisionId: string;
  commit: string;
  digest: string;
}

interface PreviewInstanceRow {
  id: string;
  buildPreviewArtifactId: string;
  commit: string;
  artifactDigest: string;
  state: BuildPreviewInstanceState;
  readinessStatus: BuildPreviewEvidenceStatus;
}

interface PreviewBrowserCheckRow {
  id: string;
  buildPreviewInstanceId: string;
  commit: string;
  artifactDigest: string;
  status: BuildPreviewEvidenceStatus;
}

export interface BuildPreviewCompletionEvidenceReader {
  loadRevision(input: {
    revisionId: string;
    project: string;
    repository: string;
  }): Promise<PreviewRevisionRow | null>;
  loadArtifact(revisionId: string): Promise<PreviewArtifactRow | null>;
  loadLatestReadyInstance(artifactId: string): Promise<PreviewInstanceRow | null>;
  loadLatestBrowserCheck(instanceId: string): Promise<PreviewBrowserCheckRow | null>;
}

export function createBuildPreviewCompletionPort(
  reader: BuildPreviewCompletionEvidenceReader,
): BuildPreviewCompletionPort {
  return {
    async loadGate(input) {
      const revision = await reader.loadRevision(input);
      if (!revision) {
        throw new Error(`Build revision ${input.revisionId} was not found`);
      }
      if (revision.previewRolloutMode === 'legacy_static') {
        return { mode: revision.previewRolloutMode, evidence: null };
      }

      const artifact = await reader.loadArtifact(revision.id);
      const instance = artifact
        ? await reader.loadLatestReadyInstance(artifact.id)
        : null;
      const browserCheck = instance
        ? await reader.loadLatestBrowserCheck(instance.id)
        : null;

      const evidence: BuildPreviewCompletionEvidence = {
        revisionId: revision.id,
        validatedCommit: revision.validatedCommit ?? '',
        artifact: artifact
          ? {
              revisionId: artifact.buildRevisionId,
              commit: artifact.commit,
              digest: artifact.digest,
            }
          : null,
        instance: instance
          ? {
              id: instance.id,
              revisionId: revision.id,
              commit: instance.commit,
              artifactDigest: instance.artifactDigest,
              state: instance.state,
            }
          : null,
        readiness: instance
          ? {
              status: instance.readinessStatus,
              revisionId: revision.id,
              instanceId: instance.id,
              artifactDigest: instance.artifactDigest,
            }
          : null,
        browserCheck: browserCheck
          ? {
              id: browserCheck.id,
              status: browserCheck.status,
              revisionId: revision.id,
              commit: browserCheck.commit,
              instanceId: browserCheck.buildPreviewInstanceId,
              artifactDigest: browserCheck.artifactDigest,
            }
          : null,
      };

      return { mode: revision.previewRolloutMode, evidence };
    },
  };
}

type Database = typeof db;

export function createDrizzleBuildPreviewCompletionReader(
  database: Database = db,
): BuildPreviewCompletionEvidenceReader {
  return {
    async loadRevision(input) {
      const [row] = await database
        .select({
          id: buildRevisions.id,
          validatedCommit: buildRevisions.validatedCommit,
          previewRolloutMode: buildRevisions.previewRolloutMode,
        })
        .from(buildRevisions)
        .innerJoin(buildRuns, eq(buildRuns.id, buildRevisions.buildRunId))
        .where(and(
          eq(buildRevisions.id, input.revisionId),
          eq(buildRuns.project, input.project),
          eq(buildRuns.repository, input.repository),
        ))
        .limit(1);
      return row ?? null;
    },

    async loadArtifact(revisionId) {
      const [row] = await database
        .select({
          id: buildPreviewArtifacts.id,
          buildRevisionId: buildPreviewArtifacts.buildRevisionId,
          commit: buildPreviewArtifacts.commit,
          digest: buildPreviewArtifacts.digest,
        })
        .from(buildPreviewArtifacts)
        .where(eq(buildPreviewArtifacts.buildRevisionId, revisionId))
        .limit(1);
      return row ?? null;
    },

    async loadLatestReadyInstance(artifactId) {
      const [row] = await database
        .select({
          id: buildPreviewInstances.id,
          buildPreviewArtifactId: buildPreviewInstances.buildPreviewArtifactId,
          commit: buildPreviewInstances.commit,
          artifactDigest: buildPreviewInstances.artifactDigest,
          state: buildPreviewInstances.state,
          readinessStatus: buildPreviewInstances.readinessStatus,
        })
        .from(buildPreviewInstances)
        .where(and(
          eq(buildPreviewInstances.buildPreviewArtifactId, artifactId),
          eq(buildPreviewInstances.state, 'ready'),
        ))
        .orderBy(desc(buildPreviewInstances.createdAt), desc(buildPreviewInstances.id))
        .limit(1);
      return row ?? null;
    },

    async loadLatestBrowserCheck(instanceId) {
      const [row] = await database
        .select({
          id: buildPreviewBrowserChecks.id,
          buildPreviewInstanceId: buildPreviewBrowserChecks.buildPreviewInstanceId,
          commit: buildPreviewBrowserChecks.commit,
          artifactDigest: buildPreviewBrowserChecks.artifactDigest,
          status: buildPreviewBrowserChecks.status,
        })
        .from(buildPreviewBrowserChecks)
        .where(eq(buildPreviewBrowserChecks.buildPreviewInstanceId, instanceId))
        .orderBy(
          desc(buildPreviewBrowserChecks.createdAt),
          desc(buildPreviewBrowserChecks.id),
        )
        .limit(1);
      return row ?? null;
    },
  };
}

export function currentBuildPreviewBrowserCheckCondition(
  revisionId: string,
  browserCheckId: string,
): SQL {
  return sql`COALESCE(${browserCheckId}::uuid = (
    SELECT browser_check.id
    FROM build_preview_artifacts AS artifact
    JOIN build_revisions AS build_revision
      ON build_revision.id = artifact.build_revision_id
    JOIN LATERAL (
      SELECT preview_instance.id, preview_instance.commit, preview_instance.artifact_digest
      FROM build_preview_instances AS preview_instance
      WHERE preview_instance.build_preview_artifact_id = artifact.id
        AND preview_instance.state = 'ready'
      ORDER BY preview_instance.created_at DESC, preview_instance.id DESC
      LIMIT 1
    ) AS ready_instance ON true
    JOIN LATERAL (
      SELECT candidate.id, candidate.status, candidate.commit, candidate.artifact_digest
      FROM build_preview_browser_checks AS candidate
      WHERE candidate.build_preview_instance_id = ready_instance.id
      ORDER BY candidate.created_at DESC, candidate.id DESC
      LIMIT 1
    ) AS browser_check ON true
    WHERE artifact.build_revision_id = ${revisionId}::uuid
      AND artifact.commit = build_revision.validated_commit
      AND ready_instance.commit = artifact.commit
      AND ready_instance.artifact_digest = artifact.digest
      AND browser_check.status = 'passed'
      AND browser_check.commit = artifact.commit
      AND browser_check.artifact_digest = artifact.digest
    LIMIT 1
  ), false)`;
}

export const defaultBuildPreviewCompletionPort = createBuildPreviewCompletionPort(
  createDrizzleBuildPreviewCompletionReader(),
);

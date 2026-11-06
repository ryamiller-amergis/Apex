/**
 * Ingests preview bundles from deployment pipelines and completes deployment settlement.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { buildRevisions, buildRuns } from '../db/schema';
import { defaultBuildDeploymentService } from './buildDeploymentService';
import { storePreviewArchive } from './buildPreviewArtifactService';

export async function ingestPreviewBundle(input: {
  pipelineRunId: string;
  commit: string;
  archive: Buffer;
}): Promise<
  | { kind: 'ok'; previewUrl: string }
  | { kind: 'not_found' }
  | { kind: 'commit_mismatch' }
  | { kind: 'error'; message: string }
> {
  const [row] = await db
    .select({ rev: buildRevisions, run: buildRuns })
    .from(buildRevisions)
    .innerJoin(buildRuns, eq(buildRuns.id, buildRevisions.buildRunId))
    .where(eq(buildRevisions.pipelineRunId, input.pipelineRunId))
    .limit(1);
  if (!row) return { kind: 'not_found' };
  if (row.rev.validatedCommit && row.rev.validatedCommit !== input.commit) {
    return { kind: 'commit_mismatch' };
  }

  try {
    const { previewUrl } = await storePreviewArchive({
      buildRunId: row.run.id,
      revisionNumber: row.rev.revisionNumber,
      commit: input.commit,
      archive: input.archive,
    });
    const settled = await defaultBuildDeploymentService.settleFromCallback({
      pipelineRunId: input.pipelineRunId,
      commit: input.commit,
      status: 'succeeded',
      previewUrl,
    });
    if (settled.kind === 'commit_mismatch') {
      return { kind: 'commit_mismatch' };
    }
    if (settled.kind === 'not_found') {
      return { kind: 'not_found' };
    }
    return { kind: 'ok', previewUrl };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await defaultBuildDeploymentService.settleFromCallback({
      pipelineRunId: input.pipelineRunId,
      commit: input.commit,
      status: 'failed',
      failedStage: 'preview_upload',
      errorText: message,
    });
    return { kind: 'error', message };
  }
}

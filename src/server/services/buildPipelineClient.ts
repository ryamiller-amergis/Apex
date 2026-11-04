/**
 * Thin wrapper over the Azure DevOps Build API for preview deployments (FEAT-013, TBI-025).
 * Uses `BUILD_DEPLOY_ADO_PAT` (falling back to `ADO_PAT`) with `azdev.WebApi`.
 */
import * as azdev from 'azure-devops-node-api';
import { redactText } from './buildRedactionService';

export interface QueuePipelineBuildInput {
  adoProject: string;
  pipelineDefinitionId: number;
  sourceBranch: string;
  commit: string;
  buildRunId: string;
  revisionId: string;
  revisionNumber: number;
}

export interface QueuedPipelineBuild {
  pipelineRunId: string;
  pipelineUrl: string | null;
}

export interface PolledPipelineBuild {
  completed: boolean;
  succeeded: boolean;
  failedStage?: string;
  errorText?: string;
  pipelineUrl?: string | null;
}

function getBuildConnection(): azdev.WebApi {
  const org = process.env.ADO_ORG?.trim();
  const pat = (process.env.BUILD_DEPLOY_ADO_PAT || process.env.ADO_PAT || '').trim();
  if (!org || !pat) {
    throw new Error('ADO_ORG and BUILD_DEPLOY_ADO_PAT (or ADO_PAT) are required to queue build deployments.');
  }
  const handler = azdev.getPersonalAccessTokenHandler(pat);
  return new azdev.WebApi(org, handler, { socketTimeout: 60_000 });
}

export async function queuePipelineBuild(
  input: QueuePipelineBuildInput,
): Promise<QueuedPipelineBuild> {
  const conn = getBuildConnection();
  const buildApi = await conn.getBuildApi();
  const branchRef = input.sourceBranch.startsWith('refs/heads/')
    ? input.sourceBranch
    : `refs/heads/${input.sourceBranch}`;

  const queued = await buildApi.queueBuild(
    {
      definition: { id: input.pipelineDefinitionId },
      sourceVersion: input.commit,
      sourceBranch: branchRef,
      parameters: JSON.stringify({
        buildRunId: input.buildRunId,
        revisionNumber: input.revisionNumber,
        commit: input.commit,
      }),
    } as any,
    input.adoProject,
  );

  if (!queued?.id) {
    throw new Error('Azure DevOps queueBuild returned no build id.');
  }

  const webLink =
    (queued._links?.web as { href?: string } | undefined)?.href ?? null;

  return {
    pipelineRunId: String(queued.id),
    pipelineUrl: webLink,
  };
}

export async function pollPipelineBuild(
  adoProject: string,
  pipelineRunId: string,
): Promise<PolledPipelineBuild> {
  const buildId = Number(pipelineRunId);
  if (!Number.isInteger(buildId) || buildId <= 0) {
    return { completed: false, succeeded: false };
  }
  const conn = getBuildConnection();
  const buildApi = await conn.getBuildApi();
  const build = await buildApi.getBuild(adoProject, buildId);
  if (!build) {
    return { completed: false, succeeded: false };
  }

  // BuildStatus.Completed === 2
  const isCompleted =
    build.status === 2 || String(build.status).toLowerCase() === 'completed';
  if (!isCompleted) {
    return { completed: false, succeeded: false };
  }

  // BuildResult.Succeeded === 2
  const isSucceeded =
    build.result === 2 || String(build.result).toLowerCase() === 'succeeded';
  const webLink =
    (build._links?.web as { href?: string } | undefined)?.href ?? null;

  if (isSucceeded) {
    return {
      completed: true,
      succeeded: true,
      pipelineUrl: webLink,
    };
  }

  let failedStage = 'deploy';
  let errorText = 'Pipeline run failed.';
  try {
    const timeline = await buildApi.getBuildTimeline(adoProject, buildId);
    const records = timeline?.records ?? [];
    const stageRecord = records.find(
      (r) =>
        (r.type?.toLowerCase() === 'stage' || r.type?.toLowerCase() === 'job')
        && (Number(r.result) === 8 || String(r.result).toLowerCase() === 'failed'),
    );
    if (stageRecord?.name) {
      failedStage = redactText(stageRecord.name).slice(0, 200);
    }
    const issues = (stageRecord?.issues ?? [])
      .map((i) => i.message)
      .filter((m): m is string => Boolean(m));
    if (issues.length > 0) {
      errorText = redactText(issues.join('; ')).slice(0, 4000);
    }
  } catch {
    // Timeline details are best-effort
  }

  return {
    completed: true,
    succeeded: false,
    failedStage,
    errorText,
    pipelineUrl: webLink,
  };
}

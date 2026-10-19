import { sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { AzureDevOpsService } from './azureDevOps';
import {
  buildImplementationPullRequestText,
  extractAgentPullRequestDescription,
} from './implementationDelivery';
import { parsePullRequestNumber } from './workItemPrLinkService';

/** Azure DevOps pull-request label applied to every Cloud Agent pull request. */
export const CLOUD_AGENT_PULL_REQUEST_LABEL = 'apex-cloud-agent';

export interface CloudAgentPullRequestTextInput {
  workItemId: number;
  workItemTitle?: string | null;
  authorName?: string | null;
  authorEmail?: string | null;
  summary?: string | null;
  sourceBranch: string;
  /** Branch name used for the pull-request title. Defaults to sourceBranch. */
  titleBranch?: string | null;
}

export interface OpenCloudAgentPullRequestInput extends CloudAgentPullRequestTextInput {
  project: string;
  repo: string;
  targetBranch: string;
  /** Bearer token for the developer who started the run. Null uses the service PAT. */
  adoUserToken: string | null;
}

/** Thrown when a production run must wait for the starter's Azure DevOps token. */
export class CloudAgentPullRequestDeferred extends Error {
  constructor() {
    super('Waiting for the developer Azure DevOps token before opening the pull request.');
    this.name = 'CloudAgentPullRequestDeferred';
  }
}

export function buildCloudAgentPullRequestText(
  input: CloudAgentPullRequestTextInput,
): { title: string; description: string } {
  return buildImplementationPullRequestText({
    branchName: input.titleBranch?.trim() || input.sourceBranch,
    workItemId: input.workItemId,
    workItemTitle: input.workItemTitle,
    agentDescription: extractAgentPullRequestDescription(input.summary),
  });
}

export async function openCloudAgentPullRequest(
  input: OpenCloudAgentPullRequestInput,
): Promise<string> {
  if (!input.adoUserToken && process.env.NODE_ENV === 'production') {
    throw new CloudAgentPullRequestDeferred();
  }
  if (!input.adoUserToken) {
    console.warn(
      '[cloud-agent] opening the pull request with the service account because no developer Azure DevOps token is available',
    );
  }

  const { title, description } = buildCloudAgentPullRequestText(input);
  const ado = input.adoUserToken
    ? new AzureDevOpsService(input.project, undefined, { bearerToken: input.adoUserToken })
    : new AzureDevOpsService(input.project);
  const lockKey = `cloud-agent-pr:${input.project}:${input.repo}:${input.sourceBranch}`;

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const existing = await ado.findPullRequestUrlBySourceBranch(
      input.repo,
      input.project,
      input.sourceBranch,
    );
    if (existing) {
      try {
        await alignExistingPullRequest(ado, {
          repo: input.repo,
          project: input.project,
          prUrl: existing,
          title,
          description,
        });
      } catch (err) {
        console.warn(
          '[cloud-agent] could not mark the existing pull request as a draft',
          err instanceof Error ? err.message : String(err),
        );
      }
      await tagCloudAgentPullRequest(ado, {
        repo: input.repo,
        project: input.project,
        prUrl: existing,
      });
      return existing;
    }
    const prUrl = await ado.createPullRequest({
      repo: input.repo,
      project: input.project,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      title,
      description,
      workItemId: input.workItemId,
    });
    try {
      await alignExistingPullRequest(ado, {
        repo: input.repo,
        project: input.project,
        prUrl,
        title,
        description,
      });
    } catch (err) {
      console.warn(
        '[cloud-agent] pull request was created but could not be marked as a draft',
        err instanceof Error ? err.message : String(err),
      );
    }
    await tagCloudAgentPullRequest(ado, {
      repo: input.repo,
      project: input.project,
      prUrl,
    });
    return prUrl;
  });
}

async function alignExistingPullRequest(
  ado: AzureDevOpsService,
  input: {
    repo: string;
    project: string;
    prUrl: string;
    title: string;
    /** Omitted to keep the description already on the pull request. */
    description?: string;
  },
): Promise<void> {
  const pullRequestId = parsePullRequestNumber(input.prUrl, 'ado');
  await ado.updatePullRequest({
    repo: input.repo,
    project: input.project,
    pullRequestId,
    title: input.title,
    ...(input.description !== undefined ? { description: input.description } : {}),
    isDraft: true,
  });
}

async function tagCloudAgentPullRequest(
  ado: AzureDevOpsService,
  input: { repo: string; project: string; prUrl: string },
): Promise<void> {
  await ado.addPullRequestLabel({
    repo: input.repo,
    project: input.project,
    pullRequestId: parsePullRequestNumber(input.prUrl, 'ado'),
    name: CLOUD_AGENT_PULL_REQUEST_LABEL,
  });
}

/**
 * Sets the My Work title and draft on an already-opened Azure Repos pull request.
 * Leaves the description alone: it holds the agent's filled pr-description.md,
 * and this caller does not have the agent's final message.
 */
export async function alignCloudAgentPullRequest(input: {
  project: string;
  repo: string;
  prUrl: string;
  workItemId: number;
  sourceBranch: string;
  titleBranch?: string | null;
}): Promise<void> {
  const { title } = buildCloudAgentPullRequestText(input);
  const ado = new AzureDevOpsService(input.project);
  await alignExistingPullRequest(ado, {
    repo: input.repo,
    project: input.project,
    prUrl: input.prUrl,
    title,
  });
  await tagCloudAgentPullRequest(ado, {
    repo: input.repo,
    project: input.project,
    prUrl: input.prUrl,
  });
}

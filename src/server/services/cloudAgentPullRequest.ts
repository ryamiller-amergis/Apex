import { sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { AzureDevOpsService } from './azureDevOps';

const DESCRIPTION_LIMIT = 4_000;
const TITLE_LIMIT = 400;

export interface CloudAgentPullRequestTextInput {
  workItemId: number;
  workItemTitle?: string | null;
  authorName?: string | null;
  authorEmail?: string | null;
  summary?: string | null;
  sourceBranch: string;
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

function oneLine(value: string | null | undefined): string {
  return (value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

export function buildCloudAgentPullRequestText(
  input: CloudAgentPullRequestTextInput,
): { title: string; description: string } {
  const workItemTitle = oneLine(input.workItemTitle);
  const title = (workItemTitle
    ? `AB#${input.workItemId}: ${workItemTitle}`
    : `AB#${input.workItemId}`
  ).slice(0, TITLE_LIMIT);

  const authorName = oneLine(input.authorName);
  const authorEmail = oneLine(input.authorEmail);
  const summary = (input.summary ?? '').trim();
  const lines = [
    'Automated implementation via Apex cloud development.',
    '',
    `Work item: AB#${input.workItemId}${workItemTitle ? ` — ${workItemTitle}` : ''}`,
    `Branch: ${input.sourceBranch}`,
  ];
  if (authorName) {
    lines.push(`Started by: ${authorName}${authorEmail ? ` (${authorEmail})` : ''}`);
  }
  if (summary) {
    lines.push('', '## Implementation summary', '', summary);
  }

  return {
    title,
    description: lines.join('\n').slice(0, DESCRIPTION_LIMIT),
  };
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
    if (existing) return existing;
    return ado.createPullRequest({
      repo: input.repo,
      project: input.project,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      title,
      description,
      workItemId: input.workItemId,
    });
  });
}

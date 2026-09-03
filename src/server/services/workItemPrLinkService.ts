import type { SkillProvider } from '../../shared/types/projectSettings';
import { AzureDevOpsService } from './azureDevOps';
import { getPullRequest } from './skillCatalogGitHub';
import { trackEvent } from './telemetry';

export type WorkItemReferenceOutcome = {
  mechanism: 'ab-mention' | 'native-link';
  verified: boolean;
};

export interface LinkWorkItemToPullRequestInput {
  provider: SkillProvider;
  project: string;
  repo: string;
  prUrl: string | null;
  workItemId: number;
  runId?: string;
  sessionId?: string;
}

interface WorkItemPrLinkDependencies {
  getGithubPullRequest: typeof getPullRequest;
  createAzureDevOpsService: (project: string) => AzureDevOpsService;
  trackEvent: typeof trackEvent;
}

const defaultDependencies: WorkItemPrLinkDependencies = {
  getGithubPullRequest: getPullRequest,
  createAzureDevOpsService: (project) => new AzureDevOpsService(project),
  trackEvent,
};

export function buildWorkItemReferenceText(workItemId: number): string {
  return `AB#${workItemId}`;
}

/**
 * Throws on a malformed URL — callers that read a stored prUrl must catch.
 */
export function parsePullRequestNumber(prUrl: string, provider: SkillProvider): number {
  const parsed = new URL(prUrl);
  const pattern = provider === 'github'
    ? /\/pull\/(\d+)(?:\/|$)/i
    : /\/pullrequest\/(\d+)(?:\/|$)/i;
  const match = parsed.pathname.match(pattern);
  const value = Number(match?.[1]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid ${provider} pull request URL`);
  }
  return value;
}

export async function verifyGithubReference(
  input: Pick<LinkWorkItemToPullRequestInput, 'repo' | 'prUrl' | 'workItemId' | 'project' | 'runId' | 'sessionId'>,
  dependencies: WorkItemPrLinkDependencies = defaultDependencies,
): Promise<{ present: boolean }> {
  if (!input.prUrl) return { present: false };
  const prNumber = parsePullRequestNumber(input.prUrl, 'github');
  const pr = await dependencies.getGithubPullRequest(input.repo, prNumber);
  const reference = buildWorkItemReferenceText(input.workItemId);
  const present = `${pr.title}\n${pr.body}`.includes(reference);

  if (!present) {
    console.warn('[work-item-pr-link] missing AB# mention', JSON.stringify({
      workItemId: input.workItemId,
      prUrl: input.prUrl,
    }));
    dependencies.trackEvent('cloud_agent_run.work_item_reference_missing', {
      project: input.project,
      provider: 'github',
      workItemId: String(input.workItemId),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    });
  }

  return { present };
}

export async function linkWorkItemToPullRequest(
  input: LinkWorkItemToPullRequestInput,
  dependencies: WorkItemPrLinkDependencies = defaultDependencies,
): Promise<WorkItemReferenceOutcome | null> {
  if (!input.prUrl) return null;

  if (input.provider === 'github') {
    const result = await verifyGithubReference(input, dependencies);
    return { mechanism: 'ab-mention', verified: result.present };
  }

  const prNumber = parsePullRequestNumber(input.prUrl, 'ado');
  const repo = input.repo.split('/').filter(Boolean).pop() ?? input.repo;
  const adoService = dependencies.createAzureDevOpsService(input.project);
  await adoService.linkWorkItemToPullRequest(
    input.project,
    repo,
    prNumber,
    input.workItemId,
  );
  return { mechanism: 'native-link', verified: true };
}

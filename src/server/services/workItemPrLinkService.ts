import type { SkillProvider } from '../../shared/types/projectSettings';
import { AzureDevOpsService } from './azureDevOps';
import { getPullRequest } from './skillCatalogGitHub';
import { trackEvent } from './telemetry';

const IN_PROGRESS = 'In Progress';
const IN_PULL_REQUEST = 'In Pull Request';
/** Children the local start path would already have moved to In Progress. */
const ACTIVE_CHILD_STATES = ['New', 'Approved', 'Committed', IN_PROGRESS];

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

export interface PullRequestWorkItemStateClient {
  queryWorkItemsByWiql: AzureDevOpsService['queryWorkItemsByWiql'];
  getFeatureChildren: (featureId: number) => Promise<Array<{ id: number; state: string }>>;
  setWorkItemState: (workItemId: number, state: string) => Promise<void>;
}

/**
 * Moves the work item that a pull request belongs to.
 * A Feature moves to In Progress. Its children that are still New, Approved,
 * Committed, or In Progress move to In Pull Request. Every other work item
 * moves to In Pull Request itself.
 * Failures are logged and swallowed so they never undo a created pull request.
 */
export async function transitionWorkItemForPullRequest(
  adoService: PullRequestWorkItemStateClient,
  workItemId: number,
): Promise<void> {
  if (!Number.isSafeInteger(workItemId) || workItemId <= 0) return;

  let workItemType = '';
  try {
    const wiResult = await adoService.queryWorkItemsByWiql({
      wiql: `SELECT [System.Id],[System.WorkItemType] FROM WorkItems WHERE [System.Id] = ${workItemId}`,
      fields: ['System.Id', 'System.WorkItemType'],
    });
    workItemType = (wiResult.items[0]?.fields?.['System.WorkItemType'] as string) ?? '';
  } catch (err) {
    console.warn(
      '[work-item-pr] work item type lookup failed; treating it as a leaf work item:',
      err instanceof Error ? err.message : String(err),
    );
  }

  if (workItemType === 'Feature') {
    await setWorkItemState(adoService, workItemId, IN_PROGRESS);
    await moveActiveChildrenToPullRequest(adoService, workItemId);
    return;
  }

  await setWorkItemState(adoService, workItemId, IN_PULL_REQUEST);
}

async function setWorkItemState(
  adoService: PullRequestWorkItemStateClient,
  workItemId: number,
  state: string,
): Promise<void> {
  try {
    await adoService.setWorkItemState(workItemId, state);
  } catch (err) {
    console.warn(
      `[work-item-pr] setWorkItemState(${workItemId} -> ${state}) failed (non-fatal):`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function moveActiveChildrenToPullRequest(
  adoService: PullRequestWorkItemStateClient,
  featureId: number,
): Promise<void> {
  try {
    const children = await adoService.getFeatureChildren(featureId);
    for (const child of children) {
      if (!ACTIVE_CHILD_STATES.includes(child.state)) continue;
      await setWorkItemState(adoService, child.id, IN_PULL_REQUEST);
    }
  } catch (err) {
    console.warn(
      `[work-item-pr] child lookup for feature ${featureId} failed (non-fatal):`,
      err instanceof Error ? err.message : String(err),
    );
  }
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

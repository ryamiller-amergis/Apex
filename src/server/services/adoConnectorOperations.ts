/**
 * Azure DevOps read operations for the Playbook connector.
 *
 * Every call runs for the run's project, with the credentials Apex already holds for Azure
 * DevOps. The credentials never reach a step's config, its output, or an agent prompt.
 * Nothing here knows about a branch naming scheme: the playbook supplies the refs and prefixes.
 */
import { AzureDevOpsService } from './azureDevOps';

const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_API_VERSION = '7.1';
const DEFAULT_PULL_REQUEST_LIMIT = 100;
const MAX_PULL_REQUEST_LIMIT = 500;
const REF_LIMIT = 1000;

export class AdoConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdoConnectorError';
  }
}

interface AdoCredentials {
  organizationUrl: string;
  pat: string;
}

function credentials(): AdoCredentials {
  const organizationUrl = (process.env.ADO_ORG ?? '').trim().replace(/\/+$/, '');
  const pat = (process.env.ADO_PAT ?? '').trim();
  if (!organizationUrl || !pat) {
    throw new AdoConnectorError('Azure DevOps is not configured on this server (ADO_ORG and ADO_PAT).');
  }
  return { organizationUrl, pat };
}

/**
 * The URL for a path inside the run's project. The result must stay under that project, so a
 * path cannot step out to another project, another organization, or another host.
 */
export function buildProjectUrl(organizationUrl: string, project: string, relativePath: string): URL {
  const trimmed = relativePath.trim();
  if (!trimmed) throw new AdoConnectorError('An Azure DevOps path is required.');
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('\\') || trimmed.startsWith('//')) {
    throw new AdoConnectorError('The path must be relative to the project, for example _apis/git/repositories.');
  }
  if (/[\\#]/.test(trimmed) || [...trimmed].some((char) => char.charCodeAt(0) < 0x20)) {
    throw new AdoConnectorError('The path contains a character Azure DevOps paths do not use.');
  }

  const projectRoot = new URL(`${organizationUrl}/${encodeURIComponent(project)}/`);
  const url = new URL(trimmed, projectRoot);
  if (url.origin !== projectRoot.origin || !url.pathname.startsWith(projectRoot.pathname)) {
    throw new AdoConnectorError('The path must stay inside this project.');
  }
  if (!url.searchParams.has('api-version')) url.searchParams.set('api-version', DEFAULT_API_VERSION);
  return url;
}

/** One GET to Azure DevOps. Returns the parsed JSON body. */
export async function adoGet(project: string, relativePath: string): Promise<unknown> {
  const { organizationUrl, pat } = credentials();
  const url = buildProjectUrl(organizationUrl, project, relativePath);
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new AdoConnectorError(
      `Azure DevOps answered ${response.status} for ${url.pathname}: ${text.slice(0, 300).trim()}`,
    );
  }
  // An unusable token returns a sign-in page with status 200 or 203, not an error status.
  if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('json')) {
    throw new AdoConnectorError(
      `Azure DevOps did not return JSON for ${url.pathname}. The server credentials may be invalid.`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AdoConnectorError(`Azure DevOps returned unreadable JSON for ${url.pathname}.`);
  }
}

export interface AdoOperationContext {
  project: string;
  parameters: Record<string, string>;
}

function required(parameters: Record<string, string>, key: string, label: string): string {
  const value = parameters[key]?.trim();
  if (!value) throw new AdoConnectorError(`${label} is required.`);
  return value;
}

function optional(parameters: Record<string, string>, key: string): string {
  return parameters[key]?.trim() ?? '';
}

function positiveInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new AdoConnectorError(`${label} must be a whole number.`);
  }
  return Number(value);
}

function boundedCount(value: string, label: string, fallback: number, max: number): number {
  if (!value) return fallback;
  return Math.min(positiveInteger(value, label), max);
}

function stripRefPrefix(name: unknown): string {
  return typeof name === 'string' ? name.replace(/^refs\/(heads|tags)\//, '') : '';
}

function listOf(body: unknown): Record<string, unknown>[] {
  const value = (body as { value?: unknown } | null)?.value;
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function repositoryPath(parameters: Record<string, string>): string {
  return `_apis/git/repositories/${encodeURIComponent(required(parameters, 'repository', 'Repository'))}`;
}

function personName(person: unknown): string | null {
  const name = (person as { displayName?: unknown } | null)?.displayName;
  return typeof name === 'string' ? name : null;
}

function summarizePullRequest(
  organizationUrl: string,
  project: string,
  repository: string,
  pullRequest: Record<string, unknown>,
): Record<string, unknown> {
  const id = pullRequest.pullRequestId;
  return {
    id,
    title: pullRequest.title,
    status: pullRequest.status,
    isDraft: pullRequest.isDraft ?? false,
    createdBy: personName(pullRequest.createdBy),
    creationDate: pullRequest.creationDate,
    closedDate: pullRequest.closedDate,
    sourceBranch: stripRefPrefix(pullRequest.sourceRefName),
    targetBranch: stripRefPrefix(pullRequest.targetRefName),
    url: `${organizationUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}/pullrequest/${id}`,
  };
}

async function listRefs(
  context: AdoOperationContext,
  kind: 'heads' | 'tags',
): Promise<string> {
  const prefix = optional(context.parameters, 'startsWith');
  const path = `${repositoryPath(context.parameters)}/refs`
    + `?filter=${encodeURIComponent(`${kind}/${prefix}`)}&$top=${REF_LIMIT}`;
  const names = listOf(await adoGet(context.project, path))
    .map((ref) => stripRefPrefix(ref.name))
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  return json(names);
}

type AdoOperation = (context: AdoOperationContext) => Promise<string>;

export const ADO_OPERATIONS: Readonly<Record<string, AdoOperation>> = {
  'list-repositories': async ({ project }) => {
    const repositories = listOf(await adoGet(project, '_apis/git/repositories')).map((repository) => ({
      id: repository.id,
      name: repository.name,
      defaultBranch: stripRefPrefix(repository.defaultBranch),
      webUrl: repository.webUrl,
      isDisabled: repository.isDisabled ?? false,
    }));
    return json(repositories);
  },

  'list-branches': (context) => listRefs(context, 'heads'),

  'list-tags': (context) => listRefs(context, 'tags'),

  'list-pull-requests': async ({ project, parameters }) => {
    const repository = required(parameters, 'repository', 'Repository');
    const status = (optional(parameters, 'status') || 'completed').toLowerCase();
    if (!['active', 'completed', 'abandoned', 'all'].includes(status)) {
      throw new AdoConnectorError('Status must be active, completed, abandoned, or all.');
    }
    const limit = boundedCount(
      optional(parameters, 'top'),
      'Most results',
      DEFAULT_PULL_REQUEST_LIMIT,
      MAX_PULL_REQUEST_LIMIT,
    );
    const query = new URLSearchParams({ 'searchCriteria.status': status, $top: String(limit) });
    const target = optional(parameters, 'targetBranch');
    const source = optional(parameters, 'sourceBranch');
    if (target) query.set('searchCriteria.targetRefName', `refs/heads/${target}`);
    if (source) query.set('searchCriteria.sourceRefName', `refs/heads/${source}`);

    const { organizationUrl } = credentials();
    const body = await adoGet(project, `${repositoryPath(parameters)}/pullrequests?${query.toString()}`);
    return json(listOf(body).map((item) => summarizePullRequest(organizationUrl, project, repository, item)));
  },

  'get-pull-request': async ({ project, parameters }) => {
    const repository = required(parameters, 'repository', 'Repository');
    const id = positiveInteger(required(parameters, 'pullRequestId', 'Pull request'), 'Pull request');
    const base = `${repositoryPath(parameters)}/pullrequests/${id}`;
    const { organizationUrl } = credentials();
    const pullRequest = (await adoGet(project, base)) as Record<string, unknown>;
    // Linked work items are a second call. A pull request is still useful without them.
    let workItemIds: number[] = [];
    try {
      workItemIds = listOf(await adoGet(project, `${base}/workitems`))
        .map((item) => Number(item.id))
        .filter((value) => Number.isInteger(value));
    } catch {
      workItemIds = [];
    }
    const reviewers = Array.isArray(pullRequest.reviewers)
      ? (pullRequest.reviewers as Record<string, unknown>[]).map((reviewer) => ({
        name: personName(reviewer),
        vote: reviewer.vote,
        isRequired: reviewer.isRequired ?? false,
      }))
      : [];
    return json({
      ...summarizePullRequest(organizationUrl, project, repository, pullRequest),
      description: pullRequest.description ?? '',
      reviewers,
      workItemIds,
    });
  },

  'get-work-item': async ({ project, parameters }) => {
    const id = positiveInteger(required(parameters, 'workItemId', 'Work item'), 'Work item');
    const item = (await adoGet(project, `_apis/wit/workitems/${id}?$expand=relations`)) as {
      id?: number;
      fields?: Record<string, unknown>;
      relations?: Array<{ rel?: string; url?: string }>;
    };
    return json({
      id: item.id ?? id,
      fields: item.fields ?? {},
      relations: (item.relations ?? []).map((relation) => ({ rel: relation.rel, url: relation.url })),
    });
  },

  'query-work-items': async ({ project, parameters }) => {
    const wiql = required(parameters, 'wiql', 'WIQL query');
    const fields = optional(parameters, 'fields')
      .split(',')
      .map((field) => field.trim())
      .filter(Boolean);
    const maxResults = boundedCount(optional(parameters, 'maxResults'), 'Most results', 200, 500);
    const result = await new AzureDevOpsService(project).queryWorkItemsByWiql({
      wiql,
      fields: fields.length > 0 ? fields : undefined,
      maxResults,
    });
    return json({
      totalMatched: result.totalMatched,
      returned: result.returned,
      items: result.items.map((item) => ({ id: item.id, fields: item.fields })),
    });
  },

  'rest-get': async ({ project, parameters }) => {
    return json(await adoGet(project, required(parameters, 'path', 'Path')));
  },
};

/**
 * Azure DevOps read operations for the Playbook connector.
 *
 * Every call runs for the run's project, with the credentials Apex already holds for Azure
 * DevOps. The credentials never reach a step's config, its output, or an agent prompt.
 * Nothing here knows about a branch naming scheme: the playbook supplies the refs and prefixes.
 */
import { AzureDevOpsService } from './azureDevOps';
import { markdownToAdoHtml } from './playbookSteps/adoDescriptionHtml';

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

type AdoMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const WRITE_METHODS: readonly AdoMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE'];
const WRITE_CONTENT_TYPES = ['application/json', 'application/json-patch+json'] as const;

interface AdoRequestOptions {
  method: AdoMethod;
  body?: string;
  contentType?: string;
}

/** One request to Azure DevOps. Returns the parsed JSON body, or null when there is none. */
async function adoRequest(
  project: string,
  relativePath: string,
  options: AdoRequestOptions,
): Promise<unknown> {
  const { organizationUrl, pat } = credentials();
  const url = buildProjectUrl(organizationUrl, project, relativePath);
  const response = await fetch(url, {
    method: options.method,
    headers: {
      Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`,
      Accept: 'application/json',
      ...(options.body !== undefined ? { 'Content-Type': options.contentType ?? 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: options.body } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new AdoConnectorError(
      `Azure DevOps answered ${response.status} for ${url.pathname}: ${text.slice(0, 300).trim()}`,
    );
  }
  // A write may return nothing, for example a delete.
  if (response.status === 204 || text.trim() === '') return null;
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

/** One GET to Azure DevOps. Returns the parsed JSON body. */
export function adoGet(project: string, relativePath: string): Promise<unknown> {
  return adoRequest(project, relativePath, { method: 'GET' });
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

/** A field name such as System.State or Custom.Risk. It becomes part of a patch path. */
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

function parseFieldValues(text: string): Array<[string, unknown]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AdoConnectorError('Fields must be a JSON object, for example {"System.State": "Resolved"}.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AdoConnectorError('Fields must be a JSON object, for example {"System.State": "Resolved"}.');
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) throw new AdoConnectorError('Fields has nothing to set.');
  for (const [name] of entries) {
    if (!FIELD_NAME.test(name)) {
      throw new AdoConnectorError(`"${name}" is not a field name. Use the reference name, such as System.State.`);
    }
  }
  return entries;
}

function writeMethod(value: string): AdoMethod {
  const method = value.trim().toUpperCase();
  if (!(WRITE_METHODS as readonly string[]).includes(method)) {
    throw new AdoConnectorError('Method must be POST, PATCH, PUT, or DELETE. Use "Read anything" for a GET.');
  }
  return method as AdoMethod;
}

/**
 * Operations that change Azure DevOps. The catalog marks each `write`, so the guard asks for an
 * approval gate before them and the project must allow them (`playbookConnectorWriteAllowList`).
 */
export const ADO_WRITE_OPERATIONS: Readonly<Record<string, AdoOperation>> = {
  'create-work-item': async ({ project, parameters }) => {
    const type = required(parameters, 'workItemType', 'Work item type');
    const title = required(parameters, 'title', 'Title');
    const description = optional(parameters, 'description');
    const html = description ? markdownToAdoHtml(description) : undefined;
    // Description is the field a PBI, TBI, or Feature shows. A Bug form shows Repro Steps instead.
    const created = await new AzureDevOpsService(project).createWorkItemForPrd({
      type,
      title,
      description: html,
      reproStepsHtml: type.toLowerCase() === 'bug' ? html : undefined,
    });
    return json({ id: created.id, url: created.url });
  },

  'update-work-item': async ({ project, parameters }) => {
    const id = positiveInteger(required(parameters, 'workItemId', 'Work item'), 'Work item');
    const patch = parseFieldValues(required(parameters, 'fields', 'Fields')).map(([name, value]) => ({
      op: 'add',
      path: `/fields/${name}`,
      value,
    }));
    const updated = (await adoRequest(project, `_apis/wit/workitems/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
      contentType: 'application/json-patch+json',
    })) as { id?: number; rev?: number } | null;
    return json({ id: updated?.id ?? id, rev: updated?.rev });
  },

  'post-comment': async ({ project, parameters }) => {
    const id = positiveInteger(required(parameters, 'workItemId', 'Work item'), 'Work item');
    const comment = await new AzureDevOpsService(project).addWorkItemComment(
      id,
      required(parameters, 'text', 'Comment'),
    );
    return json({ commentId: comment.id, workItemId: id });
  },

  'create-pull-request': async ({ project, parameters }) => {
    const workItem = optional(parameters, 'workItemId');
    const draft = optional(parameters, 'draft').toLowerCase();
    if (draft && draft !== 'true' && draft !== 'false') {
      throw new AdoConnectorError('Draft must be true or false.');
    }
    const url = await new AzureDevOpsService(project).createPullRequest({
      repo: required(parameters, 'repository', 'Repository'),
      project,
      sourceBranch: required(parameters, 'sourceBranch', 'Source branch'),
      targetBranch: required(parameters, 'targetBranch', 'Target branch'),
      title: required(parameters, 'title', 'Title'),
      description: optional(parameters, 'description'),
      ...(workItem ? { workItemId: positiveInteger(workItem, 'Linked work item') } : {}),
      isDraft: draft === 'true',
    });
    return json({ url });
  },

  'rest-write': async ({ project, parameters }) => {
    const method = writeMethod(required(parameters, 'method', 'Method'));
    const path = required(parameters, 'path', 'Path');
    const contentType = optional(parameters, 'contentType') || 'application/json';
    if (!(WRITE_CONTENT_TYPES as readonly string[]).includes(contentType)) {
      throw new AdoConnectorError(`Content type must be ${WRITE_CONTENT_TYPES.join(' or ')}.`);
    }
    const body = optional(parameters, 'body');
    if (body) {
      try {
        JSON.parse(body);
      } catch {
        throw new AdoConnectorError('Body must be valid JSON.');
      }
    }
    const response = await adoRequest(project, path, {
      method,
      ...(body ? { body, contentType } : {}),
    });
    return json(response ?? { status: 'ok' });
  },
};

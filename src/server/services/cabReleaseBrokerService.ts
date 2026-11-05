/**
 * CAB-only Azure DevOps forwarder. The interactive container never receives
 * ADO_PAT. It presents its existing runner credential; this service attaches
 * the App Service PAT and refuses every other Azure DevOps call.
 */

const RELEASE_VERSION = String.raw`\d+\.\d+\.\d+(?:\.\d+)?`;
const RELEASE_BRANCH = String.raw`Release/${RELEASE_VERSION}`;
const GIT_REF = String.raw`refs/heads/[A-Za-z0-9._/-]+`;
const WIKI_PATH = String.raw`/Manual Release(?:/${RELEASE_VERSION})?`;
const WIKI_VERSION_PATH = String.raw`/Manual Release/${RELEASE_VERSION}`;

const ALLOWED_PATHS: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: 'GET', path: /^\/MaxView\/_apis\/git\/repositories\/MaxView\/refs$/ },
  { method: 'POST', path: /^\/MaxView\/_apis\/git\/repositories\/MaxView\/refs$/ },
  { method: 'GET', path: /^\/MaxView\/_apis\/build\/definitions$/ },
  { method: 'GET', path: /^\/MaxView\/_apis\/build\/builds$/ },
  { method: 'GET', path: /^\/MaxView\/_apis\/build\/builds\/\d+$/ },
  { method: 'GET', path: /^\/MaxView\/_apis\/build\/builds\/\d+\/workitems$/ },
  { method: 'GET', path: /^\/MaxView\/_apis\/build\/builds\/\d+\/logs$/ },
  { method: 'GET', path: /^\/MaxView\/_apis\/build\/builds\/\d+\/logs\/\d+$/ },
  { method: 'GET', path: /^\/MaxView\/_apis\/wit\/workitems\/\d+$/ },
  { method: 'POST', path: /^\/MaxView\/_apis\/wit\/workitemsbatch$/ },
  { method: 'GET', path: /^\/MaxView\/_apis\/wiki\/wikis\/[^/]+\/pages$/ },
  { method: 'PUT', path: /^\/MaxView\/_apis\/wiki\/wikis\/[^/]+\/pages$/ },
  { method: 'POST', path: /^\/MaxView\/_apis\/pipelines\/(670|595)\/runs$/ },
];

export class CabReleaseBrokerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'CabReleaseBrokerError';
  }
}

export type CabAdoForwardRequest = {
  method?: unknown;
  url?: unknown;
  body?: unknown;
  accept?: unknown;
  ifMatch?: unknown;
};

export type CabAdoForwardResult = {
  status: number;
  body: unknown;
  etag: string;
};

function orgBase(env: NodeJS.ProcessEnv): string {
  const org = env.ADO_ORG?.trim().replace(/\/+$/, '');
  if (!org) {
    throw new CabReleaseBrokerError(
      'ADO_ORG is not configured',
      503,
      'CAB_BROKER_UNAVAILABLE',
    );
  }
  return org;
}

function queryValue(url: URL, name: string): string {
  return url.searchParams.get(name)?.trim() ?? '';
}

function assertPattern(value: string, pattern: RegExp, message: string): void {
  if (!pattern.test(value)) {
    throw new CabReleaseBrokerError(message, 403, 'CAB_BROKER_FORBIDDEN');
  }
}

function assertWikiQuery(url: URL): void {
  assertPattern(
    queryValue(url, 'path'),
    new RegExp(`^${WIKI_PATH}$`),
    'Wiki calls are limited to /Manual Release/{version}',
  );
}

function assertWikiWriteQuery(url: URL): void {
  assertPattern(
    queryValue(url, 'path'),
    new RegExp(`^${WIKI_VERSION_PATH}$`),
    'Wiki writes are limited to /Manual Release/{version}',
  );
}

function assertRefQuery(url: URL): void {
  assertPattern(
    queryValue(url, 'filter'),
    new RegExp(String.raw`^heads/(?:${RELEASE_BRANCH}|development)$`),
    'Ref lookup is limited to Release/{version} and development',
  );
}

const BUILD_RESOURCE = /^\/MaxView\/_apis\/build\/builds\/(\d+)(\/(?:workitems|logs(?:\/\d+)?))?$/;
const PROD_CD_BRANCH = new RegExp(String.raw`^refs/heads/(?:${RELEASE_BRANCH}|development)$`);
const SNOW_DEFINITION_IDS = new Set([670, 595]);

function buildResource(relativePath: string): { id: string; child: boolean } | null {
  const match = relativePath.match(BUILD_RESOURCE);
  if (!match) return null;
  return { id: match[1], child: Boolean(match[2]) };
}

function assertCabBuild(body: unknown): void {
  const record = body as { sourceBranch?: unknown; definition?: { id?: unknown; name?: unknown } } | null;
  const definition = record && typeof record === 'object' ? record.definition : undefined;
  if (SNOW_DEFINITION_IDS.has(Number(definition?.id))) return;
  if (definition?.name !== 'mv-prod-cd') {
    throw new CabReleaseBrokerError(
      'Build reads are limited to mv-prod-cd and snow pipelines 670 and 595',
      403,
      'CAB_BROKER_FORBIDDEN',
    );
  }
  assertPattern(
    String(record?.sourceBranch ?? ''),
    PROD_CD_BRANCH,
    'Build reads are limited to Release/{version} and development',
  );
}

function assertBuildQuery(url: URL, relativePath: string): void {
  if (relativePath.endsWith('/definitions')) {
    if (queryValue(url, 'name') !== 'mv-prod-cd') {
      throw new CabReleaseBrokerError(
        'Build definition lookup is limited to mv-prod-cd',
        403,
        'CAB_BROKER_FORBIDDEN',
      );
    }
    return;
  }
  if (!relativePath.endsWith('/builds')) return;
  assertPattern(
    queryValue(url, 'branchName'),
    new RegExp(String.raw`^refs/heads/(?:${RELEASE_BRANCH}|development)$`),
    'Build lookup is limited to Release/{version} and development',
  );
}

function assertPipelineBody(body: unknown): void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CabReleaseBrokerError(
      'Snow queue body is invalid',
      403,
      'CAB_BROKER_FORBIDDEN',
    );
  }
  const record = body as {
    templateParameters?: { releaseBranch?: unknown };
    resources?: { repositories?: { self?: { refName?: unknown } } };
  };
  assertPattern(
    String(record.templateParameters?.releaseBranch ?? ''),
    new RegExp(`^${RELEASE_BRANCH}$`),
    'Snow releaseBranch must be Release/{version}',
  );
  assertPattern(
    String(record.resources?.repositories?.self?.refName ?? ''),
    new RegExp(`^${GIT_REF}$`),
    'Snow checkout ref must be a branch',
  );
}

function assertCreateRefBody(body: unknown): void {
  if (!Array.isArray(body) || body.length !== 1) {
    throw new CabReleaseBrokerError(
      'Release ref create accepts one ref',
      403,
      'CAB_BROKER_FORBIDDEN',
    );
  }
  const ref = body[0] as { name?: unknown; oldObjectId?: unknown; newObjectId?: unknown };
  assertPattern(
    String(ref.name ?? ''),
    new RegExp(String.raw`^refs/heads/${RELEASE_BRANCH}$`),
    'Only Release/{version} can be created',
  );
  if (String(ref.oldObjectId ?? '') !== '0'.repeat(40)) {
    throw new CabReleaseBrokerError(
      'Release ref create cannot update an existing ref',
      403,
      'CAB_BROKER_FORBIDDEN',
    );
  }
  assertPattern(
    String(ref.newObjectId ?? ''),
    /^[0-9a-f]{40}$/i,
    'Release ref create needs a commit id',
  );
}

function assertWikiBody(body: unknown): void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CabReleaseBrokerError('Wiki body is invalid', 403, 'CAB_BROKER_FORBIDDEN');
  }
  if (typeof (body as { content?: unknown }).content !== 'string') {
    throw new CabReleaseBrokerError(
      'Wiki body must be page content',
      403,
      'CAB_BROKER_FORBIDDEN',
    );
  }
}

export function assertCabAdoRequestAllowed(request: CabAdoForwardRequest, env: NodeJS.ProcessEnv): URL {
  const method = String(request.method ?? '').toUpperCase();
  let url: URL;
  try {
    url = new URL(String(request.url ?? ''));
  } catch {
    throw new CabReleaseBrokerError('Azure DevOps URL is invalid', 403, 'CAB_BROKER_FORBIDDEN');
  }

  const org = orgBase(env);
  if (`${url.origin}` !== new URL(org).origin || !url.href.startsWith(`${org}/`)) {
    throw new CabReleaseBrokerError(
      'Azure DevOps calls must stay in the configured organization',
      403,
      'CAB_BROKER_FORBIDDEN',
    );
  }

  const orgUrl = new URL(org);
  const relativePath = url.pathname.slice(orgUrl.pathname.length) || '/';
  const allowed = ALLOWED_PATHS.some(
    (entry) => entry.method === method && entry.path.test(relativePath),
  );
  if (!allowed) {
    throw new CabReleaseBrokerError(
      'That Azure DevOps call is outside the CAB release broker',
      403,
      'CAB_BROKER_FORBIDDEN',
    );
  }

  if (relativePath.includes('/wiki/')) assertWikiQuery(url);
  if (relativePath.endsWith('/refs') && method === 'GET') assertRefQuery(url);
  if (relativePath.includes('/_apis/build/')) assertBuildQuery(url, relativePath);
  if (method === 'POST' && relativePath.includes('/pipelines/')) assertPipelineBody(request.body);
  if (method === 'POST' && relativePath.endsWith('/refs')) assertCreateRefBody(request.body);
  if (method === 'PUT' && relativePath.includes('/wiki/')) {
    assertWikiWriteQuery(url);
    assertWikiBody(request.body);
  }
  return url;
}

function readResponseBody(text: string, contentType: string): unknown {
  if (!text) return null;
  if (contentType.includes('application/json') || text.trim().startsWith('{') || text.trim().startsWith('[')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

export async function forwardCabAdoRequest(
  request: CabAdoForwardRequest,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<CabAdoForwardResult> {
  const url = assertCabAdoRequestAllowed(request, env);
  const pat = env.ADO_PAT?.trim();
  if (!pat) {
    throw new CabReleaseBrokerError(
      'ADO_PAT is not configured on the Apex server',
      503,
      'CAB_BROKER_UNAVAILABLE',
    );
  }

  const method = String(request.method).toUpperCase();
  const accept = typeof request.accept === 'string' && request.accept.trim()
    ? request.accept.trim()
    : 'application/json';
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`,
    Accept: accept,
  };
  if (typeof request.ifMatch === 'string' && request.ifMatch.trim()) {
    headers['If-Match'] = request.ifMatch.trim();
  }

  const org = orgBase(env);
  const relativePath = url.pathname.slice(new URL(org).pathname.length) || '/';
  const build = method === 'GET' ? buildResource(relativePath) : null;
  if (build) {
    const lookup = new URL(`${org}/MaxView/_apis/build/builds/${build.id}`);
    lookup.searchParams.set('api-version', '7.1');
    const lookedUp = await fetchImpl(lookup.href, {
      method: 'GET',
      headers: {
        Authorization: headers.Authorization,
        Accept: 'application/json',
      },
    });
    const lookedUpText = await lookedUp.text();
    const lookedUpBody = readResponseBody(lookedUpText, lookedUp.headers.get('content-type') ?? '');
    if (!lookedUp.ok) {
      return {
        status: lookedUp.status,
        body: lookedUpBody,
        etag: lookedUp.headers.get('etag') ?? '',
      };
    }
    assertCabBuild(lookedUpBody);
    if (!build.child) {
      return {
        status: lookedUp.status,
        body: lookedUpBody,
        etag: lookedUp.headers.get('etag') ?? '',
      };
    }
  }

  const hasBody = method !== 'GET' && request.body !== undefined && request.body !== null;
  const response = await fetchImpl(url.href, {
    method,
    headers: {
      ...headers,
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    },
    body: hasBody ? JSON.stringify(request.body) : undefined,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: readResponseBody(text, response.headers.get('content-type') ?? ''),
    etag: response.headers.get('etag') ?? '',
  };
}

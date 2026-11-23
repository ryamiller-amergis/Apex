/**
 * Read-only ServiceNow Table API client for incident triage.
 *
 * The only non-GET call is the OAuth password-grant token POST. Errors carry the HTTP status and
 * ServiceNow's own error message, never headers, tokens, the request body or the query string.
 */

const CONFIG_KEYS = [
  'SERVICENOW_INSTANCE_URL',
  'SERVICENOW_CLIENT_ID',
  'SERVICENOW_CLIENT_SECRET',
  'SERVICENOW_USERNAME',
  'SERVICENOW_PASSWORD',
] as const;

const INCIDENT_FIELDS = [
  'sys_id',
  'number',
  'short_description',
  'description',
  'state',
  'priority',
  'impact',
  'urgency',
  'category',
  'subcategory',
  'assignment_group',
  'opened_at',
  'resolved_at',
  'sys_updated_on',
  'close_code',
  'close_notes',
].join(',');

const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGES = 50;
const MAX_ATTEMPTS_ON_RATE_LIMIT = 3;
const MAX_RETRY_AFTER_SECONDS = 60;
const DEFAULT_RETRY_AFTER_SECONDS = 5;
const TOKEN_EXPIRY_MARGIN_SECONDS = 60;
const MAX_ERROR_MESSAGE_LENGTH = 200;
const GROUP_SYS_ID = /^[0-9a-f]{32}$/i;

export interface ServiceNowIncidentRow {
  sysId: string;
  number: string;
  shortDescription: string;
  description: string;
  state: string;
  priority: string;
  impact: string;
  urgency: string;
  category: string;
  subcategory: string;
  assignmentGroupSysId: string;
  assignmentGroupName: string;
  openedAt: string | null;
  resolvedAt: string | null;
  sysUpdatedOn: string;
  closeCode: string;
  closeNotes: string;
}

export interface ListIncidentsArgs {
  groupIds: string[];
  since: Date;
  offset?: number;
  limit?: number;
}

export interface ServiceNowClientDeps {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  nowImpl?: () => number;
}

export class ServiceNowRequestError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'ServiceNowRequestError';
    this.status = status;
  }
}

interface ServiceNowConfig {
  instanceUrl: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
}

interface CachedToken {
  cacheKey: string;
  accessToken: string;
  expiresAtMs: number;
}

let cachedToken: CachedToken | null = null;

export function resetServiceNowTokenCache(): void {
  cachedToken = null;
}

function readEnv(key: (typeof CONFIG_KEYS)[number]): string {
  return (process.env[key] ?? '').trim();
}

export function isServiceNowConfigured(): boolean {
  return CONFIG_KEYS.every((key) => readEnv(key) !== '');
}

function readConfig(): ServiceNowConfig {
  const missing = CONFIG_KEYS.filter((key) => readEnv(key) === '');
  if (missing.length > 0) {
    throw new ServiceNowRequestError(`ServiceNow is not configured. Missing: ${missing.join(', ')}`);
  }
  return {
    instanceUrl: readEnv('SERVICENOW_INSTANCE_URL').replace(/\/+$/, ''),
    clientId: readEnv('SERVICENOW_CLIENT_ID'),
    clientSecret: readEnv('SERVICENOW_CLIENT_SECRET'),
    username: readEnv('SERVICENOW_USERNAME'),
    password: readEnv('SERVICENOW_PASSWORD'),
  };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function safeFetch(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch {
    throw new ServiceNowRequestError('ServiceNow request failed (network error)');
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

async function tableError(response: Response): Promise<ServiceNowRequestError> {
  const body = asRecord(await readJson(response));
  const message = asRecord(body?.error)?.message;
  const detail =
    typeof message === 'string' && message.trim() !== ''
      ? `: ${message.trim().slice(0, MAX_ERROR_MESSAGE_LENGTH)}`
      : '';
  return new ServiceNowRequestError(`ServiceNow request failed (HTTP ${response.status})${detail}`, response.status);
}

async function tokenError(response: Response): Promise<ServiceNowRequestError> {
  const body = asRecord(await readJson(response));
  const code = body?.error;
  const detail = typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? `: ${code}` : '';
  return new ServiceNowRequestError(
    `ServiceNow token request failed (HTTP ${response.status})${detail}`,
    response.status,
  );
}

async function getAccessToken(config: ServiceNowConfig, deps: ServiceNowClientDeps): Promise<string> {
  const now = (deps.nowImpl ?? Date.now)();
  const cacheKey = [config.instanceUrl, config.clientId, config.username].join('|');
  if (cachedToken && cachedToken.cacheKey === cacheKey && now < cachedToken.expiresAtMs) {
    return cachedToken.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    username: config.username,
    password: config.password,
  });
  const response = await safeFetch(deps.fetchImpl ?? fetch, `${config.instanceUrl}/oauth_token.do`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  if (!response.ok) throw await tokenError(response);

  const payload = asRecord(await readJson(response));
  const accessToken = payload?.access_token;
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new ServiceNowRequestError('ServiceNow token response had no access token', response.status);
  }
  const expiresIn = typeof payload?.expires_in === 'number' ? payload.expires_in : 0;
  cachedToken = {
    cacheKey,
    accessToken,
    expiresAtMs: now + Math.max(0, expiresIn - TOKEN_EXPIRY_MARGIN_SECONDS) * 1000,
  };
  return accessToken;
}

function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get('retry-after'));
  const bounded = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_RETRY_AFTER_SECONDS;
  return Math.min(bounded, MAX_RETRY_AFTER_SECONDS) * 1000;
}

async function getTable(url: string, config: ServiceNowConfig, deps: ServiceNowClientDeps): Promise<unknown> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleepImpl = deps.sleepImpl ?? defaultSleep;
  let refreshedToken = false;
  let rateLimited = 0;

  for (;;) {
    const accessToken = await getAccessToken(config, deps);
    const response = await safeFetch(fetchImpl, url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });

    if (response.status === 401 && !refreshedToken) {
      refreshedToken = true;
      resetServiceNowTokenCache();
      continue;
    }
    if (response.status === 429) {
      rateLimited += 1;
      if (rateLimited >= MAX_ATTEMPTS_ON_RATE_LIMIT) throw await tableError(response);
      await sleepImpl(retryAfterMs(response));
      continue;
    }
    if (!response.ok) throw await tableError(response);
    return readJson(response);
  }
}

function formatUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function cell(row: Record<string, unknown>, key: string): { value: string; display: string } {
  const raw = row[key];
  if (typeof raw === 'string') return { value: raw, display: raw };
  const record = asRecord(raw);
  const value = typeof record?.value === 'string' ? record.value : '';
  const display = typeof record?.display_value === 'string' ? record.display_value : value;
  return { value, display };
}

function parseRow(raw: unknown): ServiceNowIncidentRow {
  const row = asRecord(raw) ?? {};
  const group = cell(row, 'assignment_group');
  const openedAt = cell(row, 'opened_at').value;
  const resolvedAt = cell(row, 'resolved_at').value;
  return {
    sysId: cell(row, 'sys_id').value,
    number: cell(row, 'number').value,
    shortDescription: cell(row, 'short_description').display,
    description: cell(row, 'description').display,
    state: cell(row, 'state').display,
    priority: cell(row, 'priority').display,
    impact: cell(row, 'impact').display,
    urgency: cell(row, 'urgency').display,
    category: cell(row, 'category').display,
    subcategory: cell(row, 'subcategory').display,
    assignmentGroupSysId: group.value,
    assignmentGroupName: group.display,
    openedAt: openedAt === '' ? null : openedAt,
    resolvedAt: resolvedAt === '' ? null : resolvedAt,
    sysUpdatedOn: cell(row, 'sys_updated_on').value,
    closeCode: cell(row, 'close_code').display,
    closeNotes: cell(row, 'close_notes').display,
  };
}

export async function listIncidentsUpdatedSince(
  args: ListIncidentsArgs,
  deps: ServiceNowClientDeps = {},
): Promise<ServiceNowIncidentRow[]> {
  if (args.groupIds.length === 0 || !args.groupIds.every((id) => GROUP_SYS_ID.test(id))) {
    throw new ServiceNowRequestError('At least one valid assignment group sys_id is required');
  }
  const config = readConfig();
  const params = new URLSearchParams({
    sysparm_query: `assignment_groupIN${args.groupIds.join(',')}^sys_updated_on>=${formatUtc(args.since)}^ORDERBYsys_updated_on`,
    sysparm_fields: INCIDENT_FIELDS,
    sysparm_display_value: 'all',
    sysparm_exclude_reference_link: 'true',
    sysparm_no_count: 'true',
    sysparm_limit: String(args.limit ?? DEFAULT_PAGE_LIMIT),
    sysparm_offset: String(args.offset ?? 0),
  });

  const payload = asRecord(await getTable(`${config.instanceUrl}/api/now/table/incident?${params}`, config, deps));
  const result = payload?.result;
  return Array.isArray(result) ? result.map(parseRow) : [];
}

export async function* listAllIncidentsUpdatedSince(
  args: Omit<ListIncidentsArgs, 'offset'>,
  deps: ServiceNowClientDeps = {},
): AsyncGenerator<ServiceNowIncidentRow[]> {
  const limit = args.limit ?? DEFAULT_PAGE_LIMIT;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await listIncidentsUpdatedSince({ ...args, limit, offset: page * limit }, deps);
    if (rows.length > 0) yield rows;
    if (rows.length < limit) return;
  }
}

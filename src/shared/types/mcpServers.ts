export const MCP_SERVERS_FLAG = 'mcp-servers';

export const PREBUILT_PROVIDER_IDS = ['clerk', 'pendo', 'sendgrid'] as const;

export type PrebuiltProvider = (typeof PREBUILT_PROVIDER_IDS)[number];

export type McpServerProvider = PrebuiltProvider | 'custom';

export type McpServerConnectionStatus = 'untested' | 'usable';

export interface McpToolInput {
  name: string;
  type: string;
  description?: string;
  required: boolean;
}

export interface McpServerOperation {
  id: string;
  method: 'GET';
  path: string;
  summary: string;
  readOnly: true;
  source?: 'mcp';
  inputSchema?: Record<string, unknown>;
  inputs?: McpToolInput[];
}

export function toolInputsFromSchema(schema: Record<string, unknown> | undefined): McpToolInput[] {
  if (!schema) return [];
  const properties = schema.properties;
  const propertyRecord = properties && typeof properties === 'object' && !Array.isArray(properties)
    ? properties as Record<string, unknown>
    : {};
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === 'string') : [],
  );
  const names = [...new Set([...Object.keys(propertyRecord), ...required])];
  return names.map((name) => {
    const value = propertyRecord[name];
    const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const rawType = Array.isArray(record.type) ? record.type.find((item) => item !== 'null') : record.type;
    const description = typeof record.description === 'string' ? record.description.slice(0, 240) : undefined;
    return {
      name,
      type: typeof rawType === 'string' ? rawType : 'string',
      description,
      required: required.has(name),
    };
  });
}

export function selectEnabledMcpOperations(
  operations: readonly McpServerOperation[],
  toolNames: readonly string[],
): McpServerOperation[] {
  const readable = operations.filter(
    (operation) => operation.source === 'mcp' && operation.readOnly === true && operation.method === 'GET',
  );
  if (toolNames.length === 0) return readable;
  const allowed = new Set(toolNames);
  return readable.filter((operation) => allowed.has(operation.id));
}

export function mcpServerChatInstructions(serverName: string): string[] {
  return [
    '# MCP server',
    `You answer questions using the connected MCP server "${serverName}".`,
    'It is mounted as `mcp-server`. Use only the read-only tools it lists.',
    'This chat has no repository. Do not browse code, Azure DevOps, or any other project tool.',
    'Do not use shell, terminal, file, web, or subagent tools. They are intentionally unavailable.',
    '# Task completion contract',
    'Complete the user’s request; do not merely explain how someone else could complete it.',
    'For any question about data in the connected service, call the relevant MCP tools before answering.',
    'Use the conversation to resolve follow-up wording. Do not ask for a source, server, date, filter, or definition the user already supplied.',
    'Prefer an exact result. If the user explicitly defines an approximation, proxy, filter, or calculation, perform that calculation and label the result with the definition they chose.',
    'If the exact metric is unavailable but the returned records support one clear useful proxy, calculate it and label it precisely instead of returning a tutorial or asking the user to do the work.',
    'Never silently substitute one metric for another. A latest-event timestamp count may be a useful proxy, but label it as records whose latest event falls in the window—not as the number of events.',
    'For a time-window count, if the tool accepts `since_timestamp_ms` (or a timestamp filter), pass `since_timestamp_ms` (and `until_timestamp_ms` when bounded) with the relevant descending `order_by` (such as `-last_sign_in_at`) to get the exact count in one call.',
    'Otherwise, for a time-window count, sort by the relevant timestamp newest-first and use `limit: 1` offset probes or binary search to find the boundary instead of downloading full pages.',
    'Keep `limit` small (such as 1 for offset probes or 10–25 for browsing) unless the user asks for a full list.',
    'Use at most eight MCP calls for one answer. If an exact result still is not available, stop and return the best supported result with one short limitation note.',
    'Lead with the requested result. Add at most one short accuracy note when the distinction materially affects the answer.',
    'Do not return SQL, sample code, implementation steps, or a tutorial unless the user asks for them.',
    'If the available tools truly cannot answer the request, try the relevant tool first, then state the exact missing capability in one short sentence.',
    'When a tool needs an internal ID, slug, or conversation ID, discover it with another available tool and pass it back unchanged.',
    'If several applications or environments exist, use the production one that matches the project name and name it in the answer. Ask only for a person, email, or environment you cannot see in the tools.',
    'Treat "today" as the current calendar day in Eastern time unless the person says otherwise.',
    'Do not treat a directory total as a filtered count. Count the rows that match, or read a count the tool says is already filtered.',
    'Do not write a status such as "Searching", "Checking", or "Trying" before the answer. The chat already shows each tool step.',
    'Do not repeat an identical tool call. Do not invent records. If the tools return nothing relevant, say that in one sentence.',
    'Everyone who can use this project shares one sign-in for this server.',
  ];
}

const MCP_NO_TOOL_TURN_PATTERNS = [
  /^(?:hi|hello|hey|thanks|thank you|ok|okay|got it|goodbye|bye)[.! ]*$/i,
  /\bwhat (?:can|do) you (?:do|support)\b/i,
  /\b(?:list|show|describe|explain) (?:the )?(?:available )?tools\b/i,
  /\bhow (?:does|do) (?:this|the) (?:chat|connection|mcp server) work\b/i,
];

/**
 * Connected-service chats are data chats by default. Only a small set of
 * conversational or capability questions may complete without invoking MCP.
 */
export function mcpServerTurnRequiresToolUse(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return !MCP_NO_TOOL_TURN_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function mcpServerToolRetryPrompt(
  serverName: string,
  currentRequest: string,
): string {
  return [
    `Your draft did not use the connected "${serverName}" MCP server.`,
    'Discard that draft and complete the request now.',
    'Call the relevant MCP tools. Use filters, totals, sorting, and offset probes before pagination; use at most eight calls.',
    'Use definitions and calculations the user already supplied in the conversation.',
    'Return the result first. Do not return code, SQL, or instructions for the user to perform the task.',
    'Only after attempting the relevant tool may you briefly state that the connected server lacks the required data.',
    '',
    '# Current request',
    currentRequest,
  ].join('\n');
}

export function mcpServerNoToolFallback(serverName: string): string {
  return `I couldn’t verify that request with ${serverName} because no connected tool completed. Please try again.`;
}

export function toolArgumentTemplate(inputs: McpToolInput[] | undefined): string {
  const required = (inputs ?? []).filter((input) => input.required);
  if (required.length === 0) return '{}';
  const body: Record<string, unknown> = {};
  for (const input of required) {
    if (input.type === 'integer' || input.type === 'number') body[input.name] = 0;
    else if (input.type === 'boolean') body[input.name] = false;
    else if (input.type === 'array') body[input.name] = [];
    else if (input.type === 'object') body[input.name] = {};
    else body[input.name] = '';
  }
  return JSON.stringify(body, null, 2);
}

export interface DiscoveredMcpTool {
  name: string;
  description: string;
  readOnly: boolean;
  inputSchema?: Record<string, unknown>;
}

export interface McpServerTestRequest {
  method: 'GET';
  path: string;
  query?: Record<string, string>;
}

export interface PrebuiltConnector {
  provider: PrebuiltProvider;
  label: string;
  summary: string;
  credentialLabel: string;
  secretEnv: string;
  clientIdEnv?: string;
  docsUrl: string;
  mcpUrl?: string;
  mcpAuth: 'oauth-client' | 'oauth-user' | 'none';
  baseUrl: string;
  auth: 'bearer' | 'pendo-integration-key';
  operations: readonly McpServerOperation[];
  testRequest: McpServerTestRequest;
}

export const PREBUILT_CONNECTORS: Record<PrebuiltProvider, PrebuiltConnector> = {
  clerk: {
    provider: 'clerk',
    label: 'Clerk',
    summary: 'Look up users in your Clerk application.',
    credentialLabel: 'Secret key',
    secretEnv: 'CLERK_SECRET_KEY',
    docsUrl: 'https://clerk.com/docs/guides/ai/mcp/clerk-mcp-server',
    mcpUrl: 'https://mcp.clerk.com/mcp',
    mcpAuth: 'oauth-user',
    baseUrl: 'https://api.clerk.com',
    auth: 'bearer',
    operations: [
      {
        id: 'getUser',
        method: 'GET',
        path: '/v1/users/{userId}',
        summary: 'Get a user',
        readOnly: true,
      },
      {
        id: 'listUsers',
        method: 'GET',
        path: '/v1/users',
        summary: 'List users',
        readOnly: true,
      },
    ],
    testRequest: { method: 'GET', path: '/v1/users', query: { limit: '1' } },
  },
  pendo: {
    provider: 'pendo',
    label: 'Pendo',
    summary: 'Query visitors, accounts, and product usage in Pendo.',
    credentialLabel: 'Client secret',
    secretEnv: 'PENDO_CLIENT_SECRET',
    clientIdEnv: 'PENDO_CLIENT_ID',
    docsUrl: 'https://support.pendo.io/hc/en-us/articles/50293561169435-Authenticate-to-the-Pendo-MCP-server-with-a-service-account',
    mcpUrl: 'https://app.pendo.io/mcp/v0/shttp',
    mcpAuth: 'oauth-client',
    baseUrl: 'https://app.pendo.io',
    auth: 'pendo-integration-key',
    operations: [
      {
        id: 'getVisitor',
        method: 'GET',
        path: '/api/v1/visitor/{visitorId}',
        summary: 'Get a visitor',
        readOnly: true,
      },
      {
        id: 'getAccount',
        method: 'GET',
        path: '/api/v1/account/{accountId}',
        summary: 'Get an account',
        readOnly: true,
      },
    ],
    testRequest: { method: 'GET', path: '/api/v1/metadata/schema/visitor' },
  },
  sendgrid: {
    provider: 'sendgrid',
    label: 'SendGrid',
    summary: 'Check bounce and block suppressions in SendGrid.',
    credentialLabel: 'API key',
    secretEnv: 'SENDGRID_API_KEY',
    docsUrl: 'https://www.twilio.com/docs/sendgrid/api-reference',
    mcpAuth: 'none',
    baseUrl: 'https://api.sendgrid.com',
    auth: 'bearer',
    operations: [
      {
        id: 'getBounces',
        method: 'GET',
        path: '/v3/suppression/bounces/{email}',
        summary: 'Get bounce suppressions for an email',
        readOnly: true,
      },
      {
        id: 'getBlocks',
        method: 'GET',
        path: '/v3/suppression/blocks/{email}',
        summary: 'Get block suppressions for an email',
        readOnly: true,
      },
    ],
    testRequest: { method: 'GET', path: '/v3/scopes' },
  },
};

export type McpServerAuthMode = 'none' | 'secret' | 'oauth';

export interface McpServerConnectionPublic {
  id: string;
  project: string;
  name: string;
  provider: McpServerProvider;
  status: McpServerConnectionStatus;
  credentialHint: string;
  baseUrl: string | null;
  operations: McpServerOperation[];
  allowedUserIds: string[];
  secretNames: string[];
  missingSecretNames: string[];
  headers: Record<string, string>;
  toolNames: string[];
  authMode: McpServerAuthMode;
  oauthConnected: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastTestedAt: string | null;
}

export interface CreateMcpServerRequest {
  name: string;
  provider: McpServerProvider;
  credential: string;
  clientId?: string;
  toolNames?: string[];
  allowedUserIds: string[];
  baseUrl?: string;
  operations?: McpServerOperation[];
  openApiDocument?: unknown;
  mcpUrl?: string;
  headers?: Record<string, string>;
  secrets?: Array<{ name: string; value: string }>;
  authMode?: McpServerAuthMode;
}

export interface UpdateMcpServerRequest {
  name?: string;
  allowedUserIds?: string[];
  credential?: string;
  secrets?: Array<{ name: string; value: string }>;
  secretNames?: string[];
  mcpUrl?: string;
  headers?: Record<string, string>;
  toolNames?: string[];
  authMode?: McpServerAuthMode;
  baseUrl?: string;
  operations?: McpServerOperation[];
  openApiDocument?: unknown;
}

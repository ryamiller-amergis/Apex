export const INTEGRATIONS_FLAG = 'integrations';

export const PREBUILT_PROVIDER_IDS = ['clerk', 'pendo', 'sendgrid'] as const;

export type PrebuiltProvider = (typeof PREBUILT_PROVIDER_IDS)[number];

export type IntegrationProvider = PrebuiltProvider | 'custom';

export type IntegrationConnectionStatus = 'untested' | 'usable';

export interface IntegrationOperation {
  id: string;
  method: 'GET';
  path: string;
  summary: string;
  readOnly: true;
}

export interface IntegrationTestRequest {
  method: 'GET';
  path: string;
  query?: Record<string, string>;
}

export interface PrebuiltConnector {
  provider: PrebuiltProvider;
  label: string;
  baseUrl: string;
  auth: 'bearer' | 'pendo-integration-key';
  operations: readonly IntegrationOperation[];
  testRequest: IntegrationTestRequest;
}

export const PREBUILT_CONNECTORS: Record<PrebuiltProvider, PrebuiltConnector> = {
  clerk: {
    provider: 'clerk',
    label: 'Clerk',
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

export interface IntegrationConnectionPublic {
  id: string;
  project: string;
  name: string;
  provider: IntegrationProvider;
  status: IntegrationConnectionStatus;
  credentialHint: string;
  baseUrl: string | null;
  operations: IntegrationOperation[];
  allowedUserIds: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastTestedAt: string | null;
}

export interface CreateIntegrationConnectionRequest {
  name: string;
  provider: IntegrationProvider;
  credential: string;
  allowedUserIds: string[];
  baseUrl?: string;
  operations?: IntegrationOperation[];
  openApiDocument?: unknown;
}

export interface UpdateIntegrationConnectionRequest {
  name?: string;
  allowedUserIds?: string[];
  credential?: string;
  baseUrl?: string;
  operations?: IntegrationOperation[];
  openApiDocument?: unknown;
}

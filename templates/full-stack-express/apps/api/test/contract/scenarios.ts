import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { routes, type AnyRoute } from '@project-scope/contracts';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { syntheticProfiles } from '../fixtures/synthetic.ts';
import { TEST_SUBJECT_HEADER } from '../support/testIdentityAdapter.ts';

const documentPath = fileURLToPath(
  new URL(
    '../../../../packages/contracts/openapi/openapi.json',
    import.meta.url
  )
);

export interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: unknown;
}

export interface OpenApiOperation {
  operationId?: string;
  responses?: Record<
    string,
    {
      content?: Record<string, { schema?: unknown }>;
    }
  >;
}

export type Arrange = 'ok' | 'not-ready' | 'throw';

export interface Scenario {
  readonly id: string;
  readonly arrange: Arrange;
  readonly subject?: string;
  readonly body?: unknown;
  readonly query?: string;
}

const [personA] = syntheticProfiles;

export const scenarios = {
  getHealthLive: [{ id: 'live', arrange: 'ok' }],
  getHealthReady: [
    { id: 'ready', arrange: 'ok' },
    { id: 'not-ready', arrange: 'not-ready' },
  ],
  getMe: [
    { id: 'success', arrange: 'ok', subject: personA.subject },
    { id: 'unauthenticated', arrange: 'ok' },
    { id: 'failure', arrange: 'throw', subject: personA.subject },
  ],
  putMe: [
    {
      id: 'success',
      arrange: 'ok',
      subject: personA.subject,
      body: {
        displayName: personA.displayName,
        email: personA.email,
      },
    },
    {
      id: 'validation',
      arrange: 'ok',
      subject: personA.subject,
      body: { displayName: '' },
    },
    {
      id: 'unauthenticated',
      arrange: 'ok',
      body: { displayName: 'test-name' },
    },
  ],
} as const satisfies Record<keyof typeof routes, readonly Scenario[]>;

export function loadOpenApiDocument(): OpenApiDocument {
  return JSON.parse(readFileSync(documentPath, 'utf8')) as OpenApiDocument;
}

export function operationKey(method: string, routePath: string): string {
  return `${method.toUpperCase()} ${routePath}`;
}

export function listOperations(document: OpenApiDocument): {
  method: string;
  path: string;
  operationId: string;
}[] {
  const found = [];
  for (const [routePath, methods] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (method === 'parameters' || method.startsWith('x-')) {
        continue;
      }
      if (!operation.operationId) {
        throw new Error(
          `${operationKey(method, routePath)} has no operationId`
        );
      }
      found.push({
        method,
        path: routePath,
        operationId: operation.operationId,
      });
    }
  }
  return found;
}

export function missingScenarioKeys(
  document: OpenApiDocument,
  defined: Record<string, readonly Scenario[]>
): string[] {
  const missing: string[] = [];
  for (const operation of listOperations(document)) {
    const rows = defined[operation.operationId];
    if (!rows || rows.length === 0) {
      missing.push(
        `${operationKey(operation.method, operation.path)} (${operation.operationId})`
      );
    }
  }
  return missing;
}

function deref(schema: unknown, root: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => deref(item, root));
  }
  if (schema === null || typeof schema !== 'object') {
    return schema;
  }
  const record = schema as Record<string, unknown>;
  if (typeof record.$ref === 'string') {
    const parts = record.$ref.replace(/^#\//, '').split('/');
    let node: unknown = root;
    for (const part of parts) {
      if (node === null || typeof node !== 'object') {
        throw new Error(`Unresolved $ref ${record.$ref}`);
      }
      node = (node as Record<string, unknown>)[decodeURIComponent(part)];
    }
    return deref(node, root);
  }
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    next[key] = deref(value, root);
  }
  return next;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addFormat('email', true);

const compiled = new Map<string, ValidateFunction>();

export function responseSchema(
  document: OpenApiDocument,
  method: string,
  routePath: string,
  status: number
): { mediaType: string; validate: ValidateFunction } | null {
  const operation = document.paths[routePath]?.[method.toLowerCase()];
  const response = operation?.responses?.[String(status)];
  if (!response?.content) {
    return null;
  }
  const mediaType = Object.keys(response.content)[0];
  if (!mediaType) {
    return null;
  }
  const cacheKey = `${method} ${routePath} ${status} ${mediaType}`;
  const cached = compiled.get(cacheKey);
  if (cached) {
    return { mediaType, validate: cached };
  }
  const schema = deref(response.content[mediaType]?.schema, document);
  if (schema === null || typeof schema !== 'object') {
    return null;
  }
  const validate = ajv.compile(schema);
  compiled.set(cacheKey, validate);
  return { mediaType, validate };
}

export function schemaErrors(validate: ValidateFunction): string {
  const errors = (validate.errors ?? []) as ErrorObject[];
  return errors
    .map((error) =>
      `${error.instancePath || '/'} ${error.message ?? ''}`.trim()
    )
    .join('; ');
}

export function routeFor(operationId: keyof typeof routes): AnyRoute {
  return routes[operationId];
}

export function subjectHeader(
  subject: string | undefined
): Record<string, string> {
  return subject ? { [TEST_SUBJECT_HEADER]: subject } : {};
}

export const openApiDocumentPath = path.resolve(documentPath);

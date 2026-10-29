import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineRoute,
  routeKey,
  routeList,
  type AnyRoute,
} from '../src/index.ts';
import {
  buildOpenApiDocument,
  defaultOpenApiInfo,
  type OpenApiDocument,
} from '../src/openapi/build-document.ts';

const getThing = defineRoute({
  id: 'getThing',
  method: 'get',
  path: '/api/v1/things',
  auth: 'principal',
  summary: 'List things',
  request: { query: z.strictObject({ color: z.enum(['red', 'blue']) }) },
  responses: {
    200: {
      description: 'Things',
      body: z.strictObject({ names: z.array(z.string()) }),
    },
  },
});

type Operation = {
  operationId: string;
  security?: unknown[];
  parameters?: Array<Record<string, unknown>>;
  requestBody?: { content: Record<string, { schema: unknown }> };
  responses: Record<
    string,
    {
      headers: Record<string, unknown>;
      content?: Record<string, { schema: unknown }>;
    }
  >;
};

function operation(doc: OpenApiDocument, path: string, method: string) {
  const op = (doc.paths[path] as Record<string, Operation> | undefined)?.[
    method
  ];
  if (!op) throw new Error(`missing ${method} ${path}`);
  return op;
}

function documentedKeys(doc: OpenApiDocument): string[] {
  return Object.entries(doc.paths)
    .flatMap(([path, methods]) =>
      Object.keys(methods).map((method) =>
        routeKey({ method, path: path.replace(/\{(\w+)\}/g, ':$1') })
      )
    )
    .sort();
}

describe('buildOpenApiDocument (VT-01, PBI-006 AC-0)', () => {
  const doc = buildOpenApiDocument([getThing]);
  const op = operation(doc, '/api/v1/things', 'get');

  it('PBI-006 AC-0 writes an OpenAPI 3.1 document with the fixed info', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info).toEqual(defaultOpenApiInfo);
    expect(doc.info.description).toContain('Do not edit by hand');
  });

  it('PBI-006 AC-0 includes the request query parameter', () => {
    expect(op.operationId).toBe('getThing');
    expect(op.parameters).toEqual([
      {
        name: 'color',
        in: 'query',
        required: true,
        schema: { type: 'string', enum: ['red', 'blue'] },
      },
    ]);
  });

  it('PBI-006 AC-0 includes the success schema and every standard error', () => {
    expect(Object.keys(op.responses)).toEqual([
      '200',
      '400',
      '401',
      '429',
      '500',
    ]);
    expect(op.responses['200']!.content!['application/json']!.schema).toEqual({
      type: 'object',
      properties: { names: { type: 'array', items: { type: 'string' } } },
      required: ['names'],
      additionalProperties: false,
    });
    for (const status of ['400', '401', '429', '500']) {
      expect(op.responses[status]!.content).toEqual({
        'application/problem+json': {
          schema: { $ref: '#/components/schemas/ProblemDetails' },
        },
      });
    }
    expect(op.security).toEqual([{ principal: [] }]);
  });

  it('PBI-006 AC-0 puts the request ID header on every response', () => {
    for (const response of Object.values(op.responses)) {
      expect(response.headers).toEqual({
        'X-Request-Id': { $ref: '#/components/headers/X-Request-Id' },
      });
    }
    expect(doc.components.headers['X-Request-Id']).toMatchObject({
      required: true,
      schema: { type: 'string', minLength: 1, maxLength: 128 },
    });
  });

  it('PBI-006 AC-0 lifts named schemas into components', () => {
    expect(Object.keys(doc.components.schemas)).toEqual(['ProblemDetails']);
    expect(JSON.stringify(doc)).not.toContain('$defs');
    expect(JSON.stringify(doc)).not.toContain('"$schema"');
  });

  it('converts path parameters and request bodies', () => {
    const putThing = defineRoute({
      id: 'putThing',
      method: 'put',
      path: '/api/v1/things/:thingId',
      auth: 'none',
      summary: 'Replace a thing',
      request: {
        params: z.strictObject({ thingId: z.string() }),
        body: z.strictObject({ name: z.string().min(1) }),
      },
      responses: { 204: { description: 'Replaced' } },
    });
    const put = operation(
      buildOpenApiDocument([putThing]),
      '/api/v1/things/{thingId}',
      'put'
    );
    expect(put.parameters).toEqual([
      {
        name: 'thingId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
    ]);
    expect(put.requestBody).toMatchObject({
      required: true,
      content: { 'application/json': { schema: { required: ['name'] } } },
    });
    expect(put.security).toBeUndefined();
    expect(put.responses['204']!.content).toBeUndefined();
  });

  it('rejects two routes with the same method and path', () => {
    expect(() => buildOpenApiDocument([getThing, getThing])).toThrow(
      /GET \/api\/v1\/things/
    );
  });
});

describe('determinism (VT-02, TBI-010 DoD-2)', () => {
  it('TBI-010 DoD-2 gives identical bytes across runs and registry order', () => {
    const reversed = [...routeList].reverse();
    const outputs = [routeList, routeList, reversed, reversed].map((list) =>
      JSON.stringify(buildOpenApiDocument(list))
    );
    expect(new Set(outputs).size).toBe(1);
  });

  it('TBI-010 DoD-2 sorts paths and component schemas and writes no timestamp', () => {
    const doc = buildOpenApiDocument(routeList);
    const paths = Object.keys(doc.paths);
    expect(paths).toEqual([...paths].sort());
    const schemas = Object.keys(doc.components.schemas);
    expect(schemas).toEqual([...schemas].sort());
    expect(JSON.stringify(doc)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe('registry equals document (VT-16)', () => {
  it('TBI-010 lists exactly the routes in routeList', () => {
    const doc = buildOpenApiDocument(routeList);
    expect(documentedKeys(doc)).toEqual(routeList.map(routeKey).sort());
  });

  it('TBI-010 a route absent from the list never appears', () => {
    const withoutPut = routeList.filter(
      (route: AnyRoute) => route.id !== 'putMe'
    );
    const doc = buildOpenApiDocument(withoutPut);
    expect(documentedKeys(doc)).not.toContain('PUT /api/v1/me');
    expect(JSON.stringify(doc)).not.toContain('putMe');
  });
});

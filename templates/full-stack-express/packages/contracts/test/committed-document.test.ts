import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, resolveConfig } from 'prettier';
import { describe, expect, it } from 'vitest';
import { routeKey, routeList } from '../src/index.ts';

const documentPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../openapi/openapi.json'
);
const text = readFileSync(documentPath, 'utf8');
const document = JSON.parse(text) as {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
};

type Schema = { [key: string]: unknown };
type Operation = {
  security?: unknown[];
  parameters?: unknown[];
  requestBody?: { content: Record<string, { schema: Schema }> };
  responses: Record<
    string,
    {
      headers?: Record<string, unknown>;
      content?: Record<string, { schema: Schema }>;
    }
  >;
};

const operations = Object.entries(document.paths).flatMap(([p, methods]) =>
  Object.entries(methods).map(([method, op]) => ({ key: `${method} ${p}`, op }))
);

function collectExamples(value: unknown, found: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    value.forEach((item) => collectExamples(item, found));
  } else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (key === 'example') found.push(inner);
      else if (key === 'examples')
        found.push(...Object.values(inner as object));
      else collectExamples(inner, found);
    }
  }
  return found;
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object')
    return Object.values(value).flatMap(strings);
  return [];
}

function stripExamples(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripExamples);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'example' && key !== 'examples')
        .map(([key, inner]) => [key, stripExamples(inner)])
    );
  }
  return value;
}

function resolve(schema: Schema): Schema {
  const ref = schema.$ref;
  return typeof ref === 'string'
    ? document.components.schemas[ref.split('/').pop()!]!
    : schema;
}

describe('committed document content (VT-08, PBI-007 AC-0, TBI-011 DoD-1)', () => {
  it('PBI-007 AC-0 every response carries the X-Request-Id header', () => {
    for (const { key, op } of operations) {
      for (const [status, response] of Object.entries(op.responses)) {
        expect(response.headers?.['X-Request-Id'], `${key} ${status}`).toEqual({
          $ref: '#/components/headers/X-Request-Id',
        });
      }
    }
  });

  it('TBI-011 DoD-1 every operation declares its Problem Details errors', () => {
    const problem = {
      'application/problem+json': {
        schema: { $ref: '#/components/schemas/ProblemDetails' },
      },
    };
    for (const { key, op } of operations) {
      const required = ['500'];
      if (op.security && op.security.length > 0) required.push('401', '429');
      if (op.parameters || op.requestBody) required.push('400');
      for (const status of required) {
        expect(op.responses[status]?.content, `${key} ${status}`).toEqual(
          problem
        );
      }
      const success = Object.keys(op.responses).filter((s) => s < '300');
      expect(success.length, key).toBeGreaterThan(0);
    }
  });

  it('PBI-007 AC-0 lists exactly the defined routes (VT-16)', () => {
    const documented = operations
      .map(({ key }) => {
        const [method, p] = key.split(' ');
        return routeKey({ method: method!, path: p! });
      })
      .sort();
    expect(documented).toEqual(routeList.map(routeKey).sort());
  });
});

describe('synthetic examples only (VT-14, PBI-007 AC-3)', () => {
  const values = collectExamples(document).flatMap(strings);

  it('PBI-007 AC-3 the document has examples to inspect', () => {
    expect(values.length).toBeGreaterThan(0);
  });

  it('PBI-007 AC-3 every email in an example uses a reserved example domain', () => {
    const emails = values.filter((value) => value.includes('@'));
    expect(emails.length).toBeGreaterThan(0);
    for (const email of emails) {
      expect(email).toMatch(/@example\.(test|com)$/);
    }
    for (const value of strings(document)) {
      for (const match of value.matchAll(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g)) {
        expect(match[0]).toMatch(/@example\.(test|com)$/);
      }
    }
  });

  it('PBI-007 AC-3 names come from the synthetic allowlist and no value looks like a subject', () => {
    const names = ['Ada Example'];
    const enumLike = /^(ok|ready|active|disabled)$/;
    for (const value of values) {
      if (value.includes('@')) continue;
      expect(names.includes(value) || enumLike.test(value), value).toBe(true);
    }
    const subjectLike =
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\||^[0-9a-f]{24,}$/i;
    for (const value of values) {
      expect(value).not.toMatch(subjectLike);
    }
  });
});

describe('schemas describe inputs without examples (VT-15, PBI-007 AC-2)', () => {
  const putMe = stripExamples(document.paths['/api/v1/me']!.put) as Operation;
  const body = resolve(
    putMe.requestBody!.content['application/json']!.schema
  ) as {
    required: string[];
    additionalProperties: boolean;
    properties: Record<string, Schema>;
  };
  const response = resolve(
    putMe.responses['200']!.content!['application/json']!.schema
  ) as { properties: Record<string, Schema>; additionalProperties: boolean };

  it('PBI-007 AC-2 the request body states required fields and rejects extra ones', () => {
    expect(body.required).toEqual(['displayName']);
    expect(body.additionalProperties).toBe(false);
  });

  it('PBI-007 AC-2 the request body states length and format limits', () => {
    expect(body.properties.displayName).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: 100,
    });
    expect(JSON.stringify(body.properties.email)).toContain('"maxLength":254');
    expect(JSON.stringify(body.properties.email)).toContain('"format":"email"');
    expect(JSON.stringify(body.properties.email)).toContain('"type":"null"');
  });

  it('PBI-007 AC-2 the response lists the status enum and rejects extra fields', () => {
    expect(response.properties.status).toEqual({
      type: 'string',
      enum: ['active', 'disabled'],
    });
    expect(response.additionalProperties).toBe(false);
  });
});

describe('formatting (VT-17)', () => {
  it('TBI-010 the committed document passes Prettier with the generator options and the resolved config', async () => {
    expect(
      await check(text, { parser: 'json', printWidth: 80, tabWidth: 2 })
    ).toBe(true);
    const resolved = (await resolveConfig(documentPath)) ?? {};
    expect(await check(text, { ...resolved, filepath: documentPath })).toBe(
      true
    );
  });
});

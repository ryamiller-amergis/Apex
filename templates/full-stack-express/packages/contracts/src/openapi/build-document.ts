import { z } from 'zod';
import { problemContentType } from '../conventions/problem-details.ts';
import {
  requestIdHeader,
  requestIdSchema,
} from '../conventions/request-id.ts';
import { toOpenApiPath } from '../conventions/versioning.ts';
import { httpMethods, type AnyRoute } from '../define-route.ts';
import { routeKey } from '../registry.ts';
import { contractSchemas } from '../schema-registry.ts';

export type JsonObject = { [key: string]: unknown };

export interface OpenApiInfo {
  readonly title: string;
  readonly version: string;
  readonly description: string;
}

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: OpenApiInfo;
  paths: Record<string, Record<string, JsonObject>>;
  components: {
    headers: Record<string, JsonObject>;
    schemas: Record<string, JsonObject>;
    securitySchemes: Record<string, JsonObject>;
  };
}

// A constant rather than package.json's version, so a version bump alone
// never makes the committed document stale.
export const defaultOpenApiInfo: OpenApiInfo = {
  title: 'project-name API',
  version: '0.1.0',
  description: 'Generated from the Zod route definitions. Do not edit by hand.',
};

export const principalSecurityScheme = 'principal';

const jsonContentType = 'application/json';
const headerRef = `#/components/headers/${requestIdHeader}`;
const componentPrefix = '#/components/schemas/';

type Io = 'input' | 'output';

function sortedRecord<T>(entries: Iterable<[string, T]>): Record<string, T> {
  return Object.fromEntries(
    [...entries].sort(([left], [right]) => (left < right ? -1 : 1))
  );
}

function rewriteRefs(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(rewriteRefs);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        key === '$ref' && typeof inner === 'string'
          ? inner.replace(/^#\/\$defs\//, componentPrefix)
          : rewriteRefs(inner),
      ])
    );
  }
  return value;
}

class SchemaConverter {
  readonly components = new Map<string, JsonObject>();

  convert(schema: z.core.$ZodType, io: Io): JsonObject {
    const converted = z.toJSONSchema(schema, {
      target: 'draft-2020-12',
      io,
      metadata: contractSchemas,
      unrepresentable: 'throw',
    }) as JsonObject;
    const { $schema: _dialect, $defs, ...rest } = converted;
    for (const [id, definition] of Object.entries(
      ($defs as Record<string, unknown> | undefined) ?? {}
    )) {
      this.addComponent(id, rewriteRefs(definition) as JsonObject);
    }
    return rewriteRefs(rest) as JsonObject;
  }

  convertObject(schema: z.ZodObject, io: Io): JsonObject {
    const converted = this.convert(schema, io);
    const ref = converted.$ref;
    return typeof ref === 'string'
      ? this.components.get(ref.slice(componentPrefix.length))!
      : converted;
  }

  private addComponent(id: string, definition: JsonObject) {
    const existing = this.components.get(id);
    if (
      existing !== undefined &&
      JSON.stringify(existing) !== JSON.stringify(definition)
    ) {
      throw new Error(
        `buildOpenApiDocument: schema ${id} converts differently as request and response; give each shape its own id`
      );
    }
    this.components.set(id, definition);
  }
}

function parameters(
  route: AnyRoute,
  converter: SchemaConverter
): JsonObject[] {
  const parts = [
    ['path', route.request.params],
    ['query', route.request.query],
    ['header', route.request.headers],
  ] as const;
  return parts.flatMap(([location, schema]) => {
    if (!schema) {
      return [];
    }
    const object = converter.convertObject(schema, 'input');
    const properties = (object.properties ?? {}) as Record<string, JsonObject>;
    const required = new Set((object.required ?? []) as string[]);
    return Object.entries(properties).map(([name, property]) => ({
      name,
      in: location,
      required: location === 'path' || required.has(name),
      schema: property,
    }));
  });
}

function content(
  contentType: string,
  schema: JsonObject,
  example: unknown
): JsonObject {
  return {
    [contentType]: example === undefined ? { schema } : { schema, example },
  };
}

function operation(route: AnyRoute, converter: SchemaConverter): JsonObject {
  const op: JsonObject = {
    operationId: route.id,
    summary: route.summary,
  };
  if (route.description !== undefined) {
    op.description = route.description;
  }
  if (route.auth === 'principal') {
    op.security = [{ [principalSecurityScheme]: [] }];
  }
  const params = parameters(route, converter);
  if (params.length > 0) {
    op.parameters = params;
  }
  if (route.request.body) {
    op.requestBody = {
      required: true,
      content: content(
        jsonContentType,
        converter.convert(route.request.body, 'input'),
        route.request.bodyExample
      ),
    };
  }
  const responses: Record<string, JsonObject> = {};
  for (const [status, response] of Object.entries(route.responses)) {
    const entry: JsonObject = {
      description: response.description,
      headers: { [requestIdHeader]: { $ref: headerRef } },
    };
    if (response.body) {
      entry.content = content(
        Number(status) >= 400 ? problemContentType : jsonContentType,
        converter.convert(response.body, 'output'),
        response.example
      );
    }
    responses[status] = entry;
  }
  op.responses = responses;
  return op;
}

export function buildOpenApiDocument(
  routes: readonly AnyRoute[],
  info: OpenApiInfo = defaultOpenApiInfo
): OpenApiDocument {
  const converter = new SchemaConverter();
  const seenKeys = new Set<string>();
  const seenIds = new Set<string>();
  const byPath = new Map<string, Map<string, JsonObject>>();

  for (const route of routes) {
    const key = routeKey(route);
    if (seenKeys.has(key) || seenIds.has(route.id)) {
      throw new Error(
        `buildOpenApiDocument: ${key} (${route.id}) is defined more than once`
      );
    }
    seenKeys.add(key);
    seenIds.add(route.id);
    const path = toOpenApiPath(route.path);
    const methods = byPath.get(path) ?? new Map<string, JsonObject>();
    methods.set(route.method, operation(route, converter));
    byPath.set(path, methods);
  }

  const paths = sortedRecord(
    [...byPath].map(([path, methods]) => [
      path,
      Object.fromEntries(
        httpMethods
          .filter((method) => methods.has(method))
          .map((method) => [method, methods.get(method)!])
      ),
    ])
  );

  const requestIdHeaderObject = {
    description: 'Correlates the response with server log lines.',
    required: true,
    schema: converter.convert(requestIdSchema, 'output'),
  };

  return {
    openapi: '3.1.0',
    info: { ...info },
    paths,
    components: {
      headers: { [requestIdHeader]: requestIdHeaderObject },
      schemas: sortedRecord(converter.components),
      securitySchemes: {
        [principalSecurityScheme]: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Placeholder. The identity-provider adapter decides how the principal is sent.',
        },
      },
    },
  };
}

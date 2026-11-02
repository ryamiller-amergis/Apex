import { z } from 'zod';
import { problemDetailsSchema } from './conventions/problem-details.ts';
import {
  isVersionedPath,
  pathParameterNames,
} from './conventions/versioning.ts';

export const httpMethods = ['get', 'put', 'post', 'patch', 'delete'] as const;
export type HttpMethod = (typeof httpMethods)[number];
export type RouteAuth = 'principal' | 'none';

// A request never names the caller. The subject comes from the authenticated
// principal, so a project that adds user administration edits this list on
// purpose.
export const forbiddenIdentifierFields = [
  'userId',
  'subject',
  'sub',
  'externalSubject',
  'externalId',
] as const;

export interface RouteRequest {
  readonly params?: z.ZodObject;
  readonly query?: z.ZodObject;
  readonly headers?: z.ZodObject;
  readonly body?: z.ZodType;
  readonly bodyExample?: unknown;
}

export interface RouteResponse {
  readonly description: string;
  readonly body?: z.ZodType;
  readonly example?: unknown;
}

export type RouteResponses = { readonly [status: number]: RouteResponse };

export interface ProblemResponse {
  readonly description: string;
  readonly body: typeof problemDetailsSchema;
}

type NoEntries = Record<never, never>;
type Simplify<T> = { [K in keyof T]: T[K] };
type InputPart = 'params' | 'query' | 'headers' | 'body';
type HasInput<Req> = [keyof Req & InputPart] extends [never] ? false : true;

export type StandardResponses<A extends RouteAuth, Req> = {
  readonly 500: ProblemResponse;
} & (A extends 'principal'
  ? { readonly 401: ProblemResponse; readonly 429: ProblemResponse }
  : NoEntries) &
  (HasInput<Req> extends true ? { readonly 400: ProblemResponse } : NoEntries);

export interface RouteDefinition<
  Id extends string = string,
  M extends HttpMethod = HttpMethod,
  P extends string = string,
  A extends RouteAuth = RouteAuth,
  Req extends RouteRequest = RouteRequest,
  Res extends RouteResponses = RouteResponses,
> {
  readonly id: Id;
  readonly method: M;
  readonly path: P;
  readonly auth: A;
  readonly summary: string;
  readonly description?: string;
  readonly request: Req;
  readonly responses: Res;
}

export type AnyRoute = RouteDefinition;

export interface RouteInput<
  Id extends string,
  M extends HttpMethod,
  P extends string,
  A extends RouteAuth,
  Req extends RouteRequest,
  Res extends RouteResponses,
> {
  id: Id;
  method: M;
  path: P;
  auth: A;
  summary: string;
  description?: string;
  request?: Req;
  responses: Res;
}

export type InferParams<R extends AnyRoute> = R['request'] extends {
  readonly params: infer S extends z.ZodType;
}
  ? z.output<S>
  : never;

export type InferQuery<R extends AnyRoute> = R['request'] extends {
  readonly query: infer S extends z.ZodType;
}
  ? z.output<S>
  : never;

export type InferHeaders<R extends AnyRoute> = R['request'] extends {
  readonly headers: infer S extends z.ZodType;
}
  ? z.output<S>
  : never;

export type InferBody<R extends AnyRoute> = R['request'] extends {
  readonly body: infer S extends z.ZodType;
}
  ? z.output<S>
  : never;

export type InferResponse<
  R extends AnyRoute,
  Status extends keyof R['responses'],
> = R['responses'][Status] extends { readonly body: infer B extends z.ZodType }
  ? z.output<B>
  : undefined;

const standardDescriptions = {
  400: 'The request failed validation or the body was malformed',
  401: 'Authentication is required',
  429: 'Too many requests',
  500: 'Unexpected server error',
} as const;

function fieldNames(schema: z.core.$ZodType): string[] {
  if (schema instanceof z.ZodObject) {
    return Object.entries(schema.shape).flatMap(([name, value]) => [
      name,
      ...fieldNames(value as z.core.$ZodType),
    ]);
  }
  if (schema instanceof z.ZodArray) {
    return fieldNames(schema.element as z.core.$ZodType);
  }
  const inner = (schema._zod.def as { innerType?: z.core.$ZodType }).innerType;
  return inner ? fieldNames(inner) : [];
}

export function defineRoute<
  const Id extends string,
  const M extends HttpMethod,
  const P extends string,
  const A extends RouteAuth,
  const Res extends RouteResponses,
  const Req extends RouteRequest = NoEntries,
>(
  input: RouteInput<Id, M, P, A, Req, Res>
): RouteDefinition<
  Id,
  M,
  P,
  A,
  Req,
  Simplify<Res & StandardResponses<A, Req>>
> {
  const fail = (rule: string, message: string): never => {
    throw new Error(`defineRoute ${input.id}: ${message} (${rule})`);
  };
  const request: RouteRequest = input.request ?? {};

  if (!/^[a-z][A-Za-z0-9]*$/.test(input.id)) {
    fail('operation id', 'id must be camelCase letters and digits');
  }
  if (!httpMethods.includes(input.method)) {
    fail('method', `method "${input.method}" is not supported`);
  }
  if (!isVersionedPath(input.path)) {
    fail(
      'versioning convention',
      `path "${input.path}" must start with /api/v<n>/ or /health/`
    );
  }

  for (const part of ['params', 'query', 'headers'] as const) {
    const schema = request[part];
    if (schema !== undefined && !(schema instanceof z.ZodObject)) {
      fail('request parts', `request ${part} must be a Zod object schema`);
    }
  }

  const declaredParams = Object.keys(request.params?.shape ?? {}).sort();
  const pathParams = pathParameterNames(input.path).sort();
  if (declaredParams.join() !== pathParams.join()) {
    fail(
      'path parameters',
      `params keys [${declaredParams.join(', ')}] must equal the path parameters [${pathParams.join(', ')}]`
    );
  }

  for (const part of ['params', 'query', 'body'] as const) {
    const schema = request[part];
    const named = schema
      ? fieldNames(schema).find((name) =>
          (forbiddenIdentifierFields as readonly string[]).includes(name)
        )
      : undefined;
    if (named) {
      fail(
        'identifier guard',
        `request ${part} field "${named}" names a user identifier; take the subject from the authenticated principal`
      );
    }
  }

  if (request.bodyExample !== undefined) {
    if (!request.body?.safeParse(request.bodyExample).success) {
      fail('example', 'bodyExample must parse with the request body schema');
    }
  }

  const statuses = Object.keys(input.responses).map(Number);
  for (const status of statuses) {
    const response = input.responses[status]!;
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      fail('responses', `status ${status} is not an HTTP status code`);
    }
    if (status >= 400 && response.body !== problemDetailsSchema) {
      fail(
        'Problem Details convention',
        `error response ${status} must use problemDetailsSchema`
      );
    }
    if (
      response.example !== undefined &&
      !response.body?.safeParse(response.example).success
    ) {
      fail('example', `response ${status} example must parse with its body`);
    }
  }
  if (!statuses.some((status) => status >= 200 && status < 300)) {
    fail('responses', 'a route must declare at least one 2xx response');
  }

  const hasInput =
    request.params !== undefined ||
    request.query !== undefined ||
    request.headers !== undefined ||
    request.body !== undefined;
  const standard: Record<number, RouteResponse> = {
    500: { description: standardDescriptions[500], body: problemDetailsSchema },
  };
  if (input.auth === 'principal') {
    standard[401] = {
      description: standardDescriptions[401],
      body: problemDetailsSchema,
    };
    standard[429] = {
      description: standardDescriptions[429],
      body: problemDetailsSchema,
    };
  }
  if (hasInput) {
    standard[400] = {
      description: standardDescriptions[400],
      body: problemDetailsSchema,
    };
  }

  const responses: Record<number, RouteResponse> = {};
  for (const [status, response] of Object.entries({
    ...standard,
    ...input.responses,
  })) {
    responses[Number(status)] = Object.freeze({ ...response });
  }

  const definition = {
    id: input.id,
    method: input.method,
    path: input.path,
    auth: input.auth,
    summary: input.summary,
    ...(input.description === undefined
      ? {}
      : { description: input.description }),
    request: Object.freeze({ ...request }),
    responses: Object.freeze(responses),
  };
  return Object.freeze(definition) as unknown as RouteDefinition<
    Id,
    M,
    P,
    A,
    Req,
    Simplify<Res & StandardResponses<A, Req>>
  >;
}

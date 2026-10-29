import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  defineRoute,
  getMe,
  paginationQuerySchema,
  putMe,
  routes,
  type InferBody,
  type InferParams,
  type InferQuery,
  type InferResponse,
  type ProblemDetails,
  type profileSchema,
  type updateProfileBodySchema,
} from '../src/index.ts';

const getThing = defineRoute({
  id: 'getThing',
  method: 'get',
  path: '/api/v1/things/:thingId',
  auth: 'none',
  summary: 'Fixture',
  request: {
    params: z.strictObject({ thingId: z.string() }),
    query: paginationQuerySchema,
  },
  responses: {
    200: { description: 'Thing', body: z.strictObject({ id: z.string() }) },
  },
});

describe('derived types (VT-13, TBI-009 DoD-1)', () => {
  it('TBI-009 DoD-1 InferBody equals z.infer of the request body schema', () => {
    expectTypeOf<InferBody<typeof putMe>>().toEqualTypeOf<
      z.infer<typeof updateProfileBodySchema>
    >();
  });

  it('TBI-009 DoD-1 InferResponse equals z.infer of the response schema', () => {
    expectTypeOf<InferResponse<typeof getMe, 200>>().toEqualTypeOf<
      z.infer<typeof profileSchema>
    >();
    expectTypeOf<
      InferResponse<typeof putMe, 400>
    >().toEqualTypeOf<ProblemDetails>();
    expectTypeOf<
      InferResponse<typeof routes.getHealthReady, 503>
    >().toEqualTypeOf<ProblemDetails>();
  });

  it('TBI-009 DoD-1 InferParams and InferQuery follow the fixture schemas', () => {
    expectTypeOf<InferParams<typeof getThing>>().toEqualTypeOf<{
      thingId: string;
    }>();
    expectTypeOf<InferQuery<typeof getThing>>().toEqualTypeOf<
      z.infer<typeof paginationQuerySchema>
    >();
    expectTypeOf<InferBody<typeof getThing>>().toBeNever();
  });

  it('TBI-009 DoD-1 standard responses follow auth and input', () => {
    expectTypeOf<keyof typeof getMe.responses>().toEqualTypeOf<
      200 | 401 | 429 | 500 | 503
    >();
    expectTypeOf<keyof typeof getThing.responses>().toEqualTypeOf<
      200 | 400 | 500
    >();
    expect(Object.keys(getThing.responses)).toEqual(['200', '400', '500']);
  });
});

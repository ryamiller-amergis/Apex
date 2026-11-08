import {
  CONTRACTS_STUB,
  problemDetailsSchema,
  routes,
  type InferBody,
  type InferResponse,
  type ProblemDetails,
} from '@project-scope/contracts';
import { describe, expect, expectTypeOf, it } from 'vitest';

describe('workspace-link', () => {
  it('TBI-001 DoD-1 / VT-13 reads @project-scope/contracts', () => {
    expect(CONTRACTS_STUB).toBe('contracts-stub');
  });

  it('TBI-009 DoD-1 / VT-13 types an API handler from the putMe definition', () => {
    type Body = InferBody<typeof routes.putMe>;
    type Ok = InferResponse<typeof routes.putMe, 200>;
    const handle = (body: Body): Ok => ({
      displayName: body.displayName,
      email: body.email ?? null,
      status: 'active',
    });

    const body = routes.putMe.request.body.parse({ displayName: ' Ada ' });
    const response = routes.putMe.responses[200].body.parse(handle(body));

    expect(response).toEqual({
      displayName: 'Ada',
      email: null,
      status: 'active',
    });
    expectTypeOf<
      InferResponse<typeof routes.putMe, 400>
    >().toEqualTypeOf<ProblemDetails>();
    expect(routes.putMe.responses[400].body).toBe(problemDetailsSchema);
  });
});

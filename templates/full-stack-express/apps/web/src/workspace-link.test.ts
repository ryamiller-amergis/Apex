import {
  CONTRACTS_STUB,
  routes,
  type InferBody,
  type InferResponse,
} from '@project-scope/contracts';
import { UI_STUB } from '@project-scope/ui';
import { describe, expect, expectTypeOf, it } from 'vitest';

describe('workspace-link', () => {
  it('TBI-001 DoD-1 / VT-13 reads @project-scope/contracts and @project-scope/ui', () => {
    expect(CONTRACTS_STUB).toBe('contracts-stub');
    expect(UI_STUB).toBe('ui-stub');
  });

  it('TBI-009 DoD-1 / VT-13 parses a getMe response with the shared schema', () => {
    type Profile = InferResponse<typeof routes.getMe, 200>;
    const parse = (json: unknown): Profile =>
      routes.getMe.responses[200].body.parse(json);

    expect(
      parse({
        displayName: 'Ada Example',
        email: 'ada@example.test',
        status: 'active',
      }).status
    ).toBe('active');
    expect(() =>
      parse({ displayName: 'Ada Example', email: null, status: 'deleted' })
    ).toThrow();
    expectTypeOf<InferBody<typeof routes.putMe>>().toEqualTypeOf<{
      displayName: string;
      email?: string | null | undefined;
    }>();
  });
});

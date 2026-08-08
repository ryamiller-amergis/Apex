import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  FoundationSkillReleaseValidationClientError,
  usePublishFoundationSkillRelease,
} from '../useFoundationSkillAdmin';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);

  return { wrapper };
}

describe('usePublishFoundationSkillRelease', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('preserves structured 422 validation issues in a typed custom error', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 422,
      headers: { get: () => null },
      json: () => Promise.resolve({
        error: 'Release validation failed',
        code: 'release_validation_failed',
        issues: [
          {
            type: 'missing_dependency',
            dependentSkill: 'design-spec-review',
            dependency: 'prd-design-spec',
            message: 'Skill "design-spec-review" requires "prd-design-spec".',
            remediation: 'Add "prd-design-spec" to this release.',
            dependentProjects: [],
            dependencyProjects: [],
          },
          {
            type: 'missing_dependency',
            dependentSkill: 'design-spec-review',
            dependency: 'to-prd',
            message: 'Skill "design-spec-review" requires "to-prd".',
            remediation: 'Add "to-prd" to this release.',
            dependentProjects: [],
            dependencyProjects: [],
          },
        ],
      }),
    }) as jest.Mock;

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => usePublishFoundationSkillRelease(), { wrapper });

    let thrown: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync('rel-1');
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeInstanceOf(FoundationSkillReleaseValidationClientError);
    expect(thrown).toMatchObject({
      code: 'release_validation_failed',
      issues: [
        expect.objectContaining({
          dependency: 'prd-design-spec',
          dependentSkill: 'design-spec-review',
        }),
        expect.objectContaining({
          dependency: 'to-prd',
          dependentSkill: 'design-spec-review',
        }),
      ],
    });
  });
});

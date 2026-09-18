import type { PhaseSummary } from '../../../shared/types/interview';

const useQueryMock = jest.fn((_options: unknown) => ({ data: undefined }));
jest.mock('@tanstack/react-query', () => ({
  ...jest.requireActual('@tanstack/react-query'),
  useQuery: (options: unknown) => useQueryMock(options),
}));

import { usePhaseSummary } from '../useInterviews';

function draftSummary(overrides: Partial<PhaseSummary> = {}): PhaseSummary {
  return {
    phase: 'technical',
    status: 'draft',
    content: '',
    ownerId: 'owner-1',
    approvedAt: null,
    locked: false,
    amendable: false,
    ...overrides,
  };
}

function capturedRefetchInterval(data: unknown): number | false {
  const options = useQueryMock.mock.calls[0][0] as unknown as {
    refetchInterval: (query: { state: { data: unknown } }) => number | false;
  };
  return options.refetchInterval({ state: { data } });
}

describe('phase summary empty-draft polling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('polls every 2s while a draft summary is still empty after wrap-up', () => {
    usePhaseSummary('interview-1', 'technical');

    expect(capturedRefetchInterval(draftSummary())).toBe(2_000);
  });

  it('stops polling once the draft has content', () => {
    usePhaseSummary('interview-1', 'technical');

    expect(
      capturedRefetchInterval(draftSummary({ content: '# Technical summary' }))
    ).toBe(false);
  });

  it('does not poll an approved summary', () => {
    usePhaseSummary('interview-1', 'technical');

    expect(
      capturedRefetchInterval(
        draftSummary({
          status: 'approved',
          content: '',
        })
      )
    ).toBe(false);
  });
});

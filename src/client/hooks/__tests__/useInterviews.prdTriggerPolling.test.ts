import type { Interview, InterviewSummary } from '../../../shared/types/interview';

const useQueryMock = jest.fn((_options: unknown) => ({ data: undefined }));
jest.mock('@tanstack/react-query', () => ({
  ...jest.requireActual('@tanstack/react-query'),
  useQuery: (options: unknown) => useQueryMock(options),
}));

import { useInterview, useInterviewList } from '../useInterviews';

function awaitingInterview(overrides: Partial<InterviewSummary> = {}): InterviewSummary {
  return {
    id: 'iv-1',
    chatThreadId: 'thread-1',
    authorId: 'user-1',
    title: 'Phase interview',
    project: 'Apex',
    repo: 'Apex',
    status: 'complete',
    prdCount: 0,
    phaseFlow: 'technical_only',
    technicalPhaseStatus: 'approved',
    technicalApprovedAt: '2026-09-17T12:00:00.000Z',
    createdAt: '2026-09-17T11:00:00.000Z',
    updatedAt: '2026-09-17T12:00:00.000Z',
    ...overrides,
  };
}

function capturedRefetchInterval(data: unknown): number | false {
  const options = useQueryMock.mock.calls[0][0] as unknown as {
    refetchInterval: (query: { state: { data: unknown } }) => number | false;
  };
  return options.refetchInterval({ state: { data } });
}

describe('PBI-006 automatic PRD discovery polling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('polls the interview detail every 5s while the final phase is approved without a PRD', () => {
    useInterview('iv-1');

    const detail = { ...awaitingInterview(), prds: [] } as Interview;
    expect(capturedRefetchInterval(detail)).toBe(5_000);
  });

  it('stops polling the interview detail once a PRD exists', () => {
    useInterview('iv-1');

    const detail = { ...awaitingInterview({ prdCount: 1 }), prds: [] } as Interview;
    expect(capturedRefetchInterval(detail)).toBe(false);
  });

  it('does not poll the interview detail before the final phase is approved', () => {
    useInterview('iv-1');

    const detail = {
      ...awaitingInterview({
        phaseFlow: 'both_sequential',
        requirementsPhaseStatus: 'approved',
        technicalPhaseStatus: 'draft',
        technicalApprovedAt: null,
      }),
      prds: [],
    } as Interview;
    expect(capturedRefetchInterval(detail)).toBe(false);
  });

  it('polls the dashboard list while any interview awaits automatic generation', () => {
    useInterviewList();

    expect(capturedRefetchInterval([
      awaitingInterview({ id: 'iv-legacy', phaseFlow: null }),
      awaitingInterview(),
    ])).toBe(5_000);
  });

  it('stops polling the dashboard list when no interview awaits generation', () => {
    useInterviewList();

    expect(capturedRefetchInterval([
      awaitingInterview({ prdCount: 1 }),
      awaitingInterview({ id: 'iv-legacy', phaseFlow: null }),
    ])).toBe(false);
  });
});

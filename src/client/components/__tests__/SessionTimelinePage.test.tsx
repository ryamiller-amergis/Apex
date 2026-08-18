import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionTimelineResponse } from '../../../shared/types/observability';
import { ObservabilityApiError } from '../../hooks/useObservabilityQueries';
import { SessionTimelinePage } from '../SessionTimelinePage';

const SESSION = '22222222-2222-4222-8222-222222222222';
const mockUseSessionTimeline = jest.fn();

jest.mock('../../hooks/useSessionTimeline', () => ({
  useSessionTimeline: (...args: unknown[]) => mockUseSessionTimeline(...args),
}));

function timeline(overrides: Partial<SessionTimelineResponse> = {}): SessionTimelineResponse {
  return {
    session: { sessionId: SESSION, interviewId: '33333333-3333-4333-8333-333333333333', runIds: ['run-1'] },
    verdict: {
      health: 'progress_timeout',
      label: 'Progress timeout',
      detail: 'The run exceeded the progress abort threshold.',
      hangPointEventId: 'hang-tool',
      assessedAt: '2026-08-17T18:00:00.000Z',
    },
    sourceStatus: {
      agent: { state: 'complete' },
      trace: { state: 'complete' },
    },
    entries: [
      {
        id: 'agent-1',
        source: 'agent',
        occurredAt: '2026-08-17T17:51:00.000Z',
        title: 'Phase: implementation',
        status: 'completed',
        details: [{ label: 'Phase', value: 'implementation' }],
        runId: 'run-1',
        eventType: 'phase',
        sequence: 1,
        phase: 'implementation',
      },
      {
        id: 'trace-1',
        source: 'trace',
        occurredAt: '2026-08-17T17:51:00.000Z',
        title: 'GET /api/projects',
        status: 'completed',
        details: [{ label: 'Route', value: '/api/projects' }],
        eventType: 'api_request',
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        routeTemplate: '/api/projects',
        method: 'GET',
      },
      {
        id: 'hang-tool',
        source: 'agent',
        occurredAt: '2026-08-17T17:54:00.000Z',
        title: 'Tool: edit',
        status: 'running',
        safeDetail: 'edit running',
        details: [{ label: 'Tool', value: 'edit' }],
        runId: 'run-1',
        eventType: 'tool',
        sequence: 4,
        toolName: 'edit',
      },
    ],
    page: { nextCursor: 'cursor-2', returned: 3, loaded: 3, cap: 500, capReached: false },
    partial: false,
    ...overrides,
  };
}

function queryState(overrides: Record<string, unknown> = {}) {
  return {
    data: { pages: [timeline()] },
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    refetch: jest.fn(),
    fetchNextPage: jest.fn(),
    ...overrides,
  };
}

function renderPage(sessionId: string | null = SESSION) {
  const onSessionChange = jest.fn();
  render(
    <SessionTimelinePage project="Apex" sessionId={sessionId} onSessionChange={onSessionChange} />,
  );
  return { onSessionChange };
}

describe('SessionTimelinePage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseSessionTimeline.mockReturnValue(queryState());
  });

  it('PBI-006 AC-0 / VT-14 renders semantic order, verdict, hang label, and keyboard source filters', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(screen.getByTestId('session-timeline-page')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Session Timeline' })).toBeInTheDocument();
    expect(screen.getByTestId('session-timeline-verdict')).toHaveTextContent(/Progress timeout/);
    expect(screen.getByTestId('session-timeline-hang-point')).toHaveTextContent('Hang point');
    expect(screen.getByTestId('session-timeline-list').querySelectorAll('li')).toHaveLength(3);
    await user.click(screen.getByTestId('session-timeline-source-agent'));
    expect(screen.getByTestId('session-timeline-source-agent')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('session-timeline-list').querySelectorAll('li')).toHaveLength(2);
    await user.click(screen.getByTestId('session-timeline-expand-hang-tool'));
    expect(screen.getByTestId('session-timeline-expand-hang-tool')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('session-timeline-detail-hang-tool')).toHaveTextContent('edit');
  });

  it('PBI-006 AC-1 / VT-15 names the failed source and keeps remaining rows operable', () => {
    mockUseSessionTimeline.mockReturnValue(queryState({
      data: {
        pages: [timeline({
          partial: true,
          sourceStatus: {
            agent: { state: 'complete' },
            trace: { state: 'failed', message: 'Trace Event overlay source failed.' },
          },
        })],
      },
    }));
    renderPage();
    expect(screen.getByTestId('session-timeline-partial')).toHaveTextContent(/Incomplete timeline/);
    expect(screen.getByTestId('session-timeline-partial')).toHaveTextContent(/Trace Event overlay source failed/);
    expect(screen.getByTestId('session-timeline-entry-agent-1')).toBeInTheDocument();
  });

  it('PBI-006 AC-2 / VT-16 keeps order and filters across refresh', async () => {
    const user = userEvent.setup();
    const refetch = jest.fn();
    mockUseSessionTimeline.mockReturnValue(queryState({ refetch }));
    renderPage();
    await user.type(screen.getByTestId('session-timeline-keyword'), 'edit');
    await user.click(screen.getByTestId('session-timeline-refresh'));
    expect(refetch).toHaveBeenCalled();
    expect(screen.getByTestId('session-timeline-keyword')).toHaveValue('edit');
    expect(screen.getByTestId('session-timeline-list').querySelectorAll('li')).toHaveLength(1);
    expect(screen.getByTestId('session-timeline-entry-hang-tool')).toBeInTheDocument();
  });

  it('PBI-006 AC-3 / VT-17 hides protected details for unknown and forbidden fallbacks', () => {
    mockUseSessionTimeline.mockReturnValue(queryState({
      isError: true,
      error: new ObservabilityApiError('Not found', 404, 'OBSERVABILITY_NOT_FOUND'),
      data: undefined,
    }));
    const { unmount } = render(
      <SessionTimelinePage project="Apex" sessionId={SESSION} onSessionChange={jest.fn()} />,
    );
    expect(screen.getByTestId('session-timeline-not-found')).toBeInTheDocument();
    expect(screen.queryByTestId('session-timeline-list')).not.toBeInTheDocument();
    expect(screen.queryByText(/run-1|hang-tool|\/api\/projects/)).not.toBeInTheDocument();
    unmount();

    mockUseSessionTimeline.mockReturnValue(queryState({
      isError: true,
      error: new ObservabilityApiError('Forbidden', 403),
      data: undefined,
    }));
    render(<SessionTimelinePage project="Apex" sessionId={SESSION} onSessionChange={jest.fn()} />);
    expect(screen.getByTestId('session-timeline-forbidden')).toBeInTheDocument();
    expect(screen.queryByTestId('session-timeline-list')).not.toBeInTheDocument();
  });

  it('PBI-006 AC-2 shows no-match and cap states', async () => {
    const user = userEvent.setup();
    mockUseSessionTimeline.mockReturnValue(queryState({
      data: { pages: [timeline({ page: { nextCursor: null, returned: 3, loaded: 500, cap: 500, capReached: true } })] },
    }));
    renderPage();
    expect(screen.getByTestId('session-timeline-cap')).toHaveTextContent(/500-row/);
    await user.type(screen.getByTestId('session-timeline-keyword'), 'no-such-event');
    expect(screen.getByTestId('session-timeline-empty')).toHaveTextContent(/No events match/);
  });

  it('PBI-006 AC-3 lookup form validates a session ID without inventing protected data', async () => {
    const user = userEvent.setup();
    mockUseSessionTimeline.mockReturnValue(queryState({
      isError: true,
      error: new ObservabilityApiError('Not found', 404, 'OBSERVABILITY_NOT_FOUND'),
      data: undefined,
    }));
    const { onSessionChange } = renderPage();
    await user.clear(screen.getByTestId('session-timeline-session-id'));
    await user.type(screen.getByTestId('session-timeline-session-id'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    await user.click(screen.getByTestId('session-timeline-lookup'));
    expect(onSessionChange).toHaveBeenCalledWith('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });
});

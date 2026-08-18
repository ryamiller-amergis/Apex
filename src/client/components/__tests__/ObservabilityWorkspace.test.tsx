import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CaptureHealthResponse, TraceEventPage, TraceEventView } from '../../../shared/types/observability';
import { ObservabilityWorkspace } from '../ObservabilityWorkspace';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const SESSION = '22222222-2222-4222-8222-222222222222';

const mockUseObservabilityTrail = jest.fn();
const mockUseObservabilityHealth = jest.fn();
const mockUseSessionTimeline = jest.fn();

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({ selectedProject: 'Apex', isSuperAdmin: true }),
}));

jest.mock('../../hooks/useObservabilityQueries', () => ({
  useObservabilityTrail: (...args: unknown[]) => mockUseObservabilityTrail(...args),
  useObservabilityHealth: (...args: unknown[]) => mockUseObservabilityHealth(...args),
}));

jest.mock('../../hooks/useSessionTimeline', () => ({
  useSessionTimeline: (...args: unknown[]) => mockUseSessionTimeline(...args),
}));

jest.mock('../../hooks/usePlatformAdmin', () => ({
  usePlatformAdminUsers: () => ({
    data: [
      {
        userId: '11111111-1111-4111-8111-111111111111',
        displayName: 'Ada Lovelace',
        email: 'ada@example.com',
      },
    ],
    isLoading: false,
    isError: false,
  }),
}));

jest.mock('../InteractiveJourneyMapPage', () => ({
  __esModule: true,
  default: ({
    onOpenTrail,
  }: {
    onOpenTrail?: (handoff: { fromRoute: string; toRoute: string; from: string; to: string }) => void;
  }) => (
    <div>
      <div data-testid="journey-map-page">Journey Map</div>
      <button
        type="button"
        data-testid="journey-map-open-trail"
        onClick={() => onOpenTrail?.({
          fromRoute: '/home',
          toRoute: '/calendar',
          from: '2026-08-01',
          to: '2026-08-17',
        })}
      >
        Open Full Trail
      </button>
    </div>
  ),
}));

function event(overrides: Partial<TraceEventView> = {}): TraceEventView {
  return {
    id: 'evt-1',
    eventType: 'api_request',
    occurredAt: '2026-08-17T17:30:00.000Z',
    actorId: ACTOR,
    projectId: 'Apex',
    traceId: TRACE,
    sessionId: SESSION,
    routeTemplate: '/api/timecards',
    method: 'POST',
    statusCode: 201,
    durationMs: 142,
    severity: 'info',
    trigger: 'human',
    diagnosticSummary: 'POST /api/timecards — 201 (142ms)',
    ...overrides,
  };
}

function trailPage(items: TraceEventView[], nextCursor: string | null = null, capReached = false): TraceEventPage {
  return { items, nextCursor, capReached };
}

function health(overrides: Partial<CaptureHealthResponse> = {}): CaptureHealthResponse {
  return {
    capturedAt: '2026-08-17T18:00:00.000Z',
    instanceId: 'instance-1',
    captureEnabled: true,
    pipeline: {
      scope: 'instance',
      droppedEvents: 142,
      droppedEventsPerSecond: 0.3,
      bufferDepth: 8700,
      bufferCapacity: 10_000,
      flushErrorCount: 3,
      latestFlushError: null,
      ingestedEventsPerSecond: 80.2,
    },
    store: {
      scope: 'database',
      approximateStoreBytes: 13_314_088_960,
      oldestRetainedEventAt: '2026-08-01T00:00:00.000Z',
    },
    ...overrides,
  };
}

function queryState(overrides: Record<string, unknown> = {}) {
  return {
    data: undefined,
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    refetch: jest.fn(),
    dataUpdatedAt: Date.parse('2026-08-17T18:00:00.000Z'),
    ...overrides,
  };
}

function renderWorkspace() {
  return render(<ObservabilityWorkspace project="Apex" />);
}

async function selectActor(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByTestId('observability-actor'), ACTOR);
}

describe('ObservabilityWorkspace', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseObservabilityTrail.mockReturnValue(queryState());
    mockUseObservabilityHealth.mockReturnValue(queryState());
    mockUseSessionTimeline.mockReturnValue({
      data: undefined,
      isLoading: true,
      isFetching: false,
      isError: false,
      error: null,
      refetch: jest.fn(),
      fetchNextPage: jest.fn(),
    });
  });

  it('PBI-003 AC-0 / TC-PBI-003-001 loads shared filters and all sub-view entry points', () => {
    renderWorkspace();
    expect(screen.getByTestId('observability-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('observability-filter-form')).toBeInTheDocument();
    expect(screen.getByTestId('observability-tab-trail')).toBeInTheDocument();
    expect(screen.getByTestId('observability-tab-timeline')).toBeInTheDocument();
    expect(screen.getByTestId('observability-tab-journey')).toBeInTheDocument();
    expect(screen.getByTestId('observability-tab-health')).toBeInTheDocument();
    expect(screen.getByTestId('observability-cap-badge')).toHaveTextContent('500-row cap');
  });

  it('PBI-003 AC-3 / TC-PBI-003-008 is read-only with no mutation actions', () => {
    renderWorkspace();
    expect(screen.queryByRole('button', { name: /save|delete|edit|export|reset/i })).not.toBeInTheDocument();
  });

  it('PBI-003 AC-0 / TC-PBI-003-009 keeps shared filters when switching sub-views', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await selectActor(user);
    await user.click(screen.getByTestId('observability-tab-health'));
    expect(screen.getByTestId('observability-health-panel')).toBeInTheDocument();
    expect(screen.getByTestId('observability-actor')).toHaveValue(ACTOR);
    await user.click(screen.getByTestId('observability-tab-trail'));
    expect(screen.getByTestId('observability-actor')).toHaveValue(ACTOR);
  });

  it('PBI-003 AC-2 / TC-PBI-003-010 shows an accessible empty trail state before search', () => {
    renderWorkspace();
    expect(screen.getByTestId('observability-trail-empty')).toHaveTextContent(/search a user activity trail/i);
  });

  it('PBI-004 AC-3 / TC-PBI-004-004 blocks missing actor and malformed trace ID without querying', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await user.type(screen.getByTestId('observability-trace-id'), 'ZZ-NOT-VALID!!');
    await user.click(screen.getByTestId('observability-apply-filters'));
    expect(screen.getByTestId('observability-validation-summary')).toHaveTextContent(/validation error/i);
    expect(screen.getByText(/actor is required/i)).toBeInTheDocument();
    expect(screen.getByText(/malformed trace id/i)).toBeInTheDocument();
    const calls = mockUseObservabilityTrail.mock.calls as unknown[][];
    const lastCall = calls[calls.length - 1];
    expect(lastCall?.[1]).toBeNull();
  });

  it('lists known users by display name and submits the matching UUID', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    const actorSelect = screen.getByTestId('observability-actor');
    expect(within(actorSelect).getByRole('option', { name: 'Ada Lovelace' })).toHaveValue(ACTOR);
    expect(within(actorSelect).queryByRole('option', { name: ACTOR })).not.toBeInTheDocument();
    await selectActor(user);
    await user.click(screen.getByTestId('observability-apply-filters'));
    const calls = mockUseObservabilityTrail.mock.calls as unknown[][];
    const lastCall = calls[calls.length - 1];
    expect((lastCall?.[1] as { actorId: string } | null)?.actorId).toBe(ACTOR);
  });

  it('PBI-004 AC-0 / TC-PBI-004-001 shows chronological trail rows with trace and session links', async () => {
    const user = userEvent.setup();
    mockUseObservabilityTrail.mockReturnValue(queryState({
      data: trailPage([
        event({ id: 'evt-ui', eventType: 'ui_action', occurredAt: '2026-08-17T17:29:00.000Z', diagnosticSummary: null }),
        event({ id: 'evt-api', eventType: 'api_request', occurredAt: '2026-08-17T17:30:00.000Z' }),
        event({ id: 'evt-err', eventType: 'error', occurredAt: '2026-08-17T17:31:00.000Z', diagnosticSummary: 'ValidationError' }),
      ]),
    }));
    renderWorkspace();
    await selectActor(user);
    await user.click(screen.getByTestId('observability-apply-filters'));
    const table = screen.getByTestId('observability-trail-table');
    expect(within(table).getByText('UI Action')).toBeInTheDocument();
    expect(within(table).getByText('API Call')).toBeInTheDocument();
    expect(within(table).getByText('Error')).toBeInTheDocument();
    expect(within(table).getAllByText(ACTOR).length).toBeGreaterThan(0);
    expect(screen.getAllByTestId(`observability-trace-link-${TRACE}`).length).toBeGreaterThan(0);
    expect(screen.getAllByTestId(`observability-session-link-${SESSION}`).length).toBeGreaterThan(0);
    expect(table.textContent).not.toMatch(/@example\.com/);
  });

  it('PBI-004 AC-1 / TC-PBI-004-002 shows a recoverable trail error without stale rows', async () => {
    const user = userEvent.setup();
    mockUseObservabilityTrail.mockReturnValue(queryState({
      isError: true,
      error: { message: 'HTTP 503' },
    }));
    renderWorkspace();
    await selectActor(user);
    await user.click(screen.getByTestId('observability-apply-filters'));
    expect(screen.getByTestId('observability-trail-error')).toHaveTextContent(/unavailable/i);
    expect(screen.getByTestId('observability-trail-retry')).toBeInTheDocument();
    expect(screen.queryByTestId('observability-trail-table')).not.toBeInTheDocument();
    expect(screen.getByTestId('observability-filter-form')).toBeInTheDocument();
  });

  it('PBI-003 AC-1 / TC-PBI-003-002 isolates a trail error from other views and shared filters', async () => {
    const user = userEvent.setup();
    mockUseObservabilityTrail.mockReturnValue(queryState({
      isError: true,
      error: { message: 'HTTP 503' },
    }));
    renderWorkspace();
    await selectActor(user);
    await user.click(screen.getByTestId('observability-apply-filters'));
    await user.click(screen.getByTestId('observability-tab-health'));
    expect(screen.getByTestId('observability-health-panel')).toBeInTheDocument();
    expect(screen.getByTestId('observability-actor')).toHaveValue(ACTOR);
    expect(screen.queryByTestId('observability-trail-error')).not.toBeInTheDocument();
  });

  it('PBI-004 AC-2 / TC-PBI-004-003 presents 50-row pagination and the 500-row cap', async () => {
    const user = userEvent.setup();
    const items = Array.from({ length: 50 }, (_, index) => event({ id: `evt-${index}` }));
    mockUseObservabilityTrail.mockReturnValue(queryState({
      data: trailPage(items, 'cursor-2', true),
    }));
    renderWorkspace();
    await selectActor(user);
    await user.click(screen.getByTestId('observability-apply-filters'));
    expect(screen.getByTestId('observability-trail-pagination-info')).toHaveTextContent(/cap reached/i);
    expect(screen.getByTestId('observability-trail-next')).toBeDisabled();
    expect(screen.getAllByRole('row')).toHaveLength(51);
  });

  it('PBI-004 AC-0 / TC-PBI-004-010 opens Timeline from a session link', async () => {
    const user = userEvent.setup();
    mockUseObservabilityTrail.mockReturnValue(queryState({ data: trailPage([event()]) }));
    renderWorkspace();
    await selectActor(user);
    await user.click(screen.getByTestId('observability-apply-filters'));
    await user.click(screen.getByTestId(`observability-session-link-${SESSION}`));
    expect(screen.getByTestId('observability-timeline-panel')).toBeInTheDocument();
    expect(screen.getByTestId('session-timeline-page')).toBeInTheDocument();
    expect(screen.queryByTestId('observability-timeline-empty')).not.toBeInTheDocument();
  });

  it('PBI-005 AC-0 / TC-PBI-005-001 shows required Capture Health metrics', async () => {
    const user = userEvent.setup();
    mockUseObservabilityHealth.mockReturnValue(queryState({ data: health() }));
    renderWorkspace();
    await user.click(screen.getByTestId('observability-tab-health'));
    expect(screen.getByTestId('observability-health-dropped')).toHaveTextContent('142');
    expect(screen.getByTestId('observability-health-buffer')).toHaveTextContent('8,700');
    expect(screen.getByTestId('observability-health-throughput')).toHaveTextContent('80.2');
    expect(screen.getByTestId('observability-health-flush')).toHaveTextContent('3');
    expect(screen.getByTestId('observability-health-store')).toHaveTextContent('GB');
    expect(screen.getByTestId('observability-health-oldest')).toHaveTextContent('2026-08-01');
    expect(screen.getByTestId('observability-health-grid').textContent).not.toMatch(/authorization|stack trace|request body/i);
  });

  it('PBI-005 AC-1 / TC-PBI-005-002 shows an accessible stale-or-error health state', async () => {
    const user = userEvent.setup();
    mockUseObservabilityHealth.mockReturnValue(queryState({
      isError: true,
      error: { message: 'HTTP 502' },
    }));
    renderWorkspace();
    await user.click(screen.getByTestId('observability-tab-health'));
    expect(screen.getByTestId('observability-health-error')).toHaveTextContent(/failed/i);
    expect(screen.getByTestId('observability-health-retry')).toBeInTheDocument();
    expect(screen.getByTestId('observability-filter-form')).toBeInTheDocument();
  });

  it('PBI-005 AC-2 shows buffer-at-capacity and 30-day retention warnings', async () => {
    const user = userEvent.setup();
    mockUseObservabilityHealth.mockReturnValue(queryState({
      data: health({
        pipeline: {
          scope: 'instance',
          droppedEvents: 10,
          droppedEventsPerSecond: 1,
          bufferDepth: 10_000,
          bufferCapacity: 10_000,
          flushErrorCount: 0,
          latestFlushError: null,
          ingestedEventsPerSecond: 1,
        },
        store: {
          scope: 'database',
          approximateStoreBytes: 1,
          oldestRetainedEventAt: '2026-07-18T00:00:00.000Z',
        },
      }),
    }));
    renderWorkspace();
    await user.click(screen.getByTestId('observability-tab-health'));
    expect(screen.getByTestId('observability-health-buffer-warning')).toHaveTextContent(/at capacity/i);
    expect(screen.getByTestId('observability-health-retention-warning')).toHaveTextContent(/30-day/i);
  });

  it('PBI-007 AC-0 / TBI-011 DoD-1 mounts Journey Map and pivots to a filtered Trail', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await user.click(screen.getByTestId('observability-tab-journey'));
    expect(await screen.findByTestId('journey-map-page')).toBeInTheDocument();
    await user.click(screen.getByTestId('journey-map-open-trail'));
    await waitFor(() => expect(screen.getByTestId('observability-trail-panel')).toBeInTheDocument());
    expect(screen.getByTestId('observability-trail-empty')).toHaveTextContent('/home');
    expect(screen.getByTestId('observability-trail-empty')).toHaveTextContent('/calendar');
  });
});

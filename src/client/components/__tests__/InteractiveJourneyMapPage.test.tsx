import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JourneyMapResponse } from '../../../shared/types/observability';
import { InteractiveJourneyMapPage } from '../InteractiveJourneyMapPage';

const mockUseJourneyMap = jest.fn();
const mockUseFeatureFlag = jest.fn();

jest.mock('../../hooks/useJourneyMap', () => ({
  useJourneyMap: (...args: unknown[]) => mockUseJourneyMap(...args),
}));

jest.mock('../../hooks/useFeatureFlags', () => ({
  useFeatureFlag: (...args: unknown[]) => mockUseFeatureFlag(...args),
}));

function populated(overrides: Partial<JourneyMapResponse> = {}): JourneyMapResponse {
  return {
    generatedAt: '2026-08-17T18:00:00.000Z',
    rollupThrough: '2026-08-17T23:59:59.999Z',
    availableFrom: '2026-07-19',
    availableTo: '2026-08-17',
    range: { from: '2026-07-19', to: '2026-08-17' },
    machineTransitionsExcluded: true,
    truncated: false,
    nodes: [
      { routeTemplate: '/calendar', transitionCount: 80, distinctActorCount: 12 },
      { routeTemplate: '/home', transitionCount: 80, distinctActorCount: 12 },
    ],
    edges: [
      {
        fromRoute: '/home',
        toRoute: '/calendar',
        transitionCount: 80,
        distinctActorCount: 12,
        lastSeen: '2026-08-17',
      },
    ],
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
    isSuccess: false,
    ...overrides,
  };
}

describe('InteractiveJourneyMapPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseFeatureFlag.mockReturnValue(true);
    mockUseJourneyMap.mockReturnValue(queryState({ data: populated(), isSuccess: true }));
  });

  it('PBI-007 AC-0 / VT-02 renders normalized nodes, edges, summary, exclusion status, and equivalent table', () => {
    render(<InteractiveJourneyMapPage project="Apex" />);
    expect(screen.getByTestId('journey-map-page')).toBeInTheDocument();
    expect(screen.getByTestId('journey-map-summary')).toHaveTextContent('Machine-driven transitions excluded');
    expect(screen.getByTestId('journey-map-node-home')).toBeInTheDocument();
    expect(screen.getByTestId('journey-map-edge-home--calendar')).toBeInTheDocument();
    const table = screen.getByTestId('journey-map-transition-table');
    expect(within(table).getByText('/home')).toBeInTheDocument();
    expect(within(table).getByText('/calendar')).toBeInTheDocument();
    expect(within(table).getByText('80')).toBeInTheDocument();
    expect(screen.queryByText(/users\?id=/)).not.toBeInTheDocument();
  });

  it('PBI-007 AC-0 / TBI-011 DoD-1 / VT-03 keyboard-selects an edge and pivots with exact trail filters', async () => {
    const user = userEvent.setup();
    const onOpenTrail = jest.fn();
    render(<InteractiveJourneyMapPage project="Apex" onOpenTrail={onOpenTrail} />);
    const edge = screen.getByTestId('journey-map-edge-home--calendar');
    edge.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('journey-map-edge-detail')).toHaveTextContent('/home');
    expect(screen.getByTestId('journey-map-edge-detail')).toHaveTextContent('/calendar');
    await user.click(screen.getByTestId('journey-map-pivot'));
    expect(screen.getByTestId('journey-map-trail-dialog')).toBeInTheDocument();
    await user.click(screen.getByTestId('journey-map-open-trail'));
    expect(onOpenTrail).toHaveBeenCalledWith({
      fromRoute: '/home',
      toRoute: '/calendar',
      from: '2026-07-19',
      to: '2026-08-17',
    });
  });

  it('PBI-007 AC-1 / VT-04 shows an accessible alert on initial failure with no stale graph', async () => {
    const user = userEvent.setup();
    const refetch = jest.fn();
    mockUseJourneyMap.mockReturnValue(queryState({
      isError: true,
      error: { message: 'Journey rollup query failed' },
      refetch,
    }));
    render(<InteractiveJourneyMapPage project="Apex" />);
    expect(screen.getByTestId('journey-map-error')).toHaveAttribute('role', 'alert');
    expect(screen.queryByTestId('journey-map-graph')).not.toBeInTheDocument();
    expect(screen.queryByTestId('journey-map-transition-table')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('journey-map-retry'));
    expect(refetch).toHaveBeenCalled();
  });

  it('PBI-007 AC-1 / VT-05 removes previous graph and table when refresh fails', () => {
    mockUseJourneyMap.mockReturnValue(queryState({
      data: populated(),
      isError: true,
      error: { message: 'Internal server error' },
      refetch: jest.fn(),
    }));
    render(<InteractiveJourneyMapPage project="Apex" />);
    expect(screen.getByTestId('journey-map-error')).toBeInTheDocument();
    expect(screen.queryByTestId('journey-map-graph')).not.toBeInTheDocument();
    expect(screen.queryByTestId('journey-map-transition-table')).not.toBeInTheDocument();
  });

  it('PBI-007 AC-2 / VT-06 shows an actionable empty state and zero-count table', () => {
    mockUseJourneyMap.mockReturnValue(queryState({
      data: populated({ nodes: [], edges: [] }),
      isSuccess: true,
    }));
    render(<InteractiveJourneyMapPage project="Apex" />);
    expect(screen.getByTestId('journey-map-empty')).toHaveTextContent(/no transitions/i);
    expect(screen.getByTestId('journey-map-transition-table')).toHaveTextContent(/no transitions match/i);
  });

  it('PBI-007 AC-2 / TBI-011 DoD-2 / VT-07 limits the canvas and paginates the equivalent table for dense results', async () => {
    const user = userEvent.setup();
    const edges = Array.from({ length: 120 }, (_, index) => ({
      fromRoute: '/home',
      toRoute: `/item-${index}`,
      transitionCount: 200 - index,
      distinctActorCount: 4,
      lastSeen: '2026-08-17',
    }));
    const nodes = [
      { routeTemplate: '/home', transitionCount: 1000, distinctActorCount: 20 },
      ...edges.map((edge) => ({ routeTemplate: edge.toRoute, transitionCount: edge.transitionCount, distinctActorCount: 4 })),
    ];
    mockUseJourneyMap.mockReturnValue(queryState({
      data: populated({ nodes, edges, truncated: true }),
      isSuccess: true,
    }));
    render(<InteractiveJourneyMapPage project="Apex" />);
    expect(screen.getByTestId('journey-map-summary')).toHaveTextContent('500-row cap');
    expect(screen.getByTestId('journey-map-summary')).toHaveTextContent('Canvas shows 100 of 120');
    expect(screen.getByTestId('journey-map-edge-home--item-0')).toBeInTheDocument();
    expect(screen.queryByTestId('journey-map-edge-home--item-119')).not.toBeInTheDocument();
    expect(screen.getByTestId('journey-map-transition-table')).toHaveTextContent('/item-0');
    await user.click(screen.getByTestId('journey-map-table-next'));
    expect(screen.getByTestId('journey-map-transition-table')).toHaveTextContent('/item-50');
  });

  it('PBI-007 AC-3 / BR-011 does not mount or query when observability-viewer is disabled', () => {
    mockUseFeatureFlag.mockReturnValue(false);
    render(<InteractiveJourneyMapPage project="Apex" />);
    expect(screen.queryByTestId('journey-map-page')).not.toBeInTheDocument();
    expect(mockUseJourneyMap).toHaveBeenCalledWith('Apex', expect.anything(), false);
  });
});

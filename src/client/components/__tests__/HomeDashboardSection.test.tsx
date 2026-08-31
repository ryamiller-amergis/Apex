import { fireEvent, render, screen, within } from '@testing-library/react';
import type {
  ArtifactCycleTimeData,
  HomeDashboardPayload,
  IncompletePipelineData,
  MyWorkData,
  OpenBugsOnPbisData,
  DevToProductionData,
  TileResult,
} from '../../../shared/types/homeDashboard';
import { ArtifactCycleTimeTile } from '../ArtifactCycleTimeTile';
import { DevToProductionTile } from '../DevToProductionTile';
import { HomeDashboardSection } from '../HomeDashboardSection';
import { IncompletePipelineTile } from '../IncompletePipelineTile';
import { MyWorkTile } from '../MyWorkTile';
import { OpenBugsOnPbisTile } from '../OpenBugsOnPbisTile';

const ok = <T,>(data: T): TileResult<T> => ({ status: 'ok', data });
const empty = <T,>(data: T): TileResult<T> => ({ status: 'empty', data });
const error = <T,>(message: string): TileResult<T> => ({ status: 'error', data: null, message });
const retry = jest.fn();
const cycleKpi = (medianDays: number | null) => ({ medianDays, sampleSize: medianDays === null ? 0 : 3, windowDays: 90 as const });

const pipelineData: IncompletePipelineData = {
  updatedAt: '2026-08-31T16:00:00.000Z',
  groups: [
    {
      key: 'interview',
      label: 'Interview',
      count: 22,
      viewAllHref: '/backlog?tab=interviews',
      rows: Array.from({ length: 22 }, (_, index) => ({
        id: `interview-${index}`,
        name: `Interview ${index}`,
        route: `/backlog/interview/${index}`,
        updatedAt: '2026-08-30T16:00:00.000Z',
        ageDays: index + 1,
      })),
    },
    {
      key: 'prd',
      label: 'PRD',
      count: 0,
      viewAllHref: '/backlog?tab=prds',
      rows: [],
    },
  ],
};

const cycleData: ArtifactCycleTimeData = {
  interview: cycleKpi(4.2),
  prd: cycleKpi(null),
  testCase: cycleKpi(3.1),
  prototype: cycleKpi(5.6),
  designDoc: cycleKpi(9.3),
};

const myWorkData: MyWorkData = {
  ready: 6,
  inProgress: 3,
  cycleTime: cycleKpi(6.4),
};

const bugsData: OpenBugsOnPbisData = {
  totalOpenBugs: 24,
  rows: Array.from({ length: 22 }, (_, index) => ({
    pbiId: `${2000 + index}`,
    title: `PBI ${index}`,
    openBugCount: index + 1,
    updatedAt: '2026-08-30T16:00:00.000Z',
  })),
};

const devProdData: DevToProductionData = {
  medianDays: 11.4,
  sampleSize: 5,
  windowDays: 90,
};

beforeEach(() => retry.mockReset());

describe('IncompletePipelineTile', () => {
  it('renders grouped counts, capped linked rows, View all, and per-group empty copy', () => {
    render(<IncompletePipelineTile result={ok(pipelineData)} onRetry={retry} />);

    const group = screen.getByTestId('home-dashboard-pipeline-group-interview');
    expect(group).toHaveAccessibleName('Interview, 22 incomplete');
    expect(within(group).getAllByRole('link', { name: /^Interview \d/ })).toHaveLength(20);
    expect(within(group).getByRole('link', { name: 'View all Interview' })).toHaveAttribute('href', '/backlog?tab=interviews');
    expect(within(group).getByRole('link', { name: 'Interview 0' })).toHaveAttribute('href', '/backlog/interview/0');
    expect(screen.getByText('No incomplete PRDs in this project.')).toBeInTheDocument();
  });

  it('shows an error and retries', () => {
    render(<IncompletePipelineTile result={error('Pipeline unavailable')} onRetry={retry} />);
    expect(screen.getByText('Pipeline unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('home-dashboard-pipeline-retry'));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('renders nothing for a null permission slice', () => {
    const { container } = render(<IncompletePipelineTile result={null} onRetry={retry} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('ArtifactCycleTimeTile', () => {
  it('renders readable medians, unavailable values, and hides a missing prototype KPI', () => {
    const withoutPrototype = { ...cycleData };
    delete withoutPrototype.prototype;
    render(<ArtifactCycleTimeTile result={ok(withoutPrototype)} onRetry={retry} />);

    expect(screen.getByLabelText('Interview median cycle time: 4.2 days in the last 90 days')).toBeInTheDocument();
    expect(screen.getByLabelText('PRD median cycle time: unavailable; no completed items in the last 90 days')).toHaveTextContent('—');
    expect(screen.queryByText('Prototype')).not.toBeInTheDocument();
  });

  it('shows an Unavailable indicator for a failed KPI while sibling KPIs stay populated (PBI-002 AC-1)', () => {
    render(
      <ArtifactCycleTimeTile
        result={ok({
          ...cycleData,
          prd: { medianDays: null, sampleSize: 0, windowDays: 90, unavailable: true },
        })}
        onRetry={retry}
      />,
    );

    const failedKpi = screen.getByLabelText('PRD median cycle time: Unavailable');
    expect(failedKpi).toHaveTextContent('Unavailable');
    expect(failedKpi).not.toHaveTextContent('No completed items in the last 90 days');
    expect(failedKpi).not.toHaveTextContent('—');
    expect(screen.getByLabelText('Interview median cycle time: 4.2 days in the last 90 days')).toHaveTextContent('4.2');
    expect(screen.getByLabelText('Test Case median cycle time: 3.1 days in the last 90 days')).toHaveTextContent('3.1');
  });

  it('shows a whole-tile error and retry', () => {
    render(<ArtifactCycleTimeTile result={error('Cycle times unavailable')} onRetry={retry} />);
    fireEvent.click(screen.getByTestId('home-dashboard-cycle-time-retry'));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('renders nothing for a null permission slice', () => {
    const { container } = render(<ArtifactCycleTimeTile result={null} onRetry={retry} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('MyWorkTile', () => {
  it('renders counts, median, and a link to My Work', () => {
    render(<MyWorkTile result={ok(myWorkData)} onRetry={retry} />);
    expect(screen.getByText('6')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByLabelText('Median cycle time: 6.4 days in the last 90 days')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /My Work status/i })).toHaveAttribute('href', '/my-work');
  });

  it('keeps counts and shows empty cycle-time copy', () => {
    render(<MyWorkTile result={empty({ ...myWorkData, cycleTime: cycleKpi(null) })} onRetry={retry} />);
    expect(screen.getByText('No completed items in the last 90 days')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('supports retry and null permission hiding', () => {
    const { rerender } = render(<MyWorkTile result={error('Could not load your work items.')} onRetry={retry} />);
    fireEvent.click(screen.getByTestId('home-dashboard-my-work-retry'));
    expect(retry).toHaveBeenCalledTimes(1);
    rerender(<MyWorkTile result={null} onRetry={retry} />);
    expect(screen.queryByTestId('home-dashboard-my-work-card')).not.toBeInTheDocument();
  });
});

describe('OpenBugsOnPbisTile', () => {
  it('renders the total and caps linked rows at 20', () => {
    render(<OpenBugsOnPbisTile result={ok(bugsData)} onRetry={retry} />);
    expect(screen.getByText('24 bugs total')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /PBI \d+, \d+ open bugs/ })).toHaveLength(20);
    expect(screen.getByRole('link', { name: 'View all open bugs on PBIs' })).toHaveAttribute('href', '/calendar');
  });

  it('stays visible when empty', () => {
    render(<OpenBugsOnPbisTile result={empty({ totalOpenBugs: 0, rows: [] })} onRetry={retry} />);
    expect(screen.getByText('No open bugs on any PBIs.')).toBeInTheDocument();
  });

  it('supports retry and null permission hiding', () => {
    const { rerender } = render(<OpenBugsOnPbisTile result={error('Azure DevOps query failed.')} onRetry={retry} />);
    fireEvent.click(screen.getByTestId('home-dashboard-bugs-retry'));
    expect(retry).toHaveBeenCalledTimes(1);
    rerender(<OpenBugsOnPbisTile result={null} onRetry={retry} />);
    expect(screen.queryByTestId('home-dashboard-bugs-card')).not.toBeInTheDocument();
  });
});

describe('DevToProductionTile', () => {
  it('renders a whole-card releases link and readable median', () => {
    render(<DevToProductionTile result={ok(devProdData)} onRetry={retry} />);
    expect(screen.getByRole('link', { name: /Developer to production: 11.4 days median/i })).toHaveAttribute('href', '/planning/releases');
  });

  it('shows empty copy, retry errors, and null permission hiding', () => {
    const { rerender } = render(<DevToProductionTile result={empty({ ...devProdData, medianDays: null, sampleSize: 0 })} onRetry={retry} />);
    expect(screen.getByText('No completed items in the last 90 days')).toBeInTheDocument();
    rerender(<DevToProductionTile result={error('Failed to load Releases data.')} onRetry={retry} />);
    fireEvent.click(screen.getByTestId('home-dashboard-devprod-retry'));
    expect(retry).toHaveBeenCalledTimes(1);
    rerender(<DevToProductionTile result={null} onRetry={retry} />);
    expect(screen.queryByTestId('home-dashboard-devprod-card')).not.toBeInTheDocument();
  });
});

describe('HomeDashboardSection', () => {
  it('composes all independently authorized payload slices', () => {
    const payload: HomeDashboardPayload = {
      incompletePipeline: ok(pipelineData),
      artifactCycleTime: ok(cycleData),
      myWork: ok(myWorkData),
      openBugsOnPbis: ok(bugsData),
      devToProduction: ok(devProdData),
    };
    render(<HomeDashboardSection payload={payload} onRetry={retry} />);
    expect(screen.getByTestId('home-dashboard-root')).toBeInTheDocument();
    expect(screen.getByText('Project Status')).toBeInTheDocument();
    expect(screen.getAllByTestId(/home-dashboard-(pipeline|cycle-time|my-work|bugs|devprod)-card/)).toHaveLength(5);
  });

  it('omits each tile whose server permission slice is null', () => {
    const payload: HomeDashboardPayload = {
      incompletePipeline: null,
      artifactCycleTime: null,
      myWork: null,
      openBugsOnPbis: null,
      devToProduction: null,
    };
    render(<HomeDashboardSection payload={payload} onRetry={retry} />);
    expect(screen.getByTestId('home-dashboard-root')).toBeInTheDocument();
    expect(screen.queryByTestId(/home-dashboard-.+-card/)).not.toBeInTheDocument();
  });

  it('renders full-card skeletons with stable landmarks while the payload is loading', () => {
    render(<HomeDashboardSection isLoading onRetry={retry} />);

    const root = screen.getByTestId('home-dashboard-root');
    expect(root).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Project Status')).toBeInTheDocument();
    expect(screen.getByTestId('home-dashboard-pipeline-card')).toBeInTheDocument();
    expect(screen.getByTestId('home-dashboard-cycle-time-card')).toBeInTheDocument();
    expect(screen.getByTestId('home-dashboard-my-work-card')).toBeInTheDocument();
    expect(screen.getByTestId('home-dashboard-bugs-card')).toBeInTheDocument();
    expect(screen.getByTestId('home-dashboard-devprod-card')).toBeInTheDocument();
    expect(screen.queryByText('Incomplete Pipeline')).not.toBeInTheDocument();
  });
});

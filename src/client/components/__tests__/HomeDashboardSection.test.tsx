import { createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import type {
  ArtifactCycleTimeData,
  HomeDashboardPayload,
  IncompletePipelineData,
  MyWorkData,
  OpenBugsOnPbisData,
  DevToProductionData,
  BugToPbiRatioData,
  TileResult,
} from '../../../shared/types/homeDashboard';
import { ArtifactCycleTimeTile } from '../ArtifactCycleTimeTile';
import { BugToPbiRatioTile } from '../BugToPbiRatioTile';
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
        reason: 'No PRD generated',
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

const bugRatioData: BugToPbiRatioData = {
  bugCount: 8,
  pbiCount: 20,
  ratio: 0.4,
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
    expect(
      within(group).getByRole('link', {
        name: 'Interview 0 — No PRD generated, last updated 1 day ago',
      }),
    ).toHaveAttribute('href', '/backlog/interview/0');
    expect(screen.getByText('No incomplete PRDs in this project.')).toBeInTheDocument();
  });

  it('explains what the card shows behind an info icon', () => {
    render(<IncompletePipelineTile result={ok(pipelineData)} onRetry={retry} />);

    expect(screen.queryByTestId('home-dashboard-pipeline-info-panel')).not.toBeInTheDocument();

    const trigger = screen.getByTestId('home-dashboard-pipeline-info');
    expect(trigger).toHaveAccessibleName('About Incomplete Pipeline');

    fireEvent.click(trigger);
    const panel = screen.getByTestId('home-dashboard-pipeline-info-panel');
    expect(within(panel).getByText(/still owe work/)).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('home-dashboard-pipeline-info-panel')).not.toBeInTheDocument();
  });

  it('states why each row is still in the pipeline', () => {
    render(<IncompletePipelineTile result={ok(pipelineData)} onRetry={retry} />);

    const group = screen.getByTestId('home-dashboard-pipeline-group-interview');
    expect(within(group).getAllByText('No PRD generated')).toHaveLength(20);
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

  it('marks a failed KPI and offers a retry while sibling KPIs stay populated (PBI-002 AC-1)', () => {
    render(
      <ArtifactCycleTimeTile
        result={ok({
          ...cycleData,
          prd: { medianDays: null, sampleSize: 0, windowDays: 90, unavailable: true },
        })}
        onRetry={retry}
      />,
    );

    const failedKpi = screen.getByLabelText('PRD median cycle time: failed to load');
    expect(failedKpi).toHaveTextContent('Failed to load');
    // A failure must stay distinguishable from an empty window.
    expect(failedKpi).not.toHaveTextContent('No completed items in the last 90 days');
    expect(screen.getByLabelText('Interview median cycle time: 4.2 days in the last 90 days')).toHaveTextContent('4.2');
    expect(screen.getByLabelText('Test Case median cycle time: 3.1 days in the last 90 days')).toHaveTextContent('3.1');

    fireEvent.click(screen.getByTestId('home-dashboard-cycle-time-partial-retry'));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('falls back to the explained tile error when every KPI source fails', () => {
    const failed = { medianDays: null, sampleSize: 0, windowDays: 90 as const, unavailable: true as const };
    render(
      <ArtifactCycleTimeTile
        result={ok({ interview: failed, prd: failed, testCase: failed, prototype: failed, designDoc: failed })}
        onRetry={retry}
      />,
    );

    expect(screen.queryByText('Failed to load')).not.toBeInTheDocument();
    expect(screen.getByText('Failed to load artifact cycle times.')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('home-dashboard-cycle-time-retry'));
    expect(retry).toHaveBeenCalledTimes(1);
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
  it('opens the info panel without following the whole-card link', () => {
    render(<MyWorkTile result={ok(myWorkData)} onRetry={retry} />);

    const trigger = screen.getByTestId('home-dashboard-my-work-info');
    const click = createEvent.click(trigger, { bubbles: true, cancelable: true });
    fireEvent(trigger, click);

    // The card is an <a href="/my-work">, so the click has to be cancelled.
    expect(click.defaultPrevented).toBe(true);
    expect(screen.getByTestId('home-dashboard-my-work-info-panel')).toBeInTheDocument();
  });

  it('renders counts, median, and a link to My Work', () => {
    render(<MyWorkTile result={ok(myWorkData)} onRetry={retry} />);
    expect(screen.getByText('6')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByLabelText('Median cycle time: 6.4 days in the last 90 days')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /My Work status/i })).toHaveAttribute('href', '/my-work');
  });

  it('keeps counts and explains what makes work appear when empty', () => {
    render(<MyWorkTile result={empty({ ...myWorkData, cycleTime: cycleKpi(null) })} onRetry={retry} />);
    expect(screen.getByText('No completed items in the last 90 days')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText(/you must be the Design Doc owner/i)).toBeInTheDocument();
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
    expect(screen.getByText(/No open bugs on any PBIs\./)).toBeInTheDocument();
    expect(screen.getByText(/once a bug is linked to it as a child/i)).toBeInTheDocument();
  });

  it('opens the PBI details callback instead of navigating to Calendar', () => {
    const onSelectPbi = jest.fn();
    render(
      <OpenBugsOnPbisTile
        result={ok({ ...bugsData, rows: [bugsData.rows[0]] })}
        onRetry={retry}
        onSelectPbi={onSelectPbi}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Open PBI 0 details/i }));
    expect(onSelectPbi).toHaveBeenCalledWith('2000');
    expect(screen.queryByRole('link', { name: /PBI 0, 1 open bugs/ })).not.toBeInTheDocument();
  });

  it('supports retry and null permission hiding', () => {
    const { rerender } = render(<OpenBugsOnPbisTile result={error('Azure DevOps query failed.')} onRetry={retry} />);
    fireEvent.click(screen.getByTestId('home-dashboard-bugs-retry'));
    expect(retry).toHaveBeenCalledTimes(1);
    rerender(<OpenBugsOnPbisTile result={null} onRetry={retry} />);
    expect(screen.queryByTestId('home-dashboard-bugs-card')).not.toBeInTheDocument();
  });

  it('PBI-004 AC-1 renders last-known bug data as stale with Retry', () => {
    render(
      <OpenBugsOnPbisTile
        result={{ status: 'error', data: null, lastKnownData: bugsData, message: 'Azure DevOps unavailable' }}
        onRetry={retry}
      />,
    );
    expect(screen.getByText('24 bugs total')).toBeInTheDocument();
    expect(screen.getByText(/Last known data/i)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('home-dashboard-bugs-retry'));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe('DevToProductionTile', () => {
  it('renders a whole-card releases link and readable median', () => {
    render(<DevToProductionTile result={ok(devProdData)} onRetry={retry} />);
    expect(screen.getByRole('link', { name: /Developer to production: 11.4 days median/i })).toHaveAttribute('href', '/planning/releases');
  });

  it('explains what produces a median when empty, retries errors, and hides a null permission slice', () => {
    const { rerender } = render(<DevToProductionTile result={empty({ ...devProdData, medianDays: null, sampleSize: 0 })} onRetry={retry} />);
    expect(screen.getByText(/Link completed work items to a release/i)).toBeInTheDocument();
    rerender(<DevToProductionTile result={error('Failed to load Releases data.')} onRetry={retry} />);
    fireEvent.click(screen.getByTestId('home-dashboard-devprod-retry'));
    expect(retry).toHaveBeenCalledTimes(1);
    rerender(<DevToProductionTile result={null} onRetry={retry} />);
    expect(screen.queryByTestId('home-dashboard-devprod-card')).not.toBeInTheDocument();
  });

  it('explains that ReleaseVersion epics use related completed work items', () => {
    render(<DevToProductionTile result={ok(devProdData)} onRetry={retry} />);

    fireEvent.click(screen.getByTestId('home-dashboard-devprod-info'));

    expect(screen.getByTestId('home-dashboard-devprod-info-panel')).toHaveTextContent(
      /each related PBI, TBI, or bug is one sample/i,
    );
    expect(screen.getByTestId('home-dashboard-devprod-info-panel')).toHaveTextContent(
      /Incomplete items are excluded/i,
    );
  });

  it('PBI-005 AC-1 renders the last-known delivery median as stale with Retry', () => {
    render(
      <DevToProductionTile
        result={{ status: 'error', data: null, lastKnownData: devProdData, message: 'Releases unavailable' }}
        onRetry={retry}
      />,
    );
    expect(screen.getByText('11.4')).toBeInTheDocument();
    expect(screen.getByText(/Last known data/i)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('home-dashboard-devprod-retry'));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe('BugToPbiRatioTile', () => {
  it('renders bugs per PBI and the Mine/Team window', () => {
    render(<BugToPbiRatioTile result={ok(bugRatioData)} onRetry={retry} scope="team" />);
    expect(screen.getByTestId('home-dashboard-bug-ratio-card')).toHaveTextContent('0.4');
    expect(screen.getByText('8 bugs · 20 PBIs')).toBeInTheDocument();
    expect(screen.getByText('Team · Last 90 days')).toBeInTheDocument();
  });

  it('explains the ratio behind the info icon', () => {
    render(<BugToPbiRatioTile result={ok(bugRatioData)} onRetry={retry} scope="mine" />);
    fireEvent.click(screen.getByTestId('home-dashboard-bug-ratio-info'));
    expect(screen.getByTestId('home-dashboard-bug-ratio-info-panel')).toHaveTextContent(
      /bugs created in the last 90 days/i,
    );
    expect(screen.getByText('Mine · Last 90 days')).toBeInTheDocument();
  });

  it('explains what produces a ratio when empty and retries errors', () => {
    const { rerender } = render(
      <BugToPbiRatioTile result={empty({ ...bugRatioData, ratio: null, pbiCount: 0, bugCount: 0 })} onRetry={retry} />,
    );
    expect(screen.getByText(/Create a PBI in the last 90 days/i)).toBeInTheDocument();
    rerender(<BugToPbiRatioTile result={error('Could not load bug and PBI counts from Azure DevOps.')} onRetry={retry} />);
    fireEvent.click(screen.getByTestId('home-dashboard-bug-ratio-retry'));
    expect(retry).toHaveBeenCalledTimes(1);
    rerender(<BugToPbiRatioTile result={null} onRetry={retry} />);
    expect(screen.queryByTestId('home-dashboard-bug-ratio-card')).not.toBeInTheDocument();
  });
});

describe('HomeDashboardSection', () => {
  it('composes all independently authorized payload slices', () => {
    const payload: HomeDashboardPayload = {
      incompletePipeline: ok(pipelineData),
      artifactCycleTime: ok(cycleData),
      myWork: ok(myWorkData),
      openBugsOnPbis: ok(bugsData),
      bugToPbiRatio: ok(bugRatioData),
      devToProduction: ok(devProdData),
    };
    render(<HomeDashboardSection payload={payload} onRetry={retry} />);
    expect(screen.getByTestId('home-dashboard-root')).toBeInTheDocument();
    expect(screen.getByText('Project Status')).toBeInTheDocument();
    expect(screen.getAllByTestId(/home-dashboard-(pipeline|cycle-time|my-work|bugs|bug-ratio|devprod)-card/)).toHaveLength(6);
  });

  it('renders Mine and Team scope buttons and reports scope changes', () => {
    const onScopeChange = jest.fn();
    const payload: HomeDashboardPayload = {
      incompletePipeline: null,
      artifactCycleTime: null,
      myWork: null,
      openBugsOnPbis: null,
      bugToPbiRatio: null,
      devToProduction: null,
    };
    render(
      <HomeDashboardSection
        payload={payload}
        scope="mine"
        onScopeChange={onScopeChange}
        onRetry={retry}
      />,
    );
    expect(screen.getByRole('button', { name: 'Mine' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Team' }));
    expect(onScopeChange).toHaveBeenCalledWith('team');
  });

  it('omits each tile whose server permission slice is null', () => {
    const payload: HomeDashboardPayload = {
      incompletePipeline: null,
      artifactCycleTime: null,
      myWork: null,
      openBugsOnPbis: null,
      bugToPbiRatio: null,
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
    expect(screen.getByTestId('home-dashboard-bug-ratio-card')).toBeInTheDocument();
    expect(screen.getByTestId('home-dashboard-devprod-card')).toBeInTheDocument();
    expect(screen.queryByText('Incomplete Pipeline')).not.toBeInTheDocument();
  });
});

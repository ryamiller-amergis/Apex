import { render, screen, fireEvent } from '@testing-library/react';
import { DeploymentOutcomeReport } from '../DeploymentOutcomeReport';

const mockSetSelectedItem = jest.fn();

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({
    selectedProject: 'MaxView',
    selectedAreaPath: 'MaxView\\Area',
    setSelectedItem: mockSetSelectedItem,
  }),
}));

jest.mock('../../hooks/useDeploymentOutcomes', () => ({
  useOutcomeReport: jest.fn(),
  useFilteredOutcomes: jest.fn(),
  useExportOutcomeReport: jest.fn(),
  useAvailableReleaseVersions: jest.fn(),
  useReleaseEpics: jest.fn(),
  useReleaseRelatedCycleTime: jest.fn(),
}));

import {
  useOutcomeReport,
  useFilteredOutcomes,
  useExportOutcomeReport,
  useAvailableReleaseVersions,
  useReleaseEpics,
  useReleaseRelatedCycleTime,
} from '../../hooks/useDeploymentOutcomes';

const mockSummary = {
  total: 20,
  success: 14,
  downtime: 4,
  rollback: 2,
  avgDowntimeMinutes: 37,
  byMonth: [
    { month: '2026-01', success: 5, downtime: 1, rollback: 1 },
    { month: '2026-02', success: 4, downtime: 2, rollback: 0 },
    { month: '2026-03', success: 5, downtime: 1, rollback: 1 },
  ],
};

const mockOutcomes = [
  {
    id: 'o1',
    deploymentId: 'd1',
    releaseVersion: 'v1.0.0',
    environment: 'production',
    result: 'success' as const,
    downtimeMinutes: undefined,
    details: 'Smooth deployment',
    reportedBy: 'user-1',
    reportedAt: '2026-01-15T10:00:00Z',
  },
  {
    id: 'o2',
    deploymentId: 'd2',
    releaseVersion: 'v1.1.0',
    environment: 'production',
    result: 'downtime' as const,
    downtimeMinutes: 45,
    details: 'Database migration caused brief outage',
    reportedBy: 'user-2',
    reportedAt: '2026-02-20T14:30:00Z',
  },
  {
    id: 'o3',
    deploymentId: 'd3',
    releaseVersion: 'v1.2.0',
    environment: 'production',
    result: 'rollback' as const,
    downtimeMinutes: 120,
    details: 'Critical bug in auth flow',
    reportedBy: 'user-1',
    reportedAt: '2026-03-10T09:00:00Z',
  },
];

const mockAvailableVersions = ['v1.2.0', 'v1.1.0', 'v1.0.0'];

// v1.3.0 and v1.4.0 have no recorded outcome — they still belong in the report.
const mockReleaseEpics = [
  { id: 101, version: 'v1.0.0', status: 'released', targetDate: '2026-01-15' },
  { id: 102, version: 'v1.1.0', status: 'released', targetDate: '2026-02-20' },
  { id: 103, version: 'v1.2.0', status: 'released', targetDate: '2026-03-10' },
  { id: 104, version: 'v1.3.0', status: 'in-progress', targetDate: '2026-04-18' },
  { id: 105, version: 'v1.4.0', status: 'planned', targetDate: '2026-05-22' },
];

function setupMocks() {
  (useOutcomeReport as jest.Mock).mockReturnValue({
    data: mockSummary,
    isLoading: false,
    error: null,
  });
  (useFilteredOutcomes as jest.Mock).mockReturnValue({
    data: mockOutcomes,
    isLoading: false,
  });
  (useExportOutcomeReport as jest.Mock).mockReturnValue(jest.fn());
  (useAvailableReleaseVersions as jest.Mock).mockReturnValue({
    data: mockAvailableVersions,
    isLoading: false,
  });
  (useReleaseEpics as jest.Mock).mockReturnValue({
    data: mockReleaseEpics,
    isLoading: false,
  });
  (useReleaseRelatedCycleTime as jest.Mock).mockReturnValue({
    data: undefined,
    isLoading: false,
    error: null,
  });
}

describe('DeploymentOutcomeReport', () => {
  const onClose = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    setupMocks();
  });

  it('renders the page header with title and close button', () => {
    render(<DeploymentOutcomeReport onClose={onClose} />);
    expect(screen.getByText('Deployment Outcome Report')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /back to releases/i })).toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', () => {
    render(<DeploymentOutcomeReport onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /back to releases/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders summary cards with correct values', () => {
    render(<DeploymentOutcomeReport onClose={onClose} />);
    expect(screen.getByText('20')).toBeInTheDocument();
    expect(screen.getByText('70.0%')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('37 min')).toBeInTheDocument();
  });

  it('renders the pie chart with SVG elements', () => {
    const { container } = render(<DeploymentOutcomeReport onClose={onClose} />);
    const svgEl = container.querySelector('svg');
    expect(svgEl).toBeInTheDocument();
    const circles = container.querySelectorAll('circle');
    expect(circles.length).toBeGreaterThanOrEqual(1);
  });

  it('renders the bar chart section', () => {
    render(<DeploymentOutcomeReport onClose={onClose} />);
    expect(screen.getByText(/Monthly Trend/i)).toBeInTheDocument();
  });

  it('renders data table with outcome rows', () => {
    render(<DeploymentOutcomeReport onClose={onClose} />);
    expect(screen.getByText('v1.0.0')).toBeInTheDocument();
    expect(screen.getByText('v1.1.0')).toBeInTheDocument();
    expect(screen.getByText('v1.2.0')).toBeInTheDocument();
  });

  it('lists releases that have no recorded outcome', () => {
    render(<DeploymentOutcomeReport onClose={onClose} />);

    expect(screen.getByText('v1.3.0')).toBeInTheDocument();
    expect(screen.getByText('v1.4.0')).toBeInTheDocument();
    expect(screen.getByTestId('outcome-report-not-recorded-release:104')).toBeInTheDocument();
    expect(screen.getByTestId('outcome-report-expand-release:105')).toBeInTheDocument();
  });

  it('shows the release target date as the deploy date for unrecorded releases', () => {
    render(<DeploymentOutcomeReport onClose={onClose} />);

    const row = screen.getByTestId('outcome-report-expand-release:104').closest('tr')!;
    expect(row).toHaveTextContent('Apr 18, 2026');
  });

  it('fetches cycle time for releases with no recorded outcome', () => {
    render(<DeploymentOutcomeReport onClose={onClose} />);

    expect(useReleaseRelatedCycleTime).toHaveBeenCalledWith(104, 'MaxView', 'MaxView\\Area', true);
  });

  it('hides unrecorded releases when a result filter is applied', () => {
    render(<DeploymentOutcomeReport onClose={onClose} />);

    fireEvent.change(screen.getByTestId('outcome-report-result-filter'), {
      target: { value: 'success' },
    });
    fireEvent.click(screen.getByTestId('outcome-report-apply'));

    expect(screen.queryByText('v1.3.0')).not.toBeInTheDocument();
    expect(screen.queryByText('v1.4.0')).not.toBeInTheDocument();
  });

  it('offers release versions with no recorded outcome in the version filter', () => {
    render(<DeploymentOutcomeReport onClose={onClose} />);

    fireEvent.focus(screen.getByPlaceholderText(/search releases/i));

    expect(screen.getByTestId('outcome-report-version-option-v1.4.0')).toBeInTheDocument();
  });

  it('keeps only the selected version when the version filter is applied', () => {
    render(<DeploymentOutcomeReport onClose={onClose} />);

    fireEvent.focus(screen.getByPlaceholderText(/search releases/i));
    fireEvent.mouseDown(screen.getByTestId('outcome-report-version-option-v1.3.0'));
    fireEvent.click(screen.getByTestId('outcome-report-apply'));

    expect(screen.getByTestId('outcome-report-expand-release:104')).toBeInTheDocument();
    expect(screen.queryByTestId('outcome-report-expand-release:105')).not.toBeInTheDocument();
  });

  it('renders result badges in the data table', () => {
    const { container } = render(<DeploymentOutcomeReport onClose={onClose} />);
    const badges = container.querySelectorAll('[class*="resultBadge"]');
    expect(badges.length).toBe(3);
    const badgeTexts = Array.from(badges).map((b) => b.textContent);
    expect(badgeTexts).toContain('success');
    expect(badgeTexts).toContain('downtime');
    expect(badgeTexts).toContain('rollback');
  });

  it('renders export CSV button that triggers exportReport', async () => {
    const mockExport = jest.fn();
    (useExportOutcomeReport as jest.Mock).mockReturnValue(mockExport);
    render(<DeploymentOutcomeReport onClose={onClose} />);

    const csvBtn = screen.getByRole('button', { name: /csv/i });
    fireEvent.click(csvBtn);
    expect(mockExport).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'csv' }),
    );
  });

  it('renders date picker trigger buttons in the filter section', () => {
    render(<DeploymentOutcomeReport onClose={onClose} />);
    expect(screen.getByText(/pick start date/i)).toBeInTheDocument();
    expect(screen.getByText(/pick end date/i)).toBeInTheDocument();
  });

  it('renders release version multi-select with available options typeahead', () => {
    render(<DeploymentOutcomeReport onClose={onClose} />);
    const input = screen.getByPlaceholderText(/search releases/i);
    expect(input).toBeInTheDocument();

    // Type to trigger dropdown
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'v1' } });
    // Available versions should appear as options in the dropdown
    const versionOptions = screen.getAllByText('v1.2.0');
    expect(versionOptions.length).toBeGreaterThan(0);
  });

  it('clears filters when clear button is clicked', () => {
    render(<DeploymentOutcomeReport onClose={onClose} />);

    const clearBtn = screen.getByRole('button', { name: /clear/i });
    fireEvent.click(clearBtn);

    // After clear the filters should be empty (no startDate, endDate, or result)
    expect(useOutcomeReport).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ startDate: expect.anything() }),
    );
  });

  it('shows loading state', () => {
    (useOutcomeReport as jest.Mock).mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });
    (useFilteredOutcomes as jest.Mock).mockReturnValue({
      data: undefined,
      isLoading: true,
    });
    render(<DeploymentOutcomeReport onClose={onClose} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('shows error state', () => {
    (useOutcomeReport as jest.Mock).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('Network error'),
    });
    render(<DeploymentOutcomeReport onClose={onClose} />);
    expect(screen.getByText(/error/i)).toBeInTheDocument();
  });

  it('shows active filter chips after Apply and lets user remove them', () => {
    render(<DeploymentOutcomeReport onClose={onClose} />);

    // Set result filter and apply
    const resultSelect = screen.getByRole('combobox');
    fireEvent.change(resultSelect, { target: { value: 'rollback' } });
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));

    // Active chip should appear
    const chip = screen.getByText(/rollback/i, { selector: '[class*="activeChip"]' });
    expect(chip).toBeInTheDocument();

    // Clicking the × on the chip clears that filter
    const removeBtn = chip.parentElement!.querySelector('button')!;
    fireEvent.click(removeBtn);

    expect(useOutcomeReport).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ result: expect.anything() }),
    );
  });
});

// ── DatePickerInput behaviour ──────────────────────────────────────────────────

describe('DatePickerInput (via filter section)', () => {
  const onClose = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (useOutcomeReport as jest.Mock).mockReturnValue({ data: null, isLoading: false, error: null });
    (useFilteredOutcomes as jest.Mock).mockReturnValue({ data: [], isLoading: false });
    (useExportOutcomeReport as jest.Mock).mockReturnValue(jest.fn());
    (useAvailableReleaseVersions as jest.Mock).mockReturnValue({ data: [], isLoading: false });
    (useReleaseEpics as jest.Mock).mockReturnValue({ data: [], isLoading: false });
    (useReleaseRelatedCycleTime as jest.Mock).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
    });
  });

  it('renders start-date trigger with placeholder text', () => {
    render(<DeploymentOutcomeReport onClose={onClose} />);
    expect(screen.getByText(/pick start date/i)).toBeInTheDocument();
  });

  it('opens the calendar popover when the trigger is clicked', () => {
    render(<DeploymentOutcomeReport onClose={onClose} />);
    const trigger = screen.getByText(/pick start date/i).closest('button')!;
    fireEvent.click(trigger);
    // Should now show month/year nav buttons (‹ and ›)
    const navBtns = screen.getAllByTitle(/previous month|next month/i);
    expect(navBtns.length).toBeGreaterThanOrEqual(1);
  });

  it('selects a date and shows it on the trigger', () => {
    render(<DeploymentOutcomeReport onClose={onClose} />);
    const trigger = screen.getByText(/pick start date/i).closest('button')!;
    fireEvent.click(trigger);
    // Click the day "15" in the open calendar
    const dayBtn = screen.getAllByRole('button', { name: '15' })[0];
    fireEvent.click(dayBtn);
    // Calendar closes and date appears on trigger
    expect(screen.queryAllByTitle(/previous month/i).length).toBe(0);
    // The trigger should now show a date string containing "15"
    expect(trigger.textContent).toContain('15');
  });

  it('clears the date when the × button is clicked', () => {
    render(<DeploymentOutcomeReport onClose={onClose} />);
    const trigger = screen.getByText(/pick start date/i).closest('button')!;
    fireEvent.click(trigger);
    fireEvent.click(screen.getAllByRole('button', { name: '10' })[0]);
    // × clear button should now be visible
    const clearBtn = screen.getByTitle(/clear date/i);
    fireEvent.click(clearBtn);
    expect(screen.getByText(/pick start date/i)).toBeInTheDocument();
  });
});

// ── MultiSelectTypeahead behaviour ────────────────────────────────────────────

describe('MultiSelectTypeahead (via filter section)', () => {
  const onClose = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (useOutcomeReport as jest.Mock).mockReturnValue({ data: null, isLoading: false, error: null });
    (useFilteredOutcomes as jest.Mock).mockReturnValue({ data: [], isLoading: false });
    (useExportOutcomeReport as jest.Mock).mockReturnValue(jest.fn());
    (useAvailableReleaseVersions as jest.Mock).mockReturnValue({
      data: ['v2.0.0', 'v1.1.0', 'v1.0.0'],
      isLoading: false,
    });
    (useReleaseEpics as jest.Mock).mockReturnValue({ data: [], isLoading: false });
    (useReleaseRelatedCycleTime as jest.Mock).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
    });
  });

  it('shows all available options when input is focused', () => {
    render(<DeploymentOutcomeReport onClose={onClose} />);
    const input = screen.getByPlaceholderText(/search releases/i);
    fireEvent.focus(input);
    expect(screen.getByRole('button', { name: 'v2.0.0' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'v1.1.0' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'v1.0.0' })).toBeInTheDocument();
  });

  it('filters options based on typed query', () => {
    render(<DeploymentOutcomeReport onClose={onClose} />);
    const input = screen.getByPlaceholderText(/search releases/i);
    fireEvent.change(input, { target: { value: '2.0' } });
    expect(screen.getByRole('button', { name: 'v2.0.0' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'v1.0.0' })).not.toBeInTheDocument();
  });

  it('adds a chip when an option is selected', () => {
    render(<DeploymentOutcomeReport onClose={onClose} />);
    const input = screen.getByPlaceholderText(/search releases/i);
    fireEvent.focus(input);
    fireEvent.mouseDown(screen.getByRole('button', { name: 'v1.0.0' }));
    // Remove button for the chip appears (proves chip was created)
    expect(screen.getByTitle(/remove v1\.0\.0/i)).toBeInTheDocument();
    // The option no longer shows in the dropdown (already selected)
    expect(screen.queryByRole('button', { name: 'v1.0.0' })).not.toBeInTheDocument();
  });

  it('removes a chip when its × button is clicked', () => {
    render(<DeploymentOutcomeReport onClose={onClose} />);
    const input = screen.getByPlaceholderText(/search releases/i);
    fireEvent.focus(input);
    fireEvent.mouseDown(screen.getByRole('button', { name: 'v1.0.0' }));

    const chipRemove = screen.getByTitle(/remove v1\.0\.0/i);
    fireEvent.click(chipRemove);

    // Remove button gone → chip removed
    expect(screen.queryByTitle(/remove v1\.0\.0/i)).not.toBeInTheDocument();
  });

  it('pressing Enter selects the first filtered option', () => {
    render(<DeploymentOutcomeReport onClose={onClose} />);
    const input = screen.getByPlaceholderText(/search releases/i);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'v2' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTitle(/remove v2\.0\.0/i)).toBeInTheDocument();
  });

  it('pressing Backspace removes the last chip when input is empty', () => {
    render(<DeploymentOutcomeReport onClose={onClose} />);
    const input = screen.getByPlaceholderText(/search releases/i);
    fireEvent.focus(input);
    fireEvent.mouseDown(screen.getByRole('button', { name: 'v1.0.0' }));
    // Confirm chip exists first
    expect(screen.getByTitle(/remove v1\.0\.0/i)).toBeInTheDocument();
    // Backspace with empty input removes it
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(screen.queryByTitle(/remove v1\.0\.0/i)).not.toBeInTheDocument();
  });
});

describe('DeploymentOutcomeReport cycle time expand', () => {
  const onClose = jest.fn();

  const workItem = (id: number, title: string, state: string) => ({
    id,
    title,
    state,
    workItemType: 'Product Backlog Item',
    changedDate: '2026-01-05T00:00:00.000Z',
    createdDate: '2026-01-01T00:00:00.000Z',
    areaPath: 'MaxView\\Area',
    iterationPath: 'MaxView\\Sprint 1',
  });

  const cyclePayload = {
    items: [
      {
        id: 501,
        title: 'Completed PBI',
        workItemType: 'Product Backlog Item',
        state: 'Done',
        lastInProgressAt: '2026-01-01T00:00:00.000Z',
        lastDoneAt: '2026-01-05T00:00:00.000Z',
        cycleTimeDays: 4.2,
        incompleteReason: null,
        workItem: workItem(501, 'Completed PBI', 'Done'),
      },
      {
        id: 502,
        title: 'Still in progress',
        workItemType: 'Bug',
        state: 'In Progress',
        lastInProgressAt: '2026-01-02T00:00:00.000Z',
        lastDoneAt: null,
        cycleTimeDays: null,
        incompleteReason: 'missing_done' as const,
        workItem: workItem(502, 'Still in progress', 'In Progress'),
      },
    ],
    medianDays: 4.2,
    avgDays: 4.2,
    sampleSize: 1,
    incompleteCount: 1,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    setupMocks();
  });

  it('shows median cycle time without expanding the row', () => {
    (useReleaseRelatedCycleTime as jest.Mock).mockReturnValue({
      data: cyclePayload,
      isLoading: false,
      error: null,
    });
    render(<DeploymentOutcomeReport onClose={onClose} />);

    expect(screen.getByTestId('outcome-report-cycle-time-o1')).toHaveTextContent('4.2 d');
    expect(screen.queryByTestId('outcome-report-cycle-panel-o1')).not.toBeInTheDocument();
    expect(useReleaseRelatedCycleTime).toHaveBeenCalledWith(101, 'MaxView', 'MaxView\\Area', true);
  });

  it('opens the details panel when a work item row is clicked', () => {
    (useReleaseRelatedCycleTime as jest.Mock).mockReturnValue({
      data: cyclePayload,
      isLoading: false,
      error: null,
    });
    render(<DeploymentOutcomeReport onClose={onClose} />);
    fireEvent.click(screen.getByTestId('outcome-report-expand-o1'));

    fireEvent.click(screen.getByTestId('outcome-report-cycle-item-501'));

    expect(mockSetSelectedItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: 501, title: 'Completed PBI' }),
    );
  });

  it('opens the details panel from the work item id button', () => {
    (useReleaseRelatedCycleTime as jest.Mock).mockReturnValue({
      data: cyclePayload,
      isLoading: false,
      error: null,
    });
    render(<DeploymentOutcomeReport onClose={onClose} />);
    fireEvent.click(screen.getByTestId('outcome-report-expand-o1'));

    fireEvent.click(screen.getByTestId('outcome-report-cycle-item-open-502'));

    expect(mockSetSelectedItem).toHaveBeenCalledTimes(1);
    expect(mockSetSelectedItem).toHaveBeenCalledWith(expect.objectContaining({ id: 502 }));
  });

  it('loads and shows median cycle time after expand', () => {
    (useReleaseRelatedCycleTime as jest.Mock).mockReturnValue({
      data: cyclePayload,
      isLoading: false,
      error: null,
    });
    render(<DeploymentOutcomeReport onClose={onClose} />);
    fireEvent.click(screen.getByTestId('outcome-report-expand-o1'));
    expect(screen.getByTestId('outcome-report-cycle-time-o1')).toHaveTextContent('4.2 d');
    expect(screen.getByText(/Median cycle time · 1 of 2 items completed/i)).toBeInTheDocument();
    expect(screen.getByTestId('outcome-report-cycle-item-501')).toHaveTextContent('Completed PBI');
  });

  it('shows a note for incomplete items that never reached Done', () => {
    (useReleaseRelatedCycleTime as jest.Mock).mockReturnValue({
      data: cyclePayload,
      isLoading: false,
      error: null,
    });
    render(<DeploymentOutcomeReport onClose={onClose} />);
    fireEvent.click(screen.getByTestId('outcome-report-expand-o1'));
    expect(screen.getByTestId('outcome-report-cycle-item-502')).toHaveTextContent('Never reached Done');
  });

  it('shows loading while cycle time is fetching', () => {
    (useReleaseRelatedCycleTime as jest.Mock).mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });
    render(<DeploymentOutcomeReport onClose={onClose} />);
    fireEvent.click(screen.getByTestId('outcome-report-expand-o1'));
    expect(screen.getByTestId('outcome-report-cycle-loading-o1')).toHaveTextContent(/loading cycle time/i);
  });

  it('shows an empty state when no matching Epic exists', () => {
    (useReleaseEpics as jest.Mock).mockReturnValue({
      data: [],
      isLoading: false,
    });
    render(<DeploymentOutcomeReport onClose={onClose} />);
    fireEvent.click(screen.getByTestId('outcome-report-expand-o1'));
    expect(screen.getByTestId('outcome-report-cycle-empty-o1')).toHaveTextContent(
      /no matching release epic/i,
    );
    expect(screen.getByTestId('outcome-report-cycle-time-o1')).toHaveTextContent('—');
    expect(useReleaseRelatedCycleTime).toHaveBeenCalledWith(undefined, 'MaxView', 'MaxView\\Area', false);
  });
});


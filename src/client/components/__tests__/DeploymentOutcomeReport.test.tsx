import { render, screen, fireEvent } from '@testing-library/react';
import { DeploymentOutcomeReport } from '../DeploymentOutcomeReport';

jest.mock('../../hooks/useDeploymentOutcomes', () => ({
  useOutcomeReport: jest.fn(),
  useFilteredOutcomes: jest.fn(),
  useExportOutcomeReport: jest.fn(),
  useAvailableReleaseVersions: jest.fn(),
}));

import {
  useOutcomeReport,
  useFilteredOutcomes,
  useExportOutcomeReport,
  useAvailableReleaseVersions,
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

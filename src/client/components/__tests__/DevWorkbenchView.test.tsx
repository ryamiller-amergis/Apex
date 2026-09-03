import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DevWorkbenchView } from '../DevWorkbenchView';

const mockNavigate = jest.fn();
const mockStartMutateAsync = jest.fn();
const mockCloseMutateAsync = jest.fn();
const mockCompleteMutateAsync = jest.fn();
const mockStartLocalMutateAsync = jest.fn();
const mockStartCloudMutateAsync = jest.fn();
const mockCancelCloudMutateAsync = jest.fn();
const mockUseFeatureFlag = jest.fn().mockReturnValue(false);

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: jest.fn(),
}));

jest.mock('../../hooks/useDevWorkbench', () => ({
  useAssignedWorkItems: jest.fn(),
  useActiveSessions: jest.fn(),
  useStartDevSession: jest.fn(),
  useCloseDevSession: jest.fn(),
  useCompleteFeature: jest.fn(),
  useStartLocalFeature: jest.fn(),
  useStartCloudAgentRun: jest.fn(),
  useCloudAgentRun: jest.fn(),
  useDevSession: jest.fn(),
  useCancelCloudAgentRun: jest.fn(),
}));

jest.mock('../../hooks/useApexBacklog', () => ({
  useApexBacklogFeatures: jest.fn(),
}));

jest.mock('../../hooks/useProjectMenuConfig', () => ({
  useProjectMenuConfig: jest.fn(),
}));

jest.mock('../../hooks/useApexWorkItems', () => ({
  useAssignedBoardItems: jest.fn(),
}));

jest.mock('../../hooks/useFeatureFlags', () => ({
  useFeatureFlag: (...args: unknown[]) => mockUseFeatureFlag(...args),
  useFeatureFlags: jest.fn().mockReturnValue({ flags: {}, isLoading: false }),
}));

jest.mock('../StartLocalDevModal', () => ({
  __esModule: true,
  default: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="start-local-modal">
      <button type="button" onClick={onClose}>Close Local Modal</button>
    </div>
  ),
}));

jest.mock('../FeatureContextModal', () => ({
  __esModule: true,
  default: ({ feature, onClose }: { feature: { featureId: string }; onClose: () => void }) => (
    <div data-testid="feature-context-modal">
      <span>Context for {feature.featureId}</span>
      <button type="button" onClick={onClose}>Close Context</button>
    </div>
  ),
}));

import { useAppShell } from '../../hooks/useAppShell';
import {
  useAssignedWorkItems,
  useActiveSessions,
  useStartDevSession,
  useCloseDevSession,
  useCompleteFeature,
  useStartLocalFeature,
  useStartCloudAgentRun,
  useCloudAgentRun,
  useDevSession,
  useCancelCloudAgentRun,
} from '../../hooks/useDevWorkbench';
import { useApexBacklogFeatures } from '../../hooks/useApexBacklog';
import { useProjectMenuConfig } from '../../hooks/useProjectMenuConfig';
import { useAssignedBoardItems } from '../../hooks/useApexWorkItems';
import type {
  ActiveDevSession,
  ApexBacklogGroup,
  CloudAgentRunSummary,
  LeftoverWorkSummary,
} from '../../../shared/types/devWorkbench';

const workItems = [
  {
    id: 42,
    title: 'Implement login',
    workItemType: 'Feature',
    state: 'In Progress',
    assignedTo: 'jane@example.com',
    project: 'MaxView',
    tags: 'apex; wave-1',
  },
  {
    id: 99,
    title: 'Fix crash',
    workItemType: 'Bug',
    state: 'New',
    assignedTo: 'jane@example.com',
    project: 'MaxView',
  },
];

function renderView() {
  return render(
    <MemoryRouter>
      <DevWorkbenchView />
    </MemoryRouter>,
  );
}

function cloudRun(
  status: CloudAgentRunSummary['status'],
  overrides: Partial<CloudAgentRunSummary> = {},
): CloudAgentRunSummary {
  return {
    runId: 'run-1',
    status,
    prUrl: null,
    prStatus: 'none',
    finishedWithoutPr: false,
    terminalReason: null,
    checkResults: null,
    failingChecks: [],
    lastError: null,
    ...overrides,
  };
}

function mockCloudSession(
  run: CloudAgentRunSummary,
  leftoverWork: LeftoverWorkSummary | null = null,
) {
  (useActiveSessions as jest.Mock).mockReturnValue({
    data: [{
      id: 'cloud-session',
      workItemId: 42,
      status: 'in_progress',
      chatThreadId: null,
      branchName: null,
      prUrl: run.prUrl,
      createdAt: '2026-09-01T00:00:00Z',
      cloudAgentRun: run,
      leftoverWork,
    }],
  });
  (useCloudAgentRun as jest.Mock).mockReturnValue({ data: run, error: null });
  (useDevSession as jest.Mock).mockReturnValue({
    data: {
      id: 'cloud-session',
      cloudAgentRun: run,
      leftoverWork,
    },
  });
}

/** The assigned-work row for one item, so row-scoped nodes are queried per row. */
function workItemRow(itemId: number): HTMLElement {
  const row = screen.getByText(`#${itemId}`).closest('.item');
  if (!(row instanceof HTMLElement)) throw new Error(`No work item row for item ${itemId}`);
  return row;
}

/** The cloud run controls for one row, so row-scoped nodes are queried per row. */
function cloudRunControls(itemId: number): HTMLElement {
  const controls = screen.getByTestId(`my-work-cloud-run-status-${itemId}`).parentElement;
  if (!controls) throw new Error(`No cloud run controls for item ${itemId}`);
  return controls;
}

describe('DevWorkbenchView', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    (useAppShell as jest.Mock).mockReturnValue({ selectedProject: 'MaxView', isSuperAdmin: false });
    (useAssignedWorkItems as jest.Mock).mockReturnValue({
      data: workItems,
      isLoading: false,
      error: null,
    });
    (useActiveSessions as jest.Mock).mockReturnValue({ data: [] });
    (useStartDevSession as jest.Mock).mockReturnValue({
      mutateAsync: mockStartMutateAsync,
      error: null,
    });
    (useCloseDevSession as jest.Mock).mockReturnValue({
      mutateAsync: mockCloseMutateAsync,
    });
    (useCompleteFeature as jest.Mock).mockReturnValue({
      mutateAsync: mockCompleteMutateAsync,
      error: null,
    });
    (useStartLocalFeature as jest.Mock).mockReturnValue({
      mutateAsync: mockStartLocalMutateAsync,
      isPending: false,
      error: null,
    });
    (useStartCloudAgentRun as jest.Mock).mockReturnValue({
      mutateAsync: mockStartCloudMutateAsync,
      isPending: false,
      error: null,
    });
    (useCloudAgentRun as jest.Mock).mockReturnValue({
      data: null,
      error: null,
    });
    (useDevSession as jest.Mock).mockReturnValue({ data: undefined });
    (useCancelCloudAgentRun as jest.Mock).mockReturnValue({
      mutateAsync: mockCancelCloudMutateAsync,
      isPending: false,
      error: null,
    });
    mockUseFeatureFlag.mockReturnValue(false);
    (useApexBacklogFeatures as jest.Mock).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
    });
    (useProjectMenuConfig as jest.Mock).mockReturnValue({
      enabledViews: [],
      isLoading: false,
    });
    (useAssignedBoardItems as jest.Mock).mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    });
  });

  it('renders the My Work header and assigned work items', () => {
    renderView();

    expect(screen.getByRole('heading', { name: 'My Work' })).toBeInTheDocument();
    expect(screen.getByText('Implement login')).toBeInTheDocument();
    expect(screen.getByText('Fix crash')).toBeInTheDocument();
    expect(screen.getByText('#42')).toBeInTheDocument();
    expect(screen.getByText('Feature')).toBeInTheDocument();
  });

  it('shows a loading state while work items are loading', () => {
    (useAssignedWorkItems as jest.Mock).mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });

    renderView();

    expect(screen.getByText(/loading assigned work items/i)).toBeInTheDocument();
  });

  it('shows an error state when work items fail to load', () => {
    (useAssignedWorkItems as jest.Mock).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('Network error'),
    });

    renderView();

    expect(screen.getByText(/failed to load work items/i)).toBeInTheDocument();
    expect(screen.getByText(/network error/i)).toBeInTheDocument();
  });

  it('shows an empty state when no work items are assigned', () => {
    (useAssignedWorkItems as jest.Mock).mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    });

    renderView();

    expect(screen.getByText(/no active work items assigned to you/i)).toBeInTheDocument();
  });

  it('PBI-002 VT flag-off: hides cloud controls and keeps local development available', () => {
    renderView();
    expect(screen.queryByRole('button', { name: /^Start cloud agent$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Start Development$/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Start Local Development$/i })).toHaveLength(2);
  });

  it('PBI-002 AC-1 / VT-12: disables cloud agent start and visibly exposes the server reason', () => {
    const reason = 'Skill settings are incomplete: skillRepo is not set.';
    mockUseFeatureFlag.mockReturnValue(true);
    (useAssignedWorkItems as jest.Mock).mockReturnValue({
      data: [{
        ...workItems[0],
        cloudAgentEligibility: { allowed: false, reason },
      }],
      isLoading: false,
      error: null,
    });

    renderView();

    const button = screen.getByRole('button', { name: /^Start cloud agent$/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-describedby', 'my-work-start-cloud-dev-reason-42');
    expect(screen.getByTestId('my-work-start-cloud-dev-reason-42')).toHaveTextContent(reason);
  });

  it('PBI-002 AC-0: shows enabled cloud start beside local development', async () => {
    mockUseFeatureFlag.mockReturnValue(true);
    mockStartCloudMutateAsync.mockResolvedValue({ sessionId: 'cloud-session', runId: 'run-1' });
    (useAssignedWorkItems as jest.Mock).mockReturnValue({
      data: [{
        ...workItems[0],
        cloudAgentEligibility: { allowed: true },
      }],
      isLoading: false,
      error: null,
    });

    renderView();
    expect(screen.queryByRole('button', { name: /^Start Development$/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Start Local Development$/i })).toBeInTheDocument();
    const cloudStart = screen.getByTestId('my-work-start-cloud-dev-btn');
    expect(cloudStart).toBeEnabled();
    fireEvent.click(cloudStart);

    await waitFor(() => {
      expect(mockStartCloudMutateAsync).toHaveBeenCalledWith({
        workItemId: 42,
        project: 'MaxView',
      });
      expect(screen.getByTestId('my-work-cloud-run-status-42')).toHaveTextContent('Queued');
      expect(screen.getByTestId('my-work-cancel-cloud-run-42')).toBeInTheDocument();
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it.each([
    ['queued', 'Queued'],
    ['dispatched', 'Starting'],
    ['running', 'Running'],
  ] as const)(
    'PBI-003 AC-0 / PBI-004 AC-2: renders %s as %s with the same Cancel operation',
    async (status, label) => {
      mockUseFeatureFlag.mockReturnValue(true);
      mockCloudSession(cloudRun(status));
      mockCancelCloudMutateAsync.mockResolvedValue({ ok: true, status: 'cancelled' });

      renderView();

      const statusRegion = screen.getByTestId('my-work-cloud-run-status-42');
      expect(statusRegion).toHaveTextContent(label);
      expect(statusRegion.parentElement).toHaveAttribute('aria-live', 'polite');
      expect(screen.queryByTestId('my-work-resume-cloud-run-42')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('my-work-cancel-cloud-run-42'));

      await waitFor(() => {
        expect(mockCancelCloudMutateAsync).toHaveBeenCalledWith('cloud-session');
        expect(screen.getByTestId('my-work-cloud-run-status-42')).toHaveTextContent('Cancelled');
        expect(screen.getByTestId('my-work-resume-cloud-run-42')).toBeInTheDocument();
      });
    },
  );

  it('a cloud-only session keeps local controls available without the legacy start action', () => {
    mockUseFeatureFlag.mockReturnValue(true);
    mockCloudSession(cloudRun('running'));

    renderView();

    expect(within(workItemRow(42)).queryByRole('button', { name: 'Start Development' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume Session' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close Session' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Start Local Development' })).toHaveLength(2);
    expect(screen.getByTestId('my-work-cancel-cloud-run-42')).toBeInTheDocument();
  });

  it('opens cloud run details from the integrated status control', () => {
    mockUseFeatureFlag.mockReturnValue(true);
    mockCloudSession(cloudRun('running'));

    renderView();
    fireEvent.click(screen.getByRole('button', { name: /view cloud agent run details: running/i }));

    expect(screen.getByTestId('my-work-cloud-run-drawer-42')).toBeInTheDocument();
    expect(screen.getByText('Activity')).toBeInTheDocument();
    expect(screen.getByText(/streaming events become available/i)).toBeInTheDocument();
  });

  it('TBI-004 DoD-3: keeps an actual legacy session beside a live cloud run', () => {
    mockUseFeatureFlag.mockReturnValue(true);
    const running = cloudRun('running');
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'cloud-session',
          workItemId: 42,
          status: 'in_progress',
          chatThreadId: null,
          branchName: null,
          prUrl: null,
          createdAt: '2026-09-02T00:00:00Z',
          cloudAgentRun: running,
        },
        {
          id: 'legacy-session',
          workItemId: 42,
          status: 'in_progress',
          chatThreadId: 'thread-1',
          branchName: 'feature/42',
          prUrl: null,
          createdAt: '2026-09-01T00:00:00Z',
        },
      ],
    });
    (useCloudAgentRun as jest.Mock).mockReturnValue({ data: running, error: null });

    renderView();

    expect(screen.getByRole('button', { name: 'Resume Session' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close Session' })).toBeInTheDocument();
    expect(screen.getByTestId('my-work-cancel-cloud-run-42')).toBeInTheDocument();
  });

  it('PBI-004 AC-0: disables Cancel and labels it Cancelling... while pending', () => {
    mockUseFeatureFlag.mockReturnValue(true);
    mockCloudSession(cloudRun('running'));
    (useCancelCloudAgentRun as jest.Mock).mockReturnValue({
      mutateAsync: mockCancelCloudMutateAsync,
      isPending: true,
      error: null,
    });

    renderView();

    const cancel = screen.getByTestId('my-work-cancel-cloud-run-42');
    expect(cancel).toBeDisabled();
    expect(cancel).toHaveTextContent('Cancelling...');
  });

  it('PBI-005 AC-0: renders a stable accessible PR link and Resume for completion', () => {
    const prUrl = 'https://github.com/example/apex/pull/42';
    mockUseFeatureFlag.mockReturnValue(true);
    mockCloudSession(cloudRun('completed', { prUrl }));

    renderView();

    expect(screen.getByTestId('my-work-cloud-run-status-42')).toHaveTextContent('Completed');
    expect(screen.getByTestId('my-work-cloud-run-pr-42')).toHaveAttribute('href', prUrl);
    expect(within(cloudRunControls(42)).getByRole('link', { name: 'View PR' })).toBeInTheDocument();
    expect(screen.getByTestId('my-work-resume-cloud-run-42')).toBeInTheDocument();
  });

  it.each([
    ['open', 'Open'],
    ['merged', 'Merged'],
  ] as const)(
    'PBI-007 AC-0 / accessibility: shows %s PR status as text beside the PR link',
    (prStatus, label) => {
      const prUrl = 'https://github.com/example/apex/pull/42';
      mockUseFeatureFlag.mockReturnValue(true);
      mockCloudSession(cloudRun('completed', { prUrl, prStatus }));

      renderView();

      const status = within(cloudRunControls(42)).getByTestId('my-work-row-pr-status');
      expect(status).toHaveTextContent(label);
      const prLink = screen.getByTestId('my-work-cloud-run-pr-42');
      expect(prLink.parentElement).toContainElement(status);
      expect(status.closest('[aria-live="polite"]')).not.toBeNull();
    },
  );

  it('PBI-007 AC-0 / accessibility: renders no PR status text when the PR status is none', () => {
    const prUrl = 'https://github.com/example/apex/pull/42';
    mockUseFeatureFlag.mockReturnValue(true);
    mockCloudSession(cloudRun('completed', { prUrl, prStatus: 'none' }));

    renderView();

    expect(screen.getByTestId('my-work-cloud-run-pr-42')).toBeInTheDocument();
    expect(screen.queryByTestId('my-work-row-pr-status')).not.toBeInTheDocument();
  });

  it('PBI-007 AC-0 / accessibility: renders no PR status text when the run has no PR URL', () => {
    mockUseFeatureFlag.mockReturnValue(true);
    mockCloudSession(cloudRun('completed', { prUrl: null, prStatus: 'open' }));

    renderView();

    expect(screen.queryByTestId('my-work-row-pr-status')).not.toBeInTheDocument();
  });

  it('PBI-008 AC-0: shows failing checks alongside the PR link from polled session detail', () => {
    const prUrl = 'https://github.com/example/apex/pull/42';
    const run = cloudRun('completed', { prUrl });
    mockUseFeatureFlag.mockReturnValue(true);
    mockCloudSession(run, {
      failingChecks: [],
      missingPr: false,
      incompleteAcceptanceCriteria: [],
    });
    (useDevSession as jest.Mock).mockReturnValue({
      data: {
        id: 'cloud-session',
        cloudAgentRun: run,
        leftoverWork: {
          failingChecks: ['unit'],
          missingPr: false,
          incompleteAcceptanceCriteria: [],
        },
      },
    });

    renderView();

    const liveRegion = screen.getByTestId('my-work-cloud-run-status-42').parentElement!;
    expect(liveRegion).toHaveAttribute('aria-live', 'polite');
    expect(within(liveRegion).getByRole('link', { name: 'View PR' })).toHaveAttribute('href', prUrl);
    expect(within(liveRegion).getByTestId('my-work-leftover-work-cloud-session'))
      .toHaveTextContent('Failing check: unit');
  });

  it('PBI-008 AC-1: shows missing PR as leftover text from the active-session fallback', () => {
    mockUseFeatureFlag.mockReturnValue(true);
    mockCloudSession(cloudRun('completed', { finishedWithoutPr: true }), {
      failingChecks: [],
      missingPr: true,
      incompleteAcceptanceCriteria: [],
    });
    (useDevSession as jest.Mock).mockReturnValue({ data: undefined });

    renderView();

    expect(screen.queryByTestId('my-work-cloud-run-pr-42')).not.toBeInTheDocument();
    expect(screen.getByTestId('my-work-leftover-work-cloud-session'))
      .toHaveTextContent('No pull request was opened — no PR yet');
  });

  it.each<[string, LeftoverWorkSummary | null]>([
    ['null', null],
    ['clean', {
      failingChecks: [],
      missingPr: false,
      incompleteAcceptanceCriteria: [],
    }],
  ])('PBI-008 AC-2: %s leftover summary renders no list', (_label, leftoverWork) => {
    mockUseFeatureFlag.mockReturnValue(true);
    mockCloudSession(cloudRun('completed'), leftoverWork);

    renderView();

    expect(screen.queryByTestId('my-work-leftover-work-cloud-session')).not.toBeInTheDocument();
  });

  it('PBI-008 AC-2: a clean polled detail clears stale active-session leftover work', () => {
    const run = cloudRun('completed');
    mockUseFeatureFlag.mockReturnValue(true);
    mockCloudSession(run, {
      failingChecks: ['unit'],
      missingPr: false,
      incompleteAcceptanceCriteria: [],
    });
    (useDevSession as jest.Mock).mockReturnValue({
      data: {
        id: 'cloud-session',
        cloudAgentRun: run,
        leftoverWork: null,
      },
    });

    renderView();

    expect(screen.queryByTestId('my-work-leftover-work-cloud-session')).not.toBeInTheDocument();
  });

  it('PBI-008 VT flag-off: hides leftover work with all cloud controls', () => {
    mockUseFeatureFlag.mockReturnValue(false);
    mockCloudSession(cloudRun('completed'), {
      failingChecks: ['e2e'],
      missingPr: true,
      incompleteAcceptanceCriteria: [],
    });

    renderView();

    expect(screen.queryByTestId('my-work-leftover-work-cloud-session')).not.toBeInTheDocument();
    expect(screen.queryByTestId('my-work-cloud-run-status-42')).not.toBeInTheDocument();
  });

  it('PBI-005 AC-2 / PBI-006 AC-2: stays terminal and states the exact no-PR copy once', () => {
    mockUseFeatureFlag.mockReturnValue(true);
    mockCloudSession(cloudRun('completed', { finishedWithoutPr: true }));

    renderView();

    const controls = cloudRunControls(42);
    expect(screen.getByTestId('my-work-cloud-run-status-42')).toHaveTextContent('Finished');
    expect(within(controls).getByTestId('current-run-checks-no-pr'))
      .toHaveTextContent('Run finished, no PR yet');
    expect(within(controls).getAllByText('Run finished, no PR yet')).toHaveLength(1);
    expect(screen.queryByTestId('my-work-cloud-run-pr-42')).not.toBeInTheDocument();
    expect(within(controls).queryByText(/passed/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('my-work-resume-cloud-run-42')).toBeInTheDocument();
  });

  it('PBI-006 AC-1 / TBI-005 DoD-1: names failing suites beside the PR link and stays Completed', () => {
    const prUrl = 'https://github.com/example/apex/pull/42';
    mockUseFeatureFlag.mockReturnValue(true);
    mockCloudSession(cloudRun('completed', {
      prUrl,
      checkResults: [
        { kind: 'unit', outcome: 'failed' },
        { kind: 'e2e', outcome: 'passed' },
        { kind: 'wcag', outcome: 'failed' },
      ],
      failingChecks: ['unit', 'wcag'],
    }));

    renderView();

    const controls = cloudRunControls(42);
    expect(screen.getByTestId('my-work-cloud-run-status-42')).toHaveTextContent('Completed');
    const prLink = screen.getByTestId('my-work-cloud-run-pr-42');
    expect(prLink).toHaveAttribute('href', prUrl);
    expect(prLink.parentElement)
      .toContainElement(within(controls).getByTestId('current-run-checks-summary'));

    const failing = within(controls).getByTestId('current-run-checks-failing');
    expect(within(failing).getByText('Unit checks failed')).toBeInTheDocument();
    expect(within(failing).getByText('WCAG checks failed')).toBeInTheDocument();
    expect(within(failing).queryByText('E2E checks failed')).not.toBeInTheDocument();
    expect(screen.getByTestId('my-work-resume-cloud-run-42')).toBeInTheDocument();
  });

  it('PBI-006 AC-0: shows the PR link with no failure indicator when every check passed', () => {
    const prUrl = 'https://github.com/example/apex/pull/42';
    mockUseFeatureFlag.mockReturnValue(true);
    mockCloudSession(cloudRun('completed', {
      prUrl,
      checkResults: [
        { kind: 'unit', outcome: 'passed' },
        { kind: 'e2e', outcome: 'passed' },
        { kind: 'wcag', outcome: 'passed' },
      ],
      failingChecks: [],
    }));

    renderView();

    const controls = cloudRunControls(42);
    expect(screen.getByTestId('my-work-cloud-run-pr-42')).toHaveAttribute('href', prUrl);
    expect(within(controls).queryByTestId('current-run-checks-summary')).not.toBeInTheDocument();
    expect(within(controls).queryByTestId('current-run-checks-failing')).not.toBeInTheDocument();
  });

  it.each(['queue_ttl', 'cloud_agent_timeout'] as const)(
    'PBI-003 AC-2 / PBI-005 AC-1: maps %s to Timed out and Resume',
    (terminalReason) => {
      mockUseFeatureFlag.mockReturnValue(true);
      mockCloudSession(cloudRun('failed', { terminalReason }));

      renderView();

      expect(screen.getByTestId('my-work-cloud-run-status-42')).toHaveTextContent('Timed out');
      expect(screen.getByTestId('my-work-resume-cloud-run-42')).toBeInTheDocument();
    },
  );

  it('TBI-004 DoD-2: renders other failures as Failed and offers Resume', () => {
    mockUseFeatureFlag.mockReturnValue(true);
    mockCloudSession(cloudRun('failed', { terminalReason: 'worker_lost' }));

    renderView();

    expect(screen.getByTestId('my-work-cloud-run-status-42')).toHaveTextContent('Failed');
    expect(screen.getByTestId('my-work-resume-cloud-run-42')).toBeInTheDocument();
  });

  it('shows launch failure detail when the run failed before dispatch', () => {
    mockUseFeatureFlag.mockReturnValue(true);
    const message = 'Service-account validation for Azure DevOps repositories is not yet implemented';
    mockCloudSession(cloudRun('failed', { lastError: message }));

    renderView();

    expect(screen.getByTestId('my-work-cloud-run-status-42')).toHaveTextContent('Failed');
    expect(screen.getByTestId('my-work-cloud-run-error-42')).toHaveTextContent(message);
    expect(screen.getByTestId('my-work-resume-cloud-run-42')).toBeInTheDocument();
  });

  it('PBI-004 AC-0: renders Cancelled and offers Resume', () => {
    mockUseFeatureFlag.mockReturnValue(true);
    mockCloudSession(cloudRun('cancelled'));

    renderView();

    expect(screen.getByTestId('my-work-cloud-run-status-42')).toHaveTextContent('Cancelled');
    expect(screen.getByTestId('my-work-resume-cloud-run-42')).toBeInTheDocument();
  });

  it('PBI-005 AC-1: Resume starts a new run for the same work item and project', async () => {
    mockUseFeatureFlag.mockReturnValue(true);
    mockCloudSession(cloudRun('failed', { terminalReason: 'progress_timeout' }));
    mockStartCloudMutateAsync.mockResolvedValue({ sessionId: 'cloud-session', runId: 'run-2' });

    renderView();
    fireEvent.click(screen.getByTestId('my-work-resume-cloud-run-42'));

    await waitFor(() => {
      expect(mockStartCloudMutateAsync).toHaveBeenCalledWith({
        workItemId: 42,
        project: 'MaxView',
      });
    });
  });

  it('PBI-003 AC-1: retains the last good Running state across a poll error', () => {
    mockUseFeatureFlag.mockReturnValue(true);
    const running = cloudRun('running');
    mockCloudSession(running);
    (useCloudAgentRun as jest.Mock).mockReturnValue({
      data: running,
      error: new Error('Transient poll failure'),
    });

    renderView();

    expect(screen.getByTestId('my-work-cloud-run-status-42')).toHaveTextContent('Running');
    expect(screen.getByTestId('my-work-cancel-cloud-run-42')).toBeInTheDocument();
  });

  it('PBI-004 AC-1/AC-3: shows a cancel rejection inline and retains current status', async () => {
    mockUseFeatureFlag.mockReturnValue(true);
    mockCloudSession(cloudRun('running'));
    mockCancelCloudMutateAsync.mockRejectedValue(new Error('Run is already terminal.'));

    renderView();
    fireEvent.click(screen.getByTestId('my-work-cancel-cloud-run-42'));

    expect(await screen.findByText('Run is already terminal.')).toBeInTheDocument();
    expect(screen.getByTestId('my-work-cloud-run-status-42')).toHaveTextContent('Running');
    expect(screen.getByTestId('my-work-cancel-cloud-run-42')).toBeInTheDocument();
  });

  it('PBI-002 AC-2/AC-3: shows start rejection inline without creating a visible run', async () => {
    mockUseFeatureFlag.mockReturnValue(true);
    mockStartCloudMutateAsync.mockRejectedValue(new Error('A live run already exists.'));
    (useAssignedWorkItems as jest.Mock).mockReturnValue({
      data: [{ ...workItems[0], cloudAgentEligibility: { allowed: true } }],
      isLoading: false,
      error: null,
    });

    renderView();
    fireEvent.click(screen.getByTestId('my-work-start-cloud-dev-btn'));

    expect(await screen.findByText('A live run already exists.')).toBeInTheDocument();
    expect(screen.queryByTestId('my-work-cloud-run-status-42')).not.toBeInTheDocument();
    expect(screen.getByTestId('my-work-start-cloud-dev-btn')).toBeInTheDocument();
  });

  it('TBI-004 DoD-3: does not render cloud controls on app-native My Work', () => {
    mockUseFeatureFlag.mockReturnValue(true);
    (useAppShell as jest.Mock).mockReturnValue({
      selectedProject: 'Apex',
      isSuperAdmin: false,
      usesBoardWorkItems: false,
    });
    (useApexBacklogFeatures as jest.Mock).mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    });

    renderView();

    expect(screen.queryByRole('button', { name: /^Start cloud agent$/i })).not.toBeInTheDocument();
  });

  it('shows resume and close actions for work items with an active session', () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-1',
          workItemId: 42,
          status: 'in_progress',
          chatThreadId: 'thread-1',
          branchName: 'feature/42',
          createdAt: '2026-06-01T00:00:00Z',
        },
      ],
    });

    renderView();

    expect(screen.getByText('Active Session')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /resume session/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /resume session/i }));
    expect(mockNavigate).toHaveBeenCalledWith('/my-work/session/session-1');
  });

  it('closes an active session when Close Session is clicked', async () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-1',
          workItemId: 42,
          status: 'in_progress',
          chatThreadId: 'thread-1',
          branchName: 'feature/42',
          createdAt: '2026-06-01T00:00:00Z',
        },
      ],
    });
    mockCloseMutateAsync.mockResolvedValue({ ok: true });

    renderView();
    fireEvent.click(screen.getByRole('button', { name: /close session/i }));

    await waitFor(() => {
      expect(mockCloseMutateAsync).toHaveBeenCalledWith('session-1');
    });
  });
});

const apexBacklogGroups: ApexBacklogGroup[] = [
  {
    prdId: 'prd-1',
    prdTitle: 'PDF Assembly',
    epics: [
      {
        epicTitle: 'Core Platform',
        features: [
          {
            featureId: 'FEAT-001',
            featureTitle: 'Menu & Navigation',
            featurePriority: 'Must',
            epicTitle: 'Core Platform',
            prdId: 'prd-1',
            prdTitle: 'PDF Assembly',
            dependsOn: [],
            itemCount: 3,
            pbiCount: 2,
            tbiCount: 1,
          },
          {
            featureId: 'FEAT-002',
            featureTitle: 'Document Upload',
            featurePriority: 'Must',
            epicTitle: 'Core Platform',
            prdId: 'prd-1',
            prdTitle: 'PDF Assembly',
            dependsOn: ['FEAT-001'],
            itemCount: 5,
            pbiCount: 3,
            tbiCount: 2,
          },
        ],
      },
    ],
  },
];

function expandPrdAndEpic() {
  fireEvent.click(screen.getByRole('button', { name: /PDF Assembly/i }));
  fireEvent.click(screen.getByRole('button', { name: /Core Platform/i }));
}

function mockApexWorkbenchHooks(project = 'Apex') {
  (useAppShell as jest.Mock).mockReturnValue({
    selectedProject: project,
    usesBoardWorkItems: project.toLowerCase() === 'apex',
  });
  (useProjectMenuConfig as jest.Mock).mockReturnValue({
    enabledViews: [],
    isLoading: false,
  });
  (useAssignedBoardItems as jest.Mock).mockReturnValue({
    data: [],
    isLoading: false,
    error: null,
  });
  (useAssignedWorkItems as jest.Mock).mockReturnValue({
    data: undefined,
    isLoading: false,
    error: null,
  });
  (useActiveSessions as jest.Mock).mockReturnValue({ data: [] });
  (useStartDevSession as jest.Mock).mockReturnValue({
    mutateAsync: mockStartMutateAsync,
    error: null,
  });
  (useCloseDevSession as jest.Mock).mockReturnValue({
    mutateAsync: mockCloseMutateAsync,
  });
  (useCompleteFeature as jest.Mock).mockReturnValue({
    mutateAsync: mockCompleteMutateAsync,
    error: null,
  });
  (useStartLocalFeature as jest.Mock).mockReturnValue({
    mutateAsync: mockStartLocalMutateAsync,
    isPending: false,
    error: null,
  });
  (useApexBacklogFeatures as jest.Mock).mockReturnValue({
    data: apexBacklogGroups,
    isLoading: false,
    error: null,
  });
}

describe('filterApexBacklogByStatus', () => {
  const { filterApexBacklogByStatus, filterApexBacklogBySearch } = jest.requireActual('../DevWorkbenchView') as typeof import('../DevWorkbenchView');

  it('returns all groups for the All filter', () => {
    const result = filterApexBacklogByStatus(apexBacklogGroups, [], 'all');
    expect(result).toHaveLength(1);
    expect(result[0].epics[0].features).toHaveLength(2);
  });

  it('keeps only Ready features for the Ready filter', () => {
    const sessions: ActiveDevSession[] = [
      {
        id: 's1',
        workItemId: null,
        chatThreadId: null,
        branchName: null,
        status: 'completed',
        prUrl: null,
        createdAt: '2026-07-01T00:00:00Z',
        prdId: 'prd-1',
        featureId: 'FEAT-001',
      },
    ];
    const result = filterApexBacklogByStatus(apexBacklogGroups, sessions, 'ready');
    expect(result[0].epics[0].features.map((f) => f.featureId)).toEqual(['FEAT-002']);
  });

  it('keeps only Complete features for the Complete filter', () => {
    const sessions: ActiveDevSession[] = [
      {
        id: 's1',
        workItemId: null,
        chatThreadId: null,
        branchName: null,
        status: 'completed',
        prUrl: null,
        createdAt: '2026-07-01T00:00:00Z',
        prdId: 'prd-1',
        featureId: 'FEAT-001',
      },
    ];
    const result = filterApexBacklogByStatus(apexBacklogGroups, sessions, 'complete');
    expect(result[0].epics[0].features.map((f) => f.featureId)).toEqual(['FEAT-001']);
  });

  it('treats locallyCompleted keys as Complete before sessions refetch', () => {
    const result = filterApexBacklogByStatus(
      apexBacklogGroups,
      [],
      'complete',
      new Set(['prd-1:FEAT-001']),
    );
    expect(result[0].epics[0].features.map((f) => f.featureId)).toEqual(['FEAT-001']);
  });

  it('returns an empty list when nothing matches', () => {
    const result = filterApexBacklogByStatus(apexBacklogGroups, [], 'in_progress');
    expect(result).toEqual([]);
  });

  describe('filterApexBacklogBySearch', () => {
    it('returns all groups when the query is blank', () => {
      expect(filterApexBacklogBySearch(apexBacklogGroups, '  ')).toEqual(apexBacklogGroups);
    });

    it('matches PRD titles and keeps all nested features', () => {
      const result = filterApexBacklogBySearch(apexBacklogGroups, 'pdf');
      expect(result).toHaveLength(1);
      expect(result[0].prdTitle).toBe('PDF Assembly');
      expect(result[0].epics[0].features).toHaveLength(2);
    });

    it('matches Epic titles and keeps features under that epic', () => {
      const result = filterApexBacklogBySearch(apexBacklogGroups, 'core platform');
      expect(result[0].epics).toHaveLength(1);
      expect(result[0].epics[0].features).toHaveLength(2);
    });

    it('matches Feature titles and keeps only those features', () => {
      const result = filterApexBacklogBySearch(apexBacklogGroups, 'navigation');
      expect(result[0].epics[0].features.map((f) => f.featureId)).toEqual(['FEAT-001']);
    });

    it('matches feature ids case-insensitively', () => {
      const result = filterApexBacklogBySearch(apexBacklogGroups, 'feat-002');
      expect(result[0].epics[0].features.map((f) => f.featureId)).toEqual(['FEAT-002']);
    });

    it('returns an empty list when nothing matches', () => {
      expect(filterApexBacklogBySearch(apexBacklogGroups, 'zzzz-no-match')).toEqual([]);
    });
  });
});

describe('DevWorkbenchView — Apex backlog (Mark Complete)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApexWorkbenchHooks();
  });

  it('uses the app-native PRD backlog for Amego instead of ADO work items', () => {
    mockApexWorkbenchHooks('Amego');

    renderView();

    expect(useAssignedWorkItems).toHaveBeenCalledWith(null);
    expect(useApexBacklogFeatures).toHaveBeenCalledWith('Amego');
    expect(screen.getByText('PDF Assembly')).toBeInTheDocument();
    expect(screen.queryByText('Implement login')).not.toBeInTheDocument();
  });

  it('defaults PRD and Epic sections to collapsed', () => {
    renderView();

    expect(screen.getByText('PDF Assembly')).toBeInTheDocument();
    expect(screen.queryByText('Menu & Navigation')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /PDF Assembly/i })).toHaveAttribute('aria-expanded', 'false');
  });

  it('searches by feature title and expands matching sections', () => {
    renderView();

    fireEvent.change(screen.getByRole('searchbox', { name: /search prds, epics, and features/i }), {
      target: { value: 'Upload' },
    });

    expect(screen.getByText('Document Upload')).toBeInTheDocument();
    expect(screen.queryByText('Menu & Navigation')).not.toBeInTheDocument();
  });

  it('searches by PRD title and shows nested features', () => {
    renderView();

    fireEvent.change(screen.getByRole('searchbox', { name: /search prds, epics, and features/i }), {
      target: { value: 'PDF Assembly' },
    });

    expect(screen.getByText('Menu & Navigation')).toBeInTheDocument();
    expect(screen.getByText('Document Upload')).toBeInTheDocument();
  });

  it('shows an empty search message when nothing matches', () => {
    renderView();

    fireEvent.change(screen.getByRole('searchbox', { name: /search prds, epics, and features/i }), {
      target: { value: 'no-such-item' },
    });

    expect(screen.getByText(/no prds, epics, or features match this search/i)).toBeInTheDocument();
  });

  it('renders status filter pills matching the interviews toolbar layout', () => {
    renderView();

    const toolbar = screen.getByRole('toolbar', { name: /filter features by status/i });
    expect(toolbar).toBeInTheDocument();
    expect(within(toolbar).getByRole('button', { name: /^All$/i })).toHaveAttribute('aria-pressed', 'true');
    expect(within(toolbar).getByRole('button', { name: /^Ready$/i })).toBeInTheDocument();
    expect(within(toolbar).getByRole('button', { name: /^In Progress$/i })).toBeInTheDocument();
    expect(within(toolbar).getByRole('button', { name: /^Complete$/i })).toBeInTheDocument();
  });

  it('filters the backlog when a status pill is selected', () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-completed-1',
          workItemId: 0,
          status: 'completed',
          chatThreadId: null,
          branchName: null,
          prUrl: null,
          createdAt: '2026-07-01T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-001',
        },
      ],
    });

    renderView();
    const toolbar = screen.getByRole('toolbar', { name: /filter features by status/i });
    fireEvent.click(within(toolbar).getByRole('button', { name: /^Complete/i }));
    expandPrdAndEpic();

    expect(screen.getByText('Menu & Navigation')).toBeInTheDocument();
    expect(screen.queryByText('Document Upload')).not.toBeInTheDocument();
  });

  it('shows an empty state when the filter matches nothing', () => {
    renderView();
    const toolbar = screen.getByRole('toolbar', { name: /filter features by status/i });
    fireEvent.click(within(toolbar).getByRole('button', { name: /^Complete/i }));
    expect(screen.getByText(/no features match this filter/i)).toBeInTheDocument();
  });

  it('renders features with Mark Complete buttons after expanding', () => {
    renderView();
    expandPrdAndEpic();

    expect(screen.getByText('Menu & Navigation')).toBeInTheDocument();
    expect(screen.getByText('Document Upload')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /mark complete/i })).toHaveLength(2);
  });

  it('shows Ready badge for features with no unmet dependencies', () => {
    renderView();
    expandPrdAndEpic();

    expect(screen.getAllByText('Ready').length).toBeGreaterThanOrEqual(1);
  });

  it('shows Blocked badge for features with unmet dependencies', () => {
    renderView();
    expandPrdAndEpic();

    expect(screen.getByText('Blocked by FEAT-001')).toBeInTheDocument();
  });

  it('calls completeFeature with the correct prdId and featureId', async () => {
    mockCompleteMutateAsync.mockResolvedValue({ ok: true, sessionId: 'session-new' });

    renderView();
    expandPrdAndEpic();
    const completeButtons = screen.getAllByRole('button', { name: /mark complete/i });
    fireEvent.click(completeButtons[0]);

    await waitFor(() => {
      expect(mockCompleteMutateAsync).toHaveBeenCalledWith({
        prdId: 'prd-1',
        featureId: 'FEAT-001',
        project: 'Apex',
      });
    });
  });

  it('hides Start Local Development immediately after Mark Complete', async () => {
    mockCompleteMutateAsync.mockResolvedValue({ ok: true, sessionId: 'session-new' });

    renderView();
    expandPrdAndEpic();

    expect(screen.getAllByRole('button', { name: /start local development/i })).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('button', { name: /mark complete/i })[0]);

    await waitFor(() => {
      expect(screen.getByText('Done')).toBeInTheDocument();
    });
    // Completed feature no longer offers Start Local; remaining Ready feature still does
    expect(screen.getAllByRole('button', { name: /start local development/i })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^Start Development$/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /view context/i }).length).toBeGreaterThanOrEqual(2);
  });

  it('completes only the selected feature and rolls parents up from all children', async () => {
    mockCompleteMutateAsync.mockResolvedValue({ ok: true, sessionId: 'session-new' });

    renderView();
    expandPrdAndEpic();
    fireEvent.click(screen.getAllByRole('button', { name: /mark complete/i })[0]);

    await waitFor(() => {
      expect(screen.getByTestId('my-work-feature-status-FEAT-001')).toHaveTextContent('Complete');
    });
    expect(screen.getByTestId('my-work-feature-status-FEAT-002')).toHaveTextContent('Ready');
    expect(screen.getByTestId('my-work-prd-status-prd-1')).toHaveTextContent('In Progress');
    expect(screen.getByTestId('my-work-epic-status-prd-1-0')).toHaveTextContent('In Progress');
    expect(screen.getAllByText('Done')).toHaveLength(1);
  });

  it('hides Start Local Development when a feature already has a completed session', () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-completed-1',
          workItemId: 0,
          status: 'completed',
          chatThreadId: null,
          branchName: null,
          prUrl: null,
          createdAt: '2026-07-01T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-001',
        },
      ],
    });

    renderView();
    expandPrdAndEpic();

    expect(screen.getByText('Done')).toBeInTheDocument();
    // FEAT-002 still Ready — only one Start Local remains
    expect(screen.getAllByRole('button', { name: /start local development/i })).toHaveLength(1);
  });

  it('shows Complete badge and Done label when a feature has a completed session', () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-completed-1',
          workItemId: 0,
          status: 'completed',
          chatThreadId: null,
          branchName: null,
          prUrl: null,
          createdAt: '2026-07-01T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-001',
        },
      ],
    });

    renderView();
    expandPrdAndEpic();

    expect(screen.getAllByText('Complete').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  it('unblocks dependent features when all dependencies are completed', () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-completed-1',
          workItemId: 0,
          status: 'completed',
          chatThreadId: null,
          branchName: null,
          prUrl: null,
          createdAt: '2026-07-01T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-001',
        },
      ],
    });

    renderView();
    expandPrdAndEpic();

    expect(screen.queryByText('Blocked by FEAT-001')).not.toBeInTheDocument();
    expect(screen.getAllByText('Ready').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('In Progress').length).toBeGreaterThanOrEqual(1);
  });

  it('rolls Ready status up to Epic and PRD when all features are Ready', () => {
    renderView();
    expandPrdAndEpic();

    expect(screen.getAllByText('Ready').length).toBeGreaterThanOrEqual(3);
  });

  it('rolls In Progress up to Epic and PRD when any feature is In Progress', () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-1',
          workItemId: 0,
          status: 'in_progress',
          chatThreadId: 'thread-1',
          branchName: 'feature/x',
          prUrl: null,
          createdAt: '2026-07-02T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-001',
        },
      ],
    });

    renderView();
    expandPrdAndEpic();

    expect(screen.getAllByText('In Progress').length).toBeGreaterThanOrEqual(3);
  });

  it('marks In Progress via Start Local Development', async () => {
    mockStartLocalMutateAsync.mockResolvedValue({ ok: true, sessionId: 'local-1', status: 'in_progress' });

    renderView();
    expandPrdAndEpic();
    fireEvent.click(screen.getAllByRole('button', { name: /start local development/i })[0]);

    await waitFor(() => {
      expect(mockStartLocalMutateAsync).toHaveBeenCalledWith({
        prdId: 'prd-1',
        featureId: 'FEAT-001',
        project: 'Apex',
      });
    });
  });

  it('allows Mark Complete while a feature is In Progress', async () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-1',
          workItemId: 0,
          status: 'in_progress',
          chatThreadId: 'thread-1',
          branchName: 'feature/x',
          prUrl: null,
          createdAt: '2026-07-02T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-001',
        },
      ],
    });
    mockCompleteMutateAsync.mockResolvedValue({ ok: true, sessionId: 'session-1' });

    renderView();
    expandPrdAndEpic();
    const completeButtons = screen.getAllByRole('button', { name: /mark complete/i });
    fireEvent.click(completeButtons[0]);

    await waitFor(() => {
      expect(mockCompleteMutateAsync).toHaveBeenCalledWith({
        prdId: 'prd-1',
        featureId: 'FEAT-001',
        project: 'Apex',
      });
    });
  });

  it('shows View Context on every feature including Complete and opens the modal', () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-completed-1',
          workItemId: 0,
          status: 'completed',
          chatThreadId: null,
          branchName: null,
          prUrl: null,
          createdAt: '2026-07-01T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-001',
        },
      ],
    });

    renderView();
    expandPrdAndEpic();

    const viewButtons = screen.getAllByRole('button', { name: /view context/i });
    expect(viewButtons.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole('button', { name: /^Start Development$/i })).not.toBeInTheDocument();

    fireEvent.click(viewButtons[0]);
    expect(screen.getByTestId('feature-context-modal')).toBeInTheDocument();
    expect(screen.getByText(/Context for FEAT-/i)).toBeInTheDocument();
  });

  it('shows Clear Progress for cloud and local in-progress sessions and never Resume/Close Session', () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-cloud',
          workItemId: 0,
          status: 'in_progress',
          chatThreadId: 'thread-1',
          branchName: 'feature/x',
          prUrl: null,
          createdAt: '2026-07-02T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-001',
        },
        {
          id: 'session-local',
          workItemId: 0,
          status: 'in_progress',
          chatThreadId: null,
          branchName: null,
          prUrl: null,
          createdAt: '2026-07-02T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-002',
        },
      ],
    });

    renderView();
    expandPrdAndEpic();

    expect(screen.getAllByRole('button', { name: /clear progress/i })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /resume session/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /close session/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Start Development$/i })).not.toBeInTheDocument();
  });
});

describe('DevWorkbenchView — session-to-feature matching', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApexWorkbenchHooks();
  });

  it('prefers active session over closed session for the same feature', () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-old-closed',
          workItemId: 0,
          status: 'closed',
          chatThreadId: null,
          branchName: 'feature/apex-feat-001-old',
          prUrl: null,
          createdAt: '2026-07-01T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-001',
        },
        {
          id: 'session-active',
          workItemId: 0,
          status: 'in_progress',
          chatThreadId: 'thread-2',
          branchName: 'feature/apex-feat-001-new',
          prUrl: null,
          createdAt: '2026-07-05T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-001',
        },
      ],
    });

    renderView();
    expandPrdAndEpic();

    expect(screen.getAllByText('In Progress').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /resume session/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /clear progress/i })).toBeInTheDocument();
  });

  it('closing feature 001 does not affect feature 002 session', async () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-feat-001',
          workItemId: 0,
          status: 'in_progress',
          chatThreadId: 'thread-1',
          branchName: 'feature/apex-feat-001',
          prUrl: null,
          createdAt: '2026-07-01T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-001',
        },
        {
          id: 'session-feat-002',
          workItemId: 0,
          status: 'in_progress',
          chatThreadId: 'thread-2',
          branchName: 'feature/apex-feat-002',
          prUrl: null,
          createdAt: '2026-07-02T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-002',
        },
      ],
    });
    mockCloseMutateAsync.mockResolvedValue({ ok: true });

    renderView();
    expandPrdAndEpic();

    const inProgressBadges = screen.getAllByText('In Progress');
    expect(inProgressBadges.length).toBeGreaterThanOrEqual(2);

    const clearButtons = screen.getAllByRole('button', { name: /clear progress/i });
    fireEvent.click(clearButtons[0]);

    await waitFor(() => {
      expect(mockCloseMutateAsync).toHaveBeenCalledWith('session-feat-001');
      expect(mockCloseMutateAsync).not.toHaveBeenCalledWith('session-feat-002');
    });
  });

  it('does not cross-reference sessions between different features', () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-feat-002',
          workItemId: 0,
          status: 'in_progress',
          chatThreadId: 'thread-2',
          branchName: 'feature/apex-feat-002',
          prUrl: null,
          createdAt: '2026-07-02T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-002',
        },
        {
          id: 'session-feat-001',
          workItemId: 0,
          status: 'in_progress',
          chatThreadId: 'thread-1',
          branchName: 'feature/apex-feat-001',
          prUrl: null,
          createdAt: '2026-07-01T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-001',
        },
      ],
    });

    renderView();
    expandPrdAndEpic();

    const inProgressBadges = screen.getAllByText('In Progress');
    expect(inProgressBadges.length).toBeGreaterThanOrEqual(2);

    const clearButtons = screen.getAllByRole('button', { name: /clear progress/i });
    expect(clearButtons).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /resume session/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /close session/i })).not.toBeInTheDocument();
  });

  it('shows In Progress with In PR note for a feature with a pushed session', () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-feat-001',
          workItemId: 0,
          status: 'in_progress',
          chatThreadId: 'thread-1',
          branchName: 'feature/apex-feat-001',
          prUrl: 'https://dev.azure.com/org/project/_git/repo/pullrequest/123',
          createdAt: '2026-07-01T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-001',
        },
      ],
    });

    renderView();
    expandPrdAndEpic();

    expect(screen.getAllByText('In Progress').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('In PR')).toBeInTheDocument();
  });

  it('with multiple sessions per feature, active session wins over older closed one regardless of array order', async () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-new-active',
          workItemId: 0,
          status: 'in_progress',
          chatThreadId: 'thread-new',
          branchName: 'feature/apex-feat-001-retry',
          prUrl: null,
          createdAt: '2026-07-05T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-001',
        },
        {
          id: 'session-old-closed',
          workItemId: 0,
          status: 'closed',
          chatThreadId: null,
          branchName: 'feature/apex-feat-001-first',
          prUrl: null,
          createdAt: '2026-07-01T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-001',
        },
      ],
    });
    mockCloseMutateAsync.mockResolvedValue({ ok: true });

    renderView();
    expandPrdAndEpic();

    expect(screen.getAllByText('In Progress').length).toBeGreaterThanOrEqual(1);

    const clearButton = screen.getByRole('button', { name: /clear progress/i });
    fireEvent.click(clearButton);

    await waitFor(() => {
      expect(mockCloseMutateAsync).toHaveBeenCalledWith('session-new-active');
    });
  });
});

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DevWorkbenchView } from '../DevWorkbenchView';

const mockNavigate = jest.fn();
const mockStartMutateAsync = jest.fn();
const mockCloseMutateAsync = jest.fn();
const mockCompleteMutateAsync = jest.fn();

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
}));

jest.mock('../../hooks/useApexBacklog', () => ({
  useApexBacklogFeatures: jest.fn(),
}));

import { useAppShell } from '../../hooks/useAppShell';
import {
  useAssignedWorkItems,
  useActiveSessions,
  useStartDevSession,
  useCloseDevSession,
  useCompleteFeature,
} from '../../hooks/useDevWorkbench';
import { useApexBacklogFeatures } from '../../hooks/useApexBacklog';

const workItems = [
  {
    id: 42,
    title: 'Implement login',
    workItemType: 'Product Backlog Item',
    state: 'In Progress',
    assignedTo: 'jane@example.com',
    project: 'MaxView',
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

describe('DevWorkbenchView', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    (useAppShell as jest.Mock).mockReturnValue({ selectedProject: 'MaxView' });
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
    (useApexBacklogFeatures as jest.Mock).mockReturnValue({
      data: undefined,
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
    expect(screen.getByText('Product Backlog Item')).toBeInTheDocument();
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

  it('starts a development session and navigates to the session view', async () => {
    mockStartMutateAsync.mockResolvedValue({ sessionId: 'session-1' });

    renderView();
    fireEvent.click(screen.getAllByRole('button', { name: /start development/i })[0]);

    await waitFor(() => {
      expect(mockStartMutateAsync).toHaveBeenCalledWith({ workItemId: 42, project: 'MaxView' });
      expect(mockNavigate).toHaveBeenCalledWith('/my-work/session/session-1');
    });
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

const apexBacklogGroups = [
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

describe('DevWorkbenchView — Apex backlog (Mark Complete)', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    (useAppShell as jest.Mock).mockReturnValue({ selectedProject: 'Apex' });
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
    (useApexBacklogFeatures as jest.Mock).mockReturnValue({
      data: apexBacklogGroups,
      isLoading: false,
      error: null,
    });
  });

  it('renders features with Mark Complete buttons', () => {
    renderView();

    expect(screen.getByText('Menu & Navigation')).toBeInTheDocument();
    expect(screen.getByText('Document Upload')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /mark complete/i })).toHaveLength(2);
  });

  it('shows Ready badge for features with no unmet dependencies', () => {
    renderView();

    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('shows Blocked badge for features with unmet dependencies', () => {
    renderView();

    expect(screen.getByText('Blocked by FEAT-001')).toBeInTheDocument();
  });

  it('calls completeFeature with the correct prdId and featureId', async () => {
    mockCompleteMutateAsync.mockResolvedValue({ ok: true, sessionId: 'session-new' });

    renderView();
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

  it('shows Completed badge and Done label when a feature has a closed session', () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-closed-1',
          workItemId: 0,
          status: 'closed',
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

    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  it('unblocks dependent features when all dependencies are closed', () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-closed-1',
          workItemId: 0,
          status: 'closed',
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

    expect(screen.queryByText('Blocked by FEAT-001')).not.toBeInTheDocument();
    const readyBadges = screen.getAllByText('Ready');
    expect(readyBadges).toHaveLength(1);
  });
});

describe('DevWorkbenchView — session-to-feature matching', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    (useAppShell as jest.Mock).mockReturnValue({ selectedProject: 'Apex' });
    (useAssignedWorkItems as jest.Mock).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
    });
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
    (useApexBacklogFeatures as jest.Mock).mockReturnValue({
      data: apexBacklogGroups,
      isLoading: false,
      error: null,
    });
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

    // Should show In Progress (from the active session), NOT Completed
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.queryByText('Completed')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /resume session/i })).toBeInTheDocument();
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

    // Both features should show In Progress
    const inProgressBadges = screen.getAllByText('In Progress');
    expect(inProgressBadges).toHaveLength(2);

    // Close feature 001 by clicking its Close Session button (first one)
    const closeButtons = screen.getAllByRole('button', { name: /close session/i });
    fireEvent.click(closeButtons[0]);

    await waitFor(() => {
      // Must close session-feat-001, NOT session-feat-002
      expect(mockCloseMutateAsync).toHaveBeenCalledWith('session-feat-001');
      expect(mockCloseMutateAsync).not.toHaveBeenCalledWith('session-feat-002');
    });
  });

  it('does not cross-reference sessions between different features', () => {
    // Regression: if sessions are returned in wrong order, feature 001 might
    // pick up feature 002's session
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

    // Both should show In Progress independently
    const inProgressBadges = screen.getAllByText('In Progress');
    expect(inProgressBadges).toHaveLength(2);

    // Both should have Resume Session buttons
    const resumeButtons = screen.getAllByRole('button', { name: /resume session/i });
    expect(resumeButtons).toHaveLength(2);
  });

  it('shows In PR state for a feature with a pushed session', () => {
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

    expect(screen.getByText('In PR')).toBeInTheDocument();
  });

  it('with multiple sessions per feature, active session wins over older closed one regardless of array order', async () => {
    // Sessions returned with closed AFTER active (reverse creation order)
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

    // Feature 001 should show as In Progress (the active session)
    expect(screen.getByText('In Progress')).toBeInTheDocument();

    // Closing should target the active session, not the old closed one
    const closeButton = screen.getByRole('button', { name: /close session/i });
    fireEvent.click(closeButton);

    await waitFor(() => {
      expect(mockCloseMutateAsync).toHaveBeenCalledWith('session-new-active');
    });
  });
});

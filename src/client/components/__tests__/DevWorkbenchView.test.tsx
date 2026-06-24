import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DevWorkbenchView } from '../DevWorkbenchView';

const mockNavigate = jest.fn();
const mockStartMutateAsync = jest.fn();
const mockCloseMutateAsync = jest.fn();

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
}));

import { useAppShell } from '../../hooks/useAppShell';
import {
  useAssignedWorkItems,
  useActiveSessions,
  useStartDevSession,
  useCloseDevSession,
} from '../../hooks/useDevWorkbench';

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

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlatformAdmin } from '../PlatformAdmin';
import {
  useApproveProjectAccessRequest,
  usePlatformAdminAccessRequests,
  usePlatformAdminAssignments,
  usePlatformAdminMenuConfigs,
  usePlatformAdminPendingAssignments,
  usePlatformAdminProjects,
  usePlatformAdminUsers,
  useRemovePlatformAdminPendingAssignment,
  useRejectProjectAccessRequest,
  useSetPlatformAdminAssignments,
  useSetPlatformAdminMenuConfig,
} from '../../hooks/usePlatformAdmin';

jest.mock('../../hooks/usePlatformAdmin', () => ({
  useApproveProjectAccessRequest: jest.fn(),
  usePlatformAdminAccessRequests: jest.fn(),
  usePlatformAdminAssignments: jest.fn(),
  usePlatformAdminMenuConfigs: jest.fn(),
  usePlatformAdminPendingAssignments: jest.fn(),
  usePlatformAdminProjects: jest.fn(),
  usePlatformAdminUsers: jest.fn(),
  useRemovePlatformAdminPendingAssignment: jest.fn(),
  useRejectProjectAccessRequest: jest.fn(),
  useSetPlatformAdminAssignments: jest.fn(),
  useSetPlatformAdminMenuConfig: jest.fn(),
}));

const mockUseApproveProjectAccessRequest = useApproveProjectAccessRequest as jest.Mock;
const mockUsePlatformAdminAccessRequests = usePlatformAdminAccessRequests as jest.Mock;
const mockUsePlatformAdminAssignments = usePlatformAdminAssignments as jest.Mock;
const mockUsePlatformAdminMenuConfigs = usePlatformAdminMenuConfigs as jest.Mock;
const mockUsePlatformAdminPendingAssignments = usePlatformAdminPendingAssignments as jest.Mock;
const mockUsePlatformAdminProjects = usePlatformAdminProjects as jest.Mock;
const mockUsePlatformAdminUsers = usePlatformAdminUsers as jest.Mock;
const mockUseRemovePlatformAdminPendingAssignment = useRemovePlatformAdminPendingAssignment as jest.Mock;
const mockUseRejectProjectAccessRequest = useRejectProjectAccessRequest as jest.Mock;
const mockUseSetPlatformAdminAssignments = useSetPlatformAdminAssignments as jest.Mock;
const mockUseSetPlatformAdminMenuConfig = useSetPlatformAdminMenuConfig as jest.Mock;

function setupPlatformAdmin(
  projects = [{ id: 'project-1', name: 'MaxView', description: 'Delivery planning' }],
  accessRequests: any[] = [],
  pendingAssignmentsByProject: Record<string, any[]> = {},
) {
  const saveAssignments = jest.fn().mockResolvedValue(undefined);
  const approveRequest = jest.fn().mockResolvedValue(undefined);
  const removePending = jest.fn().mockResolvedValue(undefined);
  const rejectRequest = jest.fn().mockResolvedValue(undefined);

  mockUsePlatformAdminProjects.mockReturnValue({
    data: projects,
    isLoading: false,
    isError: false,
    error: null,
  });
  mockUsePlatformAdminAssignments.mockReturnValue({
    data: [],
    isLoading: false,
    isError: false,
    error: null,
  });
  mockUsePlatformAdminMenuConfigs.mockReturnValue({
    data: [],
    isLoading: false,
    isError: false,
    error: null,
  });
  mockUsePlatformAdminUsers.mockReturnValue({
    data: [
      { userId: 'user-1', displayName: 'Ada Lovelace', email: 'ada@example.com' },
      { userId: 'user-2', displayName: 'Grace Hopper', email: 'grace@example.com' },
    ],
    isLoading: false,
    isError: false,
    error: null,
  });
  mockUsePlatformAdminAccessRequests.mockReturnValue({
    data: accessRequests,
    isLoading: false,
    isError: false,
    error: null,
  });
  mockUsePlatformAdminPendingAssignments.mockImplementation((project: string) => ({
    data: pendingAssignmentsByProject[project] ?? [],
    isLoading: false,
    isError: false,
    error: null,
  }));
  mockUseSetPlatformAdminAssignments.mockReturnValue({
    mutateAsync: saveAssignments,
    isPending: false,
    error: null,
  });
  mockUseRemovePlatformAdminPendingAssignment.mockReturnValue({
    mutateAsync: removePending,
    isPending: false,
    error: null,
  });
  mockUseSetPlatformAdminMenuConfig.mockReturnValue({
    mutateAsync: jest.fn().mockResolvedValue(undefined),
    isPending: false,
    error: null,
  });
  mockUseApproveProjectAccessRequest.mockReturnValue({
    mutateAsync: approveRequest,
    isPending: false,
    error: null,
  });
  mockUseRejectProjectAccessRequest.mockReturnValue({
    mutateAsync: rejectRequest,
    isPending: false,
    error: null,
  });

  render(<PlatformAdmin onBackToProjects={jest.fn()} user={{ name: 'Test Admin', email: 'admin@test.com' }} theme="light" hasUnreadChangelog={false} onThemeChange={jest.fn()} onOpenChangelog={jest.fn()} onLogout={jest.fn()} />);

  return { saveAssignments, approveRequest, rejectRequest, removePending };
}

describe('PlatformAdmin user-project access', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lets a super admin find and select users before saving assignments', async () => {
    const user = userEvent.setup({ delay: null });
    const { saveAssignments } = setupPlatformAdmin();

    await user.type(screen.getByLabelText(/add users/i), 'ada');
    await user.click(screen.getByRole('option', { name: /ada lovelace/i }));
    await user.click(screen.getByRole('button', { name: /save assignments/i }));

    await waitFor(() => {
      expect(saveAssignments).toHaveBeenCalledWith({ project: 'MaxView', userIds: ['user-1'] });
    });
  });

  it('imports CSV users by email and saves unmatched emails as pending first-login assignments', async () => {
    const user = userEvent.setup();
    const { saveAssignments } = setupPlatformAdmin();
    const file = new File(['email\nADA@example.com\nmissing@example.com\n'], 'users.csv', {
      type: 'text/csv',
    });

    await user.upload(screen.getByLabelText(/import csv\/txt/i), file);

    expect(await screen.findByText('Imported 1 user, 1 pending first login.')).toBeInTheDocument();
    expect(screen.getByText('missing@example.com')).toBeInTheDocument();
    expect(screen.getByText('Will be pending after save')).toBeInTheDocument();
    expect(saveAssignments).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /save assignments/i }));

    await waitFor(() => {
      expect(saveAssignments).toHaveBeenCalledWith({
        project: 'MaxView',
        userIds: ['user-1'],
        pendingEmails: ['missing@example.com'],
      });
    });
  });

  it('renders pending first-login assignments and allows removal', async () => {
    const user = userEvent.setup();
    const { removePending } = setupPlatformAdmin(undefined, [], {
      MaxView: [
        {
          id: 'pending-1',
          email: 'missing@example.com',
          project: 'MaxView',
          assignedBy: 'super-admin',
          assignedAt: '2026-06-14T12:00:00Z',
        },
      ],
    });

    expect(screen.getByLabelText('MaxView pending first-login users')).toBeInTheDocument();
    expect(screen.getByText('missing@example.com')).toBeInTheDocument();
    expect(screen.getByText('Awaiting first login')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /remove pending missing@example\.com/i }));

    await waitFor(() => {
      expect(removePending).toHaveBeenCalledWith({ project: 'MaxView', email: 'missing@example.com' });
    });
  });

  it('renders catalog projects that do not have assignments or menu config rows yet', () => {
    setupPlatformAdmin([
      { id: 'project-1', name: 'MaxView', description: 'Delivery planning' },
      { id: 'project-2', name: 'Support Ops', description: 'Non-ADO support project' },
    ]);

    expect(screen.getByRole('heading', { name: 'Support Ops' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Support Ops' })).toBeInTheDocument();
  });

  it('renders pending access requests and accepts or rejects them', async () => {
    const user = userEvent.setup();
    const { approveRequest, rejectRequest } = setupPlatformAdmin(undefined, [
      {
        id: 'request-1',
        userId: 'user-1',
        displayName: 'Ada Lovelace',
        email: 'ada@example.com',
        project: 'MatterWorx',
        status: 'pending',
        requestedAt: '2026-06-12T12:00:00Z',
        reviewedBy: null,
        reviewedAt: null,
        reviewNote: null,
      },
      {
        id: 'request-2',
        userId: 'user-2',
        displayName: 'Grace Hopper',
        email: 'grace@example.com',
        project: 'Apex',
        status: 'pending',
        requestedAt: '2026-06-12T12:05:00Z',
        reviewedBy: null,
        reviewedAt: null,
        reviewNote: null,
      },
    ]);

    expect(screen.getByRole('heading', { name: /access requests/i })).toBeInTheDocument();
    expect(screen.getAllByText(/ada lovelace/i).length).toBeGreaterThan(0);
    expect(screen.getByText('MatterWorx')).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: /accept/i })[0]);
    await user.click(screen.getAllByRole('button', { name: /reject/i })[1]);

    await waitFor(() => {
      expect(approveRequest).toHaveBeenCalledWith({ requestId: 'request-1' });
      expect(rejectRequest).toHaveBeenCalledWith({ requestId: 'request-2' });
    });
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectSelector } from '../ProjectSelector';
import { useProjects } from '../../hooks/useProjects';
import {
  useCreateProjectAccessRequests,
  useMyProjectAccessRequests,
  useRequestableProjectCatalog,
} from '../../hooks/usePlatformAdmin';

jest.mock('../../hooks/useProjects', () => ({
  useProjects: jest.fn(),
}));

jest.mock('../../hooks/usePlatformAdmin', () => ({
  useCreateProjectAccessRequests: jest.fn(),
  useMyProjectAccessRequests: jest.fn(),
  useRequestableProjectCatalog: jest.fn(),
}));

const mockUseCreateProjectAccessRequests = useCreateProjectAccessRequests as jest.Mock;
const mockUseMyProjectAccessRequests = useMyProjectAccessRequests as jest.Mock;
const mockUseRequestableProjectCatalog = useRequestableProjectCatalog as jest.Mock;

describe('ProjectSelector platform admin action', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useProjects as jest.Mock).mockReturnValue({
      data: [{ id: 'project-1', name: 'MaxView', description: 'Delivery planning' }],
      isLoading: false,
      isError: false,
    });
    mockUseRequestableProjectCatalog.mockReturnValue({
      data: [
        { id: 'project-2', name: 'MatterWorx', description: 'Delivery planning' },
        { id: 'project-3', name: 'Apex', description: 'Non-ADO project' },
      ],
      isLoading: false,
      isError: false,
      error: null,
    });
    mockUseMyProjectAccessRequests.mockReturnValue({
      data: [],
      isLoading: false,
    });
    mockUseCreateProjectAccessRequests.mockReturnValue({
      mutateAsync: jest.fn().mockResolvedValue([
        {
          id: 'request-1',
          userId: 'user-1',
          project: 'MatterWorx',
          status: 'pending',
          requestedAt: '2026-06-12T12:00:00Z',
        },
      ]),
      isPending: false,
      error: null,
    });
  });

  it('shows the Platform Admin action for super admins', () => {
    render(
      <ProjectSelector
        selectedProject="MaxView"
        isSuperAdmin
        onSelect={jest.fn()}
        onOpenPlatformAdmin={jest.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /platform admin/i })).toBeInTheDocument();
  });

  it('hides the Platform Admin action for regular users', () => {
    render(
      <ProjectSelector
        selectedProject="MaxView"
        isSuperAdmin={false}
        onSelect={jest.fn()}
        onOpenPlatformAdmin={jest.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: /platform admin/i })).not.toBeInTheDocument();
  });

  it('shows Request Access for regular users and submits selected projects', async () => {
    const user = userEvent.setup();
    const createRequests = jest.fn().mockResolvedValue([
      {
        id: 'request-1',
        userId: 'user-1',
        project: 'MatterWorx',
        status: 'pending',
        requestedAt: '2026-06-12T12:00:00Z',
      },
    ]);
    mockUseCreateProjectAccessRequests.mockReturnValue({
      mutateAsync: createRequests,
      isPending: false,
      error: null,
    });

    render(
      <ProjectSelector
        selectedProject="MaxView"
        isSuperAdmin={false}
        onSelect={jest.fn()}
        onOpenPlatformAdmin={jest.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /request access/i }));
    expect(screen.getByRole('dialog', { name: /request project access/i })).toBeInTheDocument();

    await user.click(screen.getByLabelText(/matterworx/i));
    await user.click(screen.getByRole('button', { name: /submit request/i }));

    await waitFor(() => {
      expect(createRequests).toHaveBeenCalledWith({ projects: ['MatterWorx'] });
    });
    expect(await screen.findByText(/requested access to 1 project/i)).toBeInTheDocument();
  });

  it('hides Request Access for platform admins', () => {
    render(
      <ProjectSelector
        selectedProject="MaxView"
        isSuperAdmin
        onSelect={jest.fn()}
        onOpenPlatformAdmin={jest.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: /request access/i })).not.toBeInTheDocument();
  });

  it('calls the platform admin navigation handler when clicked', () => {
    const onOpenPlatformAdmin = jest.fn();
    render(
      <ProjectSelector
        selectedProject="MaxView"
        isSuperAdmin
        onSelect={jest.fn()}
        onOpenPlatformAdmin={onOpenPlatformAdmin}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /platform admin/i }));

    expect(onOpenPlatformAdmin).toHaveBeenCalledTimes(1);
  });
});

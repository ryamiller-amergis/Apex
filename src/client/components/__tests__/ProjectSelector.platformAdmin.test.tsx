import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ProjectSelector } from '../ProjectSelector';
import { useProjects } from '../../hooks/useProjects';
import { useFeatureFlag } from '../../hooks/useFeatureFlags';
import { useCanSubmitRfp } from '../../hooks/useRfpTriage';
import {
  useCreateProjectAccessRequests,
  useMyProjectAccessRequests,
  useRequestableProjectCatalog,
} from '../../hooks/usePlatformAdmin';
import { useCreateRfpSubmitAccessRequest, useMyRfpRequests, useMyRfpSubmitAccessRequests } from '../../hooks/useRfpIntake';

jest.mock('../../hooks/useProjects', () => ({
  useProjects: jest.fn(),
}));

jest.mock('../../hooks/useFeatureFlags', () => ({
  useFeatureFlag: jest.fn(() => false),
}));

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useSearchParams: () => [new URLSearchParams(), jest.fn()],
}));

jest.mock('../../hooks/useRfpTriage', () => ({
  useCanSubmitRfp: jest.fn(() => false),
}));

jest.mock('../../hooks/useRfpIntake', () => ({
  useMyRfpRequests: jest.fn(() => ({
    data: { items: [], total: 0 },
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  })),
  useMyRfpSubmitAccessRequests: jest.fn(() => ({
    data: [],
    isLoading: false,
    isError: false,
  })),
  useCreateRfpSubmitAccessRequest: jest.fn(() => ({
    mutateAsync: jest.fn(),
    isPending: false,
  })),
}));

jest.mock('../UserMenu', () => ({
  UserMenu: () => <div data-testid="user-menu" />,
}));

jest.mock('../../hooks/usePlatformAdmin', () => ({
  useCreateProjectAccessRequests: jest.fn(),
  useMyProjectAccessRequests: jest.fn(),
  useRequestableProjectCatalog: jest.fn(),
}));

const mockUseCreateProjectAccessRequests = useCreateProjectAccessRequests as jest.Mock;
const mockUseMyProjectAccessRequests = useMyProjectAccessRequests as jest.Mock;
const mockUseRequestableProjectCatalog = useRequestableProjectCatalog as jest.Mock;
const mockUseFeatureFlag = useFeatureFlag as jest.Mock;
const mockUseCanSubmitRfp = useCanSubmitRfp as jest.Mock;
const mockUseMyRfpSubmitAccessRequests = useMyRfpSubmitAccessRequests as jest.Mock;
const mockUseCreateRfpSubmitAccessRequest = useCreateRfpSubmitAccessRequest as jest.Mock;
const mockUseMyRfpRequests = useMyRfpRequests as jest.Mock;

describe('ProjectSelector platform admin action', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseFeatureFlag.mockReturnValue(false);
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
    mockUseCanSubmitRfp.mockReturnValue(false);
    mockUseMyRfpSubmitAccessRequests.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
    });
    mockUseCreateRfpSubmitAccessRequest.mockReturnValue({
      mutateAsync: jest.fn(),
      isPending: false,
    });
    mockUseMyRfpRequests.mockReturnValue({
      data: { items: [], total: 0 },
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
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

    fireEvent.click(screen.getByRole('button', { name: /request access/i }));
    expect(screen.getByRole('dialog', { name: /request project access/i })).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/matterworx/i));
    fireEvent.click(screen.getByRole('button', { name: /submit request/i }));

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

  it('VT-10 hides Request a Product when rfp-intake is off', () => {
    mockUseFeatureFlag.mockReturnValue(false);
    render(
      <ProjectSelector
        selectedProject="MaxView"
        isSuperAdmin={false}
        onSelect={jest.fn()}
      />,
    );
    expect(screen.queryByTestId('project-selector-request-menu')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rfp-request-product-item')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rfp-your-requests-list')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /request access/i })).toBeInTheDocument();
    expect(screen.getByText(/select a project to start planning/i)).toBeInTheDocument();
  });

  it('TBI-004 DoD-0 does not show a landing triage card when Apex view is granted', () => {
    mockUseFeatureFlag.mockReturnValue(true);
    render(
      <ProjectSelector
        selectedProject="MaxView"
        isSuperAdmin={false}
        onSelect={jest.fn()}
      />,
    );
    expect(screen.queryByTestId('rfp-triage-entry-card')).not.toBeInTheDocument();
    expect(screen.getByTestId('project-selector-grid')).toBeInTheDocument();
  });

  it('asks for intake access from the Request menu when the user cannot yet submit RFPs', () => {
    mockUseFeatureFlag.mockReturnValue(true);
    mockUseCanSubmitRfp.mockReturnValue(false);
    render(
      <ProjectSelector
        selectedProject="MaxView"
        isSuperAdmin={false}
        onSelect={jest.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /request access/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('project-selector-request-menu'));
    expect(screen.getByTestId('project-selector-request-project-access')).toBeInTheDocument();
    expect(screen.getByTestId('rfp-submit-access-request-item')).toBeInTheDocument();
    expect(screen.queryByTestId('rfp-request-product-item')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rfp-your-requests-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rfp-go-to-project-card')).not.toBeInTheDocument();
  });

  it('shows Intake access pending in the Request menu while approval is outstanding', () => {
    mockUseFeatureFlag.mockReturnValue(true);
    mockUseCanSubmitRfp.mockReturnValue(false);
    mockUseMyRfpSubmitAccessRequests.mockReturnValue({
      data: [{ id: 'access-1', status: 'pending' }],
      isLoading: false,
      isError: false,
    });
    render(
      <ProjectSelector
        selectedProject="MaxView"
        isSuperAdmin={false}
        onSelect={jest.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('project-selector-request-menu'));
    expect(screen.getByTestId('rfp-submit-access-pending-item')).toBeDisabled();
    expect(screen.queryByTestId('rfp-submit-access-request-item')).not.toBeInTheDocument();
    expect(screen.getByTestId('rfp-submit-access-pending-banner')).toHaveTextContent(/intake access requested/i);
  });

  it('shows a success banner after requesting intake access', async () => {
    mockUseFeatureFlag.mockReturnValue(true);
    mockUseCanSubmitRfp.mockReturnValue(false);
    const mutateAsync = jest.fn().mockResolvedValue({ id: 'access-1', status: 'pending' });
    mockUseCreateRfpSubmitAccessRequest.mockReturnValue({
      mutateAsync,
      isPending: false,
      error: null,
    });
    render(
      <ProjectSelector
        selectedProject="MaxView"
        isSuperAdmin={false}
        onSelect={jest.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('project-selector-request-menu'));
    fireEvent.click(screen.getByTestId('rfp-submit-access-request-item'));
    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalled();
      expect(screen.getByTestId('rfp-submit-access-pending-banner')).toBeInTheDocument();
    });
    expect(screen.getByTestId('rfp-submit-access-pending-item')).toBeDisabled();
  });

  it('shows Request a Product in the Request menu after submit access is granted', () => {
    mockUseFeatureFlag.mockReturnValue(true);
    mockUseCanSubmitRfp.mockReturnValue(true);
    render(
      <ProjectSelector
        selectedProject="MaxView"
        isSuperAdmin={false}
        onSelect={jest.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('project-selector-request-menu'));
    expect(screen.getByTestId('project-selector-request-project-access')).toBeInTheDocument();
    expect(screen.getByTestId('rfp-request-product-item')).toBeInTheDocument();
    expect(screen.queryByTestId('rfp-your-requests-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rfp-submit-access-request-item')).not.toBeInTheDocument();
  });

  it('shows submitted product requests under the project grid', () => {
    mockUseFeatureFlag.mockReturnValue(true);
    mockUseCanSubmitRfp.mockReturnValue(true);
    mockUseMyRfpRequests.mockReturnValue({
      data: {
        items: [{
          id: 'rfp-1',
          title: 'test',
          status: 'evaluating',
          aiStatus: 'evaluating',
          currentVerdict: null,
          clarificationUsed: false,
          createdAt: '2026-08-20T00:00:00Z',
          updatedAt: '2026-08-20T00:00:00Z',
        }],
        total: 1,
      },
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
    });
    render(
      <ProjectSelector
        selectedProject="MaxView"
        isSuperAdmin={false}
        onSelect={jest.fn()}
      />,
    );
    expect(screen.getByTestId('rfp-your-requests-list')).toBeInTheDocument();
    expect(screen.getByTestId('rfp-request-row-rfp-1')).toHaveTextContent(/test/i);
    expect(screen.getByTestId('rfp-request-row-rfp-1')).toHaveTextContent(/evaluating/i);
  });

  it('opens the project-access modal from the Request menu', () => {
    mockUseFeatureFlag.mockReturnValue(true);
    render(
      <ProjectSelector
        selectedProject="MaxView"
        isSuperAdmin={false}
        onSelect={jest.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('project-selector-request-menu'));
    fireEvent.click(screen.getByTestId('project-selector-request-project-access'));
    expect(screen.getByRole('dialog', { name: /request project access/i })).toBeInTheDocument();
  });
});

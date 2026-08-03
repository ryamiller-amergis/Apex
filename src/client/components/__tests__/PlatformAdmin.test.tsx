import { render, screen, waitFor, within } from '@testing-library/react';
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
  usePlatformAdminGroups,
  useRemovePlatformAdminPendingAssignment,
  useRejectProjectAccessRequest,
  useSetPlatformAdminAssignments,
  useSetPlatformAdminMenuConfig,
} from '../../hooks/usePlatformAdmin';
import {
  useAddFlagRule,
  useCreateFeatureFlag,
  useDeleteFeatureFlag,
  useFeatureFlagsList,
  useFlagAudit,
  useRemoveFlagRule,
  useUpdateFeatureFlag,
} from '../../hooks/usePlatformAdminFeatureFlags';
import type {
  PendingProjectAssignment,
  PlatformAdminAccessRequest,
} from '../../../shared/types/platformAdmin';
import type { FeatureFlagWithRules } from '../../../shared/types/featureFlags';

jest.mock('../UserMenu', () => ({
  UserMenu: () => <div data-testid="user-menu" />,
}));

jest.mock('../WalkthroughsAdminPanel', () => ({
  WalkthroughsAdminPanel: () => (
    <div data-testid="walkthroughs-admin-panel">
      <div data-testid="walkthrough-catalog" />
    </div>
  ),
}));

jest.mock('../GroundingRolloutStatus', () => ({
  GroundingRolloutStatus: ({
    stage,
    onAdvance,
  }: {
    stage: string;
    onAdvance: () => void;
  }) => (
    <section data-testid="grounding-rollout-status">
      <span>{stage}</span>
      <button
        type="button"
        data-testid="grounding-advance-button"
        onClick={onAdvance}
      >
        Review advancement controls
      </button>
    </section>
  ),
}));

jest.mock('../../hooks/usePlatformAdmin', () => ({
  useApproveProjectAccessRequest: jest.fn(),
  usePlatformAdminAccessRequests: jest.fn(),
  usePlatformAdminAssignments: jest.fn(),
  usePlatformAdminMenuConfigs: jest.fn(),
  usePlatformAdminPendingAssignments: jest.fn(),
  usePlatformAdminProjects: jest.fn(),
  usePlatformAdminUsers: jest.fn(),
  usePlatformAdminGroups: jest.fn(),
  useRemovePlatformAdminPendingAssignment: jest.fn(),
  useRejectProjectAccessRequest: jest.fn(),
  useSetPlatformAdminAssignments: jest.fn(),
  useSetPlatformAdminMenuConfig: jest.fn(),
}));

jest.mock('../../hooks/usePlatformAdminFeatureFlags', () => ({
  useFeatureFlagsList: jest.fn(),
  useCreateFeatureFlag: jest.fn(),
  useUpdateFeatureFlag: jest.fn(),
  useDeleteFeatureFlag: jest.fn(),
  useAddFlagRule: jest.fn(),
  useRemoveFlagRule: jest.fn(),
  useFlagAudit: jest.fn(),
}));

const mockUseApproveProjectAccessRequest = useApproveProjectAccessRequest as jest.Mock;
const mockUsePlatformAdminAccessRequests = usePlatformAdminAccessRequests as jest.Mock;
const mockUsePlatformAdminAssignments = usePlatformAdminAssignments as jest.Mock;
const mockUsePlatformAdminMenuConfigs = usePlatformAdminMenuConfigs as jest.Mock;
const mockUsePlatformAdminPendingAssignments = usePlatformAdminPendingAssignments as jest.Mock;
const mockUsePlatformAdminProjects = usePlatformAdminProjects as jest.Mock;
const mockUsePlatformAdminUsers = usePlatformAdminUsers as jest.Mock;
const mockUsePlatformAdminGroups = usePlatformAdminGroups as jest.Mock;
const mockUseRemovePlatformAdminPendingAssignment = useRemovePlatformAdminPendingAssignment as jest.Mock;
const mockUseRejectProjectAccessRequest = useRejectProjectAccessRequest as jest.Mock;
const mockUseSetPlatformAdminAssignments = useSetPlatformAdminAssignments as jest.Mock;
const mockUseSetPlatformAdminMenuConfig = useSetPlatformAdminMenuConfig as jest.Mock;
const mockUseFeatureFlagsList = useFeatureFlagsList as jest.Mock;
const mockUseCreateFeatureFlag = useCreateFeatureFlag as jest.Mock;
const mockUseUpdateFeatureFlag = useUpdateFeatureFlag as jest.Mock;
const mockUseDeleteFeatureFlag = useDeleteFeatureFlag as jest.Mock;
const mockUseAddFlagRule = useAddFlagRule as jest.Mock;
const mockUseRemoveFlagRule = useRemoveFlagRule as jest.Mock;
const mockUseFlagAudit = useFlagAudit as jest.Mock;

function setupPlatformAdmin(
  projects = [{ id: 'project-1', name: 'MaxView', description: 'Delivery planning' }],
  accessRequests: PlatformAdminAccessRequest[] = [],
  pendingAssignmentsByProject: Record<string, PendingProjectAssignment[]> = {},
  flags: FeatureFlagWithRules[] = [],
  groups: Array<{ id: string; name: string; project: string }> = [],
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
  mockUsePlatformAdminGroups.mockReturnValue({
    data: groups,
    isLoading: false,
    isError: false,
    error: null,
  });
  mockUseFeatureFlagsList.mockReturnValue({
    data: flags,
    isLoading: false,
    isError: false,
    error: null,
  });
  mockUseCreateFeatureFlag.mockReturnValue({
    mutateAsync: jest.fn().mockResolvedValue(undefined),
    isPending: false,
    error: null,
  });
  mockUseUpdateFeatureFlag.mockReturnValue({
    mutateAsync: jest.fn().mockResolvedValue(undefined),
    isPending: false,
    error: null,
  });
  mockUseDeleteFeatureFlag.mockReturnValue({
    mutate: jest.fn(),
    mutateAsync: jest.fn().mockResolvedValue(undefined),
    isPending: false,
    error: null,
    reset: jest.fn(),
  });
  mockUseAddFlagRule.mockReturnValue({
    mutateAsync: jest.fn().mockResolvedValue(undefined),
    isPending: false,
    error: null,
  });
  mockUseRemoveFlagRule.mockReturnValue({
    mutateAsync: jest.fn().mockResolvedValue(undefined),
    isPending: false,
    error: null,
  });
  mockUseFlagAudit.mockReturnValue({
    data: [],
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

  it('renders catalog projects that do not have assignments or menu config rows yet', async () => {
    const user = userEvent.setup();
    setupPlatformAdmin([
      { id: 'project-1', name: 'MaxView', description: 'Delivery planning' },
      { id: 'project-2', name: 'Support Ops', description: 'Non-ADO support project' },
    ]);

    expect(screen.getByRole('heading', { name: 'MaxView' })).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /menu visibility/i }));
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

    expect(screen.getByRole('tab', { name: /access & users/i })).toBeInTheDocument();
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

describe('PlatformAdmin feature flags', () => {
  const flagFixture = {
    id: 'flag-1',
    key: 'repo-grounding-workspace-profile',
    description: 'Demo flag',
    enabled: false,
    lifecycle: 'active' as const,
    cleanupReady: false,
    createdBy: 'admin',
    createdAt: '2026-06-30T00:00:00Z',
    updatedAt: '2026-06-30T00:00:00Z',
    rules: [],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    setupPlatformAdmin(
      undefined,
      [],
      {},
      [flagFixture],
      [
        { id: 'group-1', name: 'Developer', project: 'MaxView' },
        { id: 'group-2', name: 'Developer', project: 'Apex' },
        { id: 'group-3', name: 'QA', project: 'MaxView' },
      ],
    );
  });

  it('renders the feature flags tab and lists existing flags', async () => {
    const user = userEvent.setup({ delay: null });

    await user.click(screen.getByRole('tab', { name: /feature flags/i }));

    expect(screen.getByRole('heading', { name: /feature flags/i })).toBeInTheDocument();
    expect(screen.getByText('repo-grounding-workspace-profile')).toBeInTheDocument();
  });

  it('AC-0 / BR-011 mounts the current rollout scorecard and focuses manual audited controls', async () => {
    const user = userEvent.setup({ delay: null });

    await user.click(screen.getByRole('tab', { name: /feature flags/i }));

    expect(screen.getByTestId('grounding-rollout-status')).toHaveTextContent(
      'design-module',
    );
    await user.click(screen.getByTestId('grounding-advance-button'));

    await waitFor(() => {
      expect(
        document.getElementById('grounding-rollout-feature-flag-controls'),
      ).toHaveFocus();
    });
    expect(screen.getByRole('button', { name: /hide rules/i })).toBeVisible();
  });

  it('lets a super admin add project targeting rules via typeahead multi-select', async () => {
    const user = userEvent.setup({ delay: null });
    const addRule = jest.fn().mockResolvedValue(undefined);
    mockUseAddFlagRule.mockReturnValue({
      mutateAsync: addRule,
      isPending: false,
      error: null,
    });

    await user.click(screen.getByRole('tab', { name: /feature flags/i }));
    await user.click(screen.getByRole('button', { name: /rules \(0\)/i }));
    await user.type(screen.getByPlaceholderText(/search projects/i), 'max');
    await user.click(screen.getByRole('option', { name: 'MaxView' }));
    await user.click(screen.getByRole('button', { name: /add rules/i }));

    await waitFor(() => {
      expect(addRule).toHaveBeenCalledWith({
        flagId: 'flag-1',
        type: 'project',
        value: 'MaxView',
      });
    });
  });

  it('lets a super admin add user targeting rules via typeahead multi-select', async () => {
    const user = userEvent.setup({ delay: null });
    const addRule = jest.fn().mockResolvedValue(undefined);
    mockUseAddFlagRule.mockReturnValue({
      mutateAsync: addRule,
      isPending: false,
      error: null,
    });

    await user.click(screen.getByRole('tab', { name: /feature flags/i }));
    await user.click(screen.getByRole('button', { name: /rules \(0\)/i }));
    await user.selectOptions(screen.getByLabelText(/target type/i), 'user');
    await user.type(screen.getByPlaceholderText(/search by name, email, or user id/i), 'ada');
    await user.click(screen.getByRole('option', { name: /ada lovelace/i }));
    await user.click(screen.getByRole('button', { name: /add rules/i }));

    await waitFor(() => {
      expect(addRule).toHaveBeenCalledWith({
        flagId: 'flag-1',
        type: 'user',
        value: 'user-1',
      });
    });
  });

  it('shows unique group names and adds rules for all matching group ids', async () => {
    const user = userEvent.setup({ delay: null });
    const addRule = jest.fn().mockResolvedValue(undefined);
    mockUseAddFlagRule.mockReturnValue({
      mutateAsync: addRule,
      isPending: false,
      error: null,
    });

    await user.click(screen.getByRole('tab', { name: /feature flags/i }));
    await user.click(screen.getByRole('button', { name: /rules \(0\)/i }));
    await user.selectOptions(screen.getByLabelText(/target type/i), 'group');
    await user.type(screen.getByPlaceholderText(/search group names/i), 'dev');
    expect(screen.getAllByRole('option', { name: 'Developer' })).toHaveLength(1);
    await user.click(screen.getByRole('option', { name: 'Developer' }));
    await user.click(screen.getByRole('button', { name: /add rules/i }));

    await waitFor(() => {
      expect(addRule).toHaveBeenCalledTimes(2);
      expect(addRule).toHaveBeenCalledWith({
        flagId: 'flag-1',
        type: 'group',
        value: 'group-1',
      });
      expect(addRule).toHaveBeenCalledWith({
        flagId: 'flag-1',
        type: 'group',
        value: 'group-2',
      });
    });
  });

  it('AC-0 / accessibility NFR exposes labeled keyboard-operable rollout controls', async () => {
    const user = userEvent.setup({ delay: null });
    const addRule = jest.fn().mockResolvedValue(undefined);
    mockUseAddFlagRule.mockReturnValue({
      mutateAsync: addRule,
      isPending: false,
      error: null,
    });

    await user.click(screen.getByRole('tab', { name: /feature flags/i }));
    await user.click(screen.getByRole('button', { name: /rules \(0\)/i }));

    expect(screen.getByTestId('feature-flag-kill-switch-toggle')).toHaveAccessibleName(
      'repo-grounding-workspace-profile kill switch',
    );
    expect(screen.getByTestId('feature-flag-rule-type-caller')).toHaveValue('caller');
    expect(screen.getByTestId('feature-flag-rule-type-environment')).toHaveValue('environment');

    const targetType = screen.getByLabelText(/target type/i);
    expect(targetType).toHaveAccessibleName('Target type');
    await user.selectOptions(targetType, 'caller');
    const valueInput = screen.getByTestId('feature-flag-rule-value-input');
    expect(valueInput).toHaveAccessibleName('Caller key');
    await user.type(valueInput, 'interview');
    const addButton = screen.getByRole('button', { name: /add rule/i });
    addButton.focus();
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(addRule).toHaveBeenCalledWith({
        flagId: 'flag-1',
        type: 'caller',
        value: 'interview',
      });
    });

    await user.selectOptions(screen.getByLabelText(/target type/i), 'environment');
    const environmentInput = screen.getByTestId('feature-flag-rule-value-input');
    expect(environmentInput).toHaveAccessibleName('Environment name');
    await user.type(environmentInput, 'dev');
    screen.getByRole('button', { name: /add rule/i }).focus();
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(addRule).toHaveBeenCalledWith({
        flagId: 'flag-1',
        type: 'environment',
        value: 'dev',
      });
    });
  });

  it('opens a custom delete modal and deletes the flag on confirm', async () => {
    const user = userEvent.setup({ delay: null });
    const deleteMutate = jest.fn();
    mockUseDeleteFeatureFlag.mockReturnValue({
      mutate: deleteMutate,
      mutateAsync: jest.fn().mockResolvedValue(undefined),
      isPending: false,
      error: null,
      reset: jest.fn(),
    });

    await user.click(screen.getByRole('tab', { name: /feature flags/i }));
    await user.click(screen.getAllByRole('button', { name: /^delete$/i })[0]);

    const dialog = screen.getByRole('dialog', { name: /delete feature flag/i });
    expect(within(dialog).getByText(/repo-grounding-workspace-profile/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));

    expect(deleteMutate).toHaveBeenCalledWith(
      { id: 'flag-1' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });
});

describe('PlatformAdmin walkthroughs tab', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders walkthrough catalog when walkthroughs tab is selected', async () => {
    const user = userEvent.setup();
    setupPlatformAdmin();

    await user.click(screen.getByTestId('platform-admin-tab-walkthroughs'));

    expect(screen.getByTestId('walkthrough-catalog')).toBeInTheDocument();
  });
});

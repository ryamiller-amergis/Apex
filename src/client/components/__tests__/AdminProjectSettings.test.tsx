/**
 * Smoke coverage for AdminProjectSettings Design Module skill wiring.
 */

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { AdminProjectSettings } from '../AdminProjectSettings';

jest.mock('../../hooks/useProjectSkillConfig', () => ({
  useAllProjectSkillConfigs: jest.fn(),
  useUpsertProjectSkillConfig: jest.fn(),
  useDeleteProjectSkillConfig: jest.fn(),
  useAvailableModels: jest.fn(),
  useAvailableBedrockModels: jest.fn(),
  useProjectApprovers: jest.fn(),
  useSetProjectApprovers: jest.fn(),
}));

jest.mock('../../hooks/useChatThreads', () => ({
  useSkillRepos: jest.fn(),
  useSkillBranches: jest.fn(),
  useSkillList: jest.fn(),
}));

jest.mock('../../hooks/useRbac', () => ({
  useUsers: jest.fn(),
}));

jest.mock('../../hooks/useGroups', () => ({
  useGroupsWithMembers: jest.fn(),
}));

jest.mock('../../hooks/useFoundationSkillAdmin', () => ({
  useProjectAvailableSkills: jest.fn().mockReturnValue({
    data: [],
    isLoading: false,
    isError: false,
  }),
}));

jest.mock('../../hooks/useFeatureFlags', () => ({
  useFeatureFlag: jest.fn().mockReturnValue(false),
}));

jest.mock('../GroupAwarePeoplePicker', () => ({
  GroupAwarePeoplePicker: ({
    groups,
    selectedUserIds,
    selectedGroupIds,
    onUserIdsChange,
    onGroupIdsChange,
  }: {
    groups: Array<{ id: string; name: string; members: unknown[] }>;
    selectedUserIds: string[];
    selectedGroupIds: string[];
    onUserIdsChange: (ids: string[]) => void;
    onGroupIdsChange: (ids: string[]) => void;
  }) => (
    <div>
      <span>users:{selectedUserIds.join(',')}</span>
      <span>groups:{selectedGroupIds.join(',')}</span>
      {groups
        .filter((group) => selectedGroupIds.includes(group.id))
        .map((group) => (
          <span key={group.id}>{group.name} ({group.members.length} members)</span>
        ))}
      <button type="button" onClick={() => onUserIdsChange([...selectedUserIds, 'user-added'])}>
        Add first user
      </button>
      <button type="button" onClick={() => onGroupIdsChange([...selectedGroupIds, 'group-empty'])}>
        Add empty group
      </button>
    </div>
  ),
}));

import {
  useAllProjectSkillConfigs,
  useUpsertProjectSkillConfig,
  useDeleteProjectSkillConfig,
  useAvailableModels,
  useAvailableBedrockModels,
  useProjectApprovers,
  useSetProjectApprovers,
} from '../../hooks/useProjectSkillConfig';
import {
  useSkillRepos,
  useSkillBranches,
  useSkillList,
} from '../../hooks/useChatThreads';
import { useUsers } from '../../hooks/useRbac';
import { useGroupsWithMembers } from '../../hooks/useGroups';

function setupMocks() {
  const noop = { mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false, error: null };
  (useAllProjectSkillConfigs as jest.Mock).mockReturnValue({
    data: [],
    isLoading: false,
    isError: false,
  });
  (useUpsertProjectSkillConfig as jest.Mock).mockReturnValue(noop);
  (useDeleteProjectSkillConfig as jest.Mock).mockReturnValue(noop);
  (useAvailableModels as jest.Mock).mockReturnValue({ data: [], isLoading: false });
  (useAvailableBedrockModels as jest.Mock).mockReturnValue({ data: [] });
  (useProjectApprovers as jest.Mock).mockReturnValue({
    data: null,
    isSuccess: false,
    isError: false,
  });
  (useSetProjectApprovers as jest.Mock).mockReturnValue(noop);
  (useSkillRepos as jest.Mock).mockReturnValue({ data: [], isLoading: false });
  (useSkillBranches as jest.Mock).mockReturnValue({ data: [], isLoading: false });
  (useSkillList as jest.Mock).mockReturnValue({ data: [], isLoading: false });
  (useUsers as jest.Mock).mockReturnValue({ data: [] });
  (useGroupsWithMembers as jest.Mock).mockReturnValue({ data: [] });
}

const projectConfig = {
  id: 'settings-1',
  project: 'Apex',
  friendlyName: 'Main',
  isDefault: true,
  skillRepo: 'Apex/skills',
  skillBranch: 'main',
  approvalMode: 'all_required' as const,
  approvalModes: {
    prd: 'all_required' as const,
    design_doc: 'any_one' as const,
    design_prototype: 'any_one' as const,
    test_case: 'all_required' as const,
    adr: 'any_one' as const,
  },
};

function openReviewerSettings() {
  fireEvent.click(screen.getByTestId('ps-config-edit-settings-1'));
  fireEvent.click(screen.getByRole('button', { name: /Reviewers/i }));
}

describe('AdminProjectSettings — Design Module skill', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupMocks();
  });

  it('shows empty state when no configs exist', () => {
    render(<AdminProjectSettings selectedProject="Apex" />);

    expect(screen.getByText('Project Skill Settings')).toBeInTheDocument();
    expect(
      screen.getByText(/No skill settings configured for/i)
    ).toBeInTheDocument();
  });

  it('exposes Design Module under Sidecar Skills when adding a config', () => {
    render(<AdminProjectSettings selectedProject="Apex" />);

    fireEvent.click(screen.getByRole('button', { name: '+ Add Repo Config' }));
    fireEvent.click(screen.getByText('Sidecar Skills'));

    expect(screen.getByText('Design Module')).toBeInTheDocument();
    expect(
      screen.getByText(
        /Generates Architecture Explorer module documents from curated source globs/i
      )
    ).toBeInTheDocument();
  });

  it('surfaces load errors', () => {
    (useAllProjectSkillConfigs as jest.Mock).mockReturnValue({
      data: [],
      isLoading: false,
      isError: true,
    });

    render(<AdminProjectSettings selectedProject="Apex" />);

    expect(screen.getByText('Failed to load project settings.')).toBeInTheDocument();
  });
});

describe('AdminProjectSettings — reviewer pools and module approval modes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupMocks();
    (useAllProjectSkillConfigs as jest.Mock).mockReturnValue({
      data: [projectConfig],
      isLoading: false,
      isError: false,
    });
  });

  it('PBI-001 AC-2 shows a configured zero-member ADR group and keeps its mode visible', () => {
    (useGroupsWithMembers as jest.Mock).mockReturnValue({
      data: [{
        id: 'group-empty',
        name: 'Empty Architects',
        description: null,
        project: 'Apex',
        createdAt: '2026-08-28T00:00:00Z',
        updatedAt: '2026-08-28T00:00:00Z',
        members: [],
      }],
    });
    (useProjectApprovers as jest.Mock).mockReturnValue({
      data: {
        approvers: [],
        approverGroups: [
          { groupId: 'group-empty', groupName: 'Empty Architects', documentType: 'adr' },
        ],
      },
      isSuccess: true,
      isError: false,
    });

    render(<AdminProjectSettings selectedProject="Apex" />);
    openReviewerSettings();

    const adrPool = screen.getByTestId('ps-adr-approver-pool');
    expect(within(adrPool).getByText('groups:group-empty')).toBeInTheDocument();
    expect(within(adrPool).getByText('Empty Architects (0 members)')).toBeVisible();
    expect(screen.getByTestId('ps-approval-mode-adr')).toBeVisible();
    expect(screen.queryByTestId('ps-no-reviewers-helper-adr')).not.toBeInTheDocument();
  });

  it('PBI-002 AC-0 changes Design Doc independently while PRD remains all required', () => {
    (useProjectApprovers as jest.Mock).mockReturnValue({
      data: {
        approvers: [
          { documentType: 'prd', userId: 'prd-user' },
          { documentType: 'design_doc', userId: 'design-user' },
        ],
        approverGroups: [],
      },
      isSuccess: true,
      isError: false,
    });

    render(<AdminProjectSettings selectedProject="Apex" />);
    openReviewerSettings();
    fireEvent.click(screen.getByTestId('ps-approval-mode-design_doc-all-required'));
    fireEvent.click(screen.getByTestId('ps-approval-mode-design_doc-any-one'));

    expect(screen.getByTestId('ps-approval-mode-design_doc-any-one')).toBeChecked();
    expect(screen.getByTestId('ps-approval-mode-prd-all-required')).toBeChecked();
  });

  it('PBI-002 AC-2 loads migrated ADR any-one mode independently', () => {
    (useProjectApprovers as jest.Mock).mockReturnValue({
      data: {
        approvers: [{ documentType: 'adr', userId: 'architect-1' }],
        approverGroups: [],
      },
      isSuccess: true,
      isError: false,
    });

    render(<AdminProjectSettings selectedProject="Apex" />);
    openReviewerSettings();

    expect(screen.getByTestId('ps-approval-mode-adr-any-one')).toBeChecked();
  });

  it('PBI-003 AC-0 hides empty QA mode and announces No Reviewers after a successful load', () => {
    (useProjectApprovers as jest.Mock).mockReturnValue({
      data: { approvers: [], approverGroups: [] },
      isSuccess: true,
      isError: false,
    });

    render(<AdminProjectSettings selectedProject="Apex" />);
    openReviewerSettings();

    expect(screen.queryByTestId('ps-approval-mode-test_case')).not.toBeInTheDocument();
    expect(screen.getByTestId('ps-no-reviewers-helper-test_case')).toHaveTextContent(
      'No Reviewers — documents will be approved by their owner',
    );
    expect(screen.getByTestId('ps-no-reviewers-helper-test_case')).toHaveAttribute(
      'aria-live',
      'polite',
    );
  });

  it('PBI-003 AC-0 states the owner-approval consequence on every empty module', () => {
    (useProjectApprovers as jest.Mock).mockReturnValue({
      data: { approvers: [], approverGroups: [] },
      isSuccess: true,
      isError: false,
    });

    render(<AdminProjectSettings selectedProject="Apex" />);
    openReviewerSettings();

    for (const module of ['prd', 'design_doc', 'design_prototype', 'test_case', 'adr']) {
      expect(screen.getByTestId(`ps-no-reviewers-helper-${module}`)).toHaveTextContent(
        'No Reviewers — documents will be approved by their owner',
      );
    }
  });

  it('VT-10 / PBI-003 AC-1 keeps the last-known mode control when approvers fail to load', () => {
    (useProjectApprovers as jest.Mock).mockReturnValue({
      data: undefined,
      isSuccess: false,
      isError: true,
    });

    render(<AdminProjectSettings selectedProject="Apex" />);
    openReviewerSettings();

    expect(screen.getByTestId('ps-approval-mode-test_case')).toBeVisible();
    expect(screen.queryByTestId('ps-no-reviewers-helper-test_case')).not.toBeInTheDocument();
  });

  it('VT-11 / PBI-003 AC-2 shows QA mode immediately after adding its first user', () => {
    (useProjectApprovers as jest.Mock).mockReturnValue({
      data: { approvers: [], approverGroups: [] },
      isSuccess: true,
      isError: false,
    });

    render(<AdminProjectSettings selectedProject="Apex" />);
    openReviewerSettings();
    fireEvent.click(within(screen.getByTestId('ps-test_case-approver-pool')).getByRole('button', {
      name: 'Add first user',
    }));

    expect(screen.getByTestId('ps-approval-mode-test_case')).toBeVisible();
    expect(screen.queryByTestId('ps-no-reviewers-helper-test_case')).not.toBeInTheDocument();
  });

  it('PBI-001 AC-0 and PBI-002 AC-0 save ADR users/groups and complete module modes', async () => {
    const mutateAsync = jest.fn().mockResolvedValue(projectConfig);
    const saveApprovers = jest.fn().mockResolvedValue({});
    (useUpsertProjectSkillConfig as jest.Mock).mockReturnValue({
      mutate: jest.fn(),
      mutateAsync,
      isPending: false,
      error: null,
    });
    (useSetProjectApprovers as jest.Mock).mockReturnValue({
      mutate: jest.fn(),
      mutateAsync: saveApprovers,
      isPending: false,
      error: null,
    });
    (useProjectApprovers as jest.Mock).mockReturnValue({
      data: {
        approvers: [
          { documentType: 'adr', userId: 'architect-1' },
          { documentType: 'adr', userId: 'architect-2' },
        ],
        approverGroups: [
          { documentType: 'adr', groupId: 'architecture-group', groupName: 'Architects' },
        ],
      },
      isSuccess: true,
      isError: false,
    });

    render(<AdminProjectSettings selectedProject="Apex" />);
    openReviewerSettings();
    fireEvent.click(screen.getByTestId('ps-form-save'));

    await waitFor(() => expect(saveApprovers).toHaveBeenCalledWith(expect.objectContaining({
      adrApprovers: ['architect-1', 'architect-2'],
      adrApproverGroups: ['architecture-group'],
    })));
    expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        approvalModes: projectConfig.approvalModes,
      }),
    }));
  });

  it('PBI-001 AC-1 and PBI-002 AC-1 surface save errors and retain the edited controls', async () => {
    (useUpsertProjectSkillConfig as jest.Mock).mockReturnValue({
      mutate: jest.fn(),
      mutateAsync: jest.fn().mockRejectedValue(new Error('Save unavailable')),
      isPending: false,
      error: null,
    });
    (useProjectApprovers as jest.Mock).mockReturnValue({
      data: {
        approvers: [{ documentType: 'design_doc', userId: 'design-user' }],
        approverGroups: [],
      },
      isSuccess: true,
      isError: false,
    });

    render(<AdminProjectSettings selectedProject="Apex" />);
    openReviewerSettings();
    fireEvent.click(screen.getByTestId('ps-approval-mode-design_doc-all-required'));
    fireEvent.click(screen.getByTestId('ps-form-save'));

    expect(await screen.findByText('Save unavailable')).toBeVisible();
    expect(screen.getByTestId('ps-approval-mode-design_doc-all-required')).toBeChecked();
    expect(screen.getByText('Edit: Main')).toBeVisible();
  });

  it('PBI-001 AC-1 keeps the ADR pool visible when the reviewer save fails', async () => {
    (useUpsertProjectSkillConfig as jest.Mock).mockReturnValue({
      mutate: jest.fn(),
      mutateAsync: jest.fn().mockResolvedValue(projectConfig),
      isPending: false,
      error: null,
    });
    (useSetProjectApprovers as jest.Mock).mockReturnValue({
      mutate: jest.fn(),
      mutateAsync: jest.fn().mockRejectedValue(new Error('Reviewer service unavailable')),
      isPending: false,
      error: null,
    });
    (useProjectApprovers as jest.Mock).mockReturnValue({
      data: {
        approvers: [{ documentType: 'adr', userId: 'architect-1' }],
        approverGroups: [],
      },
      isSuccess: true,
      isError: false,
    });

    render(<AdminProjectSettings selectedProject="Apex" />);
    openReviewerSettings();
    fireEvent.click(screen.getByTestId('ps-form-save'));

    expect(await screen.findByText(
      'Repo config saved, but reviewers failed to save: Reviewer service unavailable',
    )).toBeVisible();
    expect(within(screen.getByTestId('ps-adr-approver-pool')).getByText(
      'users:architect-1',
    )).toBeVisible();
    expect(screen.getByText('Edit: Main')).toBeVisible();
  });
});

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
    disabled = false,
    placeholder = 'Search groups or people…',
  }: {
    groups: Array<{ id: string; name: string; members: unknown[] }>;
    selectedUserIds: string[];
    selectedGroupIds: string[];
    onUserIdsChange: (ids: string[]) => void;
    onGroupIdsChange: (ids: string[]) => void;
    disabled?: boolean;
    placeholder?: string;
  }) => (
    <div>
      <span>users:{selectedUserIds.join(',')}</span>
      <span>groups:{selectedGroupIds.join(',')}</span>
      {groups
        .filter((group) => selectedGroupIds.includes(group.id))
        .map((group) => (
          <span key={group.id}>{group.name} ({group.members.length} members)</span>
        ))}
      {selectedUserIds.length === 0 && selectedGroupIds.length === 0 && (
        <span>No groups or people selected</span>
      )}
      <input readOnly value="" aria-label={placeholder} disabled={disabled} />
      <button
        type="button"
        disabled={disabled}
        onClick={() => onUserIdsChange([...selectedUserIds, 'user-added'])}
      >
        Add first user
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onGroupIdsChange([...selectedGroupIds, 'group-empty'])}
      >
        Add empty group
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          onUserIdsChange([]);
          onGroupIdsChange([]);
        }}
      >
        Clear selections
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

describe('AdminProjectSettings — effort overrides', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupMocks();
    (useAllProjectSkillConfigs as jest.Mock).mockReturnValue({
      data: [projectConfig],
      isLoading: false,
      isError: false,
    });
  });

  it('renders default, stage, and standalone ADR effort controls', () => {
    render(<AdminProjectSettings selectedProject="Apex" />);

    fireEvent.click(screen.getByTestId('ps-config-edit-settings-1'));
    expect(screen.getByTestId('ps-defaultEffort')).toBeVisible();
    expect(screen.getByTestId('ps-stage-effort-interviewEffort')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /Document Pipeline — ADR/i }));
    expect(screen.getByTestId('ps-adrEffort')).toBeVisible();
  });

  it.each(['low', 'medium', 'high'] as const)(
    'PBI-001 AC-0 saves the accepted %s interview effort override',
    async (effort) => {
    const mutateAsync = jest.fn().mockResolvedValue(projectConfig);
    (useUpsertProjectSkillConfig as jest.Mock).mockReturnValue({
      mutate: jest.fn(),
      mutateAsync,
      isPending: false,
      error: null,
    });

    render(<AdminProjectSettings selectedProject="Apex" />);
    fireEvent.click(screen.getByTestId('ps-config-edit-settings-1'));
    fireEvent.change(screen.getByTestId('ps-stage-effort-interviewEffort'), {
      target: { value: effort },
    });
    fireEvent.click(screen.getByTestId('ps-form-save'));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ interviewEffort: effort }),
    })));
    },
  );

  it('PBI-001 AC-2 maps Inherit to null after replacing High', async () => {
    const mutateAsync = jest.fn().mockResolvedValue(projectConfig);
    (useUpsertProjectSkillConfig as jest.Mock).mockReturnValue({
      mutate: jest.fn(),
      mutateAsync,
      isPending: false,
      error: null,
    });
    (useAllProjectSkillConfigs as jest.Mock).mockReturnValue({
      data: [{ ...projectConfig, interviewEffort: 'high' }],
      isLoading: false,
      isError: false,
    });

    render(<AdminProjectSettings selectedProject="Apex" />);
    fireEvent.click(screen.getByTestId('ps-config-edit-settings-1'));
    const effortSelect = screen.getByTestId('ps-stage-effort-interviewEffort');
    expect(effortSelect).toHaveValue('high');
    fireEvent.change(effortSelect, { target: { value: '' } });
    fireEvent.click(screen.getByTestId('ps-form-save'));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ interviewEffort: null }),
    })));
  });
});

describe('AdminProjectSettings — quick pill effort overrides', () => {
  const pillConfig = {
    ...projectConfig,
    quickSkillPills: [{ label: 'Prod Support', skillPath: 'skills/prod/SKILL.md' }],
    quickMcpPills: [{
      label: 'SendGrid',
      mcpServerName: 'sendgrid',
      transport: 'stdio' as const,
      command: 'npx',
    }],
    interviewSkillOptions: [{ path: 'skills/grill/SKILL.md', friendlyName: 'Feature Interview' }],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    setupMocks();
    (useAllProjectSkillConfigs as jest.Mock).mockReturnValue({
      data: [pillConfig],
      isLoading: false,
      isError: false,
    });
    (useSkillList as jest.Mock).mockReturnValue({
      data: [{ id: 'skill-1', path: 'skills/prod/SKILL.md', name: 'Production Support' }],
      isLoading: false,
    });
  });

  it('saves an effort override selected on an existing quick skill pill', async () => {
    const mutateAsync = jest.fn().mockResolvedValue(pillConfig);
    (useUpsertProjectSkillConfig as jest.Mock).mockReturnValue({
      mutate: jest.fn(),
      mutateAsync,
      isPending: false,
      error: null,
    });

    render(<AdminProjectSettings selectedProject="Apex" />);
    fireEvent.click(screen.getByTestId('ps-config-edit-settings-1'));
    fireEvent.change(screen.getByTestId('ps-skill-pill-effort-0'), {
      target: { value: 'high' },
    });
    fireEvent.click(screen.getByTestId('ps-form-save'));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        quickSkillPills: [expect.objectContaining({ label: 'Prod Support', effort: 'high' })],
      }),
    })));
  });

  it('saves an effort override selected on an existing quick MCP pill', async () => {
    const mutateAsync = jest.fn().mockResolvedValue(pillConfig);
    (useUpsertProjectSkillConfig as jest.Mock).mockReturnValue({
      mutate: jest.fn(),
      mutateAsync,
      isPending: false,
      error: null,
    });

    render(<AdminProjectSettings selectedProject="Apex" />);
    fireEvent.click(screen.getByTestId('ps-config-edit-settings-1'));
    fireEvent.change(screen.getByTestId('ps-mcp-pill-effort-0'), {
      target: { value: 'low' },
    });
    fireEvent.click(screen.getByTestId('ps-form-save'));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        quickMcpPills: [expect.objectContaining({ mcpServerName: 'sendgrid', effort: 'low' })],
      }),
    })));
  });

  it('saves an effort override selected on an interview skill option', async () => {
    const mutateAsync = jest.fn().mockResolvedValue(pillConfig);
    (useUpsertProjectSkillConfig as jest.Mock).mockReturnValue({
      mutate: jest.fn(),
      mutateAsync,
      isPending: false,
      error: null,
    });

    render(<AdminProjectSettings selectedProject="Apex" />);
    fireEvent.click(screen.getByTestId('ps-config-edit-settings-1'));
    fireEvent.change(screen.getByTestId('ps-interview-option-effort-0'), {
      target: { value: 'medium' },
    });
    fireEvent.click(screen.getByTestId('ps-form-save'));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        interviewSkillOptions: [expect.objectContaining({
          friendlyName: 'Feature Interview',
          effort: 'medium',
        })],
      }),
    })));
  });

  it('adds a new quick skill pill with the chosen model and effort', () => {
    render(<AdminProjectSettings selectedProject="Apex" />);
    fireEvent.click(screen.getByTestId('ps-config-edit-settings-1'));

    fireEvent.change(screen.getByTestId('ps-pill-label'), {
      target: { value: 'Incident Triage' },
    });
    fireEvent.change(screen.getByTestId('ps-pill-skill'), {
      target: { value: 'skills/prod/SKILL.md' },
    });
    fireEvent.change(screen.getByTestId('ps-pill-effort'), {
      target: { value: 'high' },
    });
    fireEvent.click(screen.getByTestId('ps-skill-pill-add'));

    expect(screen.getByTestId('ps-skill-pill-effort-1')).toHaveValue('high');
    expect(screen.getByText('Incident Triage')).toBeInTheDocument();
    // Inputs reset so the next pill starts clean.
    expect(screen.getByTestId('ps-pill-label')).toHaveValue('');
    expect(screen.getByTestId('ps-pill-effort')).toHaveValue('');
  });

  it('explains why Add did nothing instead of failing silently', () => {
    render(<AdminProjectSettings selectedProject="Apex" />);
    fireEvent.click(screen.getByTestId('ps-config-edit-settings-1'));

    fireEvent.click(screen.getByTestId('ps-skill-pill-add'));
    expect(screen.getByTestId('ps-skill-pill-add-error')).toHaveTextContent(
      'Enter a label for the pill.',
    );

    fireEvent.change(screen.getByTestId('ps-pill-label'), {
      target: { value: 'Incident Triage' },
    });
    fireEvent.click(screen.getByTestId('ps-skill-pill-add'));
    expect(screen.getByTestId('ps-skill-pill-add-error')).toHaveTextContent(
      'Select a skill for the pill.',
    );
  });

  it('reports an empty skill list rather than a dead Add button', () => {
    (useSkillList as jest.Mock).mockReturnValue({ data: [], isLoading: false });

    render(<AdminProjectSettings selectedProject="Apex" />);
    fireEvent.click(screen.getByTestId('ps-config-edit-settings-1'));

    expect(screen.getByTestId('ps-skill-pill-add-no-skills')).toBeInTheDocument();
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

describe('AdminProjectSettings — Home pill allow-lists', () => {
  const skillPills = [
    { label: 'Prod Support', skillPath: 'skills/prod/SKILL.md' },
    { label: 'Release Notes', skillPath: 'skills/release/SKILL.md' },
  ];
  const mcpPills = [
    {
      label: 'SendGrid',
      mcpServerName: 'sendgrid',
      transport: 'stdio' as const,
      command: 'npx',
    },
    {
      label: 'Twilio',
      mcpServerName: 'twilio',
      transport: 'http' as const,
      url: 'https://mcp.twilio.com/docs',
    },
  ];
  const allowlistConfig = {
    ...projectConfig,
    quickSkillPills: skillPills,
    quickMcpPills: mcpPills,
  };

  function mockConfig(config: Record<string, unknown>) {
    (useAllProjectSkillConfigs as jest.Mock).mockReturnValue({
      data: [config],
      isLoading: false,
      isError: false,
    });
  }

  function mockUpsert(overrides: Record<string, unknown> = {}) {
    const mutateAsync = jest.fn().mockResolvedValue(allowlistConfig);
    (useUpsertProjectSkillConfig as jest.Mock).mockReturnValue({
      mutate: jest.fn(),
      mutateAsync,
      isPending: false,
      error: null,
      ...overrides,
    });
    return mutateAsync;
  }

  function openPillEditor() {
    fireEvent.click(screen.getByTestId('ps-config-edit-settings-1'));
  }

  beforeEach(() => {
    jest.clearAllMocks();
    setupMocks();
    mockConfig(allowlistConfig);
    (useUsers as jest.Mock).mockReturnValue({
      data: [{ oid: 'user-added', displayName: 'Ada Lovelace', email: 'ada@example.com' }],
    });
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
    (useSkillList as jest.Mock).mockReturnValue({
      data: [{ id: 'skill-1', path: 'skills/prod/SKILL.md', name: 'Production Support' }],
      isLoading: false,
    });
  });

  it('TBI-002 DoD-0 and DoD-1 bind a labeled allow-list picker to every skill and MCP pill row', () => {
    render(<AdminProjectSettings selectedProject="Apex" />);
    openPillEditor();

    for (const testId of [
      'ps-skill-pill-allowlist-0',
      'ps-skill-pill-allowlist-1',
      'ps-mcp-pill-allowlist-0',
      'ps-mcp-pill-allowlist-1',
    ]) {
      const wrapper = screen.getByTestId(testId);
      expect(wrapper).toBeVisible();
      // NFR: screen-reader labeled, matching the existing pill editor fields.
      expect(within(wrapper).getByRole('textbox', {
        name: /Search groups or people/i,
      })).toBeVisible();
      // BR-001: empty allow-list copy comes straight from the picker.
      expect(within(wrapper).getByText('No groups or people selected')).toBeVisible();
    }
  });

  it('TBI-002 DoD-0 and DoD-1 disable every pill allow-list picker while a save is in flight', () => {
    mockUpsert({ isPending: true });

    render(<AdminProjectSettings selectedProject="Apex" />);
    openPillEditor();

    for (const testId of ['ps-skill-pill-allowlist-0', 'ps-mcp-pill-allowlist-0']) {
      const wrapper = screen.getByTestId(testId);
      expect(within(wrapper).getByRole('button', { name: 'Add first user' })).toBeDisabled();
      expect(within(wrapper).getByRole('textbox', {
        name: /Search groups or people/i,
      })).toBeDisabled();
    }
  });

  it('VT-04 / PBI-001 AC-0 / TBI-002 DoD-0 — Given a Project Admin editing a skill pill, When a user and a group are added, Then only that row shows the selection', () => {
    render(<AdminProjectSettings selectedProject="Apex" />);
    openPillEditor();

    const edited = screen.getByTestId('ps-skill-pill-allowlist-0');
    fireEvent.click(within(edited).getByRole('button', { name: 'Add first user' }));
    fireEvent.click(within(edited).getByRole('button', { name: 'Add empty group' }));

    expect(within(edited).getByText('users:user-added')).toBeVisible();
    expect(within(edited).getByText('groups:group-empty')).toBeVisible();
    expect(within(edited).getByText('Empty Architects (0 members)')).toBeVisible();

    const untouched = screen.getByTestId('ps-skill-pill-allowlist-1');
    expect(within(untouched).getByText('users:')).toBeInTheDocument();
    expect(within(untouched).getByText('groups:')).toBeInTheDocument();
  });

  it('VT-06 / PBI-001 AC-0 / TBI-002 DoD-2 — Given a skill pill allow-list edit, When saved, Then the payload persists the allow-list with the existing pill attributes', async () => {
    const mutateAsync = mockUpsert();

    render(<AdminProjectSettings selectedProject="Apex" />);
    openPillEditor();

    const wrapper = screen.getByTestId('ps-skill-pill-allowlist-0');
    fireEvent.click(within(wrapper).getByRole('button', { name: 'Add first user' }));
    fireEvent.click(within(wrapper).getByRole('button', { name: 'Add empty group' }));
    fireEvent.click(screen.getByTestId('ps-form-save'));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        quickSkillPills: [
          expect.objectContaining({
            label: 'Prod Support',
            skillPath: 'skills/prod/SKILL.md',
            allowedUserIds: ['user-added'],
            allowedGroupIds: ['group-empty'],
          }),
          expect.objectContaining({ label: 'Release Notes' }),
        ],
      }),
    })));
  });

  it('PBI-001 AC-2 / TBI-002 DoD-3 — Given a skill pill with a saved allow-list, When it is cleared and saved, Then both arrays persist as empty', async () => {
    mockConfig({
      ...allowlistConfig,
      quickSkillPills: [
        { ...skillPills[0], allowedUserIds: ['user-added'], allowedGroupIds: ['group-empty'] },
        skillPills[1],
      ],
    });
    const mutateAsync = mockUpsert();

    render(<AdminProjectSettings selectedProject="Apex" />);
    openPillEditor();

    const wrapper = screen.getByTestId('ps-skill-pill-allowlist-0');
    expect(within(wrapper).getByText('users:user-added')).toBeVisible();
    fireEvent.click(within(wrapper).getByRole('button', { name: 'Clear selections' }));

    expect(within(wrapper).getByText('No groups or people selected')).toBeVisible();
    fireEvent.click(screen.getByTestId('ps-form-save'));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        quickSkillPills: [
          expect.objectContaining({
            label: 'Prod Support',
            allowedUserIds: [],
            allowedGroupIds: [],
          }),
          expect.objectContaining({ label: 'Release Notes' }),
        ],
      }),
    })));
  });

  it('VT-07 / PBI-001 AC-1 — Given a skill pill allow-list edit, When the save is rejected, Then the error shows and the edited picker state stays available for retry', async () => {
    mockUpsert({ mutateAsync: jest.fn().mockRejectedValue(new Error('Save unavailable')) });

    render(<AdminProjectSettings selectedProject="Apex" />);
    openPillEditor();

    const wrapper = screen.getByTestId('ps-skill-pill-allowlist-0');
    fireEvent.click(within(wrapper).getByRole('button', { name: 'Add first user' }));
    fireEvent.click(screen.getByTestId('ps-form-save'));

    expect(await screen.findByText('Save unavailable')).toBeVisible();
    expect(within(screen.getByTestId('ps-skill-pill-allowlist-0')).getByText(
      'users:user-added',
    )).toBeVisible();
    expect(screen.getByTestId('ps-form-save')).toBeVisible();
    expect(screen.getByText('Edit: Main')).toBeVisible();
  });

  it('VT-05 / PBI-002 AC-0 / TBI-002 DoD-1 — Given a Project Admin editing an MCP pill, When a user and a group are added, Then only that row shows the selection', () => {
    render(<AdminProjectSettings selectedProject="Apex" />);
    openPillEditor();

    const edited = screen.getByTestId('ps-mcp-pill-allowlist-0');
    fireEvent.click(within(edited).getByRole('button', { name: 'Add first user' }));
    fireEvent.click(within(edited).getByRole('button', { name: 'Add empty group' }));

    expect(within(edited).getByText('users:user-added')).toBeVisible();
    expect(within(edited).getByText('groups:group-empty')).toBeVisible();

    const untouched = screen.getByTestId('ps-mcp-pill-allowlist-1');
    expect(within(untouched).getByText('users:')).toBeInTheDocument();
    expect(within(untouched).getByText('groups:')).toBeInTheDocument();
  });

  it('VT-06 / PBI-002 AC-0 / TBI-002 DoD-2 — Given an MCP pill allow-list edit, When saved, Then the payload persists the allow-list with the existing pill attributes', async () => {
    const mutateAsync = mockUpsert();

    render(<AdminProjectSettings selectedProject="Apex" />);
    openPillEditor();

    const wrapper = screen.getByTestId('ps-mcp-pill-allowlist-0');
    fireEvent.click(within(wrapper).getByRole('button', { name: 'Add first user' }));
    fireEvent.click(within(wrapper).getByRole('button', { name: 'Add empty group' }));
    fireEvent.click(screen.getByTestId('ps-form-save'));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        quickMcpPills: [
          expect.objectContaining({
            mcpServerName: 'sendgrid',
            transport: 'stdio',
            command: 'npx',
            allowedUserIds: ['user-added'],
            allowedGroupIds: ['group-empty'],
          }),
          expect.objectContaining({ mcpServerName: 'twilio' }),
        ],
      }),
    })));
  });

  it('PBI-002 AC-2 / TBI-002 DoD-3 — Given an MCP pill with a saved allow-list, When it is cleared and saved, Then both arrays persist as empty', async () => {
    mockConfig({
      ...allowlistConfig,
      quickMcpPills: [
        { ...mcpPills[0], allowedUserIds: ['user-added'], allowedGroupIds: ['group-empty'] },
        mcpPills[1],
      ],
    });
    const mutateAsync = mockUpsert();

    render(<AdminProjectSettings selectedProject="Apex" />);
    openPillEditor();

    const wrapper = screen.getByTestId('ps-mcp-pill-allowlist-0');
    expect(within(wrapper).getByText('groups:group-empty')).toBeVisible();
    fireEvent.click(within(wrapper).getByRole('button', { name: 'Clear selections' }));

    expect(within(wrapper).getByText('No groups or people selected')).toBeVisible();
    fireEvent.click(screen.getByTestId('ps-form-save'));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        quickMcpPills: [
          expect.objectContaining({
            mcpServerName: 'sendgrid',
            allowedUserIds: [],
            allowedGroupIds: [],
          }),
          expect.objectContaining({ mcpServerName: 'twilio' }),
        ],
      }),
    })));
  });

  it('VT-07 / PBI-002 AC-1 — Given an MCP pill allow-list edit, When the save is rejected, Then the error shows and the edited picker state stays available for retry', async () => {
    mockUpsert({ mutateAsync: jest.fn().mockRejectedValue(new Error('Save unavailable')) });

    render(<AdminProjectSettings selectedProject="Apex" />);
    openPillEditor();

    const wrapper = screen.getByTestId('ps-mcp-pill-allowlist-0');
    fireEvent.click(within(wrapper).getByRole('button', { name: 'Add empty group' }));
    fireEvent.click(screen.getByTestId('ps-form-save'));

    expect(await screen.findByText('Save unavailable')).toBeVisible();
    expect(within(screen.getByTestId('ps-mcp-pill-allowlist-0')).getByText(
      'groups:group-empty',
    )).toBeVisible();
    expect(screen.getByTestId('ps-form-save')).toBeVisible();
    expect(screen.getByText('Edit: Main')).toBeVisible();
  });
});

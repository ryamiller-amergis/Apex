import { render, screen } from '@testing-library/react';
import { AdminProjectSettings } from '../AdminProjectSettings';
import type { ProjectSkillConfig } from '../../../shared/types/projectSettings';

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

jest.mock('../GroupAwarePeoplePicker', () => ({
  GroupAwarePeoplePicker: () => <div data-testid="people-picker" />,
}));

jest.mock('../../hooks/useFeatureFlags', () => ({
  useFeatureFlag: jest.fn(),
}));

jest.mock('../../hooks/useProjectRepositoryReadiness', () => {
  const actual = jest.requireActual('../../hooks/useProjectRepositoryReadiness') as Record<string, unknown>;
  return {
    ...actual,
    useAdminProjectRepositoryReadiness: jest.fn(),
    useCloneProjectRepository: jest.fn(),
  };
});

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
import { useFeatureFlag } from '../../hooks/useFeatureFlags';
import {
  useAdminProjectRepositoryReadiness,
  useCloneProjectRepository,
} from '../../hooks/useProjectRepositoryReadiness';

const readyConfig: ProjectSkillConfig = {
  id: 'cfg-ready',
  project: 'Apex',
  friendlyName: 'Apex main',
  isDefault: true,
  skillProvider: 'github',
  skillRepo: 'AI-Pilot',
  skillBranch: 'main',
  repositoryCheckoutStatus: 'ready',
  repositoryCheckoutSha: 'abc123def456',
};

function setupMocks() {
  const noop = { mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false, error: null, variables: undefined };
  (useAllProjectSkillConfigs as jest.Mock).mockReturnValue({
    data: [readyConfig],
    isLoading: false,
    isError: false,
  });
  (useUpsertProjectSkillConfig as jest.Mock).mockReturnValue(noop);
  (useDeleteProjectSkillConfig as jest.Mock).mockReturnValue(noop);
  (useAvailableModels as jest.Mock).mockReturnValue({ data: [], isLoading: false });
  (useAvailableBedrockModels as jest.Mock).mockReturnValue({ data: [] });
  (useProjectApprovers as jest.Mock).mockReturnValue({ data: null });
  (useSetProjectApprovers as jest.Mock).mockReturnValue(noop);
  (useSkillRepos as jest.Mock).mockReturnValue({ data: [], isLoading: false });
  (useSkillBranches as jest.Mock).mockReturnValue({ data: [], isLoading: false });
  (useSkillList as jest.Mock).mockReturnValue({ data: [], isLoading: false });
  (useUsers as jest.Mock).mockReturnValue({ data: [] });
  (useGroupsWithMembers as jest.Mock).mockReturnValue({ data: [] });
  (useFeatureFlag as jest.Mock).mockReturnValue(true);
  (useCloneProjectRepository as jest.Mock).mockReturnValue(noop);
}

describe('AdminProjectSettings repo checkout AC-3/AC-4', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupMocks();
  });

  it('AC-3: shows Refresh when the configuration is Ready', () => {
    (useAdminProjectRepositoryReadiness as jest.Mock).mockReturnValue({
      data: {
        skillSettingsId: 'cfg-ready',
        status: 'ready',
        sha: 'abc123def456',
        error: null,
        startedAt: null,
        completedAt: null,
        filesystemReady: true,
      },
      isFetching: false,
    });

    render(<AdminProjectSettings selectedProject="Apex" />);

    expect(screen.getByTestId('repo-checkout-refresh-cfg-ready')).toBeInTheDocument();
    expect(screen.queryByTestId('repo-checkout-clone-cfg-ready')).not.toBeInTheDocument();
  });

  it('AC-4: shows progress bar and phase label while cloning', () => {
    (useAdminProjectRepositoryReadiness as jest.Mock).mockReturnValue({
      data: {
        skillSettingsId: 'cfg-ready',
        status: 'cloning',
        sha: null,
        error: null,
        startedAt: '2026-08-12T00:00:00Z',
        completedAt: null,
        filesystemReady: false,
        progressPercent: 26,
        progressLabel: 'Receiving objects 45%',
      },
      isFetching: true,
    });

    render(<AdminProjectSettings selectedProject="Apex" />);

    expect(screen.getByTestId('repo-checkout-progress-cfg-ready')).toBeInTheDocument();
    expect(screen.getByTestId('repo-checkout-progress-bar-cfg-ready')).toHaveAttribute(
      'aria-valuenow',
      '26',
    );
    expect(screen.getByTestId('repo-checkout-progress-label-cfg-ready')).toHaveTextContent(
      'Receiving objects 45%',
    );
  });
});

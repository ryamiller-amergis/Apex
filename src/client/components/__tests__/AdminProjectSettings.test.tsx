/**
 * Smoke coverage for AdminProjectSettings Design Module skill wiring.
 */

import { render, screen, fireEvent } from '@testing-library/react';
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

jest.mock('../GroupAwarePeoplePicker', () => ({
  GroupAwarePeoplePicker: () => <div data-testid="people-picker" />,
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
  (useProjectApprovers as jest.Mock).mockReturnValue({ data: null });
  (useSetProjectApprovers as jest.Mock).mockReturnValue(noop);
  (useSkillRepos as jest.Mock).mockReturnValue({ data: [], isLoading: false });
  (useSkillBranches as jest.Mock).mockReturnValue({ data: [], isLoading: false });
  (useSkillList as jest.Mock).mockReturnValue({ data: [], isLoading: false });
  (useUsers as jest.Mock).mockReturnValue({ data: [] });
  (useGroupsWithMembers as jest.Mock).mockReturnValue({ data: [] });
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

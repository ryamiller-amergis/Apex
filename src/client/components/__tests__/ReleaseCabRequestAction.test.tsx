import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReleaseCabRequestAction } from '../ReleaseCabRequestAction';
import { useFeatureFlag } from '../../hooks/useFeatureFlags';
import { useAppShell } from '../../hooks/useAppShell';
import { useProjectSkillConfig } from '../../hooks/useProjectSkillConfig';
import { useSkillList } from '../../hooks/useChatThreads';

jest.mock('../../hooks/useFeatureFlags', () => ({
  useFeatureFlag: jest.fn(),
}));

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: jest.fn(),
}));

jest.mock('../../hooks/useProjectSkillConfig', () => ({
  useProjectSkillConfig: jest.fn(),
}));

jest.mock('../../hooks/useChatThreads', () => ({
  useSkillList: jest.fn(),
}));

const mockFlag = useFeatureFlag as jest.Mock;
const mockShell = useAppShell as jest.Mock;
const mockSkillConfig = useProjectSkillConfig as jest.Mock;
const mockSkillList = useSkillList as jest.Mock;

function stubShell(overrides?: { can?: (key: string) => boolean; isInAnyGroup?: () => boolean }) {
  mockShell.mockReturnValue({
    can: overrides?.can ?? ((key: string) => key === 'planning:releases' || key === 'chat:create'),
    isInAnyGroup: overrides?.isInAnyGroup ?? (() => true),
    permissionsLoaded: true,
  });
}

describe('ReleaseCabRequestAction', () => {
  const onClick = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockSkillConfig.mockReturnValue({
      data: { skillRepo: 'MaxView', skillBranch: 'main', skillProvider: 'ado' },
    });
    mockSkillList.mockReturnValue({
      data: [{ name: 'cab-release', path: '.cursor/skills/cab-release/SKILL.md' }],
    });
    stubShell();
  });

  it('renders nothing when the flag is off', () => {
    mockFlag.mockReturnValue(false);
    const { container } = render(<ReleaseCabRequestAction project="MaxView" onClick={onClick} />);
    expect(container).toBeEmptyDOMElement();
    expect(mockFlag).toHaveBeenCalledWith('release-cab-request', 'MaxView');
  });

  it('renders nothing without chat:create', () => {
    mockFlag.mockReturnValue(true);
    stubShell({ can: (key) => key === 'planning:releases' });
    const { container } = render(<ReleaseCabRequestAction project="MaxView" onClick={onClick} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the operator is not in BA', () => {
    mockFlag.mockReturnValue(true);
    stubShell({ isInAnyGroup: () => false });
    const { container } = render(<ReleaseCabRequestAction project="MaxView" onClick={onClick} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when cab-release is missing from the skill list', () => {
    mockFlag.mockReturnValue(true);
    mockSkillList.mockReturnValue({ data: [{ name: 'grill-with-docs', path: '.cursor/skills/grill-with-docs/SKILL.md' }] });
    const { container } = render(<ReleaseCabRequestAction project="MaxView" onClick={onClick} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the Actions item when the flag, permissions, and skill are present', async () => {
    mockFlag.mockReturnValue(true);
    const user = userEvent.setup();
    render(<ReleaseCabRequestAction project="MaxView" onClick={onClick} />);
    const button = screen.getByTestId('release-create-cab-action');
    expect(button).toHaveTextContent('Create CAB request');
    await user.click(button);
    expect(onClick).toHaveBeenCalled();
  });
});

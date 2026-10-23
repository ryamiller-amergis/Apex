import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReleaseCabRequestAction } from '../ReleaseCabRequestAction';
import { useFeatureFlag } from '../../hooks/useFeatureFlags';
import { useAppShell } from '../../hooks/useAppShell';

jest.mock('../../hooks/useFeatureFlags', () => ({
  useFeatureFlag: jest.fn(),
}));

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: jest.fn(),
}));

const mockFlag = useFeatureFlag as jest.Mock;
const mockShell = useAppShell as jest.Mock;

function stubShell(overrides?: { can?: (key: string) => boolean }) {
  mockShell.mockReturnValue({
    can: overrides?.can ?? ((key: string) => key === 'planning:releases' || key === 'chat:create'),
    permissionsLoaded: true,
  });
}

function stubFlags(flags: Record<string, boolean>) {
  mockFlag.mockImplementation((key: string) => flags[key] === true);
}

describe('ReleaseCabRequestAction', () => {
  const onClick = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    stubShell();
  });

  it('renders nothing when the flag is off', () => {
    stubFlags({ 'ai-runs-v2-transport': true });
    const { container } = render(<ReleaseCabRequestAction project="MaxView" onClick={onClick} />);
    expect(container).toBeEmptyDOMElement();
    expect(mockFlag).toHaveBeenCalledWith('release-cab-request', 'MaxView');
  });

  it('renders nothing when the interactive container transport is off', () => {
    stubFlags({ 'release-cab-request': true });
    const { container } = render(<ReleaseCabRequestAction project="MaxView" onClick={onClick} />);
    expect(container).toBeEmptyDOMElement();
    expect(mockFlag).toHaveBeenCalledWith('ai-runs-v2-transport', 'MaxView');
  });

  it('renders nothing without chat:create', () => {
    stubFlags({ 'release-cab-request': true, 'ai-runs-v2-transport': true });
    stubShell({ can: (key) => key === 'planning:releases' });
    const { container } = render(<ReleaseCabRequestAction project="MaxView" onClick={onClick} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the Actions item when the flags and permissions are present', async () => {
    stubFlags({ 'release-cab-request': true, 'ai-runs-v2-transport': true });
    const user = userEvent.setup();
    render(<ReleaseCabRequestAction project="MaxView" onClick={onClick} />);
    const button = screen.getByTestId('release-create-cab-action');
    expect(button).toHaveTextContent('Create CAB request');
    await user.click(button);
    expect(onClick).toHaveBeenCalled();
  });
});

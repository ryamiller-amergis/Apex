import { render, screen } from '@testing-library/react';
import { FeatureFlagDemo } from '../FeatureFlagDemo';
import { useFeatureFlag } from '../../hooks/useFeatureFlags';

jest.mock('../../hooks/useFeatureFlags', () => ({
  useFeatureFlag: jest.fn(),
}));

const mockUseFeatureFlag = useFeatureFlag as jest.Mock;

describe('FeatureFlagDemo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders nothing when the example-flag-demo flag is disabled', () => {
    mockUseFeatureFlag.mockReturnValue(false);
    const { container } = render(<FeatureFlagDemo project="MaxView" />);

    expect(container).toBeEmptyDOMElement();
    expect(mockUseFeatureFlag).toHaveBeenCalledWith('example-flag-demo', 'MaxView');
  });

  it('renders the demo banner when the flag is enabled', () => {
    mockUseFeatureFlag.mockReturnValue(true);
    render(<FeatureFlagDemo project="MaxView" />);

    expect(screen.getByText('Feature Flag Demo')).toBeInTheDocument();
    expect(screen.getByText(/gated behind the "example-flag-demo" feature flag/i)).toBeInTheDocument();
  });
});

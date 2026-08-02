import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RunGroundingStatus } from '../RunGroundingStatus';
import { useFeatureFlag } from '../../hooks/useFeatureFlags';
import { useRunGrounding } from '../../hooks/useRunGrounding';

jest.mock('../../hooks/useFeatureFlags', () => ({
  useFeatureFlag: jest.fn(),
}));
jest.mock('../../hooks/useRunGrounding', () => ({
  useRunGrounding: jest.fn(),
}));

const mockUseFeatureFlag = useFeatureFlag as jest.MockedFunction<
  typeof useFeatureFlag
>;
const mockUseRunGrounding = useRunGrounding as jest.MockedFunction<
  typeof useRunGrounding
>;

const sha = 'a'.repeat(40);
const status = {
  runType: 'chat' as const,
  runId: 'prd-thread',
  role: 'target' as const,
  groundedSha: sha,
  groundedShaShort: sha.slice(0, 12),
  groundedAt: '2026-08-02T14:00:00.000Z',
  driftState: 'source-changed' as const,
  canReGround: true,
};

function mockGroundingHook(overrides = {}) {
  mockUseRunGrounding.mockReturnValue({
    statuses: [status],
    isLoading: false,
    isError: false,
    reGround: jest.fn().mockResolvedValue(undefined),
    isReGrounding: false,
    reGroundError: null,
    ...overrides,
  });
}

describe('TBI-004 DoD-3 reusable grounding status UI', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseFeatureFlag.mockReturnValue(true);
    mockGroundingHook();
  });

  it('DoD-3 renders the SHA, grounded date, non-blocking drift state, and owner action', () => {
    // Arrange / Act
    render(
      <RunGroundingStatus surface="prd" domainRunId="prd-1" project="Apex" />
    );

    // Assert
    expect(screen.getByTestId('run-grounding-status')).toBeInTheDocument();
    expect(screen.getByTestId('run-grounding-sha')).toHaveTextContent(
      sha.slice(0, 12)
    );
    expect(screen.getByTestId('run-grounding-sha')).toHaveTextContent(
      /Aug 2, 2026/i
    );
    expect(screen.getByTestId('run-grounding-sha')).toHaveAttribute(
      'title',
      expect.stringContaining(sha)
    );
    const notice = screen.getByTestId('run-grounding-drift-notice');
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice).toHaveAttribute('aria-live', 'polite');
    expect(notice).toHaveTextContent(/source changed/i);
    expect(screen.getByTestId('run-grounding-reground-button')).toBeEnabled();
  });

  it('DoD-3 explains why a participant cannot use the owner-only action', () => {
    // Arrange
    mockGroundingHook({
      statuses: [{ ...status, canReGround: false }],
    });

    // Act
    render(
      <RunGroundingStatus surface="prd" domainRunId="prd-1" project="Apex" />
    );

    // Assert
    expect(screen.getByTestId('run-grounding-reground-button')).toBeDisabled();
    expect(screen.getByText(/only the run owner can re-ground/i)).toBeVisible();
  });

  it('DoD-3 requires confirmation and Escape returns focus to the trigger without re-grounding', async () => {
    // Arrange
    const reGround = jest.fn().mockResolvedValue(undefined);
    mockGroundingHook({ reGround });
    render(
      <RunGroundingStatus surface="prd" domainRunId="prd-1" project="Apex" />
    );
    const trigger = screen.getByTestId('run-grounding-reground-button');

    // Act
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });

    // Assert
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    );
    expect(reGround).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
  });

  it('DoD-3 confirms explicit re-ground through the required action contract', async () => {
    // Arrange
    const reGround = jest.fn().mockResolvedValue(undefined);
    mockGroundingHook({ reGround });
    render(
      <RunGroundingStatus surface="prd" domainRunId="prd-1" project="Apex" />
    );

    // Act
    fireEvent.click(screen.getByTestId('run-grounding-reground-button'));
    fireEvent.click(screen.getByTestId('run-grounding-reground-confirm'));

    // Assert
    await waitFor(() => expect(reGround).toHaveBeenCalledWith('target'));
  });

  it('feature flag off preserves the existing null UI', () => {
    // Arrange
    mockUseFeatureFlag.mockReturnValue(false);

    // Act
    const { container } = render(
      <RunGroundingStatus surface="prd" domainRunId="prd-1" project="Apex" />
    );

    // Assert
    expect(container).toBeEmptyDOMElement();
    expect(mockUseRunGrounding).not.toHaveBeenCalled();
  });
});

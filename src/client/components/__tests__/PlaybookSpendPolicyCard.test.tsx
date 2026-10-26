import { render, screen } from '@testing-library/react';
import { PlaybookSpendPolicyCard } from '../PlaybookSpendPolicyCard';
import {
  usePlaybookSpendPolicy,
  useUpdatePlaybookSpendPolicy,
} from '../../hooks/usePlaybookSpendPolicy';

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({
    can: (permission: string) => permission === 'playbooks:admin',
  }),
}));
jest.mock('../../hooks/usePlaybookSpendPolicy', () => ({
  usePlaybookSpendPolicy: jest.fn(),
  useUpdatePlaybookSpendPolicy: jest.fn(),
}));

const mockPolicy = usePlaybookSpendPolicy as jest.MockedFunction<
  typeof usePlaybookSpendPolicy
>;
const mockUpdate = useUpdatePlaybookSpendPolicy as jest.MockedFunction<
  typeof useUpdatePlaybookSpendPolicy
>;

describe('FEAT-015 Project Admin spend policy card', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdate.mockReturnValue({
      mutateAsync: jest.fn(),
      isPending: false,
      isSuccess: false,
      error: null,
    } as unknown as ReturnType<typeof useUpdatePlaybookSpendPolicy>);
  });

  it('shows blocked status, spend values, and the accessible override controls', () => {
    mockPolicy.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        project: 'Apex',
        enabled: true,
        baselineCostUsd: '10.000000',
        capUsd: '30.000000',
        currentSpendUsd: '30.000000',
        warningThresholdUsd: '22.500000',
        startsBlocked: true,
        warningActive: true,
        warningGeneration: 1,
        warningCrossedAt: '2026-09-22T16:00:00.000Z',
        warningRecipientUserIds: ['admin-1'],
        overrideByUserId: null,
        overrideToUsd: null,
        overrideAt: null,
        overrideReason: null,
        createdAt: '2026-09-22T16:00:00.000Z',
        updatedAt: '2026-09-22T16:00:00.000Z',
      },
    } as unknown as ReturnType<typeof usePlaybookSpendPolicy>);

    render(<PlaybookSpendPolicyCard project="Apex" />);

    expect(
      screen.getByTestId('playbook-spend-policy-status')
    ).toHaveTextContent('New starts blocked');
    expect(screen.getByTestId('playbook-spend-cap-input')).toBeInTheDocument();
    expect(screen.getByTestId('playbook-spend-override-reason')).toBeRequired();
    expect(screen.getByTestId('playbook-spend-override-submit')).toBeDisabled();
  });
});

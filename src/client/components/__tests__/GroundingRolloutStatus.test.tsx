import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GroundingGateEvaluation } from '../../../shared/types/groundingOperations';
import { useGroundingRolloutStatus } from '../../hooks/useGroundingRolloutStatus';
import { GroundingRolloutStatus } from '../GroundingRolloutStatus';

jest.mock('../../hooks/useGroundingRolloutStatus', () => ({
  useGroundingRolloutStatus: jest.fn(),
}));

const mockUseGroundingRolloutStatus = useGroundingRolloutStatus as jest.Mock;

const eligibleEvaluation: GroundingGateEvaluation = {
  cohort: 'design-module',
  sampleSize: 125,
  minimumSampleSize: 100,
  gates: [
    {
      id: 'fallback-rate',
      label: 'Remote fallback rate',
      value: 0.01,
      threshold: 0.02,
      comparison: '<',
      status: 'pass',
    },
    {
      id: 'warm-materialization-p95',
      label: 'Warm materialization P95',
      value: 5_000,
      threshold: 10_000,
      comparison: '<',
      status: 'pass',
    },
    {
      id: 'cold-materialization-p95',
      label: 'Cold materialization P95',
      value: 30_000,
      threshold: 60_000,
      comparison: '<',
      status: 'pass',
    },
    {
      id: 'mirror-hit-rate',
      label: 'Mirror hit rate',
      value: 0.95,
      threshold: 0.9,
      comparison: '>',
      status: 'pass',
    },
    {
      id: 'grounding-failures',
      label: 'Grounding-caused failures',
      value: 0,
      threshold: 0,
      comparison: '=',
      status: 'pass',
    },
  ],
  eligible: true,
  blockingGates: [],
};

function mockQuery(overrides: Record<string, unknown> = {}) {
  mockUseGroundingRolloutStatus.mockReturnValue({
    data: eligibleEvaluation,
    isLoading: false,
    isError: false,
    error: null,
    refetch: jest.fn(),
    ...overrides,
  });
}

describe('GroundingRolloutStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery();
  });

  it('AC-0 / BR-011 / accessibility NFR reports eligible supporting metrics and keyboard-operable manual advancement', async () => {
    const user = userEvent.setup({ delay: null });
    const onAdvance = jest.fn();

    render(
      <GroundingRolloutStatus
        stage="design-module"
        onAdvance={onAdvance}
      />,
    );

    expect(
      screen.getByRole('region', { name: /grounding rollout status/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /grounding rollout status/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('grounding-gate-status')).toHaveTextContent(
      /eligible/i,
    );
    expect(screen.getAllByTestId('grounding-gate-row')).toHaveLength(5);
    expect(screen.getByText('125 runs')).toBeInTheDocument();
    expect(screen.getByText('Remote fallback rate')).toBeInTheDocument();
    expect(screen.getAllByText(/pass/i).length).toBeGreaterThan(0);

    const advance = screen.getByTestId('grounding-advance-button');
    expect(advance).toBeEnabled();
    advance.focus();
    await user.keyboard('{Enter}');
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it('AC-1 / BR-011 names failed and unknown gates and disables advancement', () => {
    mockQuery({
      data: {
        ...eligibleEvaluation,
        eligible: false,
        gates: [
          {
            ...eligibleEvaluation.gates[0],
            value: 0.03,
            status: 'fail',
          },
          {
            ...eligibleEvaluation.gates[1],
            value: null,
            status: 'unknown',
          },
        ],
        blockingGates: ['fallback-rate', 'warm-materialization-p95'],
      },
    });

    render(
      <GroundingRolloutStatus
        stage="interviews-documents"
        onAdvance={jest.fn()}
      />,
    );

    expect(screen.getByTestId('grounding-gate-status')).toHaveTextContent(
      /blocked/i,
    );
    expect(screen.getByText('Remote fallback rate').closest('li')).toHaveTextContent(
      /fail/i,
    );
    expect(screen.getByText('Warm materialization P95').closest('li')).toHaveTextContent(
      /unknown/i,
    );
    expect(screen.getByTestId('grounding-advance-button')).toBeDisabled();
  });

  it('AC-1 renders the insufficient-sample empty state with unknown blocking gates', () => {
    mockQuery({
      data: {
        ...eligibleEvaluation,
        sampleSize: 25,
        eligible: false,
        gates: eligibleEvaluation.gates.map((gate) => ({
          ...gate,
          status: 'unknown',
        })),
        blockingGates: eligibleEvaluation.gates.map((gate) => gate.id),
      },
    });

    render(
      <GroundingRolloutStatus
        stage="design-module"
        onAdvance={jest.fn()}
      />,
    );

    expect(
      screen.getByText('Insufficient sample — gates unknown'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('grounding-advance-button')).toBeDisabled();
  });

  it('AC-1 / accessibility NFR exposes an alert and retries the failed query', async () => {
    const user = userEvent.setup({ delay: null });
    const refetch = jest.fn();
    mockQuery({
      data: undefined,
      isError: true,
      error: new Error('Telemetry unavailable'),
      refetch,
    });

    render(
      <GroundingRolloutStatus
        stage="design-module"
        onAdvance={jest.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Telemetry unavailable');
    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('accessibility NFR gives loading skeleton rows a polite status label', () => {
    mockQuery({ data: undefined, isLoading: true });

    render(
      <GroundingRolloutStatus
        stage="design-module"
        onAdvance={jest.fn()}
      />,
    );

    expect(screen.getByRole('status')).toHaveAccessibleName(
      /loading grounding rollout status/i,
    );
    expect(screen.getAllByTestId('grounding-gate-row')).toHaveLength(5);
  });
});

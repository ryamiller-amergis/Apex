import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DeploymentOutcomeModal } from '../DeploymentOutcomeModal';

const mockRecordMutate = jest.fn();
const mockUpdateMutate = jest.fn();
const mockDeleteMutate = jest.fn();

let recordState = { isPending: false, error: null as Error | null, isSuccess: false, reset: jest.fn() };
let updateState = { isPending: false, error: null as Error | null, isSuccess: false, reset: jest.fn() };
let deleteState = { isPending: false, error: null as Error | null };

let mockOutcomes: unknown[] = [];

jest.mock('../../hooks/useDeploymentOutcomes', () => ({
  useDeploymentOutcomes: () => ({
    data: mockOutcomes,
    isLoading: false,
  }),
  useRecordOutcome: () => ({
    mutate: mockRecordMutate,
    isPending: recordState.isPending,
    error: recordState.error,
    isSuccess: recordState.isSuccess,
    reset: recordState.reset,
  }),
  useUpdateOutcome: () => ({
    mutate: mockUpdateMutate,
    isPending: updateState.isPending,
    error: updateState.error,
    isSuccess: updateState.isSuccess,
    reset: updateState.reset,
  }),
  useDeleteOutcome: () => ({
    mutate: mockDeleteMutate,
    isPending: deleteState.isPending,
    error: deleteState.error,
  }),
  resolveDeploymentIdForRelease: jest.fn().mockResolvedValue('release:2.5.0'),
}));

const baseProps = {
  isOpen: true,
  onClose: jest.fn(),
  releaseVersion: '2.5.0',
};

function renderModal(overrides: Partial<typeof baseProps> = {}) {
  return render(<DeploymentOutcomeModal {...baseProps} {...overrides} />);
}

describe('DeploymentOutcomeModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockOutcomes = [];
    recordState = { isPending: false, error: null, isSuccess: false, reset: jest.fn() };
    updateState = { isPending: false, error: null, isSuccess: false, reset: jest.fn() };
    deleteState = { isPending: false, error: null };
    window.confirm = jest.fn(() => true);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders form fields when isOpen is true', () => {
    renderModal();

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Deployment Outcome')).toBeInTheDocument();
    expect(screen.getByText('Success')).toBeInTheDocument();
    expect(screen.getByText('Downtime')).toBeInTheDocument();
    expect(screen.getByText('Rollback')).toBeInTheDocument();
    expect(screen.getByLabelText(/details/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save outcome/i })).toBeInTheDocument();
  });

  it('renders nothing when isOpen is false', () => {
    const { container } = renderModal({ isOpen: false });
    expect(container).toBeEmptyDOMElement();
  });

  it('submits a new outcome with success result', async () => {
    renderModal();

    fireEvent.click(screen.getByText('Success'));
    fireEvent.click(screen.getByRole('button', { name: /save outcome/i }));

    await waitFor(() => {
      expect(mockRecordMutate).toHaveBeenCalledWith({
        deploymentId: 'release:2.5.0',
        releaseVersion: '2.5.0',
        result: 'success',
        downtimeMinutes: undefined,
        details: undefined,
      });
    });
  });

  it('shows validation error when downtime selected but no minutes provided', async () => {
    renderModal();

    fireEvent.click(screen.getByText('Downtime'));
    fireEvent.click(screen.getByRole('button', { name: /save outcome/i }));

    await waitFor(() => {
      expect(screen.getByText(/downtime minutes required/i)).toBeInTheDocument();
    });
    expect(mockRecordMutate).not.toHaveBeenCalled();
  });

  it('updates an existing outcome when one is loaded', async () => {
    mockOutcomes = [{
      id: 'outcome-1',
      deploymentId: 'dep-1',
      releaseVersion: '2.5.0',
      environment: 'production',
      result: 'success',
      reportedBy: 'user-1',
      reportedAt: '2026-06-08T12:00:00.000Z',
    }];

    renderModal();

    await waitFor(() => {
      expect(screen.getByText('Edit selected outcome')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Rollback'));
    fireEvent.click(screen.getByRole('button', { name: /update outcome/i }));

    await waitFor(() => {
      expect(mockUpdateMutate).toHaveBeenCalledWith({
        id: 'outcome-1',
        data: {
          result: 'rollback',
          downtimeMinutes: undefined,
          details: undefined,
        },
      });
    });
  });

  it('deletes an outcome from the history list', async () => {
    mockOutcomes = [{
      id: 'outcome-1',
      deploymentId: 'dep-1',
      releaseVersion: '2.5.0',
      environment: 'production',
      result: 'rollback',
      reportedBy: 'user-1',
      reportedAt: '2026-06-08T12:00:00.000Z',
    }];

    renderModal();

    await waitFor(() => {
      expect(screen.getByText('Recorded outcomes')).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByRole('button', { name: /delete/i })[0]);

    expect(window.confirm).toHaveBeenCalled();
    expect(mockDeleteMutate).toHaveBeenCalledWith('outcome-1', expect.any(Object));
  });

  it('calls onClose when escape key is pressed', () => {
    renderModal();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(baseProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('displays mutation error inline', () => {
    recordState.error = new Error('Network failure');
    renderModal();
    expect(screen.getByText('Network failure')).toBeInTheDocument();
  });
});

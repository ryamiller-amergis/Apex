import { render, screen, fireEvent } from '@testing-library/react';
import { PrdFixActionStrip } from '../PrdFixActionStrip';

jest.mock('../PrdFixActionStrip.module.css', () => new Proxy({}, { get: (_t, k) => String(k) }));

describe('PrdFixActionStrip', () => {
  const baseProps = {
    validationScore: 71,
    validationThreshold: 95,
    readinessLabel: 'PRD VALIDATION GAPS',
    progress: { approved: 0, rejected: 0, pending: 29, total: 29 },
    onContinueReview: jest.fn(),
    onAcceptAll: jest.fn(),
    onRevert: jest.fn(),
    onDismiss: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders score, readiness, and progress chips with Continue review', () => {
    render(<PrdFixActionStrip {...baseProps} />);
    expect(screen.getByText('71% / 95%')).toBeInTheDocument();
    expect(screen.getByText('PRD VALIDATION GAPS')).toBeInTheDocument();
    expect(screen.getByText(/0\/29 reviewed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue review/i })).toBeInTheDocument();
  });

  it('exposes secondary actions under More', () => {
    render(<PrdFixActionStrip {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: /more/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /accept all & re-validate/i }));
    expect(baseProps.onAcceptAll).toHaveBeenCalled();
  });

  it('renders proposed-changes mode without validation chips', () => {
    render(
      <PrdFixActionStrip
        summaryLabel="Comment fix ready"
        progress={{ approved: 1, rejected: 0, pending: 2, total: 3 }}
        onContinueReview={jest.fn()}
        onAcceptAll={jest.fn()}
        onRevert={jest.fn()}
        acceptLabel="Accept all"
        revertLabel="Reject all"
        ariaLabel="Proposed changes review"
      />,
    );
    expect(screen.getByText('Comment fix ready')).toBeInTheDocument();
    expect(screen.getByText(/1\/3 reviewed/)).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /more/i }));
    expect(screen.getByRole('menuitem', { name: /accept all/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /reject all/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /dismiss session/i })).not.toBeInTheDocument();
  });
});

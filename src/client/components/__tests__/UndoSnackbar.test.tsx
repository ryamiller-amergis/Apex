import { render, screen, fireEvent } from '@testing-library/react';
import { UndoSnackbar } from '../UndoSnackbar';

const defaultProps = {
  message: '2 pages deleted',
  onUndo: jest.fn(),
  onDismiss: jest.fn(),
};

function renderSnackbar(overrides: Partial<typeof defaultProps> = {}) {
  return render(<UndoSnackbar {...defaultProps} {...overrides} />);
}

describe('UndoSnackbar', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the message text', () => {
    renderSnackbar();

    expect(screen.getByText('2 pages deleted')).toBeInTheDocument();
  });

  it('calls onUndo when Undo button is clicked', () => {
    const onUndo = jest.fn();
    renderSnackbar({ onUndo });

    fireEvent.click(screen.getByTestId('undo-snackbar-action'));

    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('calls onDismiss when dismiss button is clicked', () => {
    const onDismiss = jest.fn();
    renderSnackbar({ onDismiss });

    fireEvent.click(screen.getByLabelText('Dismiss'));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not submit an ancestor form when dismissed', () => {
    const onSubmit = jest.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <UndoSnackbar {...defaultProps} />
      </form>,
    );

    fireEvent.click(screen.getByLabelText('Dismiss'));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('has role="alert" and aria-live="assertive"', () => {
    renderSnackbar();

    const snackbar = screen.getByTestId('undo-snackbar');
    expect(snackbar).toHaveAttribute('role', 'alert');
    expect(snackbar).toHaveAttribute('aria-live', 'assertive');
  });

  it('has correct data-testid attributes', () => {
    renderSnackbar();

    expect(screen.getByTestId('undo-snackbar')).toBeInTheDocument();
    expect(screen.getByTestId('undo-snackbar-action')).toBeInTheDocument();
  });

  it('displays "Undo" text on the action button', () => {
    renderSnackbar();

    expect(screen.getByTestId('undo-snackbar-action')).toHaveTextContent('Undo');
  });
});

import { render, screen, fireEvent } from '@testing-library/react';
import { ManipulationToolbar } from '../ManipulationToolbar';

const defaultProps = {
  selectedCount: 0,
  onRotate: jest.fn(),
  onDelete: jest.fn(),
  onMoveUp: jest.fn(),
  onMoveDown: jest.fn(),
  canMoveUp: false,
  canMoveDown: false,
  totalPages: 5,
};

function renderToolbar(overrides: Partial<typeof defaultProps> = {}) {
  return render(<ManipulationToolbar {...defaultProps} {...overrides} />);
}

describe('ManipulationToolbar', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('disables all action buttons when selectedCount is 0', () => {
    renderToolbar();

    expect(screen.getByTestId('toolbar-rotate')).toBeDisabled();
    expect(screen.getByTestId('toolbar-delete')).toBeDisabled();
    expect(screen.getByTestId('toolbar-move-up')).toBeDisabled();
    expect(screen.getByTestId('toolbar-move-down')).toBeDisabled();
  });

  it('enables rotate and delete when selectedCount > 0', () => {
    renderToolbar({ selectedCount: 2 });

    expect(screen.getByTestId('toolbar-rotate')).not.toBeDisabled();
    expect(screen.getByTestId('toolbar-delete')).not.toBeDisabled();
  });

  it('disables move up/down when selectedCount !== 1', () => {
    renderToolbar({ selectedCount: 2, canMoveUp: true, canMoveDown: true });

    expect(screen.getByTestId('toolbar-move-up')).toBeDisabled();
    expect(screen.getByTestId('toolbar-move-down')).toBeDisabled();
  });

  it('enables move up/down when selectedCount === 1 and can move', () => {
    renderToolbar({ selectedCount: 1, canMoveUp: true, canMoveDown: true });

    expect(screen.getByTestId('toolbar-move-up')).not.toBeDisabled();
    expect(screen.getByTestId('toolbar-move-down')).not.toBeDisabled();
  });

  it('calls onRotate when rotate button clicked', () => {
    const onRotate = jest.fn();
    renderToolbar({ selectedCount: 1, onRotate });

    fireEvent.click(screen.getByTestId('toolbar-rotate'));

    expect(onRotate).toHaveBeenCalledTimes(1);
  });

  it('calls onDelete when delete button clicked', () => {
    const onDelete = jest.fn();
    renderToolbar({ selectedCount: 1, onDelete });

    fireEvent.click(screen.getByTestId('toolbar-delete'));

    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('calls onMoveUp when move up button clicked', () => {
    const onMoveUp = jest.fn();
    renderToolbar({ selectedCount: 1, canMoveUp: true, onMoveUp });

    fireEvent.click(screen.getByTestId('toolbar-move-up'));

    expect(onMoveUp).toHaveBeenCalledTimes(1);
  });

  it('calls onMoveDown when move down button clicked', () => {
    const onMoveDown = jest.fn();
    renderToolbar({ selectedCount: 1, canMoveDown: true, onMoveDown });

    fireEvent.click(screen.getByTestId('toolbar-move-down'));

    expect(onMoveDown).toHaveBeenCalledTimes(1);
  });

  it('shows selection info when pages are selected', () => {
    renderToolbar({ selectedCount: 3 });

    expect(screen.getByText('3 pages selected')).toBeInTheDocument();
  });

  it('shows singular text for 1 page selected', () => {
    renderToolbar({ selectedCount: 1 });

    expect(screen.getByText('1 page selected')).toBeInTheDocument();
  });

  it('does not show selection info when nothing selected', () => {
    renderToolbar({ selectedCount: 0 });

    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it('has correct toolbar role and aria-label', () => {
    renderToolbar();

    const toolbar = screen.getByRole('toolbar');
    expect(toolbar).toHaveAttribute('aria-label', 'Page manipulation tools');
  });
});

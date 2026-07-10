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
  onSave: jest.fn(),
  hasUnsavedChanges: false,
  onSelectAll: jest.fn(),
  onDeselectAll: jest.fn(),
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

  it('renders save button when onSave is provided', () => {
    renderToolbar({ onSave: jest.fn() });

    expect(screen.getByTestId('toolbar-save')).toBeInTheDocument();
  });

  it('disables save button when hasUnsavedChanges is false', () => {
    renderToolbar({ onSave: jest.fn(), hasUnsavedChanges: false });

    expect(screen.getByTestId('toolbar-save')).toBeDisabled();
  });

  it('enables save button when hasUnsavedChanges is true', () => {
    renderToolbar({ onSave: jest.fn(), hasUnsavedChanges: true });

    expect(screen.getByTestId('toolbar-save')).not.toBeDisabled();
  });

  it('calls onSave when save button clicked', () => {
    const onSave = jest.fn();
    renderToolbar({ onSave, hasUnsavedChanges: true });

    fireEvent.click(screen.getByTestId('toolbar-save'));

    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('does not render save button when onSave is not provided', () => {
    renderToolbar({ onSave: undefined });

    expect(screen.queryByTestId('toolbar-save')).not.toBeInTheDocument();
  });

  it('renders Select All button when not all pages are selected', () => {
    renderToolbar({ selectedCount: 2, totalPages: 5 });

    expect(screen.getByTestId('toolbar-select-all')).toBeInTheDocument();
    expect(screen.getByTestId('toolbar-select-all')).toHaveTextContent('Select All');
  });

  it('renders Deselect All button when all pages are selected', () => {
    renderToolbar({ selectedCount: 5, totalPages: 5 });

    expect(screen.getByTestId('toolbar-select-all')).toBeInTheDocument();
    expect(screen.getByTestId('toolbar-select-all')).toHaveTextContent('Deselect All');
  });

  it('calls onSelectAll when Select All is clicked', () => {
    const onSelectAll = jest.fn();
    renderToolbar({ selectedCount: 0, totalPages: 5, onSelectAll });

    fireEvent.click(screen.getByTestId('toolbar-select-all'));

    expect(onSelectAll).toHaveBeenCalledTimes(1);
  });

  it('calls onDeselectAll when Deselect All is clicked', () => {
    const onDeselectAll = jest.fn();
    renderToolbar({ selectedCount: 5, totalPages: 5, onDeselectAll });

    fireEvent.click(screen.getByTestId('toolbar-select-all'));

    expect(onDeselectAll).toHaveBeenCalledTimes(1);
  });

  it('shows page count text', () => {
    renderToolbar({ totalPages: 12 });

    expect(screen.getByText('12 pages in assembly')).toBeInTheDocument();
  });

  it('shows singular page count text for 1 page', () => {
    renderToolbar({ totalPages: 1 });

    expect(screen.getByText('1 page in assembly')).toBeInTheDocument();
  });
});

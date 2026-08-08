/**
 * PBI-006 — DeleteDiagramDialog a11y + confirm/cancel
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { DeleteDiagramDialog } from '../DeleteDiagramDialog';

describe('DeleteDiagramDialog (PBI-006)', () => {
  const onConfirm = jest.fn();
  const onCancel = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('a11y: uses alertdialog and names the Diagram in labelledby', () => {
    render(
      <DeleteDiagramDialog
        title="Architecture sketch"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)).toHaveTextContent(/Architecture sketch/);
  });

  it('a11y: Escape cancels', () => {
    render(
      <DeleteDiagramDialog
        title="Architecture sketch"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('cancel button closes without confirming', () => {
    render(
      <DeleteDiagramDialog
        title="Architecture sketch"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByTestId('diagram-delete-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirm button invokes onConfirm', () => {
    render(
      <DeleteDiagramDialog
        title="Architecture sketch"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByTestId('diagram-delete-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('shows inline error when provided', () => {
    render(
      <DeleteDiagramDialog
        title="Architecture sketch"
        error="Failed to delete Diagram"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByText('Failed to delete Diagram')).toBeInTheDocument();
  });
});

import { render, screen } from '@testing-library/react';
import { ConfirmDeleteModal } from '../ConfirmDeleteModal';

function renderModal(error?: string | null) {
  return render(
    <ConfirmDeleteModal
      title="Delete Interview"
      itemName="Build intake"
      error={error}
      onConfirm={jest.fn()}
      onCancel={jest.fn()}
    />,
  );
}

describe('ConfirmDeleteModal', () => {
  it('shows the server reason when the delete is refused', () => {
    renderModal('This interview belongs to a build. Cancel the build instead.');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This interview belongs to a build. Cancel the build instead.',
    );
  });

  it('shows no alert before a delete is tried', () => {
    renderModal(null);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

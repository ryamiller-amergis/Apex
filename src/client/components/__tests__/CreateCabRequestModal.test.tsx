import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreateCabRequestModal } from '../CreateCabRequestModal';

describe('CreateCabRequestModal', () => {
  const onCancel = jest.fn();
  const onConfirm = jest.fn();

  const renderModal = () =>
    render(
      <CreateCabRequestModal
        targetVersion="2026.13.0"
        defaultPreviousBranch="Release/2026.12.0"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows the target version and default previous branch', () => {
    renderModal();
    expect(screen.getByTestId('create-cab-target-version')).toHaveTextContent('2026.13.0');
    expect(screen.getByTestId('create-cab-previous-branch')).toHaveValue('Release/2026.12.0');
  });

  it('confirms dry-run and no branch cut by default', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(screen.getByTestId('create-cab-confirm'));
    expect(onConfirm).toHaveBeenCalledWith({
      previousReleaseBranch: 'Release/2026.12.0',
      snowMode: 'dry-run',
      cutReleaseBranch: false,
    });
  });

  it('confirms prod run and cut-branch when selected', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(screen.getByLabelText(/Run \(prod snow/i));
    await user.click(screen.getByTestId('create-cab-cut-branch'));
    await user.click(screen.getByTestId('create-cab-confirm'));
    expect(onConfirm).toHaveBeenCalledWith({
      previousReleaseBranch: 'Release/2026.12.0',
      snowMode: 'run',
      cutReleaseBranch: true,
    });
  });

  it('cancels without confirming', () => {
    renderModal();
    fireEvent.click(screen.getByTestId('create-cab-cancel'));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

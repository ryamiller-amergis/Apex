/**
 * S9 — Client BuildRunControls component tests (PBI-035, PBI-036 / VT-34, VT-35, VT-36).
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BuildRunControls } from '../BuildRunControls';

describe('BuildRunControls (PBI-035, PBI-036 / VT-34, VT-35, VT-36)', () => {
  it('VT-34 PBI-035, PBI-036 renders Cancel and Resume buttons strictly from allowedActions', () => {
    const { rerender } = render(
      <BuildRunControls
        allowedActions={{ cancel: false, resume: false }}
        suspension={null}
        onCancel={async () => undefined}
        onResume={async () => undefined}
      />,
    );
    expect(screen.queryByTestId('build-cancel-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('build-resume-button')).not.toBeInTheDocument();

    rerender(
      <BuildRunControls
        allowedActions={{ cancel: true, resume: true }}
        suspension={null}
        onCancel={async () => undefined}
        onResume={async () => undefined}
      />,
    );
    expect(screen.getByTestId('build-cancel-button')).toHaveTextContent('Cancel build');
    expect(screen.getByTestId('build-resume-button')).toHaveTextContent('Resume build');
  });

  it('VT-35 PBI-035 AC-0..1 opens alertdialog, focuses Keep building, calls onCancel once on confirm, and shows build-cancel-error on failure', async () => {
    const user = userEvent.setup();
    const onCancel = jest.fn(async () => undefined);

    const { unmount } = render(
      <BuildRunControls
        allowedActions={{ cancel: true, resume: false }}
        suspension={null}
        onCancel={onCancel}
        onResume={async () => undefined}
      />,
    );

    await user.click(screen.getByTestId('build-cancel-button'));
    const dialog = screen.getByTestId('build-cancel-dialog');
    expect(dialog).toHaveAttribute('role', 'alertdialog');
    expect(screen.getByTestId('build-cancel-dismiss')).toHaveFocus();

    await user.click(screen.getByTestId('build-cancel-confirm'));
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    unmount();

    const failingCancel = jest.fn(async () => {
      throw new Error('Could not stop running agents.');
    });
    render(
      <BuildRunControls
        allowedActions={{ cancel: true, resume: false }}
        suspension={null}
        onCancel={failingCancel}
        onResume={async () => undefined}
      />,
    );
    await user.click(screen.getByTestId('build-cancel-button'));
    await user.click(screen.getByTestId('build-cancel-confirm'));
    expect(await screen.findByTestId('build-cancel-error')).toHaveTextContent(
      'Could not stop running agents.',
    );
  });

  it('VT-36 PBI-036 AC-0..2 renders suspension details and displays build-resume-error when Resume is refused', async () => {
    const user = userEvent.setup();
    const failingResume = jest.fn(async () => {
      throw new Error('Not resumed yet: cost limit is still reached.');
    });

    render(
      <BuildRunControls
        allowedActions={{ cancel: true, resume: true }}
        suspension={{
          reason: 'cost_cap',
          message: 'This build reached its cost limit of $25.00.',
          deadlineAt: '2026-11-10T12:00:00.000Z',
          capName: 'cost',
          used: 25,
          limit: 25,
          resumable: true,
        }}
        onCancel={async () => undefined}
        onResume={failingResume}
      />,
    );

    expect(screen.getByTestId('build-suspension-notice')).toBeInTheDocument();
    expect(screen.getByTestId('build-suspension-reason')).toHaveTextContent(
      'This build reached its cost limit of $25.00.',
    );
    expect(screen.getByTestId('build-suspension-deadline')).toBeInTheDocument();
    expect(screen.getByTestId('build-suspension-cap-usage')).toHaveTextContent('25 of 25');

    await user.click(screen.getByTestId('build-resume-button'));
    expect(await screen.findByTestId('build-resume-error')).toHaveTextContent(
      'Not resumed yet: cost limit is still reached.',
    );
  });
});

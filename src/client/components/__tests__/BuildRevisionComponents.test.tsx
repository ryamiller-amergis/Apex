/**
 * S13 — Client revision components tests (PBI-030..032 / VT-39..VT-45).
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RequestChangesDialog } from '../RequestChangesDialog';
import { BuildRevisionProgress } from '../BuildRevisionProgress';

describe('RequestChangesDialog & BuildRevisionProgress (PBI-030..032 / VT-39..VT-45)', () => {
  it('VT-39, VT-42 PBI-030 AC-0, AC-2 validates empty and >4000-char feedback and submits trimmed text on valid submit', async () => {
    const user = userEvent.setup();
    const onSubmit = jest.fn(async () => undefined);
    const onClose = jest.fn();

    render(
      <RequestChangesDialog
        open={true}
        actingForRequester={false}
        requesterDisplayName="Dana Lee"
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    );

    // Empty submit -> validation message
    await user.click(screen.getByTestId('build-request-changes-submit'));
    expect(await screen.findByTestId('build-request-changes-error')).toHaveTextContent(
      'Describe what you want changed.',
    );
    expect(onSubmit).not.toHaveBeenCalled();

    // Valid submit
    const textarea = screen.getByTestId('build-request-changes-feedback');
    await user.type(textarea, '  Please make the header compact  ');
    expect(screen.getByTestId('build-request-changes-count')).toHaveTextContent('30 / 4000');

    await user.click(screen.getByTestId('build-request-changes-submit'));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith('Please make the header compact'),
    );
  });

  it('VT-40 PBI-030 AC-1 keeps feedback text in textarea and shows alert when submit rejects', async () => {
    const user = userEvent.setup();
    const onSubmit = jest.fn(async () => {
      throw new Error('Amendment could not be started.');
    });

    render(
      <RequestChangesDialog
        open={true}
        actingForRequester={false}
        requesterDisplayName="Dana Lee"
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    const textarea = screen.getByTestId('build-request-changes-feedback');
    await user.type(textarea, 'Keep this text safe');
    await user.click(screen.getByTestId('build-request-changes-submit'));

    const err = await screen.findByTestId('build-request-changes-error');
    expect(err).toHaveAttribute('role', 'alert');
    expect(err).toHaveTextContent('Amendment could not be started.');
    expect(textarea).toHaveValue('Keep this text safe');
    expect(screen.getByTestId('build-request-changes-submit')).not.toBeDisabled();
  });

  it('VT-43 PBI-032 AC-0, AC-3 shows Request changes for {name} when admin acts on behalf of requester', () => {
    render(
      <RequestChangesDialog
        open={true}
        actingForRequester={true}
        requesterDisplayName="Dana Lee"
        onClose={() => undefined}
        onSubmit={async () => undefined}
      />,
    );

    expect(screen.getByTestId('build-request-changes-on-behalf-of')).toHaveTextContent(
      'Request changes for Dana Lee',
    );
    expect(screen.getByTestId('build-request-changes-submit')).toHaveTextContent(
      'Send changes for Dana Lee',
    );
  });

  it('VT-41, VT-44 PBI-030 AC-1, AC-3 / PBI-031 NFR-a11y renders polite live progress, cap note when 5 revisions used, and amendment error banner with Try again', async () => {
    const user = userEvent.setup();
    const onRetry = jest.fn();
    const onOpenRequestChanges = jest.fn();

    const { rerender } = render(
      <BuildRevisionProgress
        revision={{
          number: 2,
          revisionsUsed: 1,
          revisionsLimit: 5,
          stage: 'asking',
          requestedBy: { userId: 'u1', displayName: 'Dana Lee' },
          actingForRequester: false,
          requesterDisplayName: 'Dana Lee',
          viewerCanRequestChanges: true,
          amendmentError: null,
        }}
        buildStatus="intake"
        onOpenRequestChanges={onOpenRequestChanges}
        onRetryAmendment={onRetry}
      />,
    );

    const progress = screen.getByTestId('build-revision-progress');
    expect(progress).toHaveAttribute('aria-live', 'polite');
    expect(progress).toHaveTextContent('Revision 2 of 5 — asking questions');

    rerender(
      <BuildRevisionProgress
        revision={{
          number: 2,
          revisionsUsed: 1,
          revisionsLimit: 5,
          stage: 'building',
          requestedBy: { userId: 'u1', displayName: 'Dana Lee' },
          actingForRequester: false,
          requesterDisplayName: 'Dana Lee',
          viewerCanRequestChanges: true,
          amendmentError: {
            message: 'We could not draft the change. Your feedback is saved.',
            occurredAt: '2026-11-01T12:00:00.000Z',
          },
        }}
        buildStatus="building"
        onOpenRequestChanges={onOpenRequestChanges}
        onRetryAmendment={onRetry}
      />,
    );

    expect(screen.getByTestId('build-revision-progress')).toHaveTextContent(
      'Revision 2 of 5 — building',
    );
    expect(screen.getByTestId('build-revision-error-banner')).toHaveTextContent(
      'We could not draft the change. Your feedback is saved.',
    );
    await user.click(screen.getByTestId('build-revision-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);

    // VT-41: 5 of 5 used
    rerender(
      <BuildRevisionProgress
        revision={{
          number: 6,
          revisionsUsed: 5,
          revisionsLimit: 5,
          stage: 'preview_ready',
          requestedBy: { userId: 'u1', displayName: 'Dana Lee' },
          actingForRequester: false,
          requesterDisplayName: 'Dana Lee',
          viewerCanRequestChanges: true,
          amendmentError: null,
        }}
        buildStatus="preview_ready"
        onOpenRequestChanges={onOpenRequestChanges}
        onRetryAmendment={onRetry}
      />,
    );

    expect(screen.getByTestId('build-request-changes-button')).toBeDisabled();
    expect(screen.getByTestId('build-revision-cap-note')).toHaveTextContent(
      'All 5 revisions used',
    );
  });
});

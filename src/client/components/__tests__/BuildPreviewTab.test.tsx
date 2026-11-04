/**
 * S10 — Client Preview tab component tests (PBI-026..029 / VT-27..VT-31).
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BuildPreviewTab } from '../BuildPreviewTab';
import { BuildQueuePosition } from '../BuildQueuePosition';
import { BuildDeploymentFailedPanel } from '../BuildDeploymentFailedPanel';
import { RetryDeploymentButton } from '../RetryDeploymentButton';

describe('BuildPreviewTab & deployment components (PBI-026..029 / VT-27..VT-31)', () => {
  it('VT-27 PBI-026 AC-0 renders Ready status and live preview link with target="_blank" and rel="noopener noreferrer"', () => {
    render(
      <BuildPreviewTab
        buildStatus="preview_ready"
        currentRevisionNumber={2}
        deployment={{
          status: 'succeeded',
          queuePosition: null,
          previewUrl: 'https://preview.dev.example.com/rev-2',
          leaseExpiresAt: '2099-01-01T00:00:00.000Z',
          failedStage: null,
          errorExcerpt: null,
          pipelineUrl: null,
          supportContactNames: ['Dana'],
        }}
        previews={[
          {
            revisionNumber: 2,
            commit: '2'.repeat(40),
            deploymentStatus: 'succeeded',
            finishedAt: '2026-11-01T12:00:00.000Z',
            previewUrl: 'https://preview.dev.example.com/rev-2',
            isLive: true,
          },
        ]}
        canRetryDeployment={false}
        onRetryDeployment={async () => undefined}
      />,
    );

    expect(screen.getByTestId('build-preview-status')).toHaveTextContent('Ready');
    const link = screen.getByTestId('build-preview-current-link');
    expect(link).toHaveAttribute('href', 'https://preview.dev.example.com/rev-2');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveTextContent('Open the preview for revision 2 (opens in a new tab)');
  });

  it('VT-28 PBI-026 AC-1, PBI-028 AC-3, PBI-029 AC-0 shows plain message with contact names for requester, and stage/commit/pipeline/retry for contact', () => {
    const { unmount } = render(
      <BuildDeploymentFailedPanel
        commit="abcdef1234567890"
        failedStage={null}
        errorExcerpt={null}
        pipelineUrl={null}
        supportContactNames={['Dana (dana@example.com)']}
        canRetryDeployment={false}
        onRetryDeployment={async () => undefined}
      />,
    );

    expect(screen.getByTestId('build-deployment-failed-panel')).toHaveTextContent(
      'Your feature was built and passed its checks, but deployment failed.',
    );
    expect(screen.getByTestId('build-deployment-failed-contacts')).toHaveTextContent(
      'Dana (dana@example.com) has been notified.',
    );
    expect(screen.queryByTestId('build-deployment-failed-stage')).not.toBeInTheDocument();
    expect(screen.queryByTestId('build-retry-deployment-button')).not.toBeInTheDocument();
    unmount();

    render(
      <BuildDeploymentFailedPanel
        commit="abcdef1234567890"
        failedStage="Deploy_Dev"
        errorExcerpt="Connection refused"
        pipelineUrl="https://dev.azure.com/org/Apex/_build/results?buildId=4411"
        supportContactNames={['Dana (dana@example.com)']}
        canRetryDeployment={true}
        onRetryDeployment={async () => undefined}
      />,
    );

    expect(screen.getByTestId('build-deployment-failed-stage')).toHaveTextContent(
      'Failed stage: Deploy_Dev. Commit abcdef1.',
    );
    expect(screen.getByTestId('build-retry-deployment-button')).toBeInTheDocument();
  });

  it('VT-29 PBI-027 AC-0 announces queue position changes inside a polite live region', () => {
    const { rerender } = render(<BuildQueuePosition queuePosition={3} />);
    const region = screen.getByTestId('build-queue-position');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-atomic', 'true');
    expect(region).toHaveTextContent('Waiting for the preview environment. You are number 3 in line.');

    rerender(<BuildQueuePosition queuePosition={2} />);
    expect(screen.getByTestId('build-queue-position')).toHaveTextContent(
      'Waiting for the preview environment. You are number 2 in line.',
    );

    rerender(<BuildQueuePosition queuePosition={null} />);
    expect(screen.queryByTestId('build-queue-position')).not.toBeInTheDocument();
  });

  it('VT-30 PBI-029 AC-2 disables RetryDeploymentButton while pending so double-click sends one request, and shows error on failure', async () => {
    const user = userEvent.setup();
    let resolvePending!: () => void;
    const onRetry = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePending = resolve;
        }),
    );

    const { unmount } = render(<RetryDeploymentButton onRetry={onRetry} />);
    const btn = screen.getByTestId('build-retry-deployment-button');

    await user.dblClick(btn);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(btn).toBeDisabled();

    resolvePending();
    await waitFor(() => expect(btn).not.toBeDisabled());
    unmount();

    const failingRetry = jest.fn(() => Promise.reject(new Error('Server refused retry')));
    render(<RetryDeploymentButton onRetry={failingRetry} />);
    await user.click(screen.getByTestId('build-retry-deployment-button'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/We could not queue the retry\. Try again\./);
  });

  it('VT-31 PBI-026 AC-2 renders preview history rows with only the live row linked and earlier rows marked Replaced by a later deployment', () => {
    render(
      <BuildPreviewTab
        buildStatus="preview_ready"
        currentRevisionNumber={3}
        deployment={{
          status: 'succeeded',
          queuePosition: null,
          previewUrl: 'https://preview.dev.example.com/rev-3',
          leaseExpiresAt: '2099-01-01T00:00:00.000Z',
          failedStage: null,
          errorExcerpt: null,
          pipelineUrl: null,
          supportContactNames: ['Dana'],
        }}
        previews={[
          {
            revisionNumber: 3,
            commit: '3'.repeat(40),
            deploymentStatus: 'succeeded',
            finishedAt: '2026-11-01T12:00:00.000Z',
            previewUrl: 'https://preview.dev.example.com/rev-3',
            isLive: true,
          },
          {
            revisionNumber: 2,
            commit: '2'.repeat(40),
            deploymentStatus: 'succeeded',
            finishedAt: '2026-11-01T11:00:00.000Z',
            previewUrl: null,
            isLive: false,
          },
          {
            revisionNumber: 1,
            commit: '1'.repeat(40),
            deploymentStatus: 'succeeded',
            finishedAt: '2026-11-01T10:00:00.000Z',
            previewUrl: null,
            isLive: false,
          },
        ]}
        canRetryDeployment={false}
        onRetryDeployment={async () => undefined}
      />,
    );

    const row3 = screen.getByTestId('build-preview-history-row-3');
    const row2 = screen.getByTestId('build-preview-history-row-2');
    const row1 = screen.getByTestId('build-preview-history-row-1');

    expect(row3.querySelector('a')).not.toBeNull();
    expect(row2.querySelector('a')).toBeNull();
    expect(row2).toHaveTextContent('Replaced by a later deployment.');
    expect(row1.querySelector('a')).toBeNull();
    expect(row1).toHaveTextContent('Replaced by a later deployment.');
  });
});

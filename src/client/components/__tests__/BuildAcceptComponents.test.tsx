/**
 * S9 — Client Accept components tests (PBI-033, PBI-034 / VT-25..VT-29).
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BuildAcceptAction } from '../BuildAcceptAction';
import { BuildPullRequestPanel } from '../BuildPullRequestPanel';

describe('BuildAcceptAction, AcceptBuildModal & BuildPullRequestPanel (PBI-033, PBI-034 / VT-25..VT-29)', () => {
  it('VT-25 PBI-033 renders Accept button only when run is preview_ready and viewer may accept', () => {
    const { rerender } = render(
      <BuildAcceptAction
        buildStatus="preview_ready"
        canAccept={false}
        revisionNumber={2}
        riskDecisionCount={3}
        onAccept={async () => undefined}
      />,
    );
    expect(screen.queryByTestId('build-accept-btn')).not.toBeInTheDocument();

    rerender(
      <BuildAcceptAction
        buildStatus="building"
        canAccept={true}
        revisionNumber={2}
        riskDecisionCount={3}
        onAccept={async () => undefined}
      />,
    );
    expect(screen.queryByTestId('build-accept-btn')).not.toBeInTheDocument();

    rerender(
      <BuildAcceptAction
        buildStatus="preview_ready"
        canAccept={true}
        revisionNumber={2}
        riskDecisionCount={3}
        onAccept={async () => undefined}
      />,
    );
    expect(screen.getByTestId('build-accept-btn')).toHaveTextContent(
      'Accept and open pull request',
    );
  });

  it('VT-26, VT-29 PBI-033 AC-3 opens modal, focuses Cancel, disables confirm on double-click, and displays stale revision error inside modal', async () => {
    const user = userEvent.setup();
    let resolveAccept!: () => void;
    const onAccept = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveAccept = resolve;
        }),
    );

    const { unmount } = render(
      <BuildAcceptAction
        buildStatus="preview_ready"
        canAccept={true}
        revisionNumber={2}
        riskDecisionCount={3}
        onAccept={onAccept}
      />,
    );

    await user.click(screen.getByTestId('build-accept-btn'));
    const modal = screen.getByTestId('build-accept-modal');
    expect(modal).toHaveAttribute('role', 'dialog');
    expect(screen.getByTestId('build-accept-cancel-btn')).toHaveFocus();

    const confirmBtn = screen.getByTestId('build-accept-confirm-btn');
    await user.dblClick(confirmBtn);
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(confirmBtn).toBeDisabled();

    resolveAccept();
    await waitFor(() =>
      expect(screen.queryByTestId('build-accept-modal')).not.toBeInTheDocument(),
    );
    unmount();

    // VT-29: Stale revision error
    const failingAccept = jest.fn(async () => {
      const err = new Error('A newer version of your build exists. Reload to see it.') as Error & {
        code?: string;
      };
      err.code = 'BUILD_STALE_REVISION';
      throw err;
    });

    render(
      <BuildAcceptAction
        buildStatus="preview_ready"
        canAccept={true}
        revisionNumber={1}
        riskDecisionCount={2}
        onAccept={failingAccept}
      />,
    );

    await user.click(screen.getByTestId('build-accept-btn'));
    await user.click(screen.getByTestId('build-accept-confirm-btn'));

    expect(await screen.findByTestId('build-accept-error')).toHaveTextContent(
      'A newer version of your build exists. Reload to see it.',
    );
    expect(screen.getByTestId('build-accept-modal')).toBeInTheDocument();
  });

  it('VT-27 PBI-033 AC-0..2, PBI-034 AC-1..2 renders BuildPullRequestPanel across all four states with sync note and reviewer status', () => {
    const { rerender } = render(
      <BuildPullRequestPanel
        summary={{
          state: 'opening_pull_request',
          url: null,
          syncCommitSha: null,
          reviewersAdded: null,
          reviewerNames: ['Alice'],
        }}
      />,
    );
    expect(screen.getByTestId('build-pr-panel')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByTestId('build-pr-state')).toHaveTextContent(
      'Opening your pull request…',
    );

    rerender(
      <BuildPullRequestPanel
        summary={{
          state: 'syncing',
          url: null,
          syncCommitSha: null,
          reviewersAdded: null,
          reviewerNames: ['Alice'],
        }}
      />,
    );
    expect(screen.getByTestId('build-pr-state')).toHaveTextContent(
      'Your feature is being brought up to date with the latest code. This can take several minutes.',
    );

    rerender(
      <BuildPullRequestPanel
        summary={{
          state: 'pull_request_open',
          url: 'https://dev.azure.com/org/Apex/_git/repo/pullrequest/901',
          syncCommitSha: 'abcdef123456',
          reviewersAdded: false,
          reviewerNames: ['Alice', 'Bob'],
        }}
      />,
    );
    expect(screen.getByTestId('build-pr-state')).toHaveTextContent(
      'Your pull request is open. Engineers will review it.',
    );
    const prLink = screen.getByTestId('build-pr-link');
    expect(prLink).toHaveAttribute(
      'href',
      'https://dev.azure.com/org/Apex/_git/repo/pullrequest/901',
    );
    expect(prLink).toHaveAttribute('target', '_blank');
    expect(screen.getByTestId('build-pr-reviewers')).toHaveTextContent(
      'We could not add reviewers automatically. Alice and Bob have been told.',
    );
    expect(screen.getByTestId('build-pr-sync-note')).toHaveTextContent(
      'A sync commit was added after your preview. No new preview was made for it.',
    );

    rerender(
      <BuildPullRequestPanel
        summary={{
          state: 'needs_developer',
          url: null,
          syncCommitSha: null,
          reviewersAdded: null,
          reviewerNames: ['Alice', 'Bob'],
        }}
      />,
    );
    expect(screen.getByTestId('build-needs-developer-notice')).toHaveTextContent(
      'We could not bring your feature up to date with the latest code on our own. Alice and Bob have been told and will pick it up.',
    );
  });
});

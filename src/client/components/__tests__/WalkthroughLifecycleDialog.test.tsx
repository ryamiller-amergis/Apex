/**
 * PBI-002 — Publish and Control Walkthrough Lifecycle (UI).
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WalkthroughLifecycleDialog } from '../ManualWalkthroughEditor';
import type { WalkthroughDefinition } from '../../../shared/types/walkthrough';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));
jest.mock('remark-gfm', () => () => {});

function baseWalkthrough(overrides: Partial<WalkthroughDefinition> = {}): WalkthroughDefinition {
  return {
    id: 'wt-1',
    internalName: 'Internal',
    userTitle: 'Title',
    whyItMatters: 'Why',
    lifecycle: 'draft',
    priority: 1,
    revision: 1,
    publishedAt: null,
    archivedAt: null,
    createdBy: 'admin',
    createdAt: '2026-07-29T00:00:00Z',
    updatedBy: 'admin',
    updatedAt: '2026-07-29T00:00:00Z',
    steps: [
      {
        id: 's1',
        walkthroughId: 'wt-1',
        ordinal: 0,
        heading: 'Step',
        bodyMarkdown: 'Body',
      },
    ],
    targeting: { project: 'Apex', groupId: null },
    targetingRules: [{ type: 'project', value: 'Apex' }],
    ...overrides,
  };
}

describe('WalkthroughLifecycleDialog (PBI-002)', () => {
  it('AC-0 — fresh publish confirms for a valid draft with project target', async () => {
    const user = userEvent.setup();
    const onPublish = jest.fn();
    render(
      <WalkthroughLifecycleDialog
        walkthrough={baseWalkthrough({ lifecycle: 'draft' })}
        targetProject="Apex"
        isOpen
        isPending={false}
        onClose={jest.fn()}
        onPublish={onPublish}
        onUnpublish={jest.fn()}
        onArchive={jest.fn()}
      />,
    );

    expect(screen.getByTestId('walkthrough-lifecycle-dialog')).toBeInTheDocument();
    await user.click(screen.getByTestId('walkthrough-lifecycle-confirm-publish'));
    expect(onPublish).toHaveBeenCalledWith('fresh');
  });

  it('AC-1 — publish without project shows validation and does not publish', async () => {
    const user = userEvent.setup();
    const onPublish = jest.fn();
    render(
      <WalkthroughLifecycleDialog
        walkthrough={baseWalkthrough({ targeting: { project: '', groupId: null } })}
        targetProject=""
        isOpen
        isPending={false}
        onClose={jest.fn()}
        onPublish={onPublish}
        onUnpublish={jest.fn()}
        onArchive={jest.fn()}
      />,
    );

    await user.click(screen.getByTestId('walkthrough-lifecycle-confirm-publish'));
    expect(screen.getByTestId('walkthrough-lifecycle-error')).toHaveTextContent(/project target/i);
    expect(onPublish).not.toHaveBeenCalled();
  });

  it('AC-2 — published walkthrough offers silent vs reshow modes', async () => {
    const user = userEvent.setup();
    const onPublish = jest.fn();
    render(
      <WalkthroughLifecycleDialog
        walkthrough={baseWalkthrough({
          lifecycle: 'published',
          revision: 2,
          publishedAt: '2026-07-28T00:00:00Z',
        })}
        targetProject="Apex"
        isOpen
        isPending={false}
        onClose={jest.fn()}
        onPublish={onPublish}
        onUnpublish={jest.fn()}
        onArchive={jest.fn()}
      />,
    );

    expect(screen.getByTestId('walkthrough-update-mode-silent')).toBeInTheDocument();
    expect(screen.getByTestId('walkthrough-update-mode-reshow')).toBeInTheDocument();

    await user.click(screen.getByTestId('walkthrough-lifecycle-confirm-publish'));
    expect(onPublish).toHaveBeenCalledWith('silent');

    await user.click(screen.getByLabelText(/re-show/i));
    await user.click(screen.getByTestId('walkthrough-lifecycle-confirm-publish'));
    expect(onPublish).toHaveBeenLastCalledWith('reshow');
  });

  it('AC-3 — unpublish and archive actions are available; no hard-delete control', async () => {
    const user = userEvent.setup();
    const onUnpublish = jest.fn();
    const onArchive = jest.fn();
    render(
      <WalkthroughLifecycleDialog
        walkthrough={baseWalkthrough({ lifecycle: 'published', revision: 1 })}
        targetProject="Apex"
        isOpen
        isPending={false}
        onClose={jest.fn()}
        onPublish={jest.fn()}
        onUnpublish={onUnpublish}
        onArchive={onArchive}
      />,
    );

    await user.click(screen.getByTestId('walkthrough-unpublish'));
    expect(onUnpublish).toHaveBeenCalled();

    await user.click(screen.getByTestId('walkthrough-archive'));
    expect(onArchive).toHaveBeenCalled();

    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });
});

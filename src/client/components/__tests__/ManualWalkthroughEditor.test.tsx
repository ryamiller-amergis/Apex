import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ManualWalkthroughEditor } from '../ManualWalkthroughEditor';
import * as walkthroughHooks from '../../hooks/usePlatformAdminWalkthroughs';
import * as platformAdminHooks from '../../hooks/usePlatformAdmin';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));
jest.mock('remark-gfm', () => () => {});

jest.mock('../../hooks/usePlatformAdminWalkthroughs');
jest.mock('../../hooks/usePlatformAdmin');

const mockWalkthroughHooks = walkthroughHooks as jest.Mocked<typeof walkthroughHooks>;
const mockPlatformHooks = platformAdminHooks as jest.Mocked<typeof platformAdminHooks>;

function renderEditor(props: Partial<React.ComponentProps<typeof ManualWalkthroughEditor>> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ManualWalkthroughEditor
        walkthroughId={null}
        onClose={jest.fn()}
        {...props}
      />
    </QueryClientProvider>,
  );
}

function setupMocks() {
  mockWalkthroughHooks.useWalkthroughDetail.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
  } as any);
  mockWalkthroughHooks.useWalkthroughAnchors.mockReturnValue({
    data: [
      {
        key: 'user-menu-trigger',
        testId: 'user-menu-trigger',
        label: 'User menu',
        targetRoute: '/home',
        allowedPlacements: ['bottom'],
      },
    ],
    isLoading: false,
    isError: false,
    error: null,
  } as any);
  mockPlatformHooks.usePlatformAdminProjects.mockReturnValue({
    data: [{ id: 'p1', name: 'Apex', description: 'Platform' }],
    isLoading: false,
    isError: false,
    error: null,
  } as any);
  mockPlatformHooks.usePlatformAdminGroups.mockReturnValue({
    data: [{ id: 'g1', name: 'Admins', project: 'Apex' }],
    isLoading: false,
    isError: false,
    error: null,
  } as any);
  mockWalkthroughHooks.useCreateWalkthrough.mockReturnValue({
    mutateAsync: jest.fn().mockResolvedValue({
      id: 'wt-new',
      internalName: 'Draft',
      userTitle: 'Welcome',
      whyItMatters: '',
      lifecycle: 'draft',
      priority: 0,
      revision: 1,
      publishedAt: null,
      archivedAt: null,
      createdBy: 'admin',
      createdAt: '2026-07-29T00:00:00Z',
      updatedBy: 'admin',
      updatedAt: '2026-07-29T00:00:00Z',
      steps: [
        { id: 's1', walkthroughId: 'wt-new', ordinal: 0, heading: 'First', bodyMarkdown: 'Body' },
        { id: 's2', walkthroughId: 'wt-new', ordinal: 1, heading: 'Second', bodyMarkdown: 'More' },
      ],
      targeting: { project: 'Apex', groupId: null },
      targetingRules: [],
    }),
    isPending: false,
    error: null,
  } as any);
  mockWalkthroughHooks.useUpdateWalkthrough.mockReturnValue({
    mutateAsync: jest.fn(),
    isPending: false,
    error: null,
  } as any);
  mockWalkthroughHooks.usePublishWalkthrough.mockReturnValue({
    mutateAsync: jest.fn(),
    isPending: false,
    error: null,
  } as any);
  mockWalkthroughHooks.useUnpublishWalkthrough.mockReturnValue({
    mutateAsync: jest.fn(),
    isPending: false,
    error: null,
  } as any);
  mockWalkthroughHooks.useArchiveWalkthrough.mockReturnValue({
    mutateAsync: jest.fn(),
    isPending: false,
    error: null,
  } as any);
}

describe('ManualWalkthroughEditor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupMocks();
  });

  it('AC-0 — saves draft and preserves step order', async () => {
    const user = userEvent.setup();
    const onSaved = jest.fn();
    const createAsync = jest.fn().mockResolvedValue({
      id: 'wt-new',
      internalName: 'Draft',
      userTitle: 'Welcome',
      whyItMatters: '',
      lifecycle: 'draft',
      priority: 0,
      revision: 1,
      publishedAt: null,
      archivedAt: null,
      createdBy: 'admin',
      createdAt: '2026-07-29T00:00:00Z',
      updatedBy: 'admin',
      updatedAt: '2026-07-29T00:00:00Z',
      steps: [
        { id: 's1', walkthroughId: 'wt-new', ordinal: 0, heading: 'First', bodyMarkdown: 'A' },
        { id: 's2', walkthroughId: 'wt-new', ordinal: 1, heading: 'Second', bodyMarkdown: 'B' },
      ],
      targeting: { project: 'Apex', groupId: null },
      targetingRules: [],
    });
    mockWalkthroughHooks.useCreateWalkthrough.mockReturnValue({
      mutateAsync: createAsync,
      isPending: false,
      error: null,
    } as any);

    renderEditor({ onSaved });

    await user.type(screen.getByLabelText(/internal name/i), 'Draft');
    await user.type(screen.getByLabelText(/user title/i), 'Welcome');
    await user.selectOptions(screen.getByTestId('walkthrough-project-target'), 'Apex');
    await user.type(screen.getByLabelText(/heading/i), 'First');
    await user.click(screen.getByTestId('walkthrough-step-add'));
    const stepCards = screen.getAllByText(/^Step \d+$/);
    const secondStep = stepCards[1].closest('article');
    await user.type(within(secondStep!).getByLabelText(/heading/i), 'Second');
    await user.click(screen.getByTestId('walkthrough-save-draft'));

    await waitFor(() => expect(createAsync).toHaveBeenCalled());
    const payload = createAsync.mock.calls[0][0];
    expect(payload.steps[0].heading).toBe('First');
    expect(payload.steps[1].heading).toBe('Second');
    expect(onSaved).toHaveBeenCalled();
  });

  it('AC-1 — rejects invalid image URL and shows validation summary', async () => {
    const user = userEvent.setup();
    const createAsync = jest.fn();
    mockWalkthroughHooks.useCreateWalkthrough.mockReturnValue({
      mutateAsync: createAsync,
      isPending: false,
      error: null,
    } as any);
    renderEditor();

    await user.type(screen.getByLabelText(/internal name/i), 'Draft');
    await user.type(screen.getByLabelText(/user title/i), 'Welcome');
    await user.selectOptions(screen.getByTestId('walkthrough-project-target'), 'Apex');
    await user.type(screen.getByLabelText(/image url/i), 'javascript:alert(1)');
    await user.click(screen.getByTestId('walkthrough-save-draft'));

    const summary = await screen.findByTestId('walkthrough-validation-summary');
    expect(within(summary).getByText(/must be https or a root-relative path/i)).toBeInTheDocument();
    expect(createAsync).not.toHaveBeenCalled();
  });

  it('AC-1 — rejects partial CTA fields', async () => {
    const user = userEvent.setup();
    const createAsync = jest.fn();
    mockWalkthroughHooks.useCreateWalkthrough.mockReturnValue({
      mutateAsync: createAsync,
      isPending: false,
      error: null,
    } as any);
    renderEditor();

    await user.type(screen.getByLabelText(/internal name/i), 'Draft');
    await user.type(screen.getByLabelText(/user title/i), 'Welcome');
    await user.selectOptions(screen.getByTestId('walkthrough-project-target'), 'Apex');
    await user.type(screen.getByLabelText(/cta label/i), 'Go');
    await user.click(screen.getByTestId('walkthrough-save-draft'));

    const summary = await screen.findByTestId('walkthrough-validation-summary');
    expect(within(summary).getByText(/cta label and route must both be set/i)).toBeInTheDocument();
    expect(createAsync).not.toHaveBeenCalled();
  });

  it('reorders steps with move up/down buttons', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByTestId('walkthrough-step-add'));
    const moveDownButtons = screen.getAllByLabelText(/move step 1 down/i);
    await user.click(moveDownButtons[0]);

    expect(screen.getByText(/moved step 1 down/i)).toBeInTheDocument();
  });
});

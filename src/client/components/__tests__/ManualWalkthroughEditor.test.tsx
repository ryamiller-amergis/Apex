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
  } as unknown as ReturnType<typeof mockWalkthroughHooks.useWalkthroughDetail>);
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
  } as unknown as ReturnType<typeof mockWalkthroughHooks.useWalkthroughAnchors>);
  mockPlatformHooks.usePlatformAdminProjects.mockReturnValue({
    data: [{ id: 'p1', name: 'Apex', description: 'Platform' }],
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof mockPlatformHooks.usePlatformAdminProjects>);
  mockPlatformHooks.usePlatformAdminGroups.mockReturnValue({
    data: [{ id: 'g1', name: 'Admins', project: 'Apex' }],
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof mockPlatformHooks.usePlatformAdminGroups>);
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
      targeting: { projects: ['Apex'], groupId: null },
      targetingRules: [],
    }),
    isPending: false,
    error: null,
  } as unknown as ReturnType<typeof mockWalkthroughHooks.useCreateWalkthrough>);
  mockWalkthroughHooks.useUpdateWalkthrough.mockReturnValue({
    mutateAsync: jest.fn(),
    isPending: false,
    error: null,
  } as unknown as ReturnType<typeof mockWalkthroughHooks.useUpdateWalkthrough>);
  mockWalkthroughHooks.usePublishWalkthrough.mockReturnValue({
    mutateAsync: jest.fn(),
    isPending: false,
    error: null,
  } as unknown as ReturnType<typeof mockWalkthroughHooks.usePublishWalkthrough>);
  mockWalkthroughHooks.useUnpublishWalkthrough.mockReturnValue({
    mutateAsync: jest.fn(),
    isPending: false,
    error: null,
  } as unknown as ReturnType<typeof mockWalkthroughHooks.useUnpublishWalkthrough>);
  mockWalkthroughHooks.useArchiveWalkthrough.mockReturnValue({
    mutateAsync: jest.fn(),
    isPending: false,
    error: null,
  } as unknown as ReturnType<typeof mockWalkthroughHooks.useArchiveWalkthrough>);
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
      targeting: { projects: ['Apex'], groupId: null },
      targetingRules: [],
    });
    mockWalkthroughHooks.useCreateWalkthrough.mockReturnValue({
      mutateAsync: createAsync,
      isPending: false,
      error: null,
    } as unknown as ReturnType<typeof mockWalkthroughHooks.useCreateWalkthrough>);

    renderEditor({ onSaved });

    await user.type(screen.getByLabelText(/internal name/i), 'Draft');
    await user.type(screen.getByLabelText(/user title/i), 'Welcome');
    await user.click(screen.getByTestId('walkthrough-project-option-Apex'));
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
    } as unknown as ReturnType<typeof mockWalkthroughHooks.useCreateWalkthrough>);
    renderEditor();

    await user.type(screen.getByLabelText(/internal name/i), 'Draft');
    await user.type(screen.getByLabelText(/user title/i), 'Welcome');
    await user.click(screen.getByTestId('walkthrough-project-option-Apex'));
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
    } as unknown as ReturnType<typeof mockWalkthroughHooks.useCreateWalkthrough>);
    renderEditor();

    await user.type(screen.getByLabelText(/internal name/i), 'Draft');
    await user.type(screen.getByLabelText(/user title/i), 'Welcome');
    await user.click(screen.getByTestId('walkthrough-project-option-Apex'));
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

  it('renders Targeting section before AI-assisted draft panel', () => {
    renderEditor();

    const targeting = screen.getByText('Targeting');
    const aiPanel = screen.getByText('AI-assisted draft');
    const sections = document.querySelectorAll('[class*="section"], [class*="panel"]');
    const sectionTexts = Array.from(sections).map((s) => s.textContent ?? '');
    const targetingIdx = sectionTexts.findIndex((t) => t.includes('Targeting'));
    const aiIdx = sectionTexts.findIndex((t) => t.includes('AI-assisted draft'));

    expect(targeting).toBeInTheDocument();
    expect(aiPanel).toBeInTheDocument();
    expect(targetingIdx).toBeLessThan(aiIdx);
  });

  it('carries imageAlt through save draft (round-trip)', async () => {
    const user = userEvent.setup();
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
        {
          id: 's1',
          walkthroughId: 'wt-new',
          ordinal: 0,
          heading: 'Step',
          bodyMarkdown: 'Body',
          imageUrl: '/some-image.png',
          imageAlt: 'Custom description',
        },
      ],
      targeting: { projects: ['Apex'], groupId: null },
      targetingRules: [],
    });
    mockWalkthroughHooks.useCreateWalkthrough.mockReturnValue({
      mutateAsync: createAsync,
      isPending: false,
      error: null,
    } as unknown as ReturnType<typeof mockWalkthroughHooks.useCreateWalkthrough>);

    renderEditor();

    await user.type(screen.getByLabelText(/internal name/i), 'Draft');
    await user.type(screen.getByLabelText(/user title/i), 'Welcome');
    await user.click(screen.getByTestId('walkthrough-project-option-Apex'));
    await user.type(screen.getByLabelText(/heading/i), 'Step');
    await user.type(screen.getByLabelText(/image url/i), '/some-image.png');

    await waitFor(() => {
      expect(screen.getByLabelText(/image alt text/i)).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText(/image alt text/i), 'Custom description');

    await user.click(screen.getByTestId('walkthrough-save-draft'));

    await waitFor(() => expect(createAsync).toHaveBeenCalled());
    const payload = createAsync.mock.calls[0][0];
    expect(payload.steps[0].imageAlt).toBe('Custom description');
    expect(payload.steps[0].imageUrl).toBe('/some-image.png');
  });
});

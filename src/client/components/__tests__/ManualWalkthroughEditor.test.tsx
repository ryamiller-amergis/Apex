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
      isRequired: false,
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
      isRequired: true,
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
    await user.click(screen.getByTestId('walkthrough-required-toggle'));
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
    expect(payload.isRequired).toBe(true);
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

  it('explains how to configure opener anchors for hidden elements', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByTestId('walkthrough-steps-info-toggle'));

    const info = screen.getByTestId('walkthrough-steps-info-panel');
    expect(within(info).getByText(/hidden anchors/i)).toBeInTheDocument();
    expect(within(info).getByText(/anchor management/i)).toBeInTheDocument();
    expect(within(info).getByText('Opener anchors', { selector: 'strong' })).toBeInTheDocument();
    expect(within(info).getByText(/design-module-save-btn/i)).toBeInTheDocument();
  });

  it('filters anchors live in the searchable combobox and searches CTA routes', async () => {
    const user = userEvent.setup();
    mockWalkthroughHooks.useWalkthroughAnchors.mockReturnValue({
      data: [
        {
          key: 'user-menu-trigger',
          testId: 'user-menu-trigger',
          label: 'User menu',
          targetRoute: '/home',
          allowedPlacements: ['bottom'],
          smartTags: ['navigation'],
        },
        {
          key: 'profile-bio',
          testId: 'profile-bio-section',
          label: 'Profile bio',
          targetRoute: '/profile',
          allowedPlacements: ['top'],
          smartTags: ['profile', 'edit'],
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof mockWalkthroughHooks.useWalkthroughAnchors>);

    renderEditor();

    const anchorCombobox = screen.getByRole('combobox', { name: /^Anchor$/i });
    await user.click(anchorCombobox);
    expect(screen.getByRole('option', { name: /User menu.*user-menu-trigger/i }))
      .toBeInTheDocument();

    await user.type(anchorCombobox, 'bio');
    const anchorListbox = screen.getByRole('listbox', { name: /approved anchors/i });
    expect(within(anchorListbox).getByRole('option', { name: /Profile bio.*profile-bio/i }))
      .toBeInTheDocument();
    expect(within(anchorListbox).queryByRole('option', { name: /User menu/i }))
      .not.toBeInTheDocument();

    await user.click(within(anchorListbox).getByRole('option', { name: /Profile bio/i }));
    expect(anchorCombobox).toHaveValue('Profile bio (profile-bio)');

    await user.type(screen.getByLabelText(/search CTA routes/i), 'design module');
    const ctaRoute = screen.getByLabelText(/^CTA route$/i);
    expect(within(ctaRoute).getByRole('option', { name: /Design Module/i }))
      .toBeInTheDocument();
    expect(within(ctaRoute).queryByRole('option', { name: /Profile/i }))
      .not.toBeInTheDocument();
  });

  it('disables the Lifecycle button while the form has unsaved changes', async () => {
    const user = userEvent.setup();
    const published = {
      id: 'wt-1',
      internalName: 'Intro',
      userTitle: 'Welcome',
      whyItMatters: 'Because',
      lifecycle: 'published',
      priority: 0,
      isRequired: false,
      revision: 2,
      publishedAt: '2026-07-01T00:00:00Z',
      archivedAt: null,
      createdBy: 'admin',
      createdAt: '2026-07-01T00:00:00Z',
      updatedBy: 'admin',
      updatedAt: '2026-07-10T00:00:00Z',
      steps: [{ id: 's1', walkthroughId: 'wt-1', ordinal: 0, heading: 'First', bodyMarkdown: 'A' }],
      targeting: { projects: ['Apex'], groupId: null },
      targetingRules: [],
    };
    mockWalkthroughHooks.useWalkthroughDetail.mockReturnValue({
      data: published,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof mockWalkthroughHooks.useWalkthroughDetail>);

    renderEditor({ walkthroughId: 'wt-1' });

    // Freshly loaded (saved) state → lifecycle is available.
    const lifecycleBtn = await screen.findByTestId('walkthrough-publish');
    expect(lifecycleBtn).toBeEnabled();

    // Editing dirties the form → lifecycle must be gated until the draft is saved.
    await user.type(screen.getByLabelText(/user title/i), ' Updated');
    await waitFor(() => expect(screen.getByTestId('walkthrough-publish')).toBeDisabled());
    expect(
      screen.getByText(/save your draft before publishing/i),
    ).toBeInTheDocument();
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
      isRequired: false,
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

  it('carries CTA label and route through save draft (round-trip)', async () => {
    const user = userEvent.setup();
    const createAsync = jest.fn().mockResolvedValue({
      id: 'wt-cta',
      internalName: 'Draft',
      userTitle: 'Welcome',
      whyItMatters: '',
      lifecycle: 'draft',
      priority: 0,
      isRequired: false,
      revision: 1,
      publishedAt: null,
      archivedAt: null,
      createdBy: 'admin',
      createdAt: '2026-07-29T00:00:00Z',
      updatedBy: 'admin',
      updatedAt: '2026-07-29T00:00:00Z',
      steps: [{ id: 's1', walkthroughId: 'wt-cta', ordinal: 0, heading: 'Step', bodyMarkdown: 'Body' }],
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
    await user.type(screen.getByLabelText(/^CTA label$/i), 'Go to Design Module');
    await user.selectOptions(screen.getByLabelText(/^CTA route$/i), '/design-module');

    await user.click(screen.getByTestId('walkthrough-save-draft'));

    await waitFor(() => expect(createAsync).toHaveBeenCalled());
    const payload = createAsync.mock.calls[0][0];
    expect(payload.steps[0].ctaLabel).toBe('Go to Design Module');
    expect(payload.steps[0].ctaRoute).toBe('/design-module');
  });

  it('reconciles a saved placement that is no longer allowed before saving', async () => {
    const user = userEvent.setup();
    const existing = {
      id: 'wt-stale-placement',
      internalName: 'Design module guide',
      userTitle: 'Design module',
      whyItMatters: '',
      lifecycle: 'draft',
      priority: 0,
      isRequired: false,
      revision: 1,
      publishedAt: null,
      archivedAt: null,
      createdBy: 'admin',
      createdAt: '2026-07-30T00:00:00Z',
      updatedBy: 'admin',
      updatedAt: '2026-07-30T00:00:00Z',
      steps: [{
        id: 's1',
        walkthroughId: 'wt-stale-placement',
        ordinal: 0,
        heading: 'Save the module',
        bodyMarkdown: 'Save your changes.',
        route: '/design-module',
        ctaLabel: null,
        ctaRoute: null,
        anchor: {
          key: 'user-menu-trigger',
          targetRoute: '/home',
          placement: 'right',
        },
      }],
      targeting: { projects: ['Apex'], groupId: null },
      targetingRules: [{ type: 'project', value: 'Apex' }],
    };
    const updateAsync = jest.fn().mockResolvedValue({
      ...existing,
      updatedAt: '2026-07-31T00:00:00Z',
      steps: [{
        ...existing.steps[0],
        anchor: {
          ...existing.steps[0].anchor,
          placement: 'bottom',
        },
      }],
    });
    mockWalkthroughHooks.useWalkthroughDetail.mockReturnValue({
      data: existing,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof mockWalkthroughHooks.useWalkthroughDetail>);
    mockWalkthroughHooks.useUpdateWalkthrough.mockReturnValue({
      mutateAsync: updateAsync,
      isPending: false,
      error: null,
    } as unknown as ReturnType<typeof mockWalkthroughHooks.useUpdateWalkthrough>);

    renderEditor({ walkthroughId: existing.id });

    await waitFor(() => expect(screen.getByLabelText(/^Placement$/i)).toHaveValue('bottom'));
    expect(screen.getByLabelText(/^CTA route$/i)).toHaveValue('');

    await user.click(screen.getByTestId('walkthrough-save-draft'));

    await waitFor(() => expect(updateAsync).toHaveBeenCalled());
    expect(updateAsync.mock.calls[0][0].steps[0].anchor?.placement).toBe('bottom');
    expect(screen.queryByTestId('walkthrough-validation-summary')).not.toBeInTheDocument();
  });
});

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WalkthroughCatalog } from '../WalkthroughCatalog';
import * as walkthroughHooks from '../../hooks/usePlatformAdminWalkthroughs';

jest.mock('../../hooks/usePlatformAdminWalkthroughs');
jest.mock('../ManualWalkthroughEditor', () => ({
  ManualWalkthroughEditor: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="walkthrough-editor">
      <button type="button" onClick={onClose}>Close editor</button>
    </div>
  ),
}));

const mockHooks = walkthroughHooks as jest.Mocked<typeof walkthroughHooks>;

function renderCatalog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <WalkthroughCatalog />
    </QueryClientProvider>,
  );
}

const sampleWalkthrough = {
  id: 'wt-1',
  internalName: 'Onboarding',
  userTitle: 'Welcome',
  whyItMatters: 'Helps new users',
  lifecycle: 'draft' as const,
  priority: 10,
  revision: 1,
  publishedAt: null,
  archivedAt: null,
  createdBy: 'admin',
  createdAt: '2026-07-29T00:00:00Z',
  updatedBy: 'admin',
  updatedAt: '2026-07-29T12:00:00Z',
  steps: [
    { id: 's1', walkthroughId: 'wt-1', ordinal: 0, heading: 'Start', bodyMarkdown: 'Hello' },
    { id: 's2', walkthroughId: 'wt-1', ordinal: 1, heading: 'Next', bodyMarkdown: 'More' },
  ],
  targeting: { project: 'Apex', groupId: null },
  targetingRules: [{ type: 'project' as const, value: 'Apex' }],
};

describe('WalkthroughCatalog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHooks.useWalkthroughCatalog.mockReturnValue({
      data: { pages: [{ items: [sampleWalkthrough], nextCursor: null }], pageParams: [null] },
      isLoading: false,
      isError: false,
      error: null,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: jest.fn(),
    } as any);
  });

  it('AC-0 — renders catalog rows with step count and opens editor', async () => {
    const user = userEvent.setup();
    renderCatalog();

    expect(screen.getByTestId('walkthrough-catalog')).toBeInTheDocument();
    expect(screen.getByTestId('walkthrough-catalog-row-wt-1')).toHaveTextContent('Onboarding');
    expect(screen.getByText('2')).toBeInTheDocument();

    await user.click(screen.getByTestId('walkthrough-catalog-row-wt-1'));

    expect(screen.getByTestId('walkthrough-editor')).toBeInTheDocument();
  });

  it('AC-2 — shows load more when next cursor is available', async () => {
    const fetchNextPage = jest.fn();
    mockHooks.useWalkthroughCatalog.mockReturnValue({
      data: { pages: [{ items: [sampleWalkthrough], nextCursor: 'cursor-2' }], pageParams: [null] },
      isLoading: false,
      isError: false,
      error: null,
      hasNextPage: true,
      isFetchingNextPage: false,
      fetchNextPage,
    } as any);

    const user = userEvent.setup();
    renderCatalog();

    await user.click(screen.getByRole('button', { name: /load more/i }));
    expect(fetchNextPage).toHaveBeenCalled();
  });

  it('AC-0 — create button opens editor', async () => {
    const user = userEvent.setup();
    renderCatalog();

    await user.click(screen.getByTestId('walkthrough-create'));
    expect(screen.getByTestId('walkthrough-editor')).toBeInTheDocument();
  });
});

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThreadHistorySidebar } from '../ThreadHistorySidebar';
import type { ChatThreadSearchResult, ChatThreadSummary } from '../../../shared/types/chat';

const mockUseChatThreadList = jest.fn();
const mockDeleteMutateAsync = jest.fn();
const mockFlagMutate = jest.fn();

jest.mock('../../hooks/useChatThreads', () => ({
  useChatThreadList: (...args: unknown[]) => mockUseChatThreadList(...args),
  useDeleteThread: () => ({ mutateAsync: mockDeleteMutateAsync, isPending: false }),
  useFlagThread: () => ({ mutate: mockFlagMutate, isPending: false }),
}));

// Relative timestamps so date-group assertions stay stable across calendar days.
// Use "now" for lastActivityAt so local midnight boundaries never mis-bucket the thread.
const nowMs = Date.now();
const baseThread: ChatThreadSummary = {
  id: 'thread-1',
  userId: 'user-1',
  title: 'Design Review',
  status: 'idle',
  kickoff: { project: 'Apex', repo: 'AI-Pilot' },
  flagged: false,
  createdAt: new Date(nowMs - 60 * 60 * 1000).toISOString(),
  lastActivityAt: new Date(nowMs).toISOString(),
};

const searchHit: ChatThreadSearchResult = {
  ...baseThread,
  match: {
    messageId: 'msg-1',
    role: 'user',
    snippet: 'We should revisit the design tokens for the sidebar.',
    matchedAt: new Date(nowMs - 90 * 60 * 1000).toISOString(),
  },
  titleOnly: false,
};

function mockListReturn(overrides: Record<string, unknown> = {}) {
  mockUseChatThreadList.mockReturnValue({
    data: [baseThread],
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    isSearchActive: false,
    ...overrides,
  });
}

function renderSidebar(props: Partial<React.ComponentProps<typeof ThreadHistorySidebar>> = {}) {
  return render(
    <ThreadHistorySidebar
      activeThreadId={null}
      onSelectThread={jest.fn()}
      onClose={jest.fn()}
      project="Apex"
      {...props}
    />,
  );
}

describe('PBI-002 ThreadHistorySidebar search', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListReturn();
  });

  it('AC-0 / VT-05: active search shows flat results with plain snippets and no date groups', async () => {
    const user = userEvent.setup();
    mockListReturn({
      data: [searchHit],
      isSearchActive: true,
    });

    renderSidebar();

    const input = screen.getByTestId('history-search-input');
    await user.type(input, 'design');

    expect(screen.getByTestId('history-search-results')).toBeInTheDocument();
    const row = screen.getByTestId('history-search-result-row');
    expect(row).toBeInTheDocument();
    expect(screen.getByTestId('history-search-result-snippet')).toHaveTextContent(
      'We should revisit the design tokens for the sidebar.',
    );
    expect(screen.queryByText('Today')).not.toBeInTheDocument();
    expect(screen.queryByText('Yesterday')).not.toBeInTheDocument();
    // No emphasis markup inside the snippet
    const snippet = screen.getByTestId('history-search-result-snippet');
    expect(snippet.querySelector('strong, b, em, mark')).toBeNull();
  });

  it('AC-1 / VT-06: search error shows history-search-error and keeps input editable', async () => {
    const user = userEvent.setup();
    mockListReturn({
      data: undefined,
      isSearchActive: true,
      isError: true,
      error: new Error('Search failed'),
      isLoading: false,
    });

    renderSidebar();

    const input = screen.getByTestId('history-search-input') as HTMLInputElement;
    await user.type(input, 'design');

    const error = screen.getByTestId('history-search-error');
    expect(error).toHaveAttribute('role', 'alert');
    expect(error).toHaveTextContent(/failed|error|search/i);
    expect(screen.queryByTestId('history-search-result-row')).not.toBeInTheDocument();

    expect(input).not.toBeDisabled();
    await user.clear(input);
    await user.type(input, 'retry');
    expect(input).toHaveValue('retry');
  });

  it('AC-2 / VT-07: flagged toggle and project scope are passed into the hook during search', async () => {
    const user = userEvent.setup();
    mockListReturn({ isSearchActive: true, data: [searchHit] });

    renderSidebar({ project: 'Apex' });

    await user.type(screen.getByTestId('history-search-input'), 'notif');
    await user.click(screen.getByRole('button', { name: /flagged/i }));

    expect(mockUseChatThreadList).toHaveBeenCalledWith(
      50,
      'Apex',
      expect.objectContaining({
        searchTerm: expect.stringContaining('notif'),
        flaggedOnly: true,
      }),
    );
  });

  it('AC-3 / VT-08: zero results show No matching chats empty state', async () => {
    const user = userEvent.setup();
    mockListReturn({
      data: [],
      isSearchActive: true,
    });

    renderSidebar();
    await user.type(screen.getByTestId('history-search-input'), 'zzzz');

    expect(screen.getByTestId('history-search-empty')).toHaveTextContent('No matching chats');
  });

  it('AC-3 / VT-09: clearing the search restores the date-grouped history list', async () => {
    const user = userEvent.setup();
    // Start in search-empty, then after clear switch mock to non-search with threads
    mockListReturn({ data: [], isSearchActive: true });

    const { rerender } = render(
      <ThreadHistorySidebar
        activeThreadId={null}
        onSelectThread={jest.fn()}
        onClose={jest.fn()}
        project="Apex"
      />,
    );

    const input = screen.getByTestId('history-search-input');
    await user.type(input, 'zzzz');
    expect(screen.getByTestId('history-search-empty')).toBeInTheDocument();

    mockListReturn({ data: [baseThread], isSearchActive: false });
    await user.clear(input);

    rerender(
      <ThreadHistorySidebar
        activeThreadId={null}
        onSelectThread={jest.fn()}
        onClose={jest.fn()}
        project="Apex"
      />,
    );

    expect(screen.queryByTestId('history-search-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('history-search-results')).not.toBeInTheDocument();
    expect(document.querySelector('.date-group-header')).toBeInTheDocument();
    expect(screen.getByText('Today')).toBeInTheDocument();
  });

  it('VT-10: search input is labeled and result rows are keyboard-focusable', async () => {
    mockListReturn({ data: [searchHit], isSearchActive: true });
    renderSidebar();

    const input = screen.getByTestId('history-search-input');
    expect(input).toHaveAccessibleName(/search/i);

    const row = screen.getByTestId('history-search-result-row');
    const selectBtn = within(row).getByRole('button', { name: /open thread/i });
    expect(selectBtn).toBeInTheDocument();
  });

  it('U-2: shows Searching… loading indicator while a search fetch is in flight', () => {
    mockListReturn({
      data: [baseThread],
      isSearchActive: true,
      isFetching: true,
      isLoading: false,
    });
    renderSidebar();

    expect(screen.getByTestId('history-search-loading')).toHaveTextContent(/searching/i);
  });

  it('passes the raw search term into useChatThreadList (hook owns debounce)', async () => {
    const user = userEvent.setup();
    mockListReturn();
    renderSidebar();

    await user.type(screen.getByTestId('history-search-input'), 'de');

    expect(mockUseChatThreadList).toHaveBeenCalledWith(
      50,
      'Apex',
      expect.objectContaining({ searchTerm: 'de' }),
    );
  });

  it('PBI-003 AC-0 / VT-01: message-match result passes focusMessageId on select', async () => {
    const user = userEvent.setup();
    const onSelectThread = jest.fn();
    mockListReturn({ data: [searchHit], isSearchActive: true });
    renderSidebar({ onSelectThread });

    const row = screen.getByTestId('history-search-result-row');
    await user.click(within(row).getByRole('button', { name: /open thread/i }));

    expect(onSelectThread).toHaveBeenCalledWith('thread-1', { focusMessageId: 'msg-1' });
  });

  it('PBI-003 AC-2 / VT-02: title-only result selects without focusMessageId', async () => {
    const user = userEvent.setup();
    const onSelectThread = jest.fn();
    const titleOnly: ChatThreadSearchResult = {
      ...baseThread,
      titleOnly: true,
    };
    mockListReturn({ data: [titleOnly], isSearchActive: true });
    renderSidebar({ onSelectThread });

    const row = screen.getByTestId('history-search-result-row');
    await user.click(within(row).getByRole('button', { name: /open thread/i }));

    expect(onSelectThread).toHaveBeenCalledWith('thread-1', undefined);
  });

  it('PBI-003 AC-3 / VT-05: date-grouped row selects with thread id only', async () => {
    const user = userEvent.setup();
    const onSelectThread = jest.fn();
    mockListReturn({ data: [baseThread], isSearchActive: false });
    renderSidebar({ onSelectThread });

    await user.click(screen.getByRole('button', { name: /open thread/i }));

    expect(onSelectThread).toHaveBeenCalledWith('thread-1');
    expect(onSelectThread.mock.calls[0][1]).toBeUndefined();
  });
});

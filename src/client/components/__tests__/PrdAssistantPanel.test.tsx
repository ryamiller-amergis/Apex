/**
 * Tests for PrdAssistantPanel — a resizable slide-out chat panel for PRD Apex Assistant.
 *
 * 1. Panel is not visible when open={false}
 * 2. Panel becomes visible when open={true}
 * 3. On open with no existing thread, calls POST /api/interviews/prds/:prdId/assistant-thread
 * 4. Displays the chat interface after thread is created
 * 5. "New conversation" button triggers a confirmation modal
 * 6. Confirming "New conversation" calls the route again (new thread)
 * 7. Cancelling the modal keeps the existing thread
 * 8. Close button calls onClose prop
 */

import type { ReactNode } from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PrdAssistantPanel } from '../PrdAssistantPanel';

// ── Module mocks ───────────────────────────────────────────────────────────────

const mockUseChatStream = jest.fn();
jest.mock('../../hooks/useChatStream', () => ({
  useChatStream: (...args: unknown[]) => mockUseChatStream(...args),
}));

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: jest.fn() }));

// ── Helpers ────────────────────────────────────────────────────────────────────

const idleStreamState = {
  messages: [],
  streamingText: '',
  status: 'idle' as const,
  isConnected: true,
  prdReady: false,
  backlogReady: false,
  isRetrying: false,
  retryReason: null,
};

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}

function renderPanel(
  props: {
    prdId?: string;
    open?: boolean;
    onClose?: jest.Mock;
    existingThreadId?: string | null;
  } = {},
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const mergedProps = {
    prdId: 'prd-test-1',
    open: true,
    onClose: jest.fn(),
    existingThreadId: null,
    ...props,
  };
  return render(<PrdAssistantPanel {...mergedProps} />, { wrapper: createWrapper(queryClient) });
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockUseChatStream.mockReturnValue(idleStreamState);
  global.fetch = jest.fn().mockResolvedValue({
    json: () => Promise.resolve({ threadId: 'thread-new-1' }),
  } as unknown as Response);
});

afterEach(() => {
  (global as unknown as Record<string, unknown>).fetch = undefined;
});

// ── 1. Panel hidden when open={false} ─────────────────────────────────────────

describe('Visibility', () => {
  it('does not render the panel when open={false}', () => {
    renderPanel({ open: false });
    expect(screen.queryByText('Apex Assistant')).not.toBeInTheDocument();
  });

  it('renders the panel when open={true}', () => {
    renderPanel({ open: true, existingThreadId: 'thread-123' });
    expect(screen.getByText('Apex Assistant')).toBeInTheDocument();
  });
});

// ── 2. Thread creation ────────────────────────────────────────────────────────

describe('Thread creation', () => {
  it('calls POST /api/interviews/prds/:prdId/assistant-thread when no thread exists', async () => {
    renderPanel({ open: true, existingThreadId: null });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/interviews/prds/prd-test-1/assistant-thread',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('does NOT call the thread route when existingThreadId is provided', async () => {
    renderPanel({ open: true, existingThreadId: 'existing-thread-456' });

    await new Promise((r) => setTimeout(r, 50));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('displays the chat input area after thread is created', async () => {
    renderPanel({ open: true, existingThreadId: null });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    // After the fetch resolves, the input should be rendered
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Ask about this PRD/i)).toBeInTheDocument();
    });
  });

  it('displays the chat input when existingThreadId is provided from the start', () => {
    renderPanel({ open: true, existingThreadId: 'thread-123' });
    expect(screen.getByPlaceholderText(/Ask about this PRD/i)).toBeInTheDocument();
  });
});

// ── 3. New conversation modal ─────────────────────────────────────────────────

describe('New conversation — custom confirm modal', () => {
  beforeEach(() => {
    jest.spyOn(window, 'confirm').mockImplementation(() => {
      throw new Error('window.confirm must not be called');
    });
  });

  it('does NOT call window.confirm when "New conversation" is clicked', () => {
    renderPanel({ open: true, existingThreadId: 'thread-existing' });
    expect(() => {
      fireEvent.click(screen.getByRole('button', { name: /New conversation/i }));
    }).not.toThrow();
  });

  it('shows a confirmation modal with "Start new conversation?" heading', () => {
    renderPanel({ open: true, existingThreadId: 'thread-existing' });
    fireEvent.click(screen.getByRole('button', { name: /New conversation/i }));
    expect(screen.getByRole('heading', { name: /Start new conversation\?/i })).toBeInTheDocument();
  });

  it('renders Cancel and Start new buttons inside the modal', () => {
    renderPanel({ open: true, existingThreadId: 'thread-existing' });
    fireEvent.click(screen.getByRole('button', { name: /New conversation/i }));
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Start new/i })).toBeInTheDocument();
  });

  it('dismisses the modal when Cancel is clicked', () => {
    renderPanel({ open: true, existingThreadId: 'thread-existing' });
    fireEvent.click(screen.getByRole('button', { name: /New conversation/i }));
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(screen.queryByRole('heading', { name: /Start new conversation\?/i })).not.toBeInTheDocument();
  });

  it('dismisses the modal on backdrop click', () => {
    renderPanel({ open: true, existingThreadId: 'thread-existing' });
    fireEvent.click(screen.getByRole('button', { name: /New conversation/i }));
    const overlay = screen.getByRole('dialog');
    fireEvent.click(overlay);
    expect(screen.queryByRole('heading', { name: /Start new conversation\?/i })).not.toBeInTheDocument();
  });

  it('calls the thread route again when "Start new" is confirmed', async () => {
    renderPanel({ open: true, existingThreadId: 'thread-existing' });
    fireEvent.click(screen.getByRole('button', { name: /New conversation/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Start new/i }));
    });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/prds/prd-test-1/assistant-thread',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('forceNew'),
      }),
    );
  });

  it('closes the modal after confirming "Start new"', async () => {
    renderPanel({ open: true, existingThreadId: 'thread-existing' });
    fireEvent.click(screen.getByRole('button', { name: /New conversation/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Start new/i }));
    });
    expect(screen.queryByRole('heading', { name: /Start new conversation\?/i })).not.toBeInTheDocument();
  });
});

// ── 4. Close button ───────────────────────────────────────────────────────────

describe('Close button', () => {
  it('calls onClose when the × button is clicked', () => {
    const onClose = jest.fn();
    renderPanel({ open: true, existingThreadId: 'thread-123', onClose });
    fireEvent.click(screen.getByRole('button', { name: /Close assistant/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ── 5. Query invalidation on run complete ─────────────────────────────────────

describe('React Query invalidation when agent run completes', () => {
  it('calls queryClient.invalidateQueries for the PRD when isRunning goes true → false', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    mockUseChatStream.mockReturnValue({ ...idleStreamState, status: 'running' });

    const { rerender } = render(
      <PrdAssistantPanel prdId="prd-test-1" open existingThreadId="thread-123" onClose={jest.fn()} />,
      { wrapper: createWrapper(queryClient) },
    );

    mockUseChatStream.mockReturnValue({ ...idleStreamState, status: 'idle' });
    act(() => {
      rerender(
        <PrdAssistantPanel prdId="prd-test-1" open existingThreadId="thread-123" onClose={jest.fn()} />,
      );
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ['prd', 'prd-test-1'] }),
      );
    });
  });

  it('does NOT invalidate when the agent was never running (idle → idle)', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    mockUseChatStream.mockReturnValue(idleStreamState);

    const { rerender } = render(
      <PrdAssistantPanel prdId="prd-test-1" open existingThreadId="thread-123" onClose={jest.fn()} />,
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      rerender(
        <PrdAssistantPanel prdId="prd-test-1" open existingThreadId="thread-123" onClose={jest.fn()} />,
      );
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

// ── 6. Resize handle ─────────────────────────────────────────────────────────

describe('Resize handle', () => {
  it('renders a resize handle with role="separator"', () => {
    renderPanel({ open: true, existingThreadId: 'thread-123' });
    expect(screen.getByRole('separator', { name: /Resize panel/i })).toBeInTheDocument();
  });

  it('adjusts panel width when dragged', async () => {
    renderPanel({ open: true, existingThreadId: 'thread-123' });
    const handle = screen.getByRole('separator', { name: /Resize panel/i });
    const panel = handle.closest('[style]') as HTMLElement;
    const initialWidth = panel ? parseInt(panel.style.width, 10) : 380;

    act(() => { fireEvent.mouseDown(handle, { clientX: 600 }); });
    act(() => { document.dispatchEvent(new MouseEvent('mousemove', { clientX: 500, bubbles: true })); });

    await waitFor(() => {
      const newWidth = panel ? parseInt(panel.style.width, 10) : 380;
      expect(newWidth).toBeGreaterThan(initialWidth);
    });
  });
});

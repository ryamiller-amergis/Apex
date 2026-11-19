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

const mockUseChatRuntime = jest.fn();
jest.mock('../../chatHarness', () => ({
  ...jest.requireActual('../../chatHarness'),
  useChatRuntime: (...args: unknown[]) => mockUseChatRuntime(...args),
}));

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: jest.fn() }));

// ── Helpers ────────────────────────────────────────────────────────────────────

const idleRuntimeState = {
  threadId: 'thread-123',
  harnessArea: 'prd-assistant' as const,
  snapshotLoaded: true,
  snapshotError: null,
  snapshotStatusCode: null,
  canWrite: true,
  connectionState: 'open' as const,
  isConnected: true,
  hasConnectionError: false,
  lastEventId: null,
  status: 'idle' as 'idle' | 'running' | 'error' | 'closed',
  activeRunId: null as string | null,
  phase: 'idle' as 'idle' | 'starting' | 'resuming' | 'recreating' | 'running' | 'summarizing',
  latestSummary: null,
  summaryNotice: null,
  messages: [],
  optimisticMessages: [],
  streamingText: '',
  thinkingText: '',
  toolProgress: [],
  activity: [],
  phaseEvents: [],
  runHealth: null,
  progressLabel: null,
  progressPhase: null,
  lastProgressAt: null,
  prdReady: false,
  backlogReady: false,
  isRetrying: false,
  retryReason: null,
  retryableRunId: null,
  groundingPreparation: null,
  pendingCommands: [],
  lastReceipt: null,
  stopping: false,
  lastFailure: null,
  terminalRevision: 0,
};

function makeRuntimeReturn(overrides: Partial<typeof idleRuntimeState> = {}) {
  const state = { ...idleRuntimeState, ...overrides };
  return {
    runtime: {
      getDisplayedMessages: () => state.messages,
      getState: () => state,
      send: jest.fn().mockResolvedValue(null),
      steer: jest.fn().mockResolvedValue(null),
      summarize: jest.fn().mockResolvedValue(null),
      cancel: jest.fn().mockResolvedValue(null),
      retry: jest.fn().mockResolvedValue(null),
      clearReceipt: jest.fn(),
      clearFailure: jest.fn(),
      refreshSnapshot: jest.fn().mockResolvedValue(null),
    },
    state,
  };
}

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
    proposal?: ReactNode;
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
  mockUseChatRuntime.mockReturnValue(makeRuntimeReturn());
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
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
    expect(screen.getByRole('complementary', { name: 'PRD assistant panel' })).toBeInTheDocument();
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

  it('opens a newly created thread on the welcome and fills the composer from a suggestion', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ threadId: 'thread-new-1', created: true }),
    } as unknown as Response);
    renderPanel({ open: true, existingThreadId: null });

    expect(await screen.findByTestId('prd-assistant-welcome')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Summarize the open review comments' }));

    expect(screen.getByPlaceholderText(/Ask about this PRD/i)).toHaveValue('Summarize the open review comments');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not show the welcome for an existing thread while its history loads', () => {
    renderPanel({ open: true, existingThreadId: 'thread-123' });
    expect(screen.queryByTestId('prd-assistant-welcome')).not.toBeInTheDocument();
  });

  it('PBI-007 AC-1 keeps the shared transcript and composer when thread creation fails', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('network unavailable'));
    renderPanel({ open: true, existingThreadId: null });

    expect(await screen.findByText('network unavailable')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'PRD assistant panel' })).toBeInTheDocument();
    expect(screen.getByTestId('prd-assistant-composer')).toBeInTheDocument();
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

    mockUseChatRuntime.mockReturnValue(makeRuntimeReturn({ status: 'running' }));

    const { rerender } = render(
      <PrdAssistantPanel prdId="prd-test-1" open existingThreadId="thread-123" onClose={jest.fn()} />,
      { wrapper: createWrapper(queryClient) },
    );

    mockUseChatRuntime.mockReturnValue(makeRuntimeReturn({ status: 'idle' }));
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

  it('invalidates the prd-test-cases query when isRunning goes true → false', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    mockUseChatRuntime.mockReturnValue(makeRuntimeReturn({ status: 'running' }));

    const { rerender } = render(
      <PrdAssistantPanel prdId="prd-test-1" open existingThreadId="thread-123" onClose={jest.fn()} />,
      { wrapper: createWrapper(queryClient) },
    );

    mockUseChatRuntime.mockReturnValue(makeRuntimeReturn({ status: 'idle' }));
    act(() => {
      rerender(
        <PrdAssistantPanel prdId="prd-test-1" open existingThreadId="thread-123" onClose={jest.fn()} />,
      );
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ['prd-test-cases', 'prd-test-1'] }),
      );
    });
  });

  it('does NOT invalidate when the agent was never running (idle → idle)', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    mockUseChatRuntime.mockReturnValue(makeRuntimeReturn());

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

// ── 6. Harness cutover & proposal slot (S8e / VT-31 / BR-001) ─────────────────

describe('AgentHarnessPanel cutover & proposal slot', () => {
  it('renders AgentHarnessPanel with prd-assistant area and harness controls', () => {
    renderPanel({ open: true, existingThreadId: 'thread-123' });

    const harness = screen.getByTestId('prd-assistant-harness-panel');
    expect(harness).toHaveAttribute('data-harness-area', 'prd-assistant');
    expect(screen.getByTestId('prd-assistant-transcript')).toBeInTheDocument();
    expect(screen.getByTestId('prd-assistant-composer')).toBeInTheDocument();
    expect(screen.getByTestId('prd-assistant-message-input')).toBeInTheDocument();
    expect(screen.getByTestId('prd-assistant-send-btn')).toBeInTheDocument();
    expect(screen.getByTestId('prd-assistant-composer-summarize')).toBeInTheDocument();
  });

  it('shows harness live work box, Stop, and Steer controls while running', () => {
    mockUseChatRuntime.mockReturnValue(makeRuntimeReturn({ status: 'running' }));
    renderPanel({ open: true, existingThreadId: 'thread-123' });

    expect(screen.getByTestId('prd-assistant-streaming')).toBeInTheDocument();
    expect(screen.getByTestId('prd-assistant-agent-progress')).toBeInTheDocument();
    expect(screen.getByTestId('prd-assistant-agent-busy')).toBeInTheDocument();
    expect(screen.getByTestId('prd-assistant-stop-btn')).toBeInTheDocument();
    expect(screen.getByTestId('prd-assistant-composer-steer')).toBeInTheDocument();
  });

  it('wires PRD diff review through slots.proposal without auto-approving writes (BR-001)', () => {
    const acceptSpy = jest.fn();
    renderPanel({
      open: true,
      existingThreadId: 'thread-123',
      proposal: (
        <div data-testid="prd-diff-review">
          <span>Proposed PRD diff</span>
          <button type="button" data-testid="prd-diff-accept" onClick={acceptSpy}>
            Accept
          </button>
        </div>
      ),
    });

    expect(screen.getByTestId('prd-assistant-slot-proposal')).toBeInTheDocument();
    expect(screen.getByTestId('prd-diff-review')).toBeInTheDocument();
    expect(acceptSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('prd-diff-accept'));
    expect(acceptSpy).toHaveBeenCalledTimes(1);
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

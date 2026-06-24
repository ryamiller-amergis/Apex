/**
 * Tests for the DesignDocAssistantPanel changes inside DesignDocReviewView:
 *
 * 1. Branding — "Ask Apex" button / "Apex Assistant" panel title
 * 2. Custom confirmation modal replaces window.confirm for "New conversation"
 * 3. React Query invalidation when an agent run completes (isRunning true → false)
 * 4. Horizontal resize handle is rendered and responds to drag
 */

import type { ReactNode } from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DesignDocReviewView } from '../DesignDocReviewView';

// ── Module mocks ───────────────────────────────────────────────────────────────

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
  useLocation: () => ({ pathname: '/backlog/design-doc/doc-1' }),
}));

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: jest.fn(() => ({
    can: (key: string) => key === 'design-docs:review' || key === 'interviews:manage',
    userId: 'user-reviewer',
    isAdmin: false,
  })),
}));

const mockUseDesignDoc = jest.fn();
jest.mock('../../hooks/useInterviews', () => ({
  useDesignDoc: (...args: unknown[]) => mockUseDesignDoc(...args),
  usePrd: jest.fn(() => ({ data: null })),
  useUpdateDesignDocContent: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useSubmitDesignDoc: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useWithdrawDesignDoc: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useReviewDesignDoc: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useDeleteDesignDoc: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useGenerateDesignDoc: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useMarkValidationReady: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useRefreshValidation: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useCancelValidation: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useCreateValidationThread: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useValidationReport: jest.fn(() => ({ data: null })),
  useDesignDocsByPrd: jest.fn(() => ({ data: [] })),
  useFixValidation: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useAcceptFixValidation: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useRevertDesignDocSection: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useFixDesignDocWithAi: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useFixDesignDocCommentWithAi: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useReassignApprovers: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useDocumentAssignments: jest.fn(() => ({ data: [{ approverUserId: 'user-reviewer', status: 'pending' }] })),
  useDesignDocOwnerApproval: jest.fn(() => ({ data: null })),
  useDesignDocOwnerApprove: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
}));

const mockUseChatStream = jest.fn();
jest.mock('../../hooks/useChatStream', () => ({
  useChatStream: (...args: unknown[]) => mockUseChatStream(...args),
}));

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('mermaid', () => ({ initialize: jest.fn(), run: jest.fn() }));
jest.mock('../ConfirmDeleteModal', () => ({ ConfirmDeleteModal: () => null }));
jest.mock('../AnnotationLayer', () => ({ AnnotationLayer: ({ children }: { children: ReactNode }) => <>{children}</> }));
jest.mock('../ReviewCommentSidebar', () => ({ ReviewCommentSidebar: () => null }));
jest.mock('../../hooks/useReviewComments', () => ({
  useReviewComments: () => ({ data: [] }),
  useUnresolvedCommentCount: () => ({ data: { count: 0 } }),
  useCreateComment: () => ({ mutateAsync: jest.fn() }),
  useResolveComment: () => ({ mutate: jest.fn() }),
  useReopenComment: () => ({ mutate: jest.fn() }),
  useDeleteComment: () => ({ mutate: jest.fn() }),
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

const THREAD_LS_KEY = 'design-doc-assistant-thread:doc-1';

const mockDoc = {
  id: 'doc-1',
  prdId: 'prd-1',
  project: 'proj-alpha',
  status: 'draft',
  authorId: 'user-author',
  chatThreadId: 'thread-gen',
  qaChatThreadId: null,
  docAssistantThreadId: null,
  designContent: '# Design\nSome content.',
  techSpecContent: '# Tech Spec\nSome content.',
  assumptionsContent: '# Assumptions\nSome content.',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

const idleStreamState = {
  messages: [],
  streamingText: '',
  status: 'idle' as const,
  isConnected: true,
  prdReady: false,
  backlogReady: false,
};

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/backlog/design-doc/doc-1']}>
        {children}
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function renderView(queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(<DesignDocReviewView />, { wrapper: createWrapper(queryClient) });
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.setItem(THREAD_LS_KEY, 'thread-assistant-1');
  mockUseDesignDoc.mockReturnValue({ data: mockDoc, isLoading: false, isError: false });
  mockUseChatStream.mockReturnValue(idleStreamState);
});

afterEach(() => {
  localStorage.clear();
});

// ── 1. Branding ───────────────────────────────────────────────────────────────

describe('Branding — Ask Apex / Apex Assistant', () => {
  it('renders the header toggle button labelled "Ask Apex"', () => {
    renderView();
    expect(screen.getByRole('button', { name: /Ask Apex/i })).toBeInTheDocument();
  });

  it('does NOT render a button labelled "Ask AI"', () => {
    renderView();
    expect(screen.queryByRole('button', { name: /Ask AI/i })).not.toBeInTheDocument();
  });

  it('shows "Apex Assistant" as the panel title when the panel is open', () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /Ask Apex/i }));
    expect(screen.getByText('Apex Assistant')).toBeInTheDocument();
  });

  it('does NOT show "AI Assistant" as the panel title', () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /Ask Apex/i }));
    expect(screen.queryByText('AI Assistant')).not.toBeInTheDocument();
  });
});

// ── 2. Custom confirmation modal ──────────────────────────────────────────────

describe('New conversation — custom themed modal (no window.confirm)', () => {
  beforeEach(() => {
    // window.confirm must NOT be called at all
    jest.spyOn(window, 'confirm').mockImplementation(() => { throw new Error('window.confirm must not be called'); });
    // After "Start new" the panel resets threadId → null and tries to fetch a new thread.
    global.fetch = jest.fn().mockResolvedValue({
      json: () => Promise.resolve({ threadId: 'thread-new' }),
    } as any);
  });

  afterEach(() => {
    // Restore fetch so other tests are unaffected
    (global as any).fetch = undefined;
  });

  function openPanel() {
    fireEvent.click(screen.getByRole('button', { name: /Ask Apex/i }));
  }

  function clickNewConversation() {
    fireEvent.click(screen.getByRole('button', { name: /New conversation/i }));
  }

  it('does not call window.confirm when the reset button is clicked', () => {
    renderView();
    openPanel();
    // Should not throw (window.confirm is rigged to throw)
    expect(() => clickNewConversation()).not.toThrow();
  });

  it('renders a custom modal with "Start new conversation?" heading', () => {
    renderView();
    openPanel();
    clickNewConversation();
    expect(screen.getByRole('heading', { name: /Start new conversation\?/i })).toBeInTheDocument();
  });

  it('renders Cancel and Start new buttons inside the modal', () => {
    renderView();
    openPanel();
    clickNewConversation();
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Start new/i })).toBeInTheDocument();
  });

  it('dismisses the modal when Cancel is clicked and does not clear the thread', () => {
    renderView();
    openPanel();
    clickNewConversation();
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(screen.queryByRole('heading', { name: /Start new conversation\?/i })).not.toBeInTheDocument();
    // localStorage thread key must still be set
    expect(localStorage.getItem(THREAD_LS_KEY)).toBe('thread-assistant-1');
  });

  it('dismisses the modal on backdrop click without clearing the thread', () => {
    renderView();
    openPanel();
    clickNewConversation();
    // The overlay element has role="dialog"
    const overlay = screen.getByRole('dialog');
    fireEvent.click(overlay);
    expect(screen.queryByRole('heading', { name: /Start new conversation\?/i })).not.toBeInTheDocument();
    expect(localStorage.getItem(THREAD_LS_KEY)).toBe('thread-assistant-1');
  });

  it('clears localStorage and resets the thread when "Start new" is confirmed', () => {
    renderView();
    openPanel();
    clickNewConversation();
    fireEvent.click(screen.getByRole('button', { name: /Start new/i }));
    expect(localStorage.getItem(THREAD_LS_KEY)).toBeNull();
    // Modal should close
    expect(screen.queryByRole('heading', { name: /Start new conversation\?/i })).not.toBeInTheDocument();
  });
});

// ── 3. Query invalidation on run complete ─────────────────────────────────────

describe('React Query invalidation when agent run completes', () => {
  it('calls queryClient.invalidateQueries for the design doc when isRunning goes true → false', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    // Start with the panel open and the agent running
    mockUseChatStream.mockReturnValue({ ...idleStreamState, status: 'running' });

    const { rerender } = render(<DesignDocReviewView />, { wrapper: createWrapper(queryClient) });

    // Open the assistant panel so the panel component mounts with status=running
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /Ask Apex/i }));
    });

    // Confirm panel is open
    expect(screen.getByText('Apex Assistant')).toBeInTheDocument();

    // Simulate the run completing (running → idle)
    mockUseChatStream.mockReturnValue({ ...idleStreamState, status: 'idle' });

    act(() => {
      rerender(<DesignDocReviewView />);
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ['design-doc', 'doc-1'] }),
      );
    });
  });

  it('does NOT invalidate when the agent was never running (idle → idle)', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    mockUseChatStream.mockReturnValue(idleStreamState);

    const { rerender } = render(<DesignDocReviewView />, { wrapper: createWrapper(queryClient) });

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /Ask Apex/i }));
    });

    // Second render — still idle
    act(() => {
      rerender(<DesignDocReviewView />);
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('invalidates each time a run completes, not just the first time', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    mockUseChatStream.mockReturnValue({ ...idleStreamState, status: 'running' });

    const { rerender } = render(<DesignDocReviewView />, { wrapper: createWrapper(queryClient) });
    act(() => { fireEvent.click(screen.getByRole('button', { name: /Ask Apex/i })); });

    // First run completes
    mockUseChatStream.mockReturnValue(idleStreamState);
    act(() => { rerender(<DesignDocReviewView />); });
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledTimes(1));

    // Second run starts and completes
    mockUseChatStream.mockReturnValue({ ...idleStreamState, status: 'running' });
    act(() => { rerender(<DesignDocReviewView />); });
    mockUseChatStream.mockReturnValue(idleStreamState);
    act(() => { rerender(<DesignDocReviewView />); });

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledTimes(2));
  });
});

// ── 4. Resize handle ─────────────────────────────────────────────────────────

describe('Horizontal resize handle', () => {
  it('renders a resize handle with role="separator"', () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /Ask Apex/i }));
    expect(screen.getByRole('separator', { name: /Resize panel/i })).toBeInTheDocument();
  });

  it('adjusts the panel width when dragged to the left (panel grows)', async () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /Ask Apex/i }));

    const handle = screen.getByRole('separator', { name: /Resize panel/i });
    const panel = handle.closest('[style]') as HTMLElement;

    const initialWidth = panel ? parseInt(panel.style.width, 10) : 380;

    // Start drag at x=600, then move to x=500 → delta = +100
    act(() => {
      fireEvent.mouseDown(handle, { clientX: 600 });
    });
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 500, bubbles: true }));
    });

    await waitFor(() => {
      const newWidth = panel ? parseInt(panel.style.width, 10) : 380;
      expect(newWidth).toBeGreaterThan(initialWidth);
    });
  });

  it('adjusts the panel width when dragged to the right (panel shrinks)', async () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /Ask Apex/i }));

    const handle = screen.getByRole('separator', { name: /Resize panel/i });
    const panel = handle.closest('[style]') as HTMLElement;

    const initialWidth = panel ? parseInt(panel.style.width, 10) : 380;

    act(() => {
      fireEvent.mouseDown(handle, { clientX: 400 });
    });
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 500, bubbles: true }));
    });

    await waitFor(() => {
      const newWidth = panel ? parseInt(panel.style.width, 10) : 380;
      expect(newWidth).toBeLessThan(initialWidth);
    });
  });

  it('respects the minimum panel width (280px)', async () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /Ask Apex/i }));

    const handle = screen.getByRole('separator', { name: /Resize panel/i });
    const panel = handle.closest('[style]') as HTMLElement;

    // Drag far to the right — should clamp at min
    act(() => {
      fireEvent.mouseDown(handle, { clientX: 400 });
    });
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 2000, bubbles: true }));
    });

    await waitFor(() => {
      const width = panel ? parseInt(panel.style.width, 10) : 380;
      expect(width).toBeGreaterThanOrEqual(280);
    });
  });

  it('stops resizing after mouseup', async () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /Ask Apex/i }));

    const handle = screen.getByRole('separator', { name: /Resize panel/i });
    const panel = handle.closest('[style]') as HTMLElement;

    act(() => {
      fireEvent.mouseDown(handle, { clientX: 600 });
    });
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 500, bubbles: true }));
    });

    const widthAfterDrag = panel ? parseInt(panel.style.width, 10) : 380;

    // Release
    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    // Move more — should not change after mouseup
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 300, bubbles: true }));
    });

    await new Promise((r) => setTimeout(r, 30));
    const widthAfterRelease = panel ? parseInt(panel.style.width, 10) : 380;
    expect(widthAfterRelease).toBe(widthAfterDrag);
  });
});

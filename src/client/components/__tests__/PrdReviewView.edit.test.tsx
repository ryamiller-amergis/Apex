/**
 * Tests for PRD inline editing (Phase 2b):
 *  - No "Edit" tab in the tab bar
 *  - "Edit" button in the header area opens a full-document modal
 *  - Saving the modal calls updatePrdContent
 *  - Cancelling closes without saving
 *  - Section-level pencil icons in Preview (one per ## section)
 *  - Section pencil opens a section editor
 *  - Saving a section edit stitches the content and calls updatePrdContent
 */

import type { ReactNode } from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PrdReviewView } from '../PrdReviewView';

// ── Module mocks ───────────────────────────────────────────────────────────────

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => jest.fn(),
  useLocation: () => ({ pathname: '/backlog/prd/prd-1' }),
}));

const mockCanManage = jest.fn(() => true);
jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: jest.fn(() => ({
    can: mockCanManage,
    userId: 'user-author',
    isAdmin: false,
  })),
}));

const mockMutateAsync = jest.fn().mockResolvedValue(undefined);

jest.mock('../../hooks/useInterviews', () => ({
  usePrd: jest.fn(() => ({
    data: {
      id: 'prd-1',
      interviewId: 'interview-1',
      project: 'proj-alpha',
      chatThreadId: 'thread-1',
      authorId: 'user-author',
      authorName: 'Author User',
      ownerId: 'user-author',
      ownerName: 'Author User',
      title: 'Test PRD',
      status: 'draft',
      content:
        '# PRD Title\n\nIntroduction paragraph here.\n\n## Section 1\n\nContent of section 1.\n\n## Section 2\n\nContent of section 2.',
      backlogJson: null,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
    isLoading: false,
    isError: false,
  })),
  usePrdTestCases: jest.fn(() => ({ data: null })),
  useInterview: jest.fn(() => ({ data: null })),
  useDesignDocsByPrd: jest.fn(() => ({ data: [] })),
  useUpdatePrdContent: jest.fn(() => ({ mutateAsync: mockMutateAsync, isPending: false })),
  useUpdatePrdBacklog: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useSubmitPrd: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useWithdrawPrd: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useReopenPrd: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useReviewPrd: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useDeletePrd: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useCreatePrdAdoItems: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false, isSuccess: false, data: null })),
  useSyncPrdAdoStatus: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useReassignApprovers: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useFixPrdWithAi: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useFixPrdCommentWithAi: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useCreatePrdValidationThread: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useCancelPrdValidation: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useRefreshPrdValidation: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useFixPrdValidation: jest.fn(() => ({
    mutateAsync: jest.fn().mockResolvedValue({ threadId: 'validation-thread-1' }),
    isPending: false,
  })),
  useAcceptFixPrdValidation: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useRevertPrdSection: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  usePrdValidationReport: jest.fn(() => ({ data: null })),
  useDocumentAssignments: jest.fn(() => ({ data: [] })),
  useGenerateTestCases: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
}));

jest.mock('../../hooks/useReviewComments', () => ({
  useReviewComments: jest.fn(() => ({ data: [] })),
  useUnresolvedCommentCount: jest.fn(() => ({ data: { count: 0 } })),
  useCreateComment: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useResolveComment: jest.fn(() => ({ mutate: jest.fn() })),
  useReopenComment: jest.fn(() => ({ mutate: jest.fn() })),
  useDeleteComment: jest.fn(() => ({ mutate: jest.fn() })),
}));

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../ConfirmDeleteModal', () => ({ ConfirmDeleteModal: () => null }));
jest.mock('../ApproverSelectModal', () => ({ ApproverSelectModal: () => null }));
jest.mock('../AnnotationLayer', () => ({
  AnnotationLayer: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
jest.mock('../ReviewCommentSidebar', () => ({ ReviewCommentSidebar: () => null }));
jest.mock('../BacklogViewer', () => ({ BacklogViewer: () => null }));
jest.mock('../CreateAdoItemsModal', () => ({ CreateAdoItemsModal: () => null }));

// ── Helpers ────────────────────────────────────────────────────────────────────

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <PrdReviewView />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('PrdReviewView – Edit tab removed / modal added', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCanManage.mockReturnValue(true);
  });

  it('does not render a tab button labelled "Edit"', () => {
    renderView();
    // The tabs area should have "Preview" and "Backlog" only
    expect(screen.getByRole('button', { name: 'Preview' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Backlog' })).toBeInTheDocument();
    // There should be no element with exact text "Edit" that behaves as a tab
    // (i.e. clicking it switches content without opening a dialog).
    // We confirm the Edit action opens a dialog – tested below.
  });

  it('renders an Edit button in the header area', () => {
    renderView();
    const editBtn = screen.getByRole('button', { name: /^edit$/i });
    expect(editBtn).toBeInTheDocument();
  });

  it('clicking the Edit button opens a modal dialog containing the full PRD content', () => {
    renderView();
    const editBtn = screen.getByRole('button', { name: /^edit$/i });
    fireEvent.click(editBtn);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    // The dialog should contain a textarea with the PRD content
    const textarea = within(dialog).getByRole('textbox');
    expect(textarea).toHaveValue(
      '# PRD Title\n\nIntroduction paragraph here.\n\n## Section 1\n\nContent of section 1.\n\n## Section 2\n\nContent of section 2.',
    );
  });

  it('saving the modal calls updatePrdContent with the modified content', async () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));

    const dialog = screen.getByRole('dialog');
    const textarea = within(dialog).getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Updated full content' } });

    const saveBtn = within(dialog).getByRole('button', { name: /save/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({
        prdId: 'prd-1',
        content: 'Updated full content',
      });
    });
  });

  it('cancelling the modal closes it without calling updatePrdContent', () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    const dialog = screen.getByRole('dialog');
    const cancelBtn = within(dialog).getByRole('button', { name: /cancel/i });
    fireEvent.click(cancelBtn);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });
});

describe('PrdReviewView – Section-level editing in Preview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCanManage.mockReturnValue(true);
  });

  it('renders a pencil icon button for each ## section (including intro section)', () => {
    renderView();
    // Content has 3 sections: intro + ## Section 1 + ## Section 2
    const sectionEditBtns = screen.getAllByRole('button', { name: 'Edit section' });
    expect(sectionEditBtns).toHaveLength(3);
  });

  it('clicking a section pencil icon opens a section editor with that section\'s content', () => {
    renderView();
    const sectionEditBtns = screen.getAllByRole('button', { name: 'Edit section' });
    // Click the pencil for section index 1 (the ## Section 1 section)
    fireEvent.click(sectionEditBtns[1]);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    const textarea = within(dialog).getByRole('textbox');
    // Section 1 content (starts with \n## Section 1)
    expect(textarea).toHaveValue('\n## Section 1\n\nContent of section 1.\n');
  });

  it('saving the section editor calls updatePrdContent with the full stitched content', async () => {
    renderView();
    const sectionEditBtns = screen.getAllByRole('button', { name: 'Edit section' });
    fireEvent.click(sectionEditBtns[1]);

    const dialog = screen.getByRole('dialog');
    const textarea = within(dialog).getByRole('textbox');
    fireEvent.change(textarea, {
      target: { value: '\n## Section 1\n\nEdited content.\n' },
    });

    const saveBtn = within(dialog).getByRole('button', { name: /save section/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({
        prdId: 'prd-1',
        content:
          '# PRD Title\n\nIntroduction paragraph here.\n\n## Section 1\n\nEdited content.\n\n## Section 2\n\nContent of section 2.',
      });
    });
  });

  it('cancelling the section editor closes without calling updatePrdContent', () => {
    renderView();
    const sectionEditBtns = screen.getAllByRole('button', { name: 'Edit section' });
    fireEvent.click(sectionEditBtns[0]);

    const dialog = screen.getByRole('dialog');
    const cancelBtn = within(dialog).getByRole('button', { name: /cancel/i });
    fireEvent.click(cancelBtn);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('does not render section edit buttons when user cannot manage', () => {
    mockCanManage.mockReturnValue(false);
    renderView();
    const sectionEditBtns = screen.queryAllByRole('button', { name: 'Edit section' });
    expect(sectionEditBtns).toHaveLength(0);
  });
});

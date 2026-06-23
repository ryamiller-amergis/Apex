/**
 * Unit tests for ReviewCommentSidebar.
 *
 * Coverage:
 *  1. Empty state — shown when there are no comments
 *  2. Comment rendering — quoted text, author, body, timestamp
 *  3. Reply display — replies shown under their parent comment
 *  4. Reply input — present for open comments, absent for resolved ones
 *  5. Reply submission — calls onReply on button click and on Enter key
 *  6. Resolve/Reopen buttons — gated by isDocumentAuthor and isAssignedApprover
 *  7. Delete button — visible to comment author, doc author, and assigned approver
 */

import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReviewCommentSidebar } from '../ReviewCommentSidebar';
import type { ReviewCommentWithReplies } from '../../../shared/types/reviewComments';

// ── Fixtures ───────────────────────────────────────────────────────────────────

function makeComment(overrides: Partial<ReviewCommentWithReplies> = {}): ReviewCommentWithReplies {
  return {
    id: 'comment-1',
    documentId: 'prd-1',
    documentType: 'prd',
    sectionKey: 'prd',
    authorUserId: 'author-1',
    authorDisplayName: 'Alice Author',
    body: 'This needs clarification.',
    selector: { exact: 'some selected text' } as any,
    status: 'open',
    resolvedBy: null,
    resolvedAt: null,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    replies: [],
    ...overrides,
  };
}

function makeReply(overrides: Partial<ReviewCommentWithReplies['replies'][number]> = {}) {
  return {
    id: 'reply-1',
    commentId: 'comment-1',
    authorUserId: 'approver-1',
    authorDisplayName: 'Bob Approver',
    body: 'Good point, will fix.',
    createdAt: new Date(Date.now() - 30_000).toISOString(),
    ...overrides,
  };
}

// ── Render helper ──────────────────────────────────────────────────────────────

interface RenderOpts {
  comments?: ReviewCommentWithReplies[];
  currentUserId?: string;
  documentAuthorUserId?: string;
  documentOwnerUserId?: string;
  isAssignedApprover?: boolean;
  onReply?: jest.Mock;
  onResolve?: jest.Mock;
  onReopen?: jest.Mock;
  onDelete?: jest.Mock;
}

function renderSidebar(opts: RenderOpts = {}) {
  const {
    comments = [],
    currentUserId = 'viewer-1',
    documentAuthorUserId = 'doc-author-1',
    documentOwnerUserId = undefined,
    isAssignedApprover = false,
    onReply = jest.fn(),
    onResolve = jest.fn(),
    onReopen = jest.fn(),
    onDelete = jest.fn(),
  } = opts;

  render(
    <ReviewCommentSidebar
      comments={comments}
      activeCommentId={null}
      currentUserId={currentUserId}
      documentAuthorUserId={documentAuthorUserId}
      documentOwnerUserId={documentOwnerUserId}
      isAssignedApprover={isAssignedApprover}
      onCommentClick={jest.fn()}
      onReply={onReply}
      onResolve={onResolve}
      onReopen={onReopen}
      onDelete={onDelete}
    />,
  );

  return { onReply, onResolve, onReopen, onDelete };
}

// ── 1. Empty state ─────────────────────────────────────────────────────────────

describe('empty state', () => {
  it('shows the empty-state message when there are no comments', () => {
    renderSidebar({ comments: [] });

    expect(screen.getByText(/No comments yet/i)).toBeInTheDocument();
  });

  it('shows "0 open" badge when there are no comments', () => {
    renderSidebar({ comments: [] });

    // Badge is not rendered when there are no comments
    expect(screen.queryByText(/open/i)).not.toBeInTheDocument();
  });

  it('shows the open count badge when comments exist', () => {
    const comments = [makeComment(), makeComment({ id: 'comment-2' })];
    renderSidebar({ comments });

    expect(screen.getByText('2 open')).toBeInTheDocument();
  });
});

// ── 2. Comment rendering ───────────────────────────────────────────────────────

describe('comment rendering', () => {
  it('renders the quoted (selected) text', () => {
    renderSidebar({ comments: [makeComment()] });

    expect(screen.getByText('some selected text')).toBeInTheDocument();
  });

  it('renders the comment author display name', () => {
    renderSidebar({ comments: [makeComment()] });

    expect(screen.getByText('Alice Author')).toBeInTheDocument();
  });

  it('renders the comment body', () => {
    renderSidebar({ comments: [makeComment()] });

    expect(screen.getByText('This needs clarification.')).toBeInTheDocument();
  });

  it('shows a relative timestamp', () => {
    renderSidebar({ comments: [makeComment()] });

    expect(screen.getByText('1m ago')).toBeInTheDocument();
  });

  it('shows the "Resolved" badge for resolved comments', () => {
    renderSidebar({ comments: [makeComment({ status: 'resolved' })] });

    expect(screen.getByText('Resolved')).toBeInTheDocument();
  });

  it('falls back to "Unknown" when authorDisplayName is missing', () => {
    renderSidebar({
      comments: [makeComment({ authorDisplayName: undefined })],
    });

    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });
});

// ── 3. Reply display ───────────────────────────────────────────────────────────

describe('reply display', () => {
  it('renders reply author and body', () => {
    const comment = makeComment({ replies: [makeReply()] });
    renderSidebar({ comments: [comment] });

    expect(screen.getByText('Bob Approver')).toBeInTheDocument();
    expect(screen.getByText('Good point, will fix.')).toBeInTheDocument();
  });

  it('renders multiple replies in order', () => {
    const comment = makeComment({
      replies: [
        makeReply({ id: 'r1', body: 'First reply' }),
        makeReply({ id: 'r2', body: 'Second reply' }),
      ],
    });
    renderSidebar({ comments: [comment] });

    expect(screen.getByText('First reply')).toBeInTheDocument();
    expect(screen.getByText('Second reply')).toBeInTheDocument();
  });
});

// ── 4. Reply input visibility ──────────────────────────────────────────────────

describe('reply input visibility', () => {
  it('shows the reply input for open comments', () => {
    renderSidebar({ comments: [makeComment({ status: 'open' })] });

    expect(screen.getByPlaceholderText('Reply…')).toBeInTheDocument();
  });

  it('hides the reply input for resolved comments', () => {
    renderSidebar({ comments: [makeComment({ status: 'resolved' })] });

    expect(screen.queryByPlaceholderText('Reply…')).not.toBeInTheDocument();
  });
});

// ── 5. Reply submission ────────────────────────────────────────────────────────

describe('reply submission', () => {
  it('calls onReply with commentId and text when send button is clicked', async () => {
    const onReply = jest.fn();
    renderSidebar({ comments: [makeComment()], onReply });

    const input = screen.getByPlaceholderText('Reply…');
    await userEvent.type(input, 'A new reply');
    fireEvent.click(screen.getByRole('button', { name: /send reply/i }));

    expect(onReply).toHaveBeenCalledWith('comment-1', 'A new reply');
  });

  it('calls onReply when Enter (without Shift) is pressed', async () => {
    const onReply = jest.fn();
    renderSidebar({ comments: [makeComment()], onReply });

    const input = screen.getByPlaceholderText('Reply…');
    await userEvent.type(input, 'Quick reply{Enter}');

    expect(onReply).toHaveBeenCalledWith('comment-1', 'Quick reply');
  });

  it('does not call onReply when Shift+Enter is pressed', async () => {
    const onReply = jest.fn();
    renderSidebar({ comments: [makeComment()], onReply });

    const input = screen.getByPlaceholderText('Reply…');
    await userEvent.type(input, 'line one{Shift>}{Enter}{/Shift}line two');

    expect(onReply).not.toHaveBeenCalled();
  });

  it('does not call onReply for whitespace-only input', async () => {
    const onReply = jest.fn();
    renderSidebar({ comments: [makeComment()], onReply });

    const input = screen.getByPlaceholderText('Reply…');
    await userEvent.type(input, '   {Enter}');

    expect(onReply).not.toHaveBeenCalled();
  });

  it('clears the input after a successful reply', async () => {
    renderSidebar({ comments: [makeComment()] });

    const input = screen.getByPlaceholderText('Reply…') as HTMLTextAreaElement;
    await userEvent.type(input, 'My reply{Enter}');

    expect(input.value).toBe('');
  });

  it('disables the send button when input is empty', () => {
    renderSidebar({ comments: [makeComment()] });

    expect(screen.getByRole('button', { name: /send reply/i })).toBeDisabled();
  });

  it('enables the send button when input has text', async () => {
    renderSidebar({ comments: [makeComment()] });

    await userEvent.type(screen.getByPlaceholderText('Reply…'), 'hello');

    expect(screen.getByRole('button', { name: /send reply/i })).not.toBeDisabled();
  });
});

// ── 6. Resolve / Reopen buttons ────────────────────────────────────────────────

describe('Resolve and Reopen buttons', () => {
  it('shows Resolve button for the document author', () => {
    renderSidebar({
      comments: [makeComment()],
      currentUserId: 'doc-author-1',
      documentAuthorUserId: 'doc-author-1',
    });

    expect(screen.getByRole('button', { name: /resolve/i })).toBeInTheDocument();
  });

  it('shows Resolve button for an assigned approver', () => {
    renderSidebar({
      comments: [makeComment()],
      currentUserId: 'approver-99',
      isAssignedApprover: true,
    });

    expect(screen.getByRole('button', { name: /resolve/i })).toBeInTheDocument();
  });

  it('hides Resolve button for a non-author, non-approver viewer', () => {
    renderSidebar({
      comments: [makeComment()],
      currentUserId: 'random-viewer',
      documentAuthorUserId: 'doc-author-1',
      isAssignedApprover: false,
    });

    expect(screen.queryByRole('button', { name: /^resolve$/i })).not.toBeInTheDocument();
  });

  it('calls onResolve with the comment id when Resolve is clicked', () => {
    const onResolve = jest.fn();
    renderSidebar({
      comments: [makeComment()],
      currentUserId: 'doc-author-1',
      documentAuthorUserId: 'doc-author-1',
      onResolve,
    });

    fireEvent.click(screen.getByRole('button', { name: /resolve/i }));

    expect(onResolve).toHaveBeenCalledWith('comment-1');
  });

  it('shows Reopen button (not Resolve) for a resolved comment', () => {
    renderSidebar({
      comments: [makeComment({ status: 'resolved' })],
      currentUserId: 'doc-author-1',
      documentAuthorUserId: 'doc-author-1',
    });

    expect(screen.getByRole('button', { name: /reopen/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^resolve$/i })).not.toBeInTheDocument();
  });

  it('calls onReopen with the comment id when Reopen is clicked', () => {
    const onReopen = jest.fn();
    renderSidebar({
      comments: [makeComment({ status: 'resolved' })],
      currentUserId: 'doc-author-1',
      documentAuthorUserId: 'doc-author-1',
      onReopen,
    });

    fireEvent.click(screen.getByRole('button', { name: /reopen/i }));

    expect(onReopen).toHaveBeenCalledWith('comment-1');
  });
});

// ── 7. Delete button ───────────────────────────────────────────────────────────


describe('Delete button', () => {
  it('shows Delete button to the comment author', () => {
    renderSidebar({
      comments: [makeComment({ authorUserId: 'comment-author' })],
      currentUserId: 'comment-author',
    });

    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
  });

  it('shows Delete button to the document author', () => {
    renderSidebar({
      comments: [makeComment({ authorUserId: 'someone-else' })],
      currentUserId: 'doc-author-1',
      documentAuthorUserId: 'doc-author-1',
    });

    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
  });

  it('shows Delete button to an assigned approver', () => {
    renderSidebar({
      comments: [makeComment({ authorUserId: 'someone-else' })],
      currentUserId: 'approver-99',
      isAssignedApprover: true,
    });

    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
  });

  it('hides Delete button for a plain viewer', () => {
    renderSidebar({
      comments: [makeComment({ authorUserId: 'someone-else' })],
      currentUserId: 'random-viewer',
      documentAuthorUserId: 'doc-author-1',
      isAssignedApprover: false,
    });

    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('calls onDelete with the comment id when Delete is clicked', () => {
    const onDelete = jest.fn();
    renderSidebar({
      comments: [makeComment({ authorUserId: 'comment-author' })],
      currentUserId: 'comment-author',
      onDelete,
    });

    fireEvent.click(screen.getByRole('button', { name: /delete/i }));

    expect(onDelete).toHaveBeenCalledWith('comment-1');
  });
});

// ── 8. Fix with Apex button ────────────────────────────────────────────────────

function renderWithFixAi(opts: {
  comments?: ReviewCommentWithReplies[];
  onFixWithAi?: jest.Mock;
  isFixingWithAi?: boolean;
}) {
  const {
    comments = [makeComment()],
    onFixWithAi,
    isFixingWithAi = false,
  } = opts;

  render(
    <ReviewCommentSidebar
      comments={comments}
      activeCommentId={null}
      currentUserId="viewer-1"
      documentAuthorUserId="doc-author-1"
      onCommentClick={jest.fn()}
      onReply={jest.fn()}
      onResolve={jest.fn()}
      onReopen={jest.fn()}
      onDelete={jest.fn()}
      onFixWithAi={onFixWithAi}
      isFixingWithAi={isFixingWithAi}
    />,
  );
}

describe('Fix with Apex button', () => {
  it('is shown when onFixWithAi is provided and there are open comments', () => {
    renderWithFixAi({ onFixWithAi: jest.fn() });

    expect(screen.getByRole('button', { name: /fix with apex/i })).toBeInTheDocument();
  });

  it('is hidden when onFixWithAi is not provided', () => {
    renderWithFixAi({ onFixWithAi: undefined });

    expect(screen.queryByRole('button', { name: /fix with apex/i })).not.toBeInTheDocument();
  });

  it('is hidden when all comments are resolved (zero open)', () => {
    renderWithFixAi({
      comments: [makeComment({ status: 'resolved' })],
      onFixWithAi: jest.fn(),
    });

    expect(screen.queryByRole('button', { name: /fix with apex/i })).not.toBeInTheDocument();
  });

  it('calls onFixWithAi when clicked', () => {
    const onFixWithAi = jest.fn();
    renderWithFixAi({ onFixWithAi });

    fireEvent.click(screen.getByRole('button', { name: /fix with apex/i }));

    expect(onFixWithAi).toHaveBeenCalledTimes(1);
  });

  it('is disabled and shows "Fixing…" when isFixingWithAi is true', () => {
    renderWithFixAi({ onFixWithAi: jest.fn(), isFixingWithAi: true });

    const btn = screen.getByText(/Fixing/);
    expect(btn.closest('button')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /fix with apex/i })).not.toBeInTheDocument();
  });
});

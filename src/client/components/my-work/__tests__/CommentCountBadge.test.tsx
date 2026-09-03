import { render, screen } from '@testing-library/react';
import { CommentCountBadge } from '../CommentCountBadge';

describe('CommentCountBadge', () => {
  it('renders count for positive integers with accessible label', () => {
    render(<CommentCountBadge count={5} workItemId={12345} />);

    const badge = screen.getByTestId('comment-count-badge-12345');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('5');
    expect(badge).toHaveAttribute('aria-label', '5 comments');
  });

  it('uses singular aria-label for count of 1', () => {
    render(<CommentCountBadge count={1} workItemId={1} />);

    expect(screen.getByTestId('comment-count-badge-1')).toHaveAttribute('aria-label', '1 comment');
  });

  it('renders nothing for zero, null, or undefined', () => {
    const { rerender } = render(<CommentCountBadge count={0} workItemId={2} />);
    expect(screen.queryByTestId('comment-count-badge-2')).not.toBeInTheDocument();

    rerender(<CommentCountBadge count={null} workItemId={2} />);
    expect(screen.queryByTestId('comment-count-badge-2')).not.toBeInTheDocument();

    rerender(<CommentCountBadge count={undefined} workItemId={2} />);
    expect(screen.queryByTestId('comment-count-badge-2')).not.toBeInTheDocument();
  });

  it('is non-interactive (no button role or click handler)', () => {
    render(<CommentCountBadge count={3} workItemId={99} />);

    const badge = screen.getByTestId('comment-count-badge-99');
    expect(badge.tagName).toBe('SPAN');
    expect(badge).not.toHaveAttribute('role', 'button');
  });

  it('shows large counts without truncation', () => {
    render(<CommentCountBadge count={99} workItemId={7} />);

    expect(screen.getByTestId('comment-count-badge-7')).toHaveTextContent('99');
  });
});

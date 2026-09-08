import { render, screen } from '@testing-library/react';
import { CommentCountBadge } from '../CommentCountBadge';

describe('CommentCountBadge', () => {
  it('renders count for positive integers (VT-05, VT-12, VT-13)', () => {
    render(<CommentCountBadge count={5} workItemId={42} />);
    const badge = screen.getByTestId('comment-count-badge-42');
    expect(badge).toHaveTextContent('5');
    expect(badge).toHaveAttribute('aria-label', '5 comments');
  });

  it('uses singular aria-label for count of 1 (VT-12)', () => {
    render(<CommentCountBadge count={1} />);
    expect(screen.getByTestId('comment-count-badge')).toHaveAttribute('aria-label', '1 comment');
  });

  it('renders nothing for zero, null, or undefined (VT-06)', () => {
    const { rerender } = render(<CommentCountBadge count={0} workItemId={1} />);
    expect(screen.queryByTestId('comment-count-badge-1')).not.toBeInTheDocument();

    rerender(<CommentCountBadge count={null} workItemId={1} />);
    expect(screen.queryByTestId('comment-count-badge-1')).not.toBeInTheDocument();

    rerender(<CommentCountBadge count={undefined} workItemId={1} />);
    expect(screen.queryByTestId('comment-count-badge-1')).not.toBeInTheDocument();
  });

  it('is non-interactive read-only markup (VT-14)', () => {
    render(<CommentCountBadge count={3} workItemId={7} />);
    const badge = screen.getByTestId('comment-count-badge-7');
    expect(badge.tagName).toBe('SPAN');
    expect(badge).not.toHaveAttribute('role', 'button');
  });
});

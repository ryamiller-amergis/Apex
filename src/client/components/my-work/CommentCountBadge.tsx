import React from 'react';
import styles from './CommentCountBadge.module.css';

export interface CommentCountBadgeProps {
  count?: number | null;
  workItemId?: number;
}

function formatCommentLabel(count: number): string {
  return count === 1 ? '1 comment' : `${count} comments`;
}

export const CommentCountBadge: React.FC<CommentCountBadgeProps> = ({ count, workItemId }) => {
  if (count == null || count <= 0 || !Number.isFinite(count)) {
    return null;
  }

  const displayCount = Math.trunc(count);
  const testId =
    workItemId != null ? `comment-count-badge-${workItemId}` : 'comment-count-badge';

  return (
    <span
      className={styles.badge}
      data-testid={testId}
      aria-label={formatCommentLabel(displayCount)}
    >
      {displayCount}
    </span>
  );
};

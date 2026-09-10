import React from 'react';
import styles from './CommentCountBadge.module.css';

export interface CommentCountBadgeProps {
  count?: number | null;
  workItemId?: number;
}

export const CommentCountBadge: React.FC<CommentCountBadgeProps> = ({ count, workItemId }) => {
  if (count == null || count <= 0) return null;

  const label = count === 1 ? '1 comment' : `${count} comments`;

  return (
    <span
      className={styles.badge}
      aria-label={label}
      {...{
        'data-testid':
          workItemId != null ? `comment-count-badge-${workItemId}` : 'comment-count-badge',
      }}
    >
      {count}
    </span>
  );
};

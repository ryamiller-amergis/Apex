import React, { useEffect } from 'react';
import { useWorkItemCommentCount } from '../../hooks/useDevWorkbench';
import { CommentCountBadge } from './CommentCountBadge';
import styles from '../DevWorkbenchView.module.css';

export interface MyWorkItemTitleProps {
  title: string;
  workItemId?: number | null;
  project: string;
}

export const MyWorkItemTitle: React.FC<MyWorkItemTitleProps> = ({
  title,
  workItemId,
  project,
}) => {
  const shouldFetch = workItemId != null && workItemId > 0;
  const { data, isError, error } = useWorkItemCommentCount(
    shouldFetch ? workItemId : null,
    project,
  );

  useEffect(() => {
    if (!isError) return;
    console.warn('[CommentCountBadge]', {
      workItemId,
      errorSummary: error?.message ?? 'fetch failed',
      feature: 'CommentCountBadge',
    });
  }, [isError, error, workItemId]);

  return (
    <div className={styles['title-cell']}>
      <span className={styles['item-title']}>{title}</span>
      // data-testid-exempt — CommentCountBadge sets data-testid when visible
      <CommentCountBadge
        count={shouldFetch ? data?.count : null}
        workItemId={shouldFetch ? workItemId ?? undefined : undefined}
      />
    </div>
  );
};

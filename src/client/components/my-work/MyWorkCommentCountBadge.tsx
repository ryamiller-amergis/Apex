import React, { useEffect, useRef } from 'react';
import { useWorkItemCommentCount } from '../../hooks/useDevWorkbench';
import { CommentCountBadge } from './CommentCountBadge';

export interface MyWorkCommentCountBadgeProps {
  workItemId: number;
  project: string;
  'data-testid'?: string;
}

export const MyWorkCommentCountBadge: React.FC<MyWorkCommentCountBadgeProps> = ({
  workItemId,
  project,
  'data-testid': testId,
}) => {
  const { data, error, isError } = useWorkItemCommentCount(workItemId, project);
  const loggedRef = useRef(false);

  useEffect(() => {
    if (!isError || loggedRef.current) return;
    loggedRef.current = true;
    console.warn('[CommentCountBadge] My Work row comment count fetch failed', {
      workItemId,
      errorSummary: error?.message ?? 'Unknown error',
      feature: 'CommentCountBadge',
    });
  }, [isError, error, workItemId]);

  return (
    <span
      {...(testId ? { 'data-testid': testId } : { 'data-testid': `my-work-comment-count-slot-${workItemId}` })}
    >
      {/* data-testid-exempt — CommentCountBadge renders comment-count-badge-{workItemId} on the visible pill */}
      <CommentCountBadge count={data?.count} workItemId={workItemId} />
    </span>
  );
};

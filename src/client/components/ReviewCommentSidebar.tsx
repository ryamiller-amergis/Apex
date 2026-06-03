import React, { useState, useRef, useCallback, useEffect } from 'react';
import type { ReviewCommentWithReplies } from '../../shared/types/reviewComments';
import styles from './ReviewCommentSidebar.module.css';

interface ReviewCommentSidebarProps {
  comments: ReviewCommentWithReplies[];
  activeCommentId: string | null;
  currentUserId: string;
  documentAuthorUserId: string;
  documentOwnerUserId?: string;
  isAssignedApprover?: boolean;
  onCommentClick: (commentId: string) => void;
  onReply: (commentId: string, body: string) => void;
  onResolve: (commentId: string) => void;
  onReopen: (commentId: string) => void;
  onDelete: (commentId: string) => void;
}

function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(isoString).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const ReviewCommentSidebar: React.FC<ReviewCommentSidebarProps> = ({
  comments,
  activeCommentId,
  currentUserId,
  documentAuthorUserId,
  documentOwnerUserId,
  isAssignedApprover: isApprover = false,
  onCommentClick,
  onReply,
  onResolve,
  onReopen,
  onDelete,
}) => {
  const sorted = [...comments].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  const openCount = comments.filter((c) => c.status === 'open').length;

  return (
    <div className={styles.sidebar}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>
          Comments
          {comments.length > 0 && (
            <span className={styles.commentCount}>
              {openCount} open
            </span>
          )}
        </span>
      </div>

      <div className={styles.threadList}>
        {sorted.length === 0 ? (
          <div className={styles.emptyState}>
            <svg className={styles.emptyStateIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            No comments yet. Select text in the document to add a comment.
          </div>
        ) : (
          sorted.map((comment) => (
            <ThreadCard
              key={comment.id}
              comment={comment}
              isActive={comment.id === activeCommentId}
              currentUserId={currentUserId}
              isDocumentAuthor={currentUserId === documentAuthorUserId || currentUserId === documentOwnerUserId}
              isAssignedApprover={isApprover}
              onCommentClick={onCommentClick}
              onReply={onReply}
              onResolve={onResolve}
              onReopen={onReopen}
              onDelete={onDelete}
            />
          ))
        )}
      </div>
    </div>
  );
};

interface ThreadCardProps {
  comment: ReviewCommentWithReplies;
  isActive: boolean;
  currentUserId: string;
  isDocumentAuthor: boolean;
  isAssignedApprover: boolean;
  onCommentClick: (commentId: string) => void;
  onReply: (commentId: string, body: string) => void;
  onResolve: (commentId: string) => void;
  onReopen: (commentId: string) => void;
  onDelete: (commentId: string) => void;
}

const ThreadCard: React.FC<ThreadCardProps> = ({
  comment,
  isActive,
  currentUserId,
  isDocumentAuthor,
  isAssignedApprover,
  onCommentClick,
  onReply,
  onResolve,
  onReopen,
  onDelete,
}) => {
  const [replyText, setReplyText] = useState('');
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isActive && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [isActive]);

  const handleReplySubmit = useCallback(() => {
    const trimmed = replyText.trim();
    if (!trimmed) return;
    onReply(comment.id, trimmed);
    setReplyText('');
  }, [replyText, onReply, comment.id]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleReplySubmit();
      }
    },
    [handleReplySubmit],
  );

  const isResolved = comment.status === 'resolved';
  const canResolveOrReopen = isDocumentAuthor || isAssignedApprover;
  const canDelete = currentUserId === comment.authorUserId || isDocumentAuthor || isAssignedApprover;

  const cardClassName = [
    styles.threadCard,
    isActive ? styles.threadCardActive : '',
    isResolved ? styles.threadCardResolved : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={cardRef}
      className={cardClassName}
      onClick={() => onCommentClick(comment.id)}
    >
      {/* Quoted text */}
      <blockquote className={`${styles.quote}${isResolved ? ` ${styles.quoteResolved}` : ''}`}>
        {comment.selector.exact}
      </blockquote>

      {isResolved && (
        <span className={styles.resolvedBadge}>
          <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3.5 8.5 6.5 11.5 12.5 5.5" />
          </svg>
          Resolved
        </span>
      )}

      {/* Comment author + body */}
      <div className={styles.commentMeta}>
        <span className={styles.authorName}>
          {comment.authorDisplayName ?? 'Unknown'}
        </span>
        <span className={styles.timestamp}>
          {formatRelativeTime(comment.createdAt)}
        </span>
      </div>
      <div className={styles.commentBody}>{comment.body}</div>

      {/* Action buttons */}
      <div className={styles.actions}>
        {canResolveOrReopen && !isResolved && (
          <button
            className={styles.actionButton}
            onClick={(e) => { e.stopPropagation(); onResolve(comment.id); }}
            type="button"
          >
            <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3.5 8.5 6.5 11.5 12.5 5.5" />
            </svg>
            Resolve
          </button>
        )}
        {canResolveOrReopen && isResolved && (
          <button
            className={styles.actionButton}
            onClick={(e) => { e.stopPropagation(); onReopen(comment.id); }}
            type="button"
          >
            Reopen
          </button>
        )}
        {canDelete && (
          <button
            className={styles.actionButtonDanger}
            onClick={(e) => { e.stopPropagation(); onDelete(comment.id); }}
            type="button"
          >
            <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 4h10M6 4V2.5h4V4M5 4l.5 9h5l.5-9" />
            </svg>
            Delete
          </button>
        )}
      </div>

      {/* Replies */}
      {(comment.replies.length > 0 || !isResolved) && (
        <div className={styles.repliesSection}>
          {comment.replies.map((reply) => (
            <div key={reply.id} className={styles.replyItem}>
              <div className={styles.replyMeta}>
                <span className={styles.replyAuthor}>
                  {reply.authorDisplayName ?? 'Unknown'}
                </span>
                <span className={styles.replyTimestamp}>
                  {formatRelativeTime(reply.createdAt)}
                </span>
              </div>
              <div className={styles.replyBody}>{reply.body}</div>
            </div>
          ))}

          {!isResolved && (
            <div className={styles.replyInputRow}>
              <textarea
                className={styles.replyInput}
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={handleKeyDown}
                onClick={(e) => e.stopPropagation()}
                placeholder="Reply…"
                rows={1}
              />
              <button
                className={styles.replySendButton}
                onClick={(e) => { e.stopPropagation(); handleReplySubmit(); }}
                disabled={!replyText.trim()}
                type="button"
                aria-label="Send reply"
              >
                <svg viewBox="0 0 16 16" fill="currentColor">
                  <path d="M1.5 1.3l13.2 6.5a.3.3 0 010 .4L1.5 14.7a.3.3 0 01-.4-.3V9l7-1-7-1V1.6a.3.3 0 01.4-.3z" />
                </svg>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

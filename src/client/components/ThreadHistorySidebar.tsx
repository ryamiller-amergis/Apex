import React, { useMemo, useState } from 'react';
import type { ChatThreadSummary } from '../../shared/types/chat';
import { useChatThreadList, useDeleteThread, useFlagThread } from '../hooks/useChatThreads';
import styles from './ThreadHistorySidebar.module.css';

interface ThreadHistorySidebarProps {
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  onDeleteThread?: (threadId: string) => void;
  onClose: () => void;
  className?: string;
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

const STATUS_DOT_CLASS: Record<string, string> = {
  idle: styles['dot--idle'],
  running: styles['dot--running'],
  error: styles['dot--error'],
  closed: styles['dot--closed'],
};

export const ThreadHistorySidebar: React.FC<ThreadHistorySidebarProps> = ({
  activeThreadId,
  onSelectThread,
  onDeleteThread,
  onClose,
  className,
}) => {
  const { data: threads = [], isLoading, error } = useChatThreadList(50);
  const deleteThread = useDeleteThread();
  const flagThread = useFlagThread();
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [showFlaggedOnly, setShowFlaggedOnly] = useState(false);

  const visibleThreads = useMemo(
    () => (showFlaggedOnly ? threads.filter((t) => t.flagged) : threads),
    [threads, showFlaggedOnly],
  );

  const flaggedCount = useMemo(() => threads.filter((t) => t.flagged).length, [threads]);

  const handleDelete = async (id: string) => {
    setPendingDeleteId(id);
    try {
      await deleteThread.mutateAsync(id);
      if (id === activeThreadId) {
        onDeleteThread?.(id);
      }
    } finally {
      setPendingDeleteId(null);
    }
  };

  const handleToggleFlag = (threadId: string, currentlyFlagged: boolean) => {
    flagThread.mutate({ threadId, flagged: !currentlyFlagged });
  };

  return (
    <div className={`${styles.sidebar}${className ? ` ${className}` : ''}`}>
      <div className={styles.header}>
        <span className={styles['header-title']}>History</span>
        <div className={styles['header-actions']}>
          <button
            className={`${styles['filter-btn']} ${showFlaggedOnly ? styles['filter-btn--active'] : ''}`}
            onClick={() => setShowFlaggedOnly((v) => !v)}
            aria-label={showFlaggedOnly ? 'Show all threads' : 'Show flagged threads only'}
            title={showFlaggedOnly ? 'Show all' : 'Show flagged only'}
            type="button"
          >
            <svg viewBox="0 0 16 16" fill={showFlaggedOnly ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 2v12M2 2h9l-2 3.5L11 9H2" />
            </svg>
            {flaggedCount > 0 && (
              <span className={styles['filter-badge']}>{flaggedCount}</span>
            )}
          </button>
          <button
            className={styles['close-btn']}
            onClick={onClose}
            aria-label="Close history"
          >
            ✕
          </button>
        </div>
      </div>

      <div className={styles.list}>
        {isLoading && (
          <div className={styles['empty-state']}>Loading…</div>
        )}
        {error && (
          <div className={styles['empty-state']}>Failed to load history.</div>
        )}
        {!isLoading && !error && visibleThreads.length === 0 && (
          <div className={styles['empty-state']}>
            {showFlaggedOnly ? 'No flagged conversations.' : 'No past conversations yet.'}
          </div>
        )}
        {visibleThreads.map((thread) => (
          <ThreadRow
            key={thread.id}
            thread={thread}
            isActive={thread.id === activeThreadId}
            isDeleting={pendingDeleteId === thread.id}
            onSelect={onSelectThread}
            onDelete={handleDelete}
            onToggleFlag={handleToggleFlag}
          />
        ))}
      </div>
    </div>
  );
};

interface ThreadRowProps {
  thread: ChatThreadSummary;
  isActive: boolean;
  isDeleting: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onToggleFlag: (id: string, currentlyFlagged: boolean) => void;
}

const ThreadRow: React.FC<ThreadRowProps> = ({
  thread,
  isActive,
  isDeleting,
  onSelect,
  onDelete,
  onToggleFlag,
}) => (
  <div className={`${styles.row} ${isActive ? styles['row--active'] : ''} ${isDeleting ? styles['row--deleting'] : ''}`}>
    <button
      className={styles['row-select']}
      onClick={() => onSelect(thread.id)}
      disabled={isDeleting}
      type="button"
      aria-label={`Open thread: ${thread.title}`}
    >
      <span className={`${styles.dot} ${STATUS_DOT_CLASS[thread.status] ?? ''}`} />
      <span className={styles['row-body']}>
        <span className={styles['row-title']}>
          {thread.flagged && <span className={styles['row-flag-indicator']}>⚑</span>}
          {thread.title}
        </span>
        <span className={styles['row-meta']}>
          {thread.kickoff.repo && (
            <span className={styles['row-repo']}>{thread.kickoff.repo}</span>
          )}
          <span className={styles['row-time']}>
            {formatRelativeTime(thread.lastActivityAt)}
          </span>
        </span>
      </span>
    </button>
    <div className={styles['row-actions']}>
      <button
        className={`${styles['row-flag']} ${thread.flagged ? styles['row-flag--active'] : ''}`}
        onClick={(e) => { e.stopPropagation(); onToggleFlag(thread.id, thread.flagged); }}
        disabled={isDeleting}
        type="button"
        aria-label={thread.flagged ? 'Remove flag' : 'Flag for follow-up'}
        title={thread.flagged ? 'Remove flag' : 'Flag for follow-up'}
      >
        <svg viewBox="0 0 16 16" fill={thread.flagged ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 2v12M2 2h9l-2 3.5L11 9H2" />
        </svg>
      </button>
      <button
        className={styles['row-delete']}
        onClick={(e) => { e.stopPropagation(); onDelete(thread.id); }}
        disabled={isDeleting}
        type="button"
        aria-label="Delete thread"
        title="Delete"
      >
        {isDeleting ? (
          <span className={styles['delete-spinner']} />
        ) : (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 4h10M6 4V2.5h4V4M5 4l.5 9h5l.5-9" />
          </svg>
        )}
      </button>
    </div>
  </div>
);

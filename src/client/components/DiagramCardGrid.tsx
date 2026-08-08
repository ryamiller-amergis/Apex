import React, { useEffect, useState } from 'react';
import type { DiagramSummary } from '../../shared/types/diagram';
import { DIAGRAM_LIST_LIMIT } from '../hooks/useDiagrams';
import { DiagramCard } from './DiagramCard';
import styles from './DiagramCardGrid.module.css';

export type DiagramListQueryResult = {
  data?: {
    items: DiagramSummary[];
    nextOffset?: number;
    hasMore: boolean;
  };
  isLoading: boolean;
  isError: boolean;
  isFetching?: boolean;
  refetch: () => void;
};

interface DiagramCardGridProps {
  query: DiagramListQueryResult;
  offset: number;
  onLoadMore: (nextOffset: number) => void;
  emptyMessage: string;
  canDelete: boolean;
  canShare?: boolean;
  onOpen: (id: string) => void;
  onDelete?: (diagram: DiagramSummary) => void;
  onShare?: (diagram: DiagramSummary) => void;
}

export const DiagramCardGrid: React.FC<DiagramCardGridProps> = ({
  query,
  offset,
  onLoadMore,
  emptyMessage,
  canDelete,
  canShare = false,
  onOpen,
  onDelete,
  onShare,
}) => {
  const [accumulated, setAccumulated] = useState<DiagramSummary[]>([]);

  useEffect(() => {
    if (query.isError) {
      if (offset === 0) {
        setAccumulated([]);
      }
      return;
    }
    if (!query.data) return;

    setAccumulated((prev) => {
      if (offset === 0) return query.data!.items;
      const existingIds = new Set(prev.map((d) => d.id));
      const appended = query.data!.items.filter((d) => !existingIds.has(d.id));
      return [...prev, ...appended];
    });
  }, [query.data, query.isError, offset]);

  if (query.isError) {
    return (
      <div className={styles.errorPanel} role="alert" {...{ 'data-testid': 'diagrams-error' }}>
        <p className={styles.errorText}>Could not load Diagrams. Please try again.</p>
        <button
          type="button"
          className={styles.retryBtn}
          onClick={() => query.refetch()}
          {...{ 'data-testid': 'diagrams-error-retry' }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (query.isLoading && offset === 0 && accumulated.length === 0) {
    return (
      <div className={styles.grid} aria-busy="true" aria-label="Loading diagrams">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className={styles.skeleton} />
        ))}
      </div>
    );
  }

  if (!query.isLoading && accumulated.length === 0) {
    return (
      <p className={styles.empty} {...{ 'data-testid': 'diagrams-empty' }}>
        {emptyMessage}
      </p>
    );
  }

  const hasMore = Boolean(query.data?.hasMore);
  const nextOffset = query.data?.nextOffset ?? offset + DIAGRAM_LIST_LIMIT;

  return (
    <div className={styles.wrap}>
      <div className={styles.grid}>
        {accumulated.map((diagram) => (
          <DiagramCard
            key={diagram.id}
            diagram={diagram}
            canDelete={canDelete}
            canShare={canShare}
            onOpen={onOpen}
            onDelete={onDelete}
            onShare={onShare}
            {...{ 'data-testid': `diagram-card-${diagram.id}` }}
          />
        ))}
        {query.isFetching && offset > 0 && (
          <>
            <div className={styles.skeleton} />
            <div className={styles.skeleton} />
          </>
        )}
      </div>
      {hasMore && (
        <button
          type="button"
          className={styles.loadMore}
          disabled={query.isFetching}
          onClick={() => onLoadMore(nextOffset)}
          {...{ 'data-testid': 'diagrams-load-more' }}
        >
          {query.isFetching ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
};

export default DiagramCardGrid;

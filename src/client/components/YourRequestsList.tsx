import React from 'react';
import type { RfpRequestSummary } from '../../shared/types/rfpIntake';
import { useMyRfpRequests } from '../hooks/useRfpIntake';
import styles from './RfpIntakeLanding.module.css';

interface YourRequestsListProps {
  onOpenRequest: (id: string) => void;
  onStartRequest: () => void;
}

function formatLabel(value: string): string {
  return value.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

export const YourRequestsList: React.FC<YourRequestsListProps> = ({
  onOpenRequest,
  onStartRequest,
}) => {
  const [page, setPage] = React.useState(0);
  const query = useMyRfpRequests(true, page);
  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / 50));

  return (
    <section className={styles.section} {...{ 'data-testid': 'rfp-your-requests-list' }}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Your requests</h2>
      </div>
      {query.isError && (
        <p className={`${styles.banner} ${styles.errorBanner}`} role="alert">
          Could not load your requests.{' '}
          <button type="button" className={styles.secondaryButton} onClick={() => void query.refetch()} {...{ 'data-testid': 'rfp-your-requests-retry' }}>
            Retry
          </button>
        </p>
      )}
      {query.isLoading && (
        <>
          <div className={styles.skeleton} />
          <div className={styles.skeleton} />
        </>
      )}
      {!query.isLoading && !query.isError && items.length === 0 && (
        <p className={styles.empty}>
          You haven&apos;t requested a product yet.{' '}
          <button type="button" className={styles.secondaryButton} onClick={onStartRequest} {...{ 'data-testid': 'rfp-your-requests-empty-cta' }}>
            Request a Product
          </button>
        </p>
      )}
      {items.length > 0 && (
        <div className={styles.list}>
          {items.map((item: RfpRequestSummary) => (
            <button
              key={item.id}
              type="button"
              className={styles.row}
              onClick={() => onOpenRequest(item.id)}
              {...{ 'data-testid': `rfp-request-row-${item.id}` }}
            >
              <span className={styles.rowTitle}>{item.title}</span>
              <span className={styles.rowMeta} aria-live="polite">
                <span>{formatLabel(item.status)}</span>
                {item.currentVerdict && <span>{formatLabel(item.currentVerdict)}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      {total > 50 && (
        <div className={styles.pager}>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={page === 0}
            onClick={() => setPage((current) => Math.max(0, current - 1))}
            {...{ 'data-testid': 'rfp-your-requests-prev' }}
          >
            Previous
          </button>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={page + 1 >= pageCount}
            onClick={() => setPage((current) => current + 1)}
            {...{ 'data-testid': 'rfp-your-requests-next' }}
          >
            Next
          </button>
        </div>
      )}
    </section>
  );
};

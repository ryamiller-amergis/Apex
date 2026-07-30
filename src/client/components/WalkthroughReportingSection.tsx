/**
 * FEAT-008 — Platform Admin Walkthrough acknowledgement + missing-anchor reporting.
 */
import React, { useMemo, useState } from 'react';
import type {
  WalkthroughAcknowledgementStatusFilter,
  WalkthroughDefinition,
} from '../../shared/types/walkthrough';
import {
  usePublishedWalkthroughCatalog,
  useWalkthroughAcknowledgementReport,
  useWalkthroughAnchorMisses,
} from '../hooks/useWalkthroughReporting';
import styles from './WalkthroughReportingSection.module.css';

type ReportView = 'acknowledgement' | 'anchor-misses';

function formatLocalTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function flattenCatalog(
  pages: Array<{ items: WalkthroughDefinition[] }> | undefined,
): WalkthroughDefinition[] {
  if (!pages) return [];
  return pages.flatMap((p) => p.items);
}

export const WalkthroughReportingSection: React.FC = () => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<WalkthroughAcknowledgementStatusFilter>('all');
  const [activeTab, setActiveTab] = useState<ReportView>('acknowledgement');

  const catalogQuery = usePublishedWalkthroughCatalog();
  const catalogItems = useMemo(
    () => flattenCatalog(catalogQuery.data?.pages),
    [catalogQuery.data?.pages],
  );

  const selected = catalogItems.find((item) => item.id === selectedId) ?? null;
  const effectiveId = selected?.id ?? (catalogItems[0]?.id ?? null);

  const acknowledgementQuery = useWalkthroughAcknowledgementReport(effectiveId, statusFilter);
  const missesQuery = useWalkthroughAnchorMisses(effectiveId);

  const statusMessage = (() => {
    if (catalogQuery.isLoading) return 'Loading published Walkthroughs';
    if (catalogQuery.isError) return 'Failed to load published Walkthroughs';
    if (!catalogItems.length) return 'No published Walkthroughs available';
    if (activeTab === 'acknowledgement') {
      if (acknowledgementQuery.isLoading) return 'Loading acknowledgement report';
      if (acknowledgementQuery.isError) return 'Acknowledgement report failed';
      if (acknowledgementQuery.isSuccess) {
        const r = acknowledgementQuery.data;
        return `Acknowledgement report ready: ${r.acknowledgedCount} of ${r.audienceCount}`;
      }
    }
    if (missesQuery.isLoading) return 'Loading missing-anchor events';
    if (missesQuery.isError) return 'Missing-anchor report failed';
    if (missesQuery.isSuccess) {
      const count = missesQuery.data.pages.reduce((n, p) => n + p.items.length, 0);
      return count === 0
        ? 'No missing anchors recorded for this Walkthrough'
        : `Loaded ${count} missing-anchor events`;
    }
    return '';
  })();

  const refresh = () => {
    void catalogQuery.refetch();
    void acknowledgementQuery.refetch();
    void missesQuery.refetch();
  };

  return (
    <section
      className={styles.section}
      {...{ 'data-testid': 'walkthrough-reporting-section' }}
    >
      <div className={styles.liveRegion} aria-live="polite">
        {statusMessage}
      </div>

      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>Walkthrough Reports</h2>
          <p className={styles.hint}>
            Live-audience acknowledgement and missing-anchor diagnostics for published Walkthroughs.
          </p>
        </div>
        <div className={styles.controls}>
          <label className={styles.field}>
            <span className={styles.label}>Published Walkthrough</span>
            <select
              className={styles.select}
              value={effectiveId ?? ''}
              disabled={catalogQuery.isLoading || catalogItems.length === 0}
              onChange={(e) => setSelectedId(e.target.value || null)}
              {...{ 'data-testid': 'walkthrough-report-selector' }}
            >
              {catalogQuery.isLoading && <option value="">Loading…</option>}
              {!catalogQuery.isLoading && catalogItems.length === 0 && (
                <option value="">No published Walkthroughs</option>
              )}
              {catalogItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.userTitle} · rev {item.revision} · {item.targeting.projects.join(', ')}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={styles.button}
            onClick={refresh}
            {...{ 'data-testid': 'walkthrough-report-refresh' }}
          >
            Refresh
          </button>
        </div>
      </div>

      {catalogQuery.isError && (
        <div className={styles.errorPanel} {...{ 'data-testid': 'walkthrough-report-error' }}>
          <p>{catalogQuery.error instanceof Error ? catalogQuery.error.message : 'Catalog failed'}</p>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => void catalogQuery.refetch()}
            {...{ 'data-testid': 'walkthrough-report-catalog-retry' }}
          >
            Retry
          </button>
        </div>
      )}

      {!catalogQuery.isLoading && !catalogQuery.isError && catalogItems.length === 0 && (
        <div className={styles.emptyPanel} {...{ 'data-testid': 'walkthrough-report-empty' }}>
          No published Walkthroughs available
        </div>
      )}

      {effectiveId && (
        <>
          <div className={styles.tabBar} role="tablist" aria-label="Walkthrough report views">
            <button
              type="button"
              role="tab"
              id="walkthrough-report-tab-ack"
              aria-selected={activeTab === 'acknowledgement'}
              className={styles.tab}
              onClick={() => setActiveTab('acknowledgement')}
              {...{ 'data-testid': 'walkthrough-report-tab-acknowledgement' }}
            >
              Acknowledgement
            </button>
            <button
              type="button"
              role="tab"
              id="walkthrough-report-tab-misses"
              aria-selected={activeTab === 'anchor-misses'}
              className={styles.tab}
              onClick={() => setActiveTab('anchor-misses')}
              {...{ 'data-testid': 'walkthrough-report-tab-anchor-misses' }}
            >
              Missing Anchors
            </button>
          </div>

          {activeTab === 'acknowledgement' && (
            <div
              role="tabpanel"
              aria-labelledby="walkthrough-report-tab-ack"
              {...{ 'data-testid': 'walkthrough-report-acknowledgement-panel' }}
            >
              <div className={styles.controls}>
                <label className={styles.field}>
                  <span className={styles.label}>Status filter</span>
                  <select
                    className={styles.select}
                    value={statusFilter}
                    onChange={(e) =>
                      setStatusFilter(e.target.value as WalkthroughAcknowledgementStatusFilter)
                    }
                    {...{ 'data-testid': 'acknowledgement-status-filter' }}
                  >
                    <option value="all">All acknowledged</option>
                    <option value="completed">Completed</option>
                    <option value="dismissed">Dismissed</option>
                  </select>
                </label>
              </div>

              {acknowledgementQuery.isLoading && (
                <div className={styles.loadingPanel} aria-busy="true">
                  <div className={styles.skeleton} />
                </div>
              )}

              {acknowledgementQuery.isError && (
                <div className={styles.errorPanel} {...{ 'data-testid': 'walkthrough-report-error' }}>
                  <p>
                    {acknowledgementQuery.error instanceof Error
                      ? acknowledgementQuery.error.message
                      : 'Report calculation failed'}
                  </p>
                  <button
                    type="button"
                    className={styles.primaryButton}
                    onClick={() => void acknowledgementQuery.refetch()}
                    {...{ 'data-testid': 'walkthrough-report-ack-retry' }}
                  >
                    Retry
                  </button>
                </div>
              )}

              {acknowledgementQuery.isSuccess && (
                <>
                  <div
                    className={styles.summary}
                    {...{ 'data-testid': 'acknowledgement-summary' }}
                  >
                    <div className={styles.summaryStat}>
                      <span className={styles.summaryValue}>
                        {acknowledgementQuery.data.acknowledgedCount} of{' '}
                        {acknowledgementQuery.data.audienceCount}
                      </span>
                      <span className={styles.summaryLabel}>Acknowledged (live audience)</span>
                    </div>
                    <div className={styles.summaryStat}>
                      <span className={styles.summaryValue}>
                        {acknowledgementQuery.data.completedCount}
                      </span>
                      <span className={styles.summaryLabel}>Completed</span>
                    </div>
                    <div className={styles.summaryStat}>
                      <span className={styles.summaryValue}>
                        {acknowledgementQuery.data.dismissedCount}
                      </span>
                      <span className={styles.summaryLabel}>Dismissed</span>
                    </div>
                    <div className={styles.summaryStat}>
                      <span className={styles.summaryLabel}>Generated</span>
                      <time dateTime={acknowledgementQuery.data.generatedAt}>
                        {formatLocalTime(acknowledgementQuery.data.generatedAt)}
                      </time>
                    </div>
                  </div>

                  <div
                    className={styles.tableWrap}
                    {...{ 'data-testid': 'acknowledgement-detail-table' }}
                  >
                    <table className={styles.table}>
                      <caption>Current-audience acknowledgement detail</caption>
                      <thead>
                        <tr>
                          <th scope="col">User</th>
                          <th scope="col">Email</th>
                          <th scope="col">Status</th>
                          <th scope="col">Acknowledged</th>
                        </tr>
                      </thead>
                      <tbody>
                        {acknowledgementQuery.data.details.length === 0 ? (
                          <tr>
                            <td colSpan={4}>
                              No current audience members have acknowledged this revision
                            </td>
                          </tr>
                        ) : (
                          acknowledgementQuery.data.details.map((row) => (
                            <tr key={`${row.userId}-${row.status}`}>
                              <td>{row.displayName || row.userId}</td>
                              <td>{row.email || '—'}</td>
                              <td>
                                <span
                                  className={
                                    row.status === 'completed'
                                      ? styles.statusCompleted
                                      : styles.statusDismissed
                                  }
                                >
                                  {row.status === 'completed' ? '●' : '○'}
                                </span>
                                <span className={styles.statusText}>{row.status}</span>
                              </td>
                              <td>
                                <time dateTime={row.acknowledgedAt}>
                                  {formatLocalTime(row.acknowledgedAt)}
                                </time>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}

          {activeTab === 'anchor-misses' && (
            <div
              role="tabpanel"
              aria-labelledby="walkthrough-report-tab-misses"
              {...{ 'data-testid': 'walkthrough-report-anchor-misses-panel' }}
            >
              {missesQuery.isLoading && (
                <div className={styles.loadingPanel} aria-busy="true">
                  <div className={styles.skeleton} />
                </div>
              )}

              {missesQuery.isError && (
                <div className={styles.errorPanel} {...{ 'data-testid': 'walkthrough-report-error' }}>
                  <p>
                    {missesQuery.error instanceof Error
                      ? missesQuery.error.message
                      : 'Missing-anchor report failed'}
                  </p>
                  <button
                    type="button"
                    className={styles.primaryButton}
                    onClick={() => void missesQuery.refetch()}
                    {...{ 'data-testid': 'walkthrough-report-misses-retry' }}
                  >
                    Retry
                  </button>
                </div>
              )}

              {missesQuery.isSuccess && (
                <div className={styles.tableWrap} {...{ 'data-testid': 'anchor-miss-table' }}>
                  <table className={styles.table}>
                    <caption>Missing-anchor events (newest first)</caption>
                    <thead>
                      <tr>
                        <th scope="col">Step</th>
                        <th scope="col">Order</th>
                        <th scope="col">Revision</th>
                        <th scope="col">Anchor</th>
                        <th scope="col">Route</th>
                        <th scope="col">Occurred</th>
                      </tr>
                    </thead>
                    <tbody>
                      {missesQuery.data.pages.every((p) => p.items.length === 0) ? (
                        <tr>
                          <td colSpan={6}>No missing anchors recorded for this Walkthrough</td>
                        </tr>
                      ) : (
                        missesQuery.data.pages.flatMap((page) =>
                          page.items.map((item) => (
                            <tr key={item.id}>
                              <td>{item.stepHeading}</td>
                              <td>{item.stepOrder + 1}</td>
                              <td>{item.revision}</td>
                              <td>{item.anchorKey}</td>
                              <td>{item.targetRoute}</td>
                              <td>
                                <time dateTime={item.occurredAt}>
                                  {formatLocalTime(item.occurredAt)}
                                </time>
                              </td>
                            </tr>
                          )),
                        )
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {missesQuery.hasNextPage && (
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => void missesQuery.fetchNextPage()}
                  {...{ 'data-testid': 'anchor-miss-load-more' }}
                >
                  Load more
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
};

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
import { DataGridFilterPills, DataGridToolbar } from './DataGridToolbar';
import gridStyles from './DataGrid.module.css';
import styles from './WalkthroughReportingSection.module.css';

type ReportView = 'acknowledgement' | 'anchor-misses';

const STATUS_FILTERS: readonly {
  label: string;
  value: WalkthroughAcknowledgementStatusFilter;
}[] = [
  { label: 'All', value: 'all' },
  { label: 'Completed', value: 'completed' },
  { label: 'Dismissed', value: 'dismissed' },
];

const MAX_VISIBLE_PROJECT_CHIPS = 6;

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

function percentOf(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}

function formatPercent(part: number, whole: number): string {
  return `${percentOf(part, whole)}%`;
}

function catalogOptionLabel(item: WalkthroughDefinition): string {
  const projectCount = item.targeting.projects.length;
  const projectSuffix =
    projectCount === 0
      ? ''
      : projectCount === 1
        ? ` · ${item.targeting.projects[0]}`
        : ` · ${projectCount} projects`;
  return `${item.userTitle} · rev ${item.revision}${projectSuffix}`;
}

export const WalkthroughReportingSection: React.FC = () => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<WalkthroughAcknowledgementStatusFilter>('all');
  const [activeTab, setActiveTab] = useState<ReportView>('acknowledgement');
  const [detailSearch, setDetailSearch] = useState('');
  const [showAllProjects, setShowAllProjects] = useState(false);

  const catalogQuery = usePublishedWalkthroughCatalog();
  const catalogItems = useMemo(
    () => flattenCatalog(catalogQuery.data?.pages),
    [catalogQuery.data?.pages],
  );

  const selected = catalogItems.find((item) => item.id === selectedId) ?? null;
  const effectiveId = selected?.id ?? (catalogItems[0]?.id ?? null);
  const effectiveWalkthrough =
    catalogItems.find((item) => item.id === effectiveId) ?? null;

  const acknowledgementQuery = useWalkthroughAcknowledgementReport(effectiveId, statusFilter);
  const missesQuery = useWalkthroughAnchorMisses(effectiveId);

  const filteredDetails = useMemo(() => {
    const details = acknowledgementQuery.data?.details ?? [];
    const q = detailSearch.trim().toLowerCase();
    if (!q) return details;
    return details.filter((row) => {
      const haystack = [row.displayName, row.email, row.userId, row.status]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [acknowledgementQuery.data?.details, detailSearch]);

  const targetedProjects = effectiveWalkthrough?.targeting.projects ?? [];
  const visibleProjects = showAllProjects
    ? targetedProjects
    : targetedProjects.slice(0, MAX_VISIBLE_PROJECT_CHIPS);
  const hiddenProjectCount = Math.max(0, targetedProjects.length - visibleProjects.length);

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
      className={`${gridStyles.section} ${styles.section}`}
      {...{ 'data-testid': 'walkthrough-reporting-section' }}
    >
      <div className={styles.liveRegion} aria-live="polite">
        {statusMessage}
      </div>

      <div className={gridStyles.header}>
        <div>
          <h2 className={gridStyles.title}>Walkthrough Reports</h2>
          <p className={gridStyles.hint}>
            Live-audience acknowledgement and missing-anchor diagnostics for published Walkthroughs.
          </p>
        </div>
        <div className={gridStyles.headerActions}>
          <button
            type="button"
            className={gridStyles.button}
            onClick={refresh}
            {...{ 'data-testid': 'walkthrough-report-refresh' }}
          >
            Refresh
          </button>
        </div>
      </div>

      <div className={styles.pickerCard} {...{ 'data-testid': 'walkthrough-report-picker' }}>
        <label className={styles.pickerField}>
          <span className={styles.label}>Published Walkthrough</span>
          <select
            className={styles.select}
            value={effectiveId ?? ''}
            disabled={catalogQuery.isLoading || catalogItems.length === 0}
            onChange={(e) => {
              setSelectedId(e.target.value || null);
              setShowAllProjects(false);
            }}
            {...{ 'data-testid': 'walkthrough-report-selector' }}
          >
            {catalogQuery.isLoading && <option value="">Loading…</option>}
            {!catalogQuery.isLoading && catalogItems.length === 0 && (
              <option value="">No published Walkthroughs</option>
            )}
            {catalogItems.map((item) => (
              <option key={item.id} value={item.id}>
                {catalogOptionLabel(item)}
              </option>
            ))}
          </select>
        </label>

        {effectiveWalkthrough && (
          <div
            className={styles.selectedMeta}
            {...{ 'data-testid': 'walkthrough-report-selected-meta' }}
          >
            <div className={styles.selectedTitleRow}>
              <span className={styles.selectedTitle}>{effectiveWalkthrough.userTitle}</span>
              <span className={styles.selectedRevision}>
                Revision {effectiveWalkthrough.revision}
              </span>
            </div>
            <p className={styles.selectedTargeting}>
              {targetedProjects.length === 0
                ? 'No project targeting'
                : targetedProjects.length === 1
                  ? 'Targeted to 1 project'
                  : `Targeted to ${targetedProjects.length} projects`}
            </p>
            {targetedProjects.length > 0 && (
              <div className={styles.projectChips} aria-label="Targeted projects">
                {visibleProjects.map((project) => (
                  <span key={project} className={styles.projectChip} title={project}>
                    {project}
                  </span>
                ))}
                {hiddenProjectCount > 0 && !showAllProjects && (
                  <button
                    type="button"
                    className={styles.projectChipMore}
                    onClick={() => setShowAllProjects(true)}
                    {...{ 'data-testid': 'walkthrough-report-show-all-projects' }}
                  >
                    +{hiddenProjectCount} more
                  </button>
                )}
                {showAllProjects && targetedProjects.length > MAX_VISIBLE_PROJECT_CHIPS && (
                  <button
                    type="button"
                    className={styles.projectChipMore}
                    onClick={() => setShowAllProjects(false)}
                    {...{ 'data-testid': 'walkthrough-report-collapse-projects' }}
                  >
                    Show less
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {catalogQuery.isError && (
        <div className={gridStyles.error} {...{ 'data-testid': 'walkthrough-report-error' }}>
          <p>{catalogQuery.error instanceof Error ? catalogQuery.error.message : 'Catalog failed'}</p>
          <button
            type="button"
            className={gridStyles.buttonPrimary}
            onClick={() => void catalogQuery.refetch()}
            {...{ 'data-testid': 'walkthrough-report-catalog-retry' }}
          >
            Retry
          </button>
        </div>
      )}

      {!catalogQuery.isLoading && !catalogQuery.isError && catalogItems.length === 0 && (
        <div className={gridStyles.empty} {...{ 'data-testid': 'walkthrough-report-empty' }}>
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
              className={styles.panelBody}
              role="tabpanel"
              aria-labelledby="walkthrough-report-tab-ack"
              {...{ 'data-testid': 'walkthrough-report-acknowledgement-panel' }}
            >
              {acknowledgementQuery.isLoading && (
                <div className={gridStyles.loading} aria-busy="true">
                  <div className={styles.skeleton} />
                </div>
              )}

              {acknowledgementQuery.isError && (
                <div className={gridStyles.error} {...{ 'data-testid': 'walkthrough-report-error' }}>
                  <p>
                    {acknowledgementQuery.error instanceof Error
                      ? acknowledgementQuery.error.message
                      : 'Report calculation failed'}
                  </p>
                  <button
                    type="button"
                    className={gridStyles.buttonPrimary}
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
                        <span
                          className={styles.summaryPercent}
                          {...{ 'data-testid': 'acknowledgement-percent' }}
                        >
                          {formatPercent(
                            acknowledgementQuery.data.acknowledgedCount,
                            acknowledgementQuery.data.audienceCount,
                          )}
                        </span>
                      </span>
                      <span className={styles.summaryLabel}>Acknowledged (live audience)</span>
                    </div>
                    <div className={styles.summaryStat}>
                      <span className={styles.summaryValue}>
                        {acknowledgementQuery.data.completedCount}
                        <span
                          className={styles.summaryPercent}
                          {...{ 'data-testid': 'completed-percent' }}
                        >
                          {formatPercent(
                            acknowledgementQuery.data.completedCount,
                            acknowledgementQuery.data.audienceCount,
                          )}
                        </span>
                      </span>
                      <span className={styles.summaryLabel}>Completed</span>
                    </div>
                    <div className={styles.summaryStat}>
                      <span className={styles.summaryValue}>
                        {acknowledgementQuery.data.dismissedCount}
                        <span
                          className={styles.summaryPercent}
                          {...{ 'data-testid': 'dismissed-percent' }}
                        >
                          {formatPercent(
                            acknowledgementQuery.data.dismissedCount,
                            acknowledgementQuery.data.audienceCount,
                          )}
                        </span>
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

                  <div className={styles.detailSection}>
                    <h3 className={styles.detailTitle}>Current-audience acknowledgement detail</h3>
                    <DataGridToolbar
                      searchValue={detailSearch}
                      onSearchChange={setDetailSearch}
                      searchPlaceholder="Search users…"
                      searchTestId="acknowledgement-detail-search"
                    >
                      <DataGridFilterPills
                        options={STATUS_FILTERS}
                        value={statusFilter}
                        onChange={setStatusFilter}
                        testIdPrefix="acknowledgement-status"
                        aria-label="Status filter"
                        {...{ 'data-testid': 'acknowledgement-status-filter' }}
                      />
                    </DataGridToolbar>

                    <div
                      className={gridStyles.tableWrap}
                      {...{ 'data-testid': 'acknowledgement-detail-table' }}
                    >
                      <table className={gridStyles.table}>
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
                          ) : filteredDetails.length === 0 ? (
                            <tr>
                              <td colSpan={4}>No matches for this search</td>
                            </tr>
                          ) : (
                            filteredDetails.map((row) => (
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
                  </div>
                </>
              )}
            </div>
          )}

          {activeTab === 'anchor-misses' && (
            <div
              className={styles.panelBody}
              role="tabpanel"
              aria-labelledby="walkthrough-report-tab-misses"
              {...{ 'data-testid': 'walkthrough-report-anchor-misses-panel' }}
            >
              {missesQuery.isLoading && (
                <div className={gridStyles.loading} aria-busy="true">
                  <div className={styles.skeleton} />
                </div>
              )}

              {missesQuery.isError && (
                <div className={gridStyles.error} {...{ 'data-testid': 'walkthrough-report-error' }}>
                  <p>
                    {missesQuery.error instanceof Error
                      ? missesQuery.error.message
                      : 'Missing-anchor report failed'}
                  </p>
                  <button
                    type="button"
                    className={gridStyles.buttonPrimary}
                    onClick={() => void missesQuery.refetch()}
                    {...{ 'data-testid': 'walkthrough-report-misses-retry' }}
                  >
                    Retry
                  </button>
                </div>
              )}

              {missesQuery.isSuccess && (
                <div className={styles.detailSection}>
                  <h3 className={styles.detailTitle}>Missing-anchor events (newest first)</h3>
                  <div className={gridStyles.tableWrap} {...{ 'data-testid': 'anchor-miss-table' }}>
                    <table className={gridStyles.table}>
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
                </div>
              )}

              {missesQuery.hasNextPage && (
                <button
                  type="button"
                  className={gridStyles.button}
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

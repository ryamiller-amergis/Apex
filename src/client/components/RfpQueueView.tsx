import React, { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { RFP_HUMAN_STATUSES, RFP_VERDICTS } from '../../shared/types/rfpIntake';
import type { RfpHumanStatus, RfpVerdict } from '../../shared/types/rfpIntake';
import { useAppShell } from '../hooks/useAppShell';
import { useFeatureFlag } from '../hooks/useFeatureFlags';
import { useRfpQueue } from '../hooks/useRfpTriage';
import { DataGridFilterSelect, DataGridToolbar } from './DataGridToolbar';
import gridStyles from './DataGrid.module.css';
import { RfpTriageDetailPanel } from './RfpTriageDetailPanel';
import { formatLabel } from './RfpStatusControl';
import styles from './RfpQueueView.module.css';

function requestIdFromPath(pathname: string): string | undefined {
  const match = pathname.match(/^\/rfp-intake\/([^/]+)$/);
  return match?.[1];
}

const RfpQueueViewEnabled: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { can } = useAppShell();
  const [status, setStatus] = useState<RfpHumanStatus | ''>('');
  const [verdict, setVerdict] = useState<RfpVerdict | ''>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const requestId = requestIdFromPath(location.pathname);
  const queue = useRfpQueue({ status, verdict, q, page, enabled: true });
  const canManage = can('rfp-intake:manage');
  const total = queue.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / 50));

  const statusOptions = useMemo(
    () => RFP_HUMAN_STATUSES.map((value) => ({ value, label: formatLabel(value) })),
    [],
  );
  const verdictOptions = useMemo(
    () => RFP_VERDICTS.map((value) => ({ value, label: formatLabel(value) })),
    [],
  );

  return (
    <div className={styles.page} {...{ 'data-testid': 'rfp-queue-view' }}>
      <div className={styles.content}>
        <div className={gridStyles.section}>
          <div className={gridStyles.header}>
            <h1 className={gridStyles.title}>RFP Intake</h1>
            <p className={gridStyles.hint}>Search and review Requests for Product in the Apex project.</p>
          </div>
          <DataGridToolbar
            searchValue={q}
            onSearchChange={(value) => { setQ(value); setPage(0); }}
            searchPlaceholder="Search title or stakeholder"
            searchTestId="rfp-queue-search"
          >
            <DataGridFilterSelect
              label="Status"
              value={status}
              onChange={(value) => { setStatus(value as RfpHumanStatus | ''); setPage(0); }}
              options={statusOptions}
              includeEmptyOption
              emptyOptionLabel="All statuses"
              {...{ 'data-testid': 'rfp-queue-filter-status' }}
            />
            <DataGridFilterSelect
              label="Verdict"
              value={verdict}
              onChange={(value) => { setVerdict(value as RfpVerdict | ''); setPage(0); }}
              options={verdictOptions}
              includeEmptyOption
              emptyOptionLabel="All verdicts"
              {...{ 'data-testid': 'rfp-queue-filter-verdict' }}
            />
          </DataGridToolbar>

          {queue.isLoading && <p className={gridStyles.loading}>Loading requests…</p>}
          {queue.isError && (
            <p className={gridStyles.error} role="alert">
              Could not load the queue.{' '}
              <button type="button" className={styles.secondaryButton} onClick={() => void queue.refetch()} {...{ 'data-testid': 'rfp-queue-retry' }}>
                Retry
              </button>
            </p>
          )}
          {queue.data && queue.data.items.length === 0 && (
            <p className={gridStyles.empty}>No requests match these filters</p>
          )}

          {queue.data && queue.data.items.length > 0 && (
            <div className={gridStyles.tableWrap}>
              <table className={gridStyles.table}>
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Status</th>
                    <th>Verdict</th>
                    <th>Updated</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {queue.data.items.map((item) => (
                    <tr key={item.id} {...{ 'data-testid': `rfp-queue-row-${item.id}` }}>
                      <td>
                        <div>{item.title}</div>
                        <div className={styles.subtitle}>{item.stakeholder}</div>
                      </td>
                      <td>
                        <span className={styles.badge} aria-label={`Status ${formatLabel(item.status)}`}>{formatLabel(item.status)}</span>
                      </td>
                      <td>
                        <span className={styles.badge} aria-label={`Verdict ${item.currentVerdict ? formatLabel(item.currentVerdict) : 'None'}`}>
                          {item.currentVerdict ? formatLabel(item.currentVerdict) : '—'}
                        </span>
                      </td>
                      <td>{new Date(item.updatedAt).toLocaleString()}</td>
                      <td>
                        <div className={gridStyles.rowActions}>
                          <button
                            type="button"
                            className={gridStyles.buttonGhost}
                            onClick={() => navigate(`/rfp-intake/${item.id}`)}
                            {...{ 'data-testid': `rfp-queue-open-${item.id}` }}
                          >
                            Open
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className={styles.pagination} {...{ 'data-testid': 'rfp-queue-pagination' }}>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={page === 0}
              onClick={() => setPage((current) => Math.max(0, current - 1))}
              {...{ 'data-testid': 'rfp-queue-prev' }}
            >
              Previous
            </button>
            <span className={styles.subtitle}>Page {page + 1} of {pageCount}</span>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={page + 1 >= pageCount}
              onClick={() => setPage((current) => current + 1)}
              {...{ 'data-testid': 'rfp-queue-next' }}
            >
              Next
            </button>
          </div>
        </div>
      </div>

      {requestId && (
        // data-testid-exempt — root dialog already has rfp-triage-detail
        <RfpTriageDetailPanel
          requestId={requestId}
          canManage={canManage}
          onClose={() => navigate('/rfp-intake')}
        />
      )}
    </div>
  );
};

export const RfpQueueView: React.FC = () => {
  const { selectedProject, can } = useAppShell();
  const flagEnabled = useFeatureFlag('rfp-intake', 'Apex');
  const isApex = selectedProject.toLowerCase() === 'apex';
  const canView = can('rfp-intake:view') || can('rfp-intake:manage');

  // @feature-flag:rfp-intake start winner=enabled
  return flagEnabled && isApex && canView ? (
    // @feature-flag:rfp-intake enabled-start
    <RfpQueueViewEnabled />
    // @feature-flag:rfp-intake enabled-end
  ) : (
    // @feature-flag:rfp-intake disabled-start
    null
    // @feature-flag:rfp-intake disabled-end
  );
  // @feature-flag:rfp-intake end
};

export default RfpQueueView;

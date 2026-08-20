import React, { useMemo, useRef, useState } from 'react';
import type { ApiKeyMetadata, ApiKeyStatus } from '../../shared/types/apiKey';
import { useApiKeys } from '../hooks/useApiKeys';
import { useAppShell } from '../hooks/useAppShell';
import { ApiKeyManageDrawer } from './ApiKeyManageDrawer';
import {
  API_KEY_CADENCE_LABELS,
  formatApiKeyDate,
  formatApiKeyScopes,
  formatApiKeyStatus,
} from './apiKeyUi';
import { CreateApiKeyModal } from './CreateApiKeyModal';
import { DataGridFilterPills, DataGridToolbar } from './DataGridToolbar';
import gridStyles from './DataGrid.module.css';
import styles from './ApiKeysAdminView.module.css';

export interface ApiKeysAdminViewProps {
  selectedProject: string | null;
}

type StatusFilter = 'all' | ApiKeyStatus;

const STATUS_FILTERS: readonly { label: string; value: StatusFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'Active', value: 'active' },
  { label: 'Expired', value: 'expired' },
];

const PAGE_SIZE = 50;

export const ApiKeysAdminView: React.FC<ApiKeysAdminViewProps> = ({
  selectedProject,
}) => {
  const { can } = useAppShell();
  const canManage = can('api-keys:manage');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [page, setPage] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [managingKey, setManagingKey] = useState<ApiKeyMetadata | null>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);

  const keysQuery = useApiKeys(canManage ? selectedProject : null);

  const filteredItems = useMemo(() => {
    const items = keysQuery.data ?? [];
    const q = search.trim().toLowerCase();
    return items.filter((item) => {
      if (statusFilter !== 'all' && item.status !== statusFilter) return false;
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.maskedPrefix.toLowerCase().includes(q) ||
        item.shortId.toLowerCase().includes(q)
      );
    });
  }, [keysQuery.data, search, statusFilter]);

  const needsPagination = filteredItems.length > PAGE_SIZE;
  const totalPages = needsPagination
    ? Math.ceil(filteredItems.length / PAGE_SIZE)
    : 1;
  const safePage = Math.min(page, Math.max(0, totalPages - 1));
  const pageItems = needsPagination
    ? filteredItems.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)
    : filteredItems;

  if (!canManage) {
    return (
      <div className={styles.page}>
        <section
          className={gridStyles.section}
          {...{ 'data-testid': 'api-keys-access-denied' }}
        >
          <p className={gridStyles.error} role="alert">
            You don&apos;t have permission to manage API keys.
          </p>
        </section>
      </div>
    );
  }

  if (!selectedProject) {
    return (
      <div className={styles.page}>
        <section className={gridStyles.section}>
          <p className={gridStyles.empty}>Select a project to manage API keys.</p>
        </section>
      </div>
    );
  }

  const hasAnyKeys = (keysQuery.data?.length ?? 0) > 0;
  const emptyMessage = !hasAnyKeys
    ? 'No API keys yet — create one to enable programmatic access'
    : search.trim() || statusFilter !== 'all'
      ? `No API keys match your search${search.trim() ? ` “${search.trim()}”` : ''}.`
      : 'No API keys yet — create one to enable programmatic access';

  return (
    <div className={styles.page}>
    <section className={gridStyles.section} {...{ 'data-testid': 'api-keys-admin' }}>
      <div className={gridStyles.header}>
        <div>
          <h2 className={gridStyles.title}>API Keys</h2>
          <p className={gridStyles.hint}>
            Create and manage project-scoped keys for programmatic access.
          </p>
        </div>
        <div className={gridStyles.headerActions}>
          <button
            ref={addButtonRef}
            type="button"
            className={gridStyles.buttonPrimary}
            onClick={() => setCreateOpen(true)}
            {...{ 'data-testid': 'api-keys-add' }}
          >
            Add API key
          </button>
        </div>
      </div>

      <DataGridToolbar
        searchValue={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(0);
        }}
        searchPlaceholder="Search by name, prefix, or ID…"
        searchTestId="api-keys-search"
      >
        <DataGridFilterPills
          options={STATUS_FILTERS}
          value={statusFilter}
          onChange={(value) => {
            setStatusFilter(value);
            setPage(0);
          }}
          testIdPrefix="api-keys-filter-status"
          aria-label="Status"
          {...{ 'data-testid': 'api-keys-status-filters' }}
        />
      </DataGridToolbar>

      {keysQuery.isLoading && (
        <p className={gridStyles.loading} {...{ 'data-testid': 'api-keys-loading' }}>
          Loading API keys…
        </p>
      )}

      {keysQuery.isError && (
        <p className={gridStyles.error} role="alert" {...{ 'data-testid': 'api-keys-error' }}>
          {keysQuery.error instanceof Error
            ? keysQuery.error.message
            : 'Failed to load API keys'}
        </p>
      )}

      {!keysQuery.isLoading && !keysQuery.isError && pageItems.length === 0 && (
        <p className={gridStyles.empty} {...{ 'data-testid': 'api-keys-empty' }}>
          {emptyMessage}
        </p>
      )}

      {!keysQuery.isLoading && !keysQuery.isError && pageItems.length > 0 && (
        <>
          <div className={gridStyles.tableWrap} {...{ 'data-testid': 'api-keys-grid' }}>
            <table className={gridStyles.table}>
              <thead>
                <tr>
                  <th scope="col">ID</th>
                  <th scope="col">Name</th>
                  <th scope="col">Prefix</th>
                  <th scope="col">Cadence</th>
                  <th scope="col">Scopes</th>
                  <th scope="col">Expires</th>
                  <th scope="col">Created</th>
                  <th scope="col">Created by</th>
                  <th scope="col">Status</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((item) => (
                  <tr
                    key={item.id}
                    {...{ 'data-testid': `api-key-row-${item.id}` }}
                  >
                    <td className={styles.mono}>{item.shortId}</td>
                    <td>{item.name}</td>
                    <td className={styles.mono}>{item.maskedPrefix}</td>
                    <td>{API_KEY_CADENCE_LABELS[item.cadence]}</td>
                    <td title={formatApiKeyScopes(item.scopes ?? [])}>
                      {(item.scopes ?? []).length === 0
                        ? 'Ping only'
                        : `${item.scopes.length} selected`}
                    </td>
                    <td>{formatApiKeyDate(item.expiresAt)}</td>
                    <td>{formatApiKeyDate(item.createdAt)}</td>
                    <td>{item.createdBy}</td>
                    <td>
                      <span
                        className={`${styles.status} ${
                          item.status === 'active'
                            ? styles.statusActive
                            : styles.statusExpired
                        }`}
                      >
                        {formatApiKeyStatus(item.status)}
                      </span>
                    </td>
                    <td>
                      <div
                        className={gridStyles.rowActions}
                        {...{ 'data-testid': `api-key-row-actions-${item.id}` }}
                      >
                        <button
                          type="button"
                          className={gridStyles.buttonGhost}
                          onClick={() => setManagingKey(item)}
                          {...{ 'data-testid': `api-key-manage-${item.id}` }}
                        >
                          Manage
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {needsPagination && (
            <div
              className={styles.pagination}
              {...{ 'data-testid': 'api-keys-pagination' }}
            >
              <button
                type="button"
                className={gridStyles.button}
                disabled={safePage <= 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                {...{ 'data-testid': 'api-keys-page-prev' }}
              >
                Previous
              </button>
              <span className={styles.pageLabel}>
                Page {safePage + 1} of {totalPages}
              </span>
              <button
                type="button"
                className={gridStyles.button}
                disabled={safePage >= totalPages - 1}
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                {...{ 'data-testid': 'api-keys-page-next' }}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}

      {createOpen && (
        <CreateApiKeyModal
          projectId={selectedProject}
          onClose={() => {
            setCreateOpen(false);
            // Return focus conceptually to Add button
            window.setTimeout(() => addButtonRef.current?.focus(), 0);
          }}
          {...{ 'data-testid': 'api-key-create-modal' }}
        />
      )}

      {managingKey && (
        <ApiKeyManageDrawer
          key={managingKey.id}
          projectId={selectedProject}
          apiKey={managingKey}
          onClose={() => setManagingKey(null)}
          onDeleted={() => setManagingKey(null)}
          {...{ 'data-testid': 'api-key-manage-drawer' }}
        />
      )}
    </section>
    </div>
  );
};

export default ApiKeysAdminView;

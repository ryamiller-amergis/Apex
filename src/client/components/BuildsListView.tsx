import React, { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { buildStatusLabel } from '../../shared/types/build';
import { BUILDS_RUN } from '../../shared/types/buildAccess';
import { useMyPermissions } from '../hooks/useRbac';
import { useBuilds } from '../hooks/useBuilds';
import { DataGridFilterPills, DataGridToolbar } from './DataGridToolbar';
import gridStyles from './DataGrid.module.css';
import styles from './BuildsListView.module.css';

interface BuildsListViewProps {
  project: string;
  isSuperAdmin?: boolean;
}

type ListFilter = 'all' | 'in-progress';

const FILTERS: readonly { label: string; value: ListFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'In progress', value: 'in-progress' },
];

export const BuildsListView: React.FC<BuildsListViewProps> = ({ project, isSuperAdmin = false }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const notice = (location.state as { notice?: string } | null)?.notice;
  const { can } = useMyPermissions(project);
  const canRun = isSuperAdmin || can(BUILDS_RUN);
  const [filter, setFilter] = useState<ListFilter>('all');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [focusIndex, setFocusIndex] = useState(0);
  const limit = 50;
  const query = useBuilds(project, {
    state: filter === 'in-progress' ? 'active' : 'all',
    limit,
    offset,
  });

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const builds = query.data?.builds ?? [];
    if (!needle) return builds;
    return builds.filter((build) =>
      build.repository.toLowerCase().includes(needle)
      || build.requesterDisplayName.toLowerCase().includes(needle));
  }, [query.data?.builds, search]);

  const total = query.data?.total ?? 0;

  const onRowKey = (event: React.KeyboardEvent, index: number, id: string) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setFocusIndex(Math.min(visible.length - 1, index + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setFocusIndex(Math.max(0, index - 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setFocusIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setFocusIndex(Math.max(0, visible.length - 1));
    } else if (event.key === 'Enter') {
      navigate(`/builds/${id}`);
    }
  };

  return (
    <div className={styles.page} {...{ 'data-testid': 'builds-list-view' }}>
      <div className={styles.header}>
        <h1 className={styles.title}>Builds</h1>
        {notice && <p role="status">{notice}</p>}
        {canRun && (
          <button
            type="button"
            className={styles.newBuild}
            onClick={() => navigate('/builds/new')}
            {...{ 'data-testid': 'builds-list-new-build' }}
          >
            New build
          </button>
        )}
      </div>
      <DataGridToolbar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search repository or requester"
        searchTestId="builds-list-search"
      >
        <DataGridFilterPills
          options={FILTERS}
          value={filter}
          onChange={(value) => {
            setFilter(value);
            setOffset(0);
          }}
          testIdPrefix="builds-list-filter"
          aria-label="Build stage filter"
          {...{ 'data-testid': 'builds-list-filters' }}
        />
      </DataGridToolbar>
      {query.isLoading && <p className={gridStyles.loading} {...{ 'data-testid': 'builds-list-loading' }}>Loading builds…</p>}
      {query.isError && (
        <div role="alert" className={gridStyles.error} {...{ 'data-testid': 'builds-list-error' }}>
          <p>The builds list could not be loaded.</p>
          <button type="button" onClick={() => { void query.refetch(); }} {...{ 'data-testid': 'builds-list-retry' }}>
            Retry
          </button>
        </div>
      )}
      {query.isSuccess && visible.length === 0 && search.trim() && (
        <p className={gridStyles.empty} {...{ 'data-testid': 'builds-list-no-matches' }}>No builds match your search.</p>
      )}
      {query.isSuccess && visible.length === 0 && !search.trim() && (
        <div className={gridStyles.empty} {...{ 'data-testid': 'builds-list-empty' }}>
          <p>No builds yet.</p>
          {canRun && (
            <button type="button" onClick={() => navigate('/builds/new')} {...{ 'data-testid': 'builds-list-empty-new-build' }}>
              New build
            </button>
          )}
        </div>
      )}
      {query.isSuccess && visible.length > 0 && (
        <div className={gridStyles.tableWrap}>
          <table className={gridStyles.table} aria-label="Project builds" {...{ 'data-testid': 'builds-list-table' }}>
            <thead>
              <tr>
                <th scope="col">Repository</th>
                <th scope="col">Stage</th>
                <th scope="col">Requester</th>
                <th scope="col">Started</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((build, index) => (
                <tr
                  key={build.id}
                  tabIndex={index === focusIndex ? 0 : -1}
                  onKeyDown={(event) => onRowKey(event, index, build.id)}
                  {...{ 'data-testid': `builds-list-row-${build.id}` }}
                >
                  <td>{build.repository}</td>
                  <td>
                    {build.status === 'queued' && build.queuePosition
                      ? <span {...{ 'data-testid': `builds-list-queue-position-${build.id}` }}>{`Queued — position ${build.queuePosition}`}</span>
                      : buildStatusLabel(build.status)}
                  </td>
                  <td>{build.requesterDisplayName}</td>
                  <td>{new Date(build.createdAt).toLocaleString()}</td>
                  <td>
                    <button
                      type="button"
                      className={gridStyles.buttonGhost}
                      onClick={() => navigate(`/builds/${build.id}`)}
                      {...{ 'data-testid': `builds-list-open-${build.id}` }}
                    >
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {total > limit && (
        <div className={styles.pager}>
          <button
            type="button"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - limit))}
            {...{ 'data-testid': 'builds-list-page-prev' }}
          >
            Previous
          </button>
          <button
            type="button"
            disabled={offset + limit >= total}
            onClick={() => setOffset(offset + limit)}
            {...{ 'data-testid': 'builds-list-page-next' }}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
};

export default BuildsListView;

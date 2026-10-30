import React, { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { BrainstormSessionState, BrainstormSessionSummary } from '../../shared/types/brainstorm';
import { useAppShell } from '../hooks/useAppShell';
import {
  BrainstormApiError,
  useBrainstormSessions,
  useCreateBrainstormSession,
  useDeleteBrainstormSession,
} from '../hooks/useBrainstormSessions';
import { BrainstormRepositoryAdmin } from './BrainstormRepositoryAdmin';
import { BrainstormStatusChip, formatBrainstormTime } from './BrainstormSessionHeader';
import {
  DataGridFilterDivider,
  DataGridFilterPills,
  DataGridToolbar,
} from './DataGridToolbar';
import gridStyles from './DataGrid.module.css';
import styles from './BrainstormSessionsPage.module.css';

type SessionStateFilter = 'all' | BrainstormSessionState;
type SessionCreatorFilter = 'all' | 'mine';

const STATE_FILTER_OPTIONS: readonly { label: string; value: SessionStateFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'Active', value: 'active' },
  { label: 'Ended', value: 'ended' },
  { label: 'Failed', value: 'failed' },
];

const CREATOR_FILTER_OPTIONS: readonly { label: string; value: SessionCreatorFilter }[] = [
  { label: 'All creators', value: 'all' },
  { label: 'Mine', value: 'mine' },
];

interface DeleteSessionModalProps {
  session: BrainstormSessionSummary;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

const DeleteSessionModal: React.FC<DeleteSessionModalProps> = ({
  session,
  pending,
  error,
  onCancel,
  onConfirm,
}) => (
  <div
    className={styles.modalOverlay}
    role="dialog"
    aria-modal="true"
    aria-labelledby="brainstorm-delete-session-title"
    {...{ 'data-testid': 'brainstorm-delete-session-modal' }}
  >
    <div className={styles.modalCard}>
      <h3 id="brainstorm-delete-session-title" className={styles.modalTitle}>
        Delete session?
      </h3>
      <p className={styles.modalBody}>
        <strong>{session.title ?? 'Untitled session'}</strong>, its messages, artifacts, citations,
        and any cloned workspaces will be permanently deleted.
      </p>
      {error && (
        <p className={styles.formError} role="alert" {...{ 'data-testid': 'brainstorm-delete-session-error' }}>
          {error}
        </p>
      )}
      <div className={styles.modalActions}>
        <button
          type="button"
          className={gridStyles.button}
          disabled={pending}
          onClick={onCancel}
          {...{ 'data-testid': 'brainstorm-delete-session-cancel' }}
        >
          Cancel
        </button>
        <button
          type="button"
          className={styles.modalDanger}
          disabled={pending}
          onClick={onConfirm}
          {...{ 'data-testid': 'brainstorm-delete-session-confirm' }}
        >
          {pending ? 'Deleting…' : 'Delete session'}
        </button>
      </div>
    </div>
  </div>
);

interface BrainstormSessionsPageProps {
  project: string;
}

export const BrainstormSessionsPage: React.FC<BrainstormSessionsPageProps> = ({ project }) => {
  const [stateFilter, setStateFilter] = useState<SessionStateFilter>('all');
  const [creatorFilter, setCreatorFilter] = useState<SessionCreatorFilter>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [deletingSession, setDeletingSession] = useState<BrainstormSessionSummary | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const { data, isLoading, isError, refetch, isFetching } = useBrainstormSessions(project);
  const create = useCreateBrainstormSession(project);
  const deleteSession = useDeleteBrainstormSession(project);

  const filteredSessions = useMemo(() => {
    const items = data?.sessions ?? [];
    const q = search.trim().toLowerCase();
    return items.filter((session) => {
      if (stateFilter !== 'all' && session.state !== stateFilter) return false;
      if (creatorFilter === 'mine' && !(session.isCreator ?? session.canMutate ?? session.canDelete)) {
        return false;
      }
      if (!q) return true;
      const title = (session.title ?? 'Untitled session').toLowerCase();
      const creator = (session.creatorName ?? 'Unknown creator').toLowerCase();
      return title.includes(q) || creator.includes(q);
    });
  }, [creatorFilter, data?.sessions, search, stateFilter]);

  const navigate = useNavigate();
  const { can, isSuperAdmin } = useAppShell();
  const canManageRepositories = isSuperAdmin || can('admin:roles');

  const pageCount = Math.max(1, Math.ceil(filteredSessions.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageOffset = (currentPage - 1) * pageSize;
  const visibleSessions = filteredSessions.slice(pageOffset, pageOffset + pageSize);

  const start = () => {
    create.mutate(undefined, {
      onSuccess: (session) => navigate(`/brainstorm/${encodeURIComponent(session.id)}`),
    });
  };

  const confirmDelete = async () => {
    if (!deletingSession) return;
    setDeleteError(null);
    try {
      await deleteSession.mutateAsync(deletingSession.id);
      setDeletingSession(null);
    } catch (err) {
      setDeleteError(
        err instanceof BrainstormApiError ? err.message : 'We could not delete the session.',
      );
    }
  };

  const totalSessions = data?.sessions.length ?? 0;

  let sessionsContent: React.ReactNode;
  if (isLoading) {
    sessionsContent = (
      <div className={styles.skeleton} aria-busy="true" aria-label="Loading sessions">
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
      </div>
    );
  } else if (isError) {
    sessionsContent = (
      <div className={styles.state} role="alert" {...{ 'data-testid': 'brainstorm-sessions-error' }}>
        <p>We could not load Brainstorm sessions.</p>
        <button
          type="button"
          className={styles.retry}
          onClick={() => { void refetch(); }}
          disabled={isFetching}
          {...{ 'data-testid': 'brainstorm-sessions-retry' }}
        >
          Retry
        </button>
      </div>
    );
  } else if (totalSessions === 0) {
    sessionsContent = (
      <p className={gridStyles.empty} {...{ 'data-testid': 'brainstorm-sessions-empty' }}>
        No Brainstorm sessions yet.
      </p>
    );
  } else if (filteredSessions.length === 0) {
    sessionsContent = (
      <p className={gridStyles.empty} {...{ 'data-testid': 'brainstorm-sessions-no-matches' }}>
        {search.trim()
          ? `No sessions match "${search.trim()}".`
          : creatorFilter === 'mine'
            ? 'You have not created any sessions matching this filter.'
            : `No ${stateFilter} sessions found.`}
      </p>
    );
  } else {
    sessionsContent = (
      <div className={gridStyles.tableWrap}>
        <table className={gridStyles.table} {...{ 'data-testid': 'brainstorm-sessions-table' }}>
          <thead>
            <tr>
              <th scope="col">Session</th>
              <th scope="col">Creator</th>
              <th scope="col">Status</th>
              <th scope="col">Last activity</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visibleSessions.map((session) => {
              const href = `/brainstorm/${encodeURIComponent(session.id)}`;
              const allowDelete = Boolean(session.canDelete ?? session.canMutate ?? isSuperAdmin);
              return (
                <tr
                  key={session.id}
                  {...{ 'data-testid': 'brainstorm-session-row' }}
                >
                  <td>
                    <Link
                      to={href}
                      className={styles.sessionLink}
                      {...{ 'data-testid': `brainstorm-session-link-${session.id}` }}
                    >
                      {session.title ?? 'Untitled session'}
                    </Link>
                  </td>
                  <td className={styles.creatorCell}>
                    {session.creatorName ?? 'Unknown creator'}
                  </td>
                  <td>
                    {/* data-testid-exempt — BrainstormStatusChip owns brainstorm-session-status */}
                    <BrainstormStatusChip state={session.state} />
                  </td>
                  <td className={styles.timeCell}>
                    <time dateTime={session.lastActivityAt}>
                      {formatBrainstormTime(session.lastActivityAt)}
                    </time>
                  </td>
                  <td>
                    <div className={gridStyles.rowActions}>
                      <Link
                        to={href}
                        className={styles.openLink}
                        {...{ 'data-testid': `brainstorm-session-open-${session.id}` }}
                      >
                        Open
                      </Link>
                      {allowDelete && (
                        <button
                          type="button"
                          className={styles.dangerGhost}
                          onClick={() => {
                            setDeleteError(null);
                            setDeletingSession(session);
                          }}
                          {...{ 'data-testid': `brainstorm-session-delete-${session.id}` }}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <main className={styles.root} {...{ 'data-testid': 'brainstorm-sessions-page' }}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.heading}>Brainstorm</h1>
          <p className={styles.intro}>
            Explore an idea in open chat. Repository setup for this project lives here.
          </p>
        </div>
        <button
          type="button"
          className={styles.primary}
          onClick={start}
          disabled={create.isPending}
          {...{ 'data-testid': 'brainstorm-page-start-session' }}
        >
          {create.isPending ? 'Starting…' : 'Start session'}
        </button>
      </header>
      {create.isError && (
        <p className={styles.formError} role="alert" {...{ 'data-testid': 'brainstorm-page-start-error' }}>
          We could not start a session.
        </p>
      )}
      <section className={gridStyles.section} aria-labelledby="brainstorm-sessions-heading">
        <div className={gridStyles.header}>
          <div>
            <h2 id="brainstorm-sessions-heading" className={gridStyles.title}>Sessions</h2>
            <p className={gridStyles.hint}>
              Filter by session state, owner, or search by title and creator.
            </p>
          </div>
        </div>
        <DataGridToolbar
          searchValue={search}
          onSearchChange={(value) => {
            setSearch(value);
            setPage(1);
          }}
          searchPlaceholder="Search sessions by title or creator…"
          searchTestId="brainstorm-sessions-search"
        >
          <DataGridFilterPills
            options={STATE_FILTER_OPTIONS}
            value={stateFilter}
            onChange={(value) => {
              setStateFilter(value);
              setPage(1);
            }}
            testIdPrefix="brainstorm-sessions-filter-state"
            aria-label="Session status"
            {...{ 'data-testid': 'brainstorm-sessions-state-filters' }}
          />
          <DataGridFilterDivider />
          <DataGridFilterPills
            options={CREATOR_FILTER_OPTIONS}
            value={creatorFilter}
            onChange={(value) => {
              setCreatorFilter(value);
              setPage(1);
            }}
            testIdPrefix="brainstorm-sessions-filter-creator"
            aria-label="Session creator"
            {...{ 'data-testid': 'brainstorm-sessions-creator-filters' }}
          />
        </DataGridToolbar>
        {sessionsContent}
        {!isLoading && !isError && totalSessions > 0 && (
          <div
            className={styles.pagination}
            {...{ 'data-testid': 'brainstorm-sessions-pagination' }}
          >
            <span>
              {filteredSessions.length === 0 ? '0' : pageOffset + 1}–
              {Math.min(pageOffset + pageSize, filteredSessions.length)} of {filteredSessions.length}
            </span>
            <label>
              Rows
              <select
                value={pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                  setPage(1);
                }}
                {...{ 'data-testid': 'brainstorm-sessions-page-size' }}
              >
                {[10, 25, 50, 100].map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={gridStyles.buttonGhost}
              disabled={currentPage === 1}
              onClick={() => setPage((current) => current - 1)}
              {...{ 'data-testid': 'brainstorm-sessions-page-previous' }}
            >
              Previous
            </button>
            <button
              type="button"
              className={gridStyles.buttonGhost}
              disabled={currentPage >= pageCount}
              onClick={() => setPage((current) => current + 1)}
              {...{ 'data-testid': 'brainstorm-sessions-page-next' }}
            >
              Next
            </button>
          </div>
        )}
      </section>
      {canManageRepositories && (
        // data-testid-exempt — BrainstormRepositoryAdmin owns brainstorm-repo-admin
        <BrainstormRepositoryAdmin project={project} />
      )}
      {deletingSession && (
        // data-testid-exempt — DeleteSessionModal root owns brainstorm-delete-session-modal
        <DeleteSessionModal
          session={deletingSession}
          pending={deleteSession.isPending}
          error={deleteError}
          onCancel={() => {
            setDeletingSession(null);
            setDeleteError(null);
          }}
          onConfirm={() => { void confirmDelete(); }}
        />
      )}
    </main>
  );
};

export default BrainstormSessionsPage;

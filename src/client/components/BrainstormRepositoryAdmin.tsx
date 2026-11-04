import React, { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import type {
  BrainstormCatalogRepositoryDto,
  BrainstormCatalogStatus,
  BrainstormRepositoryDriftResult,
} from '../../shared/types/brainstormSources';
import { BrainstormApiError } from '../hooks/useBrainstormSessions';
import {
  useAddBrainstormRepository,
  useBrainstormRepositories,
  useCheckBrainstormRepositoryDrift,
  useCloneBrainstormRepository,
  useDeleteBrainstormRepository,
} from '../hooks/useBrainstormRepositories';
import { formatBrainstormTime } from './BrainstormSessionHeader';
import { DataGridFilterPills, DataGridToolbar } from './DataGridToolbar';
import gridStyles from './DataGrid.module.css';
import styles from './BrainstormSessionsPage.module.css';

const schema = z.object({
  displayName: z.string().trim().min(1, 'Enter a name.').max(80, 'Use 80 characters or fewer.'),
  cloneUrl: z.string().trim().min(1, 'Enter a repository URL.'),
  branch: z.string().trim().min(1, 'Enter a branch name.'),
});

type RepositoryForm = z.infer<typeof schema>;
type RepoStatusFilter = 'all' | BrainstormCatalogStatus;

const REPO_STATUS_FILTERS: readonly { label: string; value: RepoStatusFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'Ready', value: 'ready' },
  { label: 'Cloning', value: 'cloning' },
  { label: 'Failed', value: 'failed' },
];

const STATUS_LABEL: Record<BrainstormCatalogStatus, string> = {
  not_cloned: 'Not cloned',
  cloning: 'Cloning…',
  ready: 'Ready',
  failed: 'Failed',
};

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

function isCloneStale(updatedAt?: string): boolean {
  if (!updatedAt) return false;
  const parsed = Date.parse(updatedAt);
  if (Number.isNaN(parsed)) return false;
  return Date.now() - parsed > STALE_THRESHOLD_MS;
}

function statusBadgeClass(status: BrainstormCatalogStatus): string {
  switch (status) {
    case 'ready':
      return `${styles.statusBadge} ${styles.statusReady}`;
    case 'cloning':
      return `${styles.statusBadge} ${styles.statusCloning}`;
    case 'failed':
      return `${styles.statusBadge} ${styles.statusFailed}`;
    default:
      return `${styles.statusBadge} ${styles.statusNeutral}`;
  }
}

interface DeleteRepositoryModalProps {
  repository: BrainstormCatalogRepositoryDto;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

const DeleteRepositoryModal: React.FC<DeleteRepositoryModalProps> = ({
  repository,
  pending,
  error,
  onCancel,
  onConfirm,
}) => (
  <div
    className={styles.modalOverlay}
    role="dialog"
    aria-modal="true"
    aria-labelledby="brainstorm-repo-delete-title"
    {...{ 'data-testid': 'brainstorm-repo-delete-modal' }}
  >
    <div className={styles.modalCard}>
      <h3 id="brainstorm-repo-delete-title" className={styles.modalTitle}>
        Remove repository?
      </h3>
      <p className={styles.modalBody}>
        <strong>{repository.displayName}</strong> ({repository.branch}) and its local mirror will be
        removed from this project&apos;s Brainstorm catalog.
      </p>
      {error && (
        <p className={styles.formError} role="alert" {...{ 'data-testid': 'brainstorm-repo-delete-error' }}>
          {error}
        </p>
      )}
      <div className={styles.modalActions}>
        <button
          type="button"
          className={gridStyles.button}
          disabled={pending}
          onClick={onCancel}
          {...{ 'data-testid': 'brainstorm-repo-delete-cancel' }}
        >
          Cancel
        </button>
        <button
          type="button"
          className={styles.modalDanger}
          disabled={pending}
          onClick={onConfirm}
          {...{ 'data-testid': 'brainstorm-repo-delete-confirm' }}
        >
          {pending ? 'Removing…' : 'Remove repository'}
        </button>
      </div>
    </div>
  </div>
);

interface BrainstormRepositoryAdminProps {
  project: string;
}

export const BrainstormRepositoryAdmin: React.FC<BrainstormRepositoryAdminProps> = ({ project }) => {
  const [statusFilter, setStatusFilter] = useState<RepoStatusFilter>('all');
  const [search, setSearch] = useState('');
  const [deletingRepo, setDeletingRepo] = useState<BrainstormCatalogRepositoryDto | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [driftById, setDriftById] = useState<Record<string, BrainstormRepositoryDriftResult>>({});
  const [checkingAllDrift, setCheckingAllDrift] = useState(false);

  const repositories = useBrainstormRepositories(project, true);
  const add = useAddBrainstormRepository(project);
  const clone = useCloneBrainstormRepository(project);
  const deleteRepo = useDeleteBrainstormRepository(project);
  const checkDrift = useCheckBrainstormRepositoryDrift(project);

  const rows = useMemo(
    () => repositories.data?.repositories ?? [],
    [repositories.data?.repositories],
  );

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (statusFilter !== 'all' && row.status !== statusFilter) return false;
      if (!q) return true;
      return (
        row.displayName.toLowerCase().includes(q)
        || row.cloneUrl.toLowerCase().includes(q)
        || row.branch.toLowerCase().includes(q)
      );
    });
  }, [rows, search, statusFilter]);

  // data-testid-exempt — generic type argument, not an element
  const form = useForm<RepositoryForm>({ defaultValues: { displayName: '', cloneUrl: '', branch: '' } });

  const onSubmit = form.handleSubmit(async (values) => {
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'displayName' || field === 'cloneUrl' || field === 'branch') {
          form.setError(field, { message: issue.message });
        }
      }
      return;
    }
    try {
      await add.mutateAsync(parsed.data);
      form.reset();
    } catch (err) {
      const message = err instanceof BrainstormApiError ? err.message : 'We could not add the repository.';
      form.setError('cloneUrl', { message });
    }
  });

  const handleCheckDrift = async (id: string) => {
    try {
      const result = await checkDrift.mutateAsync(id);
      setDriftById((prev) => ({ ...prev, [id]: result }));
    } catch {
      // Non-fatal: row remains inspectable.
    }
  };

  const handleCheckAllDrift = async () => {
    const readyRows = rows.filter((row) => row.status === 'ready');
    if (readyRows.length === 0) return;
    setCheckingAllDrift(true);
    try {
      const results = await Promise.allSettled(
        readyRows.map((row) => checkDrift.mutateAsync(row.id)),
      );
      const next: Record<string, BrainstormRepositoryDriftResult> = {};
      for (const item of results) {
        if (item.status === 'fulfilled') {
          next[item.value.id] = item.value;
        }
      }
      setDriftById((prev) => ({ ...prev, ...next }));
    } finally {
      setCheckingAllDrift(false);
    }
  };

  const handleRefreshClone = (id: string) => {
    setDriftById((prev) => {
      const copy = { ...prev };
      delete copy[id];
      return copy;
    });
    clone.mutate(id);
  };

  const handleConfirmDelete = async () => {
    if (!deletingRepo) return;
    setDeleteError(null);
    try {
      await deleteRepo.mutateAsync(deletingRepo.id);
      setDeletingRepo(null);
    } catch (err) {
      setDeleteError(
        err instanceof BrainstormApiError ? err.message : 'We could not remove the repository.',
      );
    }
  };

  const readyCount = rows.filter((row) => row.status === 'ready').length;

  return (
    <section
      className={gridStyles.section}
      aria-labelledby="brainstorm-repo-admin-title"
      {...{ 'data-testid': 'brainstorm-repo-admin' }}
    >
      <div className={gridStyles.header}>
        <div>
          <h3 id="brainstorm-repo-admin-title" className={gridStyles.title}>Repositories</h3>
          <p className={gridStyles.hint}>
            Paste the HTTPS address and branch. Azure DevOps links may start with the organization
            name. Apex signs in with the server connection and keeps local mirrors synced on refresh.
          </p>
        </div>
        {readyCount > 0 && (
          <div className={gridStyles.headerActions}>
            <button
              type="button"
              className={gridStyles.button}
              disabled={checkingAllDrift || checkDrift.isPending}
              onClick={() => { void handleCheckAllDrift(); }}
              {...{ 'data-testid': 'brainstorm-repo-check-all-drift' }}
            >
              {checkingAllDrift ? 'Checking drift…' : 'Check for drift'}
            </button>
          </div>
        )}
      </div>

      <div className={styles.repoFormCard}>
        <form
          className={styles.repoForm}
          onSubmit={(event) => { void onSubmit(event); }}
          noValidate
          {...{ 'data-testid': 'brainstorm-repo-form' }}
        >
          <label className={styles.repoField} htmlFor="brainstorm-repo-name">
            Name
            <input
              id="brainstorm-repo-name"
              placeholder="e.g. MatterWorx"
              {...form.register('displayName')}
              {...{ 'data-testid': 'brainstorm-repo-name' }}
            />
          </label>
          <label className={styles.repoField} htmlFor="brainstorm-repo-url">
            Repository URL
            <input
              id="brainstorm-repo-url"
              placeholder="https://dev.azure.com/org/project/_git/repo"
              {...form.register('cloneUrl')}
              {...{ 'data-testid': 'brainstorm-repo-url' }}
            />
          </label>
          <label className={styles.repoField} htmlFor="brainstorm-repo-branch">
            Branch
            <input
              id="brainstorm-repo-branch"
              placeholder="development"
              {...form.register('branch')}
              {...{ 'data-testid': 'brainstorm-repo-branch' }}
            />
          </label>
          <button
            type="submit"
            className={styles.primary}
            disabled={add.isPending}
            {...{ 'data-testid': 'brainstorm-repo-add' }}
          >
            {add.isPending ? 'Adding…' : 'Add and clone'}
          </button>
        </form>
        {form.formState.errors.cloneUrl?.message && (
          <p className={styles.formError} role="alert">{form.formState.errors.cloneUrl.message}</p>
        )}
        {form.formState.errors.displayName?.message && (
          <p className={styles.formError} role="alert">{form.formState.errors.displayName.message}</p>
        )}
        {form.formState.errors.branch?.message && (
          <p className={styles.formError} role="alert">{form.formState.errors.branch.message}</p>
        )}
      </div>

      {repositories.isError && (
        <p className={gridStyles.error} role="alert">
          {repositories.error instanceof BrainstormApiError
            ? repositories.error.message
            : 'We could not load repositories.'}
        </p>
      )}

      {rows.length > 0 && (
        <DataGridToolbar
          searchValue={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search repositories by name, URL, or branch…"
          searchTestId="brainstorm-repo-search"
        >
          <DataGridFilterPills
            options={REPO_STATUS_FILTERS}
            value={statusFilter}
            onChange={setStatusFilter}
            testIdPrefix="brainstorm-repo-filter-status"
            aria-label="Repository status"
            {...{ 'data-testid': 'brainstorm-repo-status-filters' }}
          />
        </DataGridToolbar>
      )}

      {!repositories.isLoading && !repositories.isError && rows.length === 0 && (
        <p className={gridStyles.empty} {...{ 'data-testid': 'brainstorm-repo-empty' }}>
          No repositories added yet. Add a repository above to make it available in Brainstorm sessions.
        </p>
      )}

      {rows.length > 0 && filteredRows.length === 0 && (
        <p className={gridStyles.empty} {...{ 'data-testid': 'brainstorm-repo-no-matches' }}>
          {search.trim()
            ? `No repositories match "${search.trim()}".`
            : `No ${STATUS_LABEL[statusFilter as BrainstormCatalogStatus]?.toLowerCase() ?? statusFilter} repositories.`}
        </p>
      )}

      {filteredRows.length > 0 && (
        <div className={gridStyles.tableWrap}>
          <table className={gridStyles.table} {...{ 'data-testid': 'brainstorm-repo-table' }}>
            <thead>
              <tr>
                <th scope="col">Repository</th>
                <th scope="col">Branch</th>
                <th scope="col">Revision &amp; Drift</th>
                <th scope="col">Last synced</th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row) => {
                const drift = driftById[row.id];
                const stale = row.status === 'ready' && isCloneStale(row.updatedAt);
                const isCloning = row.status === 'cloning';
                return (
                  <tr
                    key={row.id}
                    {...{ 'data-testid': `brainstorm-repo-row-${row.id}` }}
                  >
                    <td>
                      <div className={styles.repoPrimaryCell}>
                        <span className={styles.repoName}>{row.displayName}</span>
                        <span className={styles.repoUrl}>{row.cloneUrl}</span>
                      </div>
                    </td>
                    <td>
                      <span className={styles.codeBadge}>{row.branch}</span>
                    </td>
                    <td>
                      <div className={styles.revisionStack}>
                        <span className={styles.codeBadge}>
                          {row.commitSha ? row.commitSha.slice(0, 7) : '—'}
                        </span>
                        {drift && drift.drifted && drift.remoteSha && (
                          <span
                            className={styles.driftWarning}
                            {...{ 'data-testid': `brainstorm-repo-drift-${row.id}` }}
                          >
                            Behind remote ({drift.remoteSha.slice(0, 7)})
                          </span>
                        )}
                        {drift && !drift.drifted && drift.reachable && (
                          <span
                            className={styles.driftOk}
                            {...{ 'data-testid': `brainstorm-repo-drift-${row.id}` }}
                          >
                            Up to date
                          </span>
                        )}
                        {drift && !drift.reachable && (
                          <span
                            className={styles.driftWarning}
                            {...{ 'data-testid': `brainstorm-repo-drift-${row.id}` }}
                          >
                            Remote unreachable
                          </span>
                        )}
                        {!drift && stale && (
                          <span
                            className={styles.driftWarning}
                            {...{ 'data-testid': `brainstorm-repo-stale-${row.id}` }}
                          >
                            Stale (&gt;24h)
                          </span>
                        )}
                      </div>
                    </td>
                    <td className={styles.timeCell}>
                      {row.updatedAt ? formatBrainstormTime(row.updatedAt) : '—'}
                    </td>
                    <td>
                      <div className={styles.statusStack}>
                        <span className={statusBadgeClass(row.status)}>
                          {STATUS_LABEL[row.status]}
                        </span>
                        {row.error && <span className={styles.repoError}>{row.error}</span>}
                      </div>
                    </td>
                    <td>
                      <div className={gridStyles.rowActions}>
                        <button
                          type="button"
                          className={gridStyles.buttonGhost}
                          disabled={isCloning || clone.isPending}
                          onClick={() => handleRefreshClone(row.id)}
                          {...{ 'data-testid': `brainstorm-repo-clone-${row.id}` }}
                        >
                          {row.status === 'failed'
                            ? 'Clone again'
                            : row.status === 'not_cloned'
                              ? 'Clone'
                              : 'Refresh clone'}
                        </button>
                        {row.status === 'ready' && (
                          <button
                            type="button"
                            className={gridStyles.buttonGhost}
                            disabled={checkDrift.isPending || checkingAllDrift}
                            onClick={() => { void handleCheckDrift(row.id); }}
                            {...{ 'data-testid': `brainstorm-repo-check-drift-${row.id}` }}
                          >
                            Check drift
                          </button>
                        )}
                        <button
                          type="button"
                          className={styles.dangerGhost}
                          disabled={isCloning || deleteRepo.isPending}
                          onClick={() => {
                            setDeleteError(null);
                            setDeletingRepo(row);
                          }}
                          {...{ 'data-testid': `brainstorm-repo-delete-${row.id}` }}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {deletingRepo && (
        // data-testid-exempt — DeleteRepositoryModal root owns brainstorm-repo-delete-modal
        <DeleteRepositoryModal
          repository={deletingRepo}
          pending={deleteRepo.isPending}
          error={deleteError}
          onCancel={() => {
            setDeletingRepo(null);
            setDeleteError(null);
          }}
          onConfirm={() => { void handleConfirmDelete(); }}
        />
      )}
    </section>
  );
};

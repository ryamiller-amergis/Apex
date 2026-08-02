import React, { useMemo, useState } from 'react';
import type { WalkthroughDefinition, WalkthroughLifecycle } from '../../shared/types/walkthrough';
import { useArchiveWalkthrough, useWalkthroughCatalog } from '../hooks/usePlatformAdminWalkthroughs';
import { DataGridFilterPills, DataGridToolbar } from './DataGridToolbar';
import { ManualWalkthroughEditor } from './ManualWalkthroughEditor';
import gridStyles from './DataGrid.module.css';
import catalogStyles from './WalkthroughCatalog.module.css';

type LifecycleFilter = 'all' | WalkthroughLifecycle;

const LIFECYCLE_FILTERS: readonly { label: string; value: LifecycleFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'Draft', value: 'draft' },
  { label: 'Published', value: 'published' },
  { label: 'Archived', value: 'archived' },
];

interface ArchiveWalkthroughModalProps {
  walkthrough: WalkthroughDefinition;
  onClose: () => void;
  onArchived: () => void;
}

const ArchiveWalkthroughModal: React.FC<ArchiveWalkthroughModalProps> = ({
  walkthrough,
  onClose,
  onArchived,
}) => {
  const archiveMutation = useArchiveWalkthrough();
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    setError(null);
    try {
      await archiveMutation.mutateAsync({
        id: walkthrough.id,
        expectedUpdatedAt: walkthrough.updatedAt,
      });
      onArchived();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to archive walkthrough');
    }
  };

  return (
    <div
      className={catalogStyles.modalOverlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="walkthrough-archive-title"
      {...{ 'data-testid': 'walkthrough-catalog-archive-modal' }}
    >
      <div className={catalogStyles.modalCard}>
        <h3 id="walkthrough-archive-title" className={catalogStyles.modalTitle}>
          Archive walkthrough?
        </h3>
        <p className={catalogStyles.modalBody}>
          <strong>{walkthrough.internalName}</strong> will be archived and hidden from end-user
          help. You can still view it in the archived filter.
        </p>
        {error && (
          <p className={catalogStyles.modalError} role="alert">
            {error}
          </p>
        )}
        <div className={catalogStyles.modalActions}>
          <button type="button" className={gridStyles.button} onClick={onClose} {...{ 'data-testid': 'walkthrough-catalog-archive-cancel' }}>
            Cancel
          </button>
          <button
            type="button"
            className={catalogStyles.modalDanger}
            disabled={archiveMutation.isPending}
            onClick={() => void handleConfirm()}
            {...{ 'data-testid': 'walkthrough-catalog-archive-confirm' }}
          >
            {archiveMutation.isPending ? 'Archiving…' : 'Archive'}
          </button>
        </div>
      </div>
    </div>
  );
};

export const WalkthroughCatalog: React.FC = () => {
  const [lifecycleFilter, setLifecycleFilter] = useState<LifecycleFilter>('all');
  const [search, setSearch] = useState('');
  const catalogQuery = useWalkthroughCatalog({
    limit: 50,
    lifecycle: lifecycleFilter === 'all' ? undefined : lifecycleFilter,
  });
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [archiving, setArchiving] = useState<WalkthroughDefinition | null>(null);

  const items = useMemo(
    () => catalogQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [catalogQuery.data?.pages],
  );

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (item) =>
        item.internalName.toLowerCase().includes(q) ||
        item.userTitle.toLowerCase().includes(q),
    );
  }, [items, search]);

  if (creating || editingId) {
    return (
      <div className={catalogStyles.editorOverlay}>
        <ManualWalkthroughEditor
          walkthroughId={creating ? null : editingId}
          onClose={() => {
            setCreating(false);
            setEditingId(null);
          }}
          onSaved={(saved) => {
            setCreating(false);
            setEditingId(saved.id);
          }}
        />
      </div>
    );
  }

  return (
    <section className={gridStyles.section} {...{ 'data-testid': 'walkthrough-catalog' }}>
      <div className={gridStyles.header}>
        <div>
          <h2 className={gridStyles.title}>Walkthroughs</h2>
          <p className={gridStyles.hint}>
            Create and manage in-app walkthrough guides for project audiences.
          </p>
        </div>
        <button
          type="button"
          className={gridStyles.buttonPrimary}
          {...{ 'data-testid': 'walkthrough-create' }}
          onClick={() => setCreating(true)}
        >
          Create Walkthrough
        </button>
      </div>

      <DataGridToolbar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search walkthroughs…"
        searchTestId="walkthrough-catalog-search"
      >
        <DataGridFilterPills
          options={LIFECYCLE_FILTERS}
          value={lifecycleFilter}
          onChange={setLifecycleFilter}
          testIdPrefix="walkthrough-catalog-filter-lifecycle"
          aria-label="Lifecycle"
          {...{ 'data-testid': 'walkthrough-catalog-lifecycle-filters' }}
        />
      </DataGridToolbar>

      {catalogQuery.isLoading && (
        <p className={gridStyles.loading} {...{ 'data-testid': 'walkthrough-catalog-loading' }}>
          Loading walkthroughs…
        </p>
      )}
      {catalogQuery.isError && (
        <p className={gridStyles.error} role="alert">
          {catalogQuery.error instanceof Error
            ? catalogQuery.error.message
            : 'Failed to load walkthroughs'}
        </p>
      )}

      {!catalogQuery.isLoading && !catalogQuery.isError && filteredItems.length === 0 && (
        <p className={gridStyles.empty} {...{ 'data-testid': 'walkthrough-catalog-empty' }}>
          {search.trim()
            ? `No walkthroughs match "${search.trim()}".`
            : 'No walkthroughs yet. Create one to get started.'}
        </p>
      )}

      {filteredItems.length > 0 && (
        <div className={gridStyles.tableWrap}>
          <table className={gridStyles.table} {...{ 'data-testid': 'walkthrough-catalog-table' }}>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">User title</th>
                <th scope="col">Lifecycle</th>
                <th scope="col">Priority</th>
                <th scope="col">Steps</th>
                <th scope="col">Updated</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.map((item: WalkthroughDefinition) => (
                <tr
                  key={item.id}
                  {...{ 'data-testid': `walkthrough-catalog-row-${item.id}` }}
                >
                  <td className={catalogStyles.nameCell}>{item.internalName}</td>
                  <td>{item.userTitle}</td>
                  <td>
                    <span
                      className={`${catalogStyles.lifecycle} ${
                        item.lifecycle === 'published'
                          ? catalogStyles.lifecyclePublished
                          : item.lifecycle === 'archived'
                            ? catalogStyles.lifecycleArchived
                            : catalogStyles.lifecycleDraft
                      }`}
                    >
                      {item.lifecycle}
                    </span>
                  </td>
                  <td>{item.priority}</td>
                  <td>{item.steps.length}</td>
                  <td>{new Date(item.updatedAt).toLocaleString()}</td>
                  <td>
                    <div className={gridStyles.rowActions}>
                      <button
                        type="button"
                        className={gridStyles.buttonGhost}
                        onClick={() => setEditingId(item.id)}
                        {...{ 'data-testid': `walkthrough-catalog-edit-${item.id}` }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className={gridStyles.buttonGhost}
                        disabled={item.lifecycle === 'archived'}
                        onClick={() => setArchiving(item)}
                        {...{ 'data-testid': `walkthrough-catalog-archive-${item.id}` }}
                      >
                        Archive
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {catalogQuery.hasNextPage && (
        <button
          type="button"
          className={gridStyles.loadMore}
          disabled={catalogQuery.isFetchingNextPage}
          onClick={() => catalogQuery.fetchNextPage()}
          {...{ 'data-testid': 'walkthrough-catalog-load-more' }}
        >
          {catalogQuery.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}

      {archiving && (
        // data-testid-exempt — ArchiveWalkthroughModal root already exposes walkthrough-catalog-archive-modal
        <ArchiveWalkthroughModal
          walkthrough={archiving}
          onClose={() => setArchiving(null)}
          onArchived={() => setArchiving(null)}
        />
      )}
    </section>
  );
};

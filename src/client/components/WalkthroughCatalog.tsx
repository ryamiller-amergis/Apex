import React, { useMemo } from 'react';
import type { WalkthroughDefinition } from '../../shared/types/walkthrough';
import {
  useWalkthroughCatalog,
} from '../hooks/usePlatformAdminWalkthroughs';
import { ManualWalkthroughEditor } from './ManualWalkthroughEditor';
import styles from './WalkthroughCatalog.module.css';

export const WalkthroughCatalog: React.FC = () => {
  const catalogQuery = useWalkthroughCatalog({ limit: 50 });
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);

  const items = useMemo(
    () => catalogQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [catalogQuery.data?.pages],
  );

  if (creating || editingId) {
    return (
      <div className={styles.editorOverlay}>
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
    <section className={styles.catalog} {...{ 'data-testid': 'walkthrough-catalog' }}>
      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>Walkthroughs</h2>
          <p className={styles.hint}>Create and manage in-app walkthrough guides for project audiences.</p>
        </div>
        <button
          type="button"
          className={styles.createButton}
          {...{ 'data-testid': 'walkthrough-create' }}
          onClick={() => setCreating(true)}
        >
          Create Walkthrough
        </button>
      </div>

      {catalogQuery.isLoading && <p className={styles.loading}>Loading walkthroughs…</p>}
      {catalogQuery.isError && (
        <p className={styles.error} role="alert">
          {catalogQuery.error instanceof Error ? catalogQuery.error.message : 'Failed to load walkthroughs'}
        </p>
      )}

      {!catalogQuery.isLoading && !catalogQuery.isError && items.length === 0 && (
        <p className={styles.empty}>No walkthroughs yet. Create one to get started.</p>
      )}

      {items.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">User title</th>
                <th scope="col">Lifecycle</th>
                <th scope="col">Priority</th>
                <th scope="col">Steps</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item: WalkthroughDefinition) => (
                <tr key={item.id}>
                  <td>
                    <button
                      type="button"
                      className={styles.rowButton}
                      {...{ 'data-testid': `walkthrough-catalog-row-${item.id}` }}
                      onClick={() => setEditingId(item.id)}
                    >
                      {item.internalName}
                    </button>
                  </td>
                  <td>{item.userTitle}</td>
                  <td>
                    <span
                      className={`${styles.lifecycle} ${
                        item.lifecycle === 'published'
                          ? styles.lifecyclePublished
                          : item.lifecycle === 'archived'
                            ? styles.lifecycleArchived
                            : styles.lifecycleDraft
                      }`}
                    >
                      {item.lifecycle}
                    </span>
                  </td>
                  <td>{item.priority}</td>
                  <td>{item.steps.length}</td>
                  <td>{new Date(item.updatedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {catalogQuery.hasNextPage && (
        <button
          type="button"
          className={styles.loadMore}
          disabled={catalogQuery.isFetchingNextPage}
          onClick={() => catalogQuery.fetchNextPage()}
          {...{ 'data-testid': 'walkthrough-catalog-load-more' }}
        >
          {catalogQuery.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  );
};

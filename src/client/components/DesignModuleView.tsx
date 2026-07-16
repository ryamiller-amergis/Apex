import React, { useEffect, useState } from 'react';
import { getDesignModuleIcon } from '../config/designModuleIcons';
import { useAppShell } from '../hooks/useAppShell';
import {
  useDeleteDesignModule,
  useDesignModule,
  useDesignModules,
  useRegenerateDesignModule,
} from '../hooks/useDesignModules';
import { DesignModuleFormModal } from './DesignModuleFormModal';
import { MarkdownWithMermaid } from './MarkdownWithMermaid';
import styles from './DesignModuleView.module.css';

interface DesignModuleViewProps {
  selectedProject: string;
}

export const DesignModuleView: React.FC<DesignModuleViewProps> = ({
  selectedProject,
}) => {
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [formMode, setFormMode] = useState<'create' | 'edit' | null>(null);
  const [forceRegeneration, setForceRegeneration] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const modulesQuery = useDesignModules();
  const moduleQuery = useDesignModule(selectedSlug);
  const regenerate = useRegenerateDesignModule();
  const deleteModule = useDeleteDesignModule();
  const { can } = useAppShell();

  const modules = modulesQuery.data ?? [];
  const activeModule = moduleQuery.data ?? null;
  const canManage = can('design-module:manage');
  const canRegenerate = can('design-module:regenerate');

  useEffect(() => {
    if (!selectedSlug && modules.length > 0) setSelectedSlug(modules[0].slug);
    if (
      selectedSlug &&
      modules.length > 0 &&
      !modules.some((module) => module.slug === selectedSlug)
    ) {
      setSelectedSlug(modules[0].slug);
    }
  }, [modules, selectedSlug]);

  useEffect(() => {
    setForceRegeneration(false);
    setNotice(null);
  }, [selectedSlug]);

  const handleRegenerate = async (): Promise<void> => {
    if (!activeModule) return;
    setNotice(null);
    const result = await regenerate.mutateAsync({
      slug: activeModule.slug,
      input: { project: selectedProject, force: forceRegeneration },
    });
    setNotice(
      result.started
        ? 'Generation started. This page will refresh when the architecture document is ready.'
        : 'The source has not changed, so no AI generation was started.'
    );
  };

  const handleDelete = async (): Promise<void> => {
    if (!activeModule) return;
    const confirmed = window.confirm(
      `Delete the "${activeModule.label}" architecture module?`
    );
    if (!confirmed) return;
    await deleteModule.mutateAsync(activeModule.slug);
    setSelectedSlug(null);
  };

  return (
    <main className={styles.layout}>
      <aside className={styles.rail} aria-label="Architecture modules">
        <div className={styles.railHeader}>
          <div>
            <h1>Design Module</h1>
            <p>Architecture Explorer</p>
          </div>
          {canManage && (
            <button
              type="button"
              className={styles.addButton}
              onClick={() => setFormMode('create')}
            >
              Add Module
            </button>
          )}
        </div>

        {modulesQuery.isLoading ? (
          <div className={styles.railMessage}>Loading modules…</div>
        ) : modulesQuery.error ? (
          <div className={styles.error}>{modulesQuery.error.message}</div>
        ) : modules.length === 0 ? (
          <div className={styles.railMessage}>
            No architecture modules are configured.
          </div>
        ) : (
          <div className={styles.moduleList}>
            {modules.map((module) => {
              const Icon = getDesignModuleIcon(module.iconKey);
              return (
                <button
                  key={module.slug}
                  type="button"
                  className={`${styles.moduleButton} ${selectedSlug === module.slug ? styles.active : ''}`}
                  onClick={() => setSelectedSlug(module.slug)}
                >
                  <span className={styles.moduleIcon}>
                    <Icon size={22} />
                  </span>
                  <span>
                    <strong>{module.label}</strong>
                    <small>{module.description}</small>
                  </span>
                  {module.isStale && (
                    <span
                      className={styles.staleDot}
                      title="May be out of date"
                    />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </aside>

      <section className={styles.content}>
        {moduleQuery.isLoading && selectedSlug ? (
          <div className={styles.empty}>Loading architecture…</div>
        ) : moduleQuery.error ? (
          <div className={styles.error}>{moduleQuery.error.message}</div>
        ) : !activeModule ? (
          <div className={styles.empty}>
            Select a module to explore its architecture.
          </div>
        ) : (
          <>
            <header className={styles.contentHeader}>
              <div>
                <div className={styles.titleRow}>
                  <h2>{activeModule.label}</h2>
                  {activeModule.isStale && (
                    <span className={styles.staleBadge}>
                      May be out of date
                    </span>
                  )}
                </div>
                {activeModule.description && <p>{activeModule.description}</p>}
                <div className={styles.meta}>
                  {activeModule.lastGeneratedAt
                    ? `Last generated ${new Date(activeModule.lastGeneratedAt).toLocaleString()}`
                    : 'Curated architecture document'}
                  {!activeModule.sourceAvailable &&
                    ' · Local source unavailable'}
                </div>
              </div>
              <div className={styles.headerActions}>
                {canManage && (
                  <>
                    <button
                      type="button"
                      className={styles.secondary}
                      onClick={() => setFormMode('edit')}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className={styles.danger}
                      onClick={handleDelete}
                      disabled={deleteModule.isPending}
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            </header>

            {canRegenerate && (
              <div className={styles.generationBar}>
                <div>
                  <strong>
                    {activeModule.hasContent
                      ? 'Regenerate from source'
                      : 'Generate content'}
                  </strong>
                  <span>
                    AI runs only when source changed unless force is enabled.
                  </span>
                </div>
                <label className={styles.force}>
                  <input
                    type="checkbox"
                    checked={forceRegeneration}
                    onChange={(event) =>
                      setForceRegeneration(event.target.checked)
                    }
                  />
                  Force
                </label>
                <button
                  type="button"
                  className={styles.primary}
                  onClick={handleRegenerate}
                  disabled={
                    regenerate.isPending ||
                    (!activeModule.isStale && !forceRegeneration)
                  }
                >
                  {regenerate.isPending
                    ? 'Starting…'
                    : activeModule.hasContent
                      ? 'Regenerate'
                      : 'Generate'}
                </button>
              </div>
            )}

            {notice && <div className={styles.notice}>{notice}</div>}
            {regenerate.error && (
              <div className={styles.error}>{regenerate.error.message}</div>
            )}
            {deleteModule.error && (
              <div className={styles.error}>{deleteModule.error.message}</div>
            )}

            <article className={styles.document}>
              {activeModule.content ? (
                <MarkdownWithMermaid content={activeModule.content} />
              ) : (
                <div className={styles.emptyDocument}>
                  <h3>No architecture content yet</h3>
                  <p>
                    Generate this module from its curated source scope to create
                    the first document.
                  </p>
                </div>
              )}
            </article>
          </>
        )}
      </section>

      {formMode && (
        <DesignModuleFormModal
          module={formMode === 'edit' ? activeModule : null}
          onClose={() => setFormMode(null)}
          onSaved={(slug) => {
            setSelectedSlug(slug);
            setFormMode(null);
          }}
        />
      )}
    </main>
  );
};

export default DesignModuleView;

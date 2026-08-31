import React, { useState } from 'react';
import { useAppShell } from '../hooks/useAppShell';
import {
  useUiLabDesigns,
  useCreateUiLabDesign,
} from '../hooks/useUiLab';
import type { UiLabDesignSummary } from '../../shared/types/uiLab';
import styles from './UiLabView.module.css';
import { UiLabCanvas } from './UiLabCanvas';

const SIDEBAR_COLLAPSED_KEY = 'apex-ui-lab-sidebar-collapsed';

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

interface ComposerProps {
  project: string;
  onCreated: (id: string) => void;
  onCancel?: () => void;
}

const Composer: React.FC<ComposerProps> = ({ project, onCreated, onCancel }) => {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [targetRoute, setTargetRoute] = useState('');
  const create = useCreateUiLabDesign();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !prompt.trim()) return;
    const design = await create.mutateAsync({
      project,
      title: title.trim(),
      prompt: prompt.trim(),
      targetRoute: targetRoute.trim() || null,
    });
    onCreated(design.id);
  };

  return (
    <div className={styles.composerWrapper}>
      <form className={styles.composer} onSubmit={handleSubmit} data-testid="ui-lab-composer-form">
        <h2 className={styles.composerHeading}>New UI Design</h2>
        <p className={styles.composerSub}>
          Describe the screen or component you want to create. The design system, colors, and MaxView components will be applied automatically.
        </p>
        <div className={styles.composerField}>
          <label className={styles.composerLabel} htmlFor="ui-lab-title">Title</label>
          <input
            id="ui-lab-title"
            className={styles.composerInput}
            placeholder="e.g. User Settings Page"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
            required
            data-testid="ui-lab-title-input"
          />
        </div>
        <div className={styles.composerField}>
          <label className={styles.composerLabel} htmlFor="ui-lab-prompt">Describe the design</label>
          <textarea
            id="ui-lab-prompt"
            className={styles.composerTextarea}
            placeholder="Describe the screen, interactions, data shown, and any specific requirements…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            required
            data-testid="ui-lab-prompt-input"
          />
        </div>
        <div className={styles.composerField}>
          <label className={styles.composerLabel} htmlFor="ui-lab-route">
            Target route <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(optional)</span>
          </label>
          <input
            id="ui-lab-route"
            className={styles.composerInput}
            placeholder="e.g. /settings/profile"
            value={targetRoute}
            onChange={(e) => setTargetRoute(e.target.value)}
            data-testid="ui-lab-route-input"
          />
        </div>
        <div className={styles.composerActions}>
          {onCancel && (
            <button type="button" className={styles.cancelBtn} onClick={onCancel} data-testid="ui-lab-composer-cancel-btn">
              Cancel
            </button>
          )}
          <button
            type="submit"
            className={styles.generateBtn}
            disabled={create.isPending || !title.trim() || !prompt.trim()}
            data-testid="ui-lab-composer-submit-btn"
          >
            {create.isPending ? 'Creating…' : 'Generate Design'}
          </button>
        </div>
        {create.isError && (
          <p style={{ color: 'var(--error-color)', fontSize: 13 }}>
            {create.error.message}
          </p>
        )}
      </form>
    </div>
  );
};

interface UiLabViewProps {
  project: string;
  /** Optional deep-linked design id from `/ui-lab/:id`. */
  initialDesignId?: string | null;
  /** When true, render only the shared canvas (no project design list). */
  sharedMode?: boolean;
}

export const UiLabView: React.FC<UiLabViewProps> = ({
  project,
  initialDesignId = null,
  sharedMode = false,
}) => {
  const { can } = useAppShell();
  const { data: designs = [], isLoading } = useUiLabDesigns(sharedMode ? null : project);

  const [selectedId, setSelectedId] = useState<string | null>(initialDesignId);
  const [showComposer, setShowComposer] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const toggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next)); } catch { /* noop */ }
      return next;
    });
  };

  React.useEffect(() => {
    if (initialDesignId) setSelectedId(initialDesignId);
  }, [initialDesignId]);

  const handleCreated = (id: string) => {
    setShowComposer(false);
    setSelectedId(id);
  };

  const handleDeleted = () => {
    setSelectedId(null);
  };

  if (sharedMode && selectedId) {
    return (
      <UiLabCanvas
        key={selectedId}
        designId={selectedId}
        project={project}
        sharedMode
      />
    );
  }

  if (!can('ui-lab:view')) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
        You don&apos;t have permission to view the UI Lab.
      </div>
    );
  }

  return (
    <div className={styles.root} data-testid="ui-lab-workspace">
      <div className={`${styles.sidebar}${sidebarCollapsed ? ` ${styles.sidebarCollapsed}` : ''}`}>
        {sidebarCollapsed ? (
          <div className={styles.sidebarStrip}>
            <button
              type="button"
              className={styles.sidebarStripBtn}
              onClick={toggleSidebar}
              title="Show design list"
              aria-label="Show design list"
              aria-expanded={false}
              data-testid="ui-lab-sidebar-expand"
            >
              ›
            </button>
            <span className={styles.sidebarStripLabel}>Designs</span>
            {designs.length > 0 && (
              <span className={styles.sidebarStripBadge}>{designs.length}</span>
            )}
          </div>
        ) : (
          <>
            <div className={styles.sidebarHeader}>
              <h2 className={styles.sidebarTitle}>UI Lab</h2>
              <div className={styles.sidebarHeaderActions}>
                {can('ui-lab:manage') && (
                  <button
                    className={styles.newBtn}
                    onClick={() => { setShowComposer(true); setSelectedId(null); }}
                    data-testid="ui-lab-new-design-btn"
                  >
                    + New
                  </button>
                )}
                <button
                  type="button"
                  className={styles.sidebarCollapseBtn}
                  onClick={toggleSidebar}
                  title="Collapse design list"
                  aria-label="Collapse design list"
                  aria-expanded
                  data-testid="ui-lab-sidebar-collapse"
                >
                  ‹
                </button>
              </div>
            </div>

            <div className={styles.designList}>
              {isLoading && (
                <p className={styles.emptyList}>Loading…</p>
              )}
              {!isLoading && designs.length === 0 && (
                <p className={styles.emptyList}>
                  No designs yet.{can('ui-lab:manage') ? '\n\nClick "+ New" to create your first design.' : ''}
                </p>
              )}
              {designs.map((d: UiLabDesignSummary) => (
                <div
                  key={d.id}
                  className={`${styles.designItem} ${d.id === selectedId ? styles.active : ''}`}
                  onClick={() => { setSelectedId(d.id); setShowComposer(false); }}
                  data-testid={`ui-lab-design-item-${d.id}`}
                >
                  <div>
                    <div className={`${styles.statusDot} ${styles[d.status]}`} style={{ marginTop: 6 }} />
                  </div>
                  <div className={styles.designItemInfo}>
                    <div className={styles.designItemTitle}>{d.title}</div>
                    <div className={styles.designItemPrompt}>{d.prompt}</div>
                    <div className={styles.designItemMeta}>
                      {d.targetRoute && <span>{d.targetRoute}</span>}
                      <span>{formatRelative(d.createdAt)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {showComposer ? (
        <Composer
          project={project}
          onCreated={handleCreated}
          onCancel={designs.length > 0 ? () => setShowComposer(false) : undefined}
        />
      ) : selectedId ? (
        <UiLabCanvas
          key={selectedId}
          designId={selectedId}
          project={project}
          onDeleted={handleDeleted}
        />
      ) : (
        <div className={styles.composerWrapper}>
          <div style={{ textAlign: 'center' }}>
            {can('ui-lab:manage') ? (
              <>
                <p style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
                  Your design canvas
                </p>
                <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 20 }}>
                  Generate interactive UI designs powered by the MaxView design system.
                </p>
                <button
                  className={styles.generateBtn}
                  onClick={() => setShowComposer(true)}
                  data-testid="ui-lab-create-first-design-btn"
                >
                  + Create your first design
                </button>
              </>
            ) : (
              <p style={{ color: 'var(--text-muted)' }}>Select a design from the sidebar.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default UiLabView;

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useAppShell } from '../hooks/useAppShell';
import {
  useUiLabDesigns,
  useUiLabDesign,
  useUiLabComments,
  useCreateUiLabDesign,
  useDeleteUiLabDesign,
  useAddUiLabComment,
  useResolveUiLabComment,
  useUiLabStream,
} from '../hooks/useUiLab';
import type { UiLabDesignSummary, RegenerateUiLabDesignRequest } from '../../shared/types/uiLab';
import styles from './UiLabView.module.css';
import { ApexLoader } from './ApexLoader';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ── Composer (new design form) ────────────────────────────────────────────────

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
    const design = await create.mutateAsync({ project, title: title.trim(), prompt: prompt.trim(), targetRoute: targetRoute.trim() || null });
    onCreated(design.id);
  };

  return (
    <div className={styles.composerWrapper}>
      <form className={styles.composer} onSubmit={handleSubmit}>
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
          />
        </div>
        <div className={styles.composerActions}>
          {onCancel && (
            <button type="button" className={styles.cancelBtn} onClick={onCancel}>
              Cancel
            </button>
          )}
          <button
            type="submit"
            className={styles.generateBtn}
            disabled={create.isPending || !title.trim() || !prompt.trim()}
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

// ── Pin overlay + comment panel ───────────────────────────────────────────────

interface CommentPanelProps {
  designId: string;
  version: number;
  pinMode: boolean;
  pendingPin: { x: number; y: number } | null;
  onCollapse: () => void;
}

const CommentPanel: React.FC<CommentPanelProps> = ({ designId, version, pinMode, pendingPin, onCollapse }) => {
  const { data: comments = [] } = useUiLabComments(designId);
  const addComment = useAddUiLabComment(designId);
  const resolveComment = useResolveUiLabComment(designId);
  const [text, setText] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    await addComment.mutateAsync({
      text: text.trim(),
      version,
      pinX: pendingPin?.x ?? null,
      pinY: pendingPin?.y ?? null,
    });
    setText('');
  };

  const open = comments.filter((c) => !c.resolved);
  const resolved = comments.filter((c) => c.resolved);

  return (
    <div className={styles.commentPanel}>
      <div className={styles.commentPanelHeader}>
        <span className={styles.commentPanelTitle}>
          Comments {open.length > 0 ? `(${open.length})` : ''}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {pinMode && <span style={{ fontSize: 11, color: 'var(--accent-color)' }}>Click canvas to pin</span>}
          <button className={styles.commentPanelCloseBtn} onClick={onCollapse} title="Collapse comments">›</button>
        </div>
      </div>

      <div className={styles.commentList}>
        {open.length === 0 && resolved.length === 0 && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px', textAlign: 'center' }}>
            No comments yet. {pinMode ? 'Click on the canvas to place a pin.' : 'Enable pin mode to place comments on the design.'}
          </p>
        )}
        {[...open, ...resolved].map((c, i) => (
          <div key={c.id} className={`${styles.commentCard} ${c.resolved ? styles.resolved : ''}`}>
            {(c.pinX != null && c.pinY != null) && (
              <div style={{ fontSize: 11, color: 'var(--accent-color)', marginBottom: 4 }}>
                #{i + 1} pin
              </div>
            )}
            <div className={styles.commentText}>{c.text}</div>
            <div className={styles.commentMeta}>
              <span>{formatRelative(c.createdAt)}</span>
              <button
                className={styles.commentResolveBtn}
                onClick={() => resolveComment.mutate({ commentId: c.id, reopen: c.resolved })}
              >
                {c.resolved ? 'Reopen' : 'Resolve'}
              </button>
            </div>
          </div>
        ))}
      </div>

      <form className={styles.commentInput} onSubmit={handleSubmit}>
        {pendingPin && (
          <div style={{ fontSize: 11, color: 'var(--accent-color)', marginBottom: 4 }}>
            Pinned at ({Math.round(pendingPin.x)}%, {Math.round(pendingPin.y)}%)
          </div>
        )}
        <textarea
          className={styles.commentTextarea}
          placeholder="Add a comment…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
        />
        <button
          type="submit"
          className={styles.commentSubmitBtn}
          disabled={!text.trim() || addComment.isPending}
        >
          {addComment.isPending ? '…' : 'Comment'}
        </button>
      </form>
    </div>
  );
};

// ── Canvas (iframe + overlay + feedback bar) ──────────────────────────────────

interface CanvasProps {
  designId: string;
  project: string;
  onDeleted: () => void;
}

const Canvas: React.FC<CanvasProps> = ({ designId, project, onDeleted }) => {
  const { data: design, isLoading } = useUiLabDesign(designId);
  const { data: comments = [] } = useUiLabComments(designId);
  const deleteDesign = useDeleteUiLabDesign(project);

  const [showComments, setShowComments] = useState(true);
  const [pinMode, setPinMode] = useState(false);
  const [pendingPin, setPendingPin] = useState<{ x: number; y: number } | null>(null);
  const [feedback, setFeedback] = useState('');
  const [scopedSelector, setScopedSelector] = useState<string | null>(null);
  const [scopedHtml, setScopedHtml] = useState<string | null>(null);
  const [viewingVersion, setViewingVersion] = useState<number | null>(null);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const stream = useUiLabStream(useCallback(() => {
    // invalidation handled by hook
  }, []));

  // Auto-start streaming when design is in 'generating' status
  useEffect(() => {
    if (design?.status === 'generating' && stream.phase === 'idle') {
      stream.startStream(designId, 'generate');
    }
  }, [design?.status, designId, stream]);

  // Return to current version whenever a regeneration completes
  useEffect(() => {
    setViewingVersion(null);
  }, [design?.version]);

  const handlePinClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!pinMode || !overlayRef.current) return;
    const rect = overlayRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    setPendingPin({ x, y });
    setPinMode(false);
  }, [pinMode]);

  const handleRegenerate = () => {
    if (!feedback.trim()) return;
    const body: RegenerateUiLabDesignRequest = {
      feedback: feedback.trim(),
      selectedSelector: scopedSelector ?? undefined,
      selectedHtml: scopedHtml ?? undefined,
    };
    setFeedback('');
    setScopedSelector(null);
    setScopedHtml(null);
    stream.startStream(designId, 'regenerate', body);
  };

  const handleDelete = async () => {
    if (!window.confirm(`Delete "${design?.title}"? This cannot be undone.`)) return;
    await deleteDesign.mutateAsync(designId);
    onDeleted();
  };

  const isActive = design?.status === 'generating' || design?.status === 'streaming' || stream.phase === 'streaming';
  const html = design?.html;
  const isViewingHistory = viewingVersion !== null;
  const historyEntry = isViewingHistory
    ? (design?.history ?? []).find(h => h.version === viewingVersion) ?? null
    : null;
  const viewHtml = isViewingHistory ? (historyEntry?.html ?? null) : html;

  if (isLoading) {
    return (
      <div className={styles.main} style={{ alignItems: 'center', justifyContent: 'center' }}>
        <ApexLoader size={72} />
      </div>
    );
  }

  if (!design) return null;

  return (
    <div className={styles.main}>
      {/* Header */}
      <div className={styles.canvasHeader}>
        <span className={styles.canvasTitle}>{design.title}</span>
        <span className={`${styles.canvasStatusBadge} ${styles[design.status]}`}>
          {design.status === 'ready' ? `v${design.version}` : design.status}
        </span>

        {/* Version history dropdown — only when previous versions exist */}
        {design.history.length > 0 && (
          <select
            className={styles.versionSelect}
            value={viewingVersion ?? design.version}
            onChange={(e) => {
              const v = Number(e.target.value);
              setViewingVersion(v === design.version ? null : v);
            }}
            title="Browse version history"
          >
            <option value={design.version}>v{design.version} (current)</option>
            {[...design.history]
              .filter(h => h.version !== design.version)
              .sort((a, b) => b.version - a.version)
              .map(h => (
                <option key={h.version} value={h.version}>
                  v{h.version}
                  {h.feedback
                    ? ` — ${h.feedback.slice(0, 38)}${h.feedback.length > 38 ? '…' : ''}`
                    : ` — ${formatRelative(h.createdAt)}`}
                </option>
              ))}
          </select>
        )}

        <div className={styles.headerActions}>
          <button
            className={`${styles.headerBtn} ${pinMode ? styles.active : ''}`}
            onClick={() => { setPinMode((p) => !p); setPendingPin(null); }}
            disabled={isActive || !html}
            title="Pin a comment on the canvas"
          >
            📌 Pin
          </button>
          <button
            className={`${styles.headerBtn} ${showComments ? styles.active : ''}`}
            onClick={() => setShowComments((s) => !s)}
            title="Toggle comment panel"
          >
            💬 Comments {comments.filter((c) => !c.resolved).length > 0 ? `(${comments.filter((c) => !c.resolved).length})` : ''}
          </button>
          <button
            className={styles.headerBtnDanger}
            onClick={handleDelete}
            disabled={deleteDesign.isPending}
            title="Delete this design"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Feedback / regenerate bar — sits above the canvas */}
      {isViewingHistory ? (
        <div className={styles.historyBanner}>
          <span>
            Viewing <strong>v{viewingVersion}</strong>
            {historyEntry?.feedback && (
              <> — <em>{historyEntry.feedback}</em></>
            )}
          </span>
          <button
            className={styles.historyBannerReturnBtn}
            onClick={() => setViewingVersion(null)}
          >
            ← Return to current (v{design.version})
          </button>
        </div>
      ) : (
        html && design.status !== 'generation_failed' && (
          <div className={styles.feedbackBar}>
          {scopedSelector && (
            <>
              <span className={styles.scopedEditBadge} title={scopedSelector}>
                Scoped: {scopedSelector}
              </span>
              <button className={styles.clearScopeBtn} onClick={() => { setScopedSelector(null); setScopedHtml(null); }}>✕</button>
            </>
          )}
          <textarea
            className={styles.feedbackInput}
            placeholder={scopedSelector ? 'Describe changes for selected element…' : 'Describe changes across the whole design, or select a region to scope your edit…'}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleRegenerate();
            }}
          />
          <button
            className={styles.feedbackSendBtn}
            onClick={handleRegenerate}
            disabled={!feedback.trim() || isActive}
          >
            {isActive ? '…' : '↑ Apply'}
          </button>
        </div>
      )
      )}

      {/* Body */}
      <div className={styles.canvasBody}>
        <div className={styles.canvasPreview}>
          {isActive && !isViewingHistory && (
            <div className={styles.streamingOverlay}>
              <ApexLoader size={88} />
            </div>
          )}

          {design.status === 'generation_failed' && (
            <div className={styles.errorPanel}>
              <span className={styles.errorIcon}>⚠️</span>
              <p className={styles.errorMessage}>{design.generationError ?? 'Generation failed.'}</p>
              <button
                className={styles.retryBtn}
                onClick={() => stream.startStream(designId, 'generate')}
              >
                Retry
              </button>
            </div>
          )}

          {viewHtml && (
            <div className={styles.iframeWrap}>
              <iframe
                ref={iframeRef}
                className={styles.mockIframe}
                srcDoc={viewHtml}
                sandbox="allow-scripts"
                title={design.title}
              />
              {/* Pin overlay */}
              <div
                ref={overlayRef}
                className={`${styles.pinOverlay} ${pinMode ? styles.pinModeActive : ''}`}
                onClick={handlePinClick}
              >
                {comments.filter((c) => c.pinX != null && c.pinY != null).map((c, i) => (
                  <div
                    key={c.id}
                    className={`${styles.pinMarker} ${c.resolved ? styles.resolved : ''}`}
                    style={{ left: `${c.pinX}%`, top: `${c.pinY}%` }}
                    title={c.text}
                  >
                    <div className={styles.pinCircle}>{i + 1}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Comment panel — collapsible strip on the right */}
        <div className={`${styles.commentPanelWrap}${!showComments ? ` ${styles.commentPanelWrapCollapsed}` : ''}`}>
          {showComments ? (
            <CommentPanel
              designId={designId}
              version={design.version}
              pinMode={pinMode}
              pendingPin={pendingPin}
              onCollapse={() => setShowComments(false)}
            />
          ) : (
            <div className={styles.commentPanelStrip}>
              <button
                className={styles.commentPanelStripBtn}
                onClick={() => setShowComments(true)}
                title="Show comments"
              >
                ‹
              </button>
              <span className={styles.commentPanelStripLabel}>Comments</span>
              {comments.filter((c) => !c.resolved).length > 0 && (
                <span className={styles.commentPanelStripBadge}>
                  {comments.filter((c) => !c.resolved).length}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

    </div>
  );
};

// ── Root view ─────────────────────────────────────────────────────────────────

interface UiLabViewProps {
  project: string;
}

export const UiLabView: React.FC<UiLabViewProps> = ({ project }) => {
  const { can } = useAppShell();
  const { data: designs = [], isLoading } = useUiLabDesigns(project);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showComposer, setShowComposer] = useState(false);

  const handleCreated = (id: string) => {
    setShowComposer(false);
    setSelectedId(id);
  };

  const handleDeleted = () => {
    setSelectedId(null);
  };

  if (!can('ui-lab:view')) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
        You don't have permission to view the UI Lab.
      </div>
    );
  }

  return (
    <div className={styles.root}>
      {/* Sidebar */}
      <div className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <h2 className={styles.sidebarTitle}>UI Lab</h2>
          {can('ui-lab:manage') && (
            <button
              className={styles.newBtn}
              onClick={() => { setShowComposer(true); setSelectedId(null); }}
            >
              + New
            </button>
          )}
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
      </div>

      {/* Main content */}
      {showComposer ? (
        <Composer
          project={project}
          onCreated={handleCreated}
          onCancel={designs.length > 0 ? () => setShowComposer(false) : undefined}
        />
      ) : selectedId ? (
        <Canvas
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
                <button className={styles.generateBtn} onClick={() => setShowComposer(true)}>
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

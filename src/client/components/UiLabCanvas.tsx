import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { RegenerateUiLabDesignRequest, UiLabCapabilities } from '../../shared/types/uiLab';
import { capabilitiesForAccess, uiLabShareDeepLink } from '../../shared/types/uiLab';
import {
  useAddUiLabComment,
  useDeleteUiLabDesign,
  useResolveUiLabComment,
  useSaveUiLabHtml,
  useUiLabComments,
  useUiLabDesign,
  useUiLabStream,
} from '../hooks/useUiLab';
import { ApexLoader } from './ApexLoader';
import ShareUiLabDialog from './ShareUiLabDialog';
import styles from './UiLabView.module.css';

const BoundaryEditor = lazy(() => import('./BoundaryEditor'));

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

interface CommentPanelProps {
  designId: string;
  version: number;
  pinMode: boolean;
  pendingPin: { x: number; y: number } | null;
  canResolveComments: boolean;
  canComment: boolean;
  onCollapse: () => void;
  onCommentAdded: () => void;
}

const CommentPanel: React.FC<CommentPanelProps> = ({
  designId,
  version,
  pinMode,
  pendingPin,
  canResolveComments,
  canComment,
  onCollapse,
  onCommentAdded,
}) => {
  const { data: comments = [] } = useUiLabComments(designId);
  const addComment = useAddUiLabComment(designId);
  const resolveComment = useResolveUiLabComment(designId);
  const [text, setText] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || !canComment) return;
    await addComment.mutateAsync({
      text: text.trim(),
      version,
      pinX: pendingPin?.x ?? null,
      pinY: pendingPin?.y ?? null,
    });
    setText('');
    onCommentAdded();
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
              {canResolveComments && (
                <button
                  className={styles.commentResolveBtn}
                  onClick={() => resolveComment.mutate({ commentId: c.id, reopen: c.resolved })}
                >
                  {c.resolved ? 'Reopen' : 'Resolve'}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {canComment && (
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
      )}
    </div>
  );
};

export interface UiLabCanvasProps {
  designId: string;
  project: string;
  /** When true, omit delete navigation callbacks that only apply in the workspace list. */
  sharedMode?: boolean;
  onDeleted?: () => void;
}

export const UiLabCanvas: React.FC<UiLabCanvasProps> = ({
  designId,
  project,
  sharedMode = false,
  onDeleted,
}) => {
  const { data: design, isLoading, isError, error } = useUiLabDesign(designId);
  const { data: comments = [] } = useUiLabComments(designId);
  const deleteDesign = useDeleteUiLabDesign(project);
  const saveHtml = useSaveUiLabHtml(designId);

  const [showComments, setShowComments] = useState(true);
  const [pinMode, setPinMode] = useState(false);
  const [pendingPin, setPendingPin] = useState<{ x: number; y: number } | null>(null);
  const [feedback, setFeedback] = useState('');
  const [scopedSelector, setScopedSelector] = useState<string | null>(null);
  const [scopedHtml, setScopedHtml] = useState<string | null>(null);
  const [viewingVersion, setViewingVersion] = useState<number | null>(null);
  const [viewSource, setViewSource] = useState(false);
  const [editingBoundary, setEditingBoundary] = useState(false);
  const [showShare, setShowShare] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const stream = useUiLabStream(useCallback(() => {
    // invalidation handled by hook
  }, []));

  useEffect(() => {
    if (design?.status === 'generating' && stream.phase === 'idle' && !sharedMode) {
      stream.startStream(designId, 'generate');
    }
  }, [design?.status, designId, stream, sharedMode]);

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

  const caps: UiLabCapabilities = design?.capabilities
    ?? capabilitiesForAccess(design?.effectiveAccess ?? (sharedMode ? 'shared' : 'manage'));

  const handleRegenerate = () => {
    if (!feedback.trim() || !caps.canRegenerate) return;
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
    if (!caps.canDelete) return;
    if (!window.confirm(`Delete "${design?.title}"? This cannot be undone.`)) return;
    await deleteDesign.mutateAsync(designId);
    onDeleted?.();
  };

  const isActive = design?.status === 'generating' || design?.status === 'streaming' || stream.phase === 'streaming';
  const html = design?.html;
  const isViewingHistory = viewingVersion !== null;
  const historyEntry = isViewingHistory
    ? (design?.history ?? []).find(h => h.version === viewingVersion) ?? null
    : null;
  const viewHtml = isViewingHistory ? (historyEntry?.html ?? null) : html;
  const shareLink = design ? uiLabShareDeepLink(design.id, design.project || project) : '';

  if (isLoading) {
    return (
      <div className={styles.main} style={{ alignItems: 'center', justifyContent: 'center' }} data-testid="ui-lab-canvas-loading">
        <ApexLoader size={72} />
      </div>
    );
  }

  if (isError || !design) {
    return (
      <div className={styles.main} style={{ alignItems: 'center', justifyContent: 'center', padding: 40 }} data-testid="ui-lab-canvas-denied">
        <p style={{ color: 'var(--text-muted)', textAlign: 'center', maxWidth: 420 }}>
          {error?.message?.includes('Forbidden') || error?.message?.includes('403')
            ? 'You do not have access to this UI Lab design. Ask the owner to share it with you again.'
            : error?.message || 'This UI Lab design could not be found.'}
        </p>
      </div>
    );
  }

  if (editingBoundary && html && caps.canEditBoundary) {
    return (
      <div className={styles.main} data-testid="ui-lab-boundary-editor">
        <Suspense fallback={<div className={styles.main} style={{ alignItems: 'center', justifyContent: 'center' }}><ApexLoader size={56} /></div>}>
          <BoundaryEditor
            html={html}
            featureName={design.title}
            isSaving={saveHtml.isPending}
            onSave={(updatedHtml) => {
              saveHtml.mutate(updatedHtml, {
                onSuccess: () => setEditingBoundary(false),
              });
            }}
            onCancel={() => setEditingBoundary(false)}
          />
        </Suspense>
      </div>
    );
  }

  return (
    <div className={styles.main} data-testid="ui-lab-canvas">
      <div className={styles.canvasHeader}>
        <span className={styles.canvasTitle}>{design.title}</span>
        <span className={`${styles.canvasStatusBadge} ${styles[design.status]}`}>
          {design.status === 'ready' ? `v${design.version}` : design.status}
        </span>
        {sharedMode && (
          <span className={styles.sharedBadge} data-testid="ui-lab-shared-badge">Shared view</span>
        )}

        {(design.history?.length ?? 0) > 0 && (
          <select
            className={styles.versionSelect}
            value={viewingVersion ?? design.version}
            onChange={(e) => {
              const v = Number(e.target.value);
              setViewingVersion(v === design.version ? null : v);
              setViewSource(false);
            }}
            title="Browse version history"
            data-testid="ui-lab-version-select"
          >
            <option value={design.version}>v{design.version} (current)</option>
            {[...(design.history ?? [])]
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
          {caps.canComment && (
            <button
              className={`${styles.headerBtn} ${pinMode ? styles.active : ''}`}
              onClick={() => { setPinMode((p) => !p); setPendingPin(null); }}
              disabled={isActive || !html || viewSource}
              title="Pin a comment on the canvas"
            >
              📌 Pin
            </button>
          )}
          <button
            className={`${styles.headerBtn} ${showComments ? styles.active : ''}`}
            onClick={() => setShowComments((s) => !s)}
            title="Toggle comment panel"
          >
            💬 Comments {comments.filter((c) => !c.resolved).length > 0 ? `(${comments.filter((c) => !c.resolved).length})` : ''}
          </button>
          {caps.canShare && (
            <button
              className={styles.headerBtn}
              onClick={() => setShowShare(true)}
              title="Share this design"
              data-testid="ui-lab-share-btn"
            >
              Share
            </button>
          )}
          {caps.canDelete && !sharedMode && (
            <button
              className={styles.headerBtnDanger}
              onClick={handleDelete}
              disabled={deleteDesign.isPending}
              title="Delete this design"
            >
              Delete
            </button>
          )}
        </div>
      </div>

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
        caps.canRegenerate && html && design.status !== 'generation_failed' && (
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

      {viewHtml && (
        <div className={styles.viewToggleBar} data-testid="ui-lab-view-toggle">
          <button
            type="button"
            className={`${styles.viewToggleBtn}${!viewSource ? ` ${styles.viewToggleBtnActive}` : ''}`}
            onClick={() => setViewSource(false)}
          >
            Preview
          </button>
          {caps.canViewSource && (
            <button
              type="button"
              className={`${styles.viewToggleBtn}${viewSource ? ` ${styles.viewToggleBtnActive}` : ''}`}
              onClick={() => { setViewSource(true); setPinMode(false); }}
              data-testid="ui-lab-view-source"
            >
              View Source
            </button>
          )}
          {caps.canEditBoundary && !isViewingHistory && html && (
            <button
              type="button"
              className={styles.boundaryBtn}
              onClick={() => { setEditingBoundary(true); setViewSource(false); }}
              data-testid="ui-lab-edit-boundary"
            >
              Edit Feature Boundary
            </button>
          )}
        </div>
      )}

      <div className={styles.canvasBody}>
        <div className={styles.canvasPreview}>
          {isActive && !isViewingHistory && !viewSource && (
            <div className={styles.streamingOverlay}>
              <ApexLoader size={88} />
            </div>
          )}

          {design.status === 'generation_failed' && caps.canRegenerate && (
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

          {viewHtml && viewSource && (
            <pre className={styles.sourceView} data-testid="ui-lab-source-view"><code>{viewHtml}</code></pre>
          )}

          {viewHtml && !viewSource && (
            <div className={styles.iframeWrap}>
              <iframe
                ref={iframeRef}
                className={styles.mockIframe}
                srcDoc={viewHtml}
                sandbox="allow-scripts"
                title={design.title}
              />
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

        <div className={`${styles.commentPanelWrap}${!showComments ? ` ${styles.commentPanelWrapCollapsed}` : ''}`}>
          {showComments ? (
            <CommentPanel
              designId={designId}
              version={design.version}
              pinMode={pinMode}
              pendingPin={pendingPin}
              canResolveComments={caps.canResolveComments}
              canComment={caps.canComment}
              onCollapse={() => setShowComments(false)}
              onCommentAdded={() => setPendingPin(null)}
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

      {showShare && caps.canShare && (
        <ShareUiLabDialog
          designId={designId}
          designTitle={design.title}
          shareLink={shareLink}
          onClose={() => setShowShare(false)}
        />
      )}
    </div>
  );
};

export default UiLabCanvas;

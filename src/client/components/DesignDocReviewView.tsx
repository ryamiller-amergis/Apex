import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import mermaid from 'mermaid';
import { useAppShell } from '../hooks/useAppShell';
import {
  useDesignDoc,
  useUpdateDesignDocContent,
  useSubmitDesignDoc,
  useWithdrawDesignDoc,
  useReviewDesignDoc,
  useDeleteDesignDoc,
} from '../hooks/useInterviews';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import type { DesignDocStatus } from '../../shared/types/interview';
import { normalizeMermaidBlocks, normalizeMermaidChart } from '../utils/mermaidMarkdown';
import styles from './DesignDocReviewView.module.css';

type TabId = 'design' | 'tech-spec' | 'assumptions';

mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'base',
});

let mermaidDiagramCounter = 0;

function statusBadgeClass(status: DesignDocStatus): string {
  switch (status) {
    case 'generating': return styles.badgeGenerating;
    case 'draft': return styles.badgeDraft;
    case 'pending_review': return styles.badgePendingReview;
    case 'approved': return styles.badgeApproved;
    case 'rejected': return styles.badgeRejected;
    case 'revision_requested': return styles.badgeRevisionRequested;
  }
}

function statusLabel(status: DesignDocStatus): string {
  switch (status) {
    case 'generating': return 'Generating';
    case 'draft': return 'Draft';
    case 'pending_review': return 'Pending Review';
    case 'approved': return 'Approved';
    case 'rejected': return 'Rejected';
    case 'revision_requested': return 'Revision Requested';
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function buildMermaidThemeVariables(source: HTMLElement | null): Record<string, string> {
  const styles = window.getComputedStyle(source ?? document.body);
  const token = (name: string, fallback: string): string => styles.getPropertyValue(name).trim() || fallback;

  const bgPrimary = token('--bg-primary', '#ffffff');
  const bgSecondary = token('--bg-secondary', '#f5f5f5');
  const bgTertiary = token('--bg-tertiary', '#e8e8e8');
  const textPrimary = token('--text-primary', '#1a1a1a');
  const textSecondary = token('--text-secondary', '#555555');
  const borderColor = token('--border-color', '#e0e0e0');
  const accentColor = token('--accent-color', '#142A67');

  return {
    background: bgSecondary,
    mainBkg: bgSecondary,
    primaryColor: bgTertiary,
    primaryBorderColor: accentColor,
    primaryTextColor: textPrimary,
    secondaryColor: bgPrimary,
    secondaryBorderColor: borderColor,
    secondaryTextColor: textPrimary,
    tertiaryColor: bgTertiary,
    tertiaryBorderColor: borderColor,
    tertiaryTextColor: textPrimary,
    lineColor: accentColor,
    textColor: textPrimary,
    titleColor: textPrimary,
    nodeTextColor: textPrimary,
    edgeLabelBackground: bgPrimary,
    clusterBkg: bgSecondary,
    clusterBorder: borderColor,
    actorBkg: bgTertiary,
    actorBorder: accentColor,
    actorTextColor: textPrimary,
    actorLineColor: accentColor,
    signalColor: accentColor,
    signalTextColor: textPrimary,
    labelBoxBkgColor: bgPrimary,
    labelBoxBorderColor: borderColor,
    labelTextColor: textPrimary,
    loopTextColor: textPrimary,
    noteBkgColor: bgTertiary,
    noteTextColor: textPrimary,
    noteBorderColor: borderColor,
    activationBkgColor: bgTertiary,
    activationBorderColor: accentColor,
    sequenceNumberColor: textSecondary,
  };
}

interface MermaidDiagramProps {
  chart: string;
}

const MermaidDiagram: React.FC<MermaidDiagramProps> = ({ chart }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const renderIdRef = useRef(`design-doc-mermaid-${mermaidDiagramCounter++}`);
  const renderChart = normalizeMermaidChart(chart);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [themeRevision, setThemeRevision] = useState(0);

  useEffect(() => {
    const observer = new MutationObserver(() => setThemeRevision((revision) => revision + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let isCancelled = false;

    setSvg(null);
    setError(null);
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: buildMermaidThemeVariables(containerRef.current),
    });

    mermaid.render(renderIdRef.current, renderChart)
      .then(({ svg: renderedSvg }) => {
        if (!isCancelled) setSvg(renderedSvg);
      })
      .catch((err: unknown) => {
        if (!isCancelled) setError(err instanceof Error ? err.message : 'Unable to render Mermaid diagram.');
      });

    return () => {
      isCancelled = true;
    };
  }, [renderChart, themeRevision]);

  if (error) {
    return (
      <div ref={containerRef} className={styles.mermaidError}>
        <div className={styles.mermaidErrorTitle}>Unable to render Mermaid diagram.</div>
        {error && <div className={styles.mermaidErrorMessage}>{error}</div>}
        <pre>{chart}</pre>
      </div>
    );
  }

  if (!svg) return <div ref={containerRef} className={styles.mermaidLoading}>Rendering diagram…</div>;

  return <div ref={containerRef} className={styles.mermaidDiagram} dangerouslySetInnerHTML={{ __html: svg }} />;
};

const markdownComponents: Components = {
  code({ className, children, ...props }) {
    const language = /language-(\w+)/.exec(className ?? '')?.[1];
    const code = String(children).replace(/\n$/, '');

    if (language === 'mermaid') {
      return <MermaidDiagram chart={code} />;
    }

    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};

interface ContentPaneProps {
  content: string;
  isEditing: boolean;
  editValue: string;
  isDirty: boolean;
  isSaving: boolean;
  canEdit: boolean;
  placeholder: string;
  onEditToggle: () => void;
  onEditChange: (v: string) => void;
  onSave: () => void;
  onDiscard: () => void;
}

const ContentPane: React.FC<ContentPaneProps> = ({
  content,
  isEditing,
  editValue,
  isDirty,
  isSaving,
  canEdit,
  placeholder,
  onEditToggle,
  onEditChange,
  onSave,
  onDiscard,
}) => {
  if (isEditing) {
    return (
      <div className={styles.editArea}>
        <textarea
          className={styles.textarea}
          value={editValue}
          onChange={(e) => onEditChange(e.target.value)}
          placeholder={placeholder}
        />
        <div className={styles.editActions}>
          <button
            className={styles.btnPrimary}
            onClick={onSave}
            disabled={!isDirty || isSaving}
            type="button"
          >
            {isSaving ? 'Saving…' : 'Save'}
          </button>
          <button
            className={styles.btnSecondary}
            onClick={onDiscard}
            type="button"
          >
            Discard
          </button>
        </div>
      </div>
    );
  }

  const previewContent = normalizeMermaidBlocks(content);

  return (
    <div className={styles.previewWrapper}>
      {canEdit && (
        <div className={styles.previewToolbar}>
          <button className={styles.btnEditInline} onClick={onEditToggle} type="button">
            Edit
          </button>
        </div>
      )}
      <div className={styles.preview}>
        {content ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{previewContent}</ReactMarkdown>
        ) : (
          <div className={styles.emptyPreview}>
            No content yet.{canEdit ? ' Click Edit to write this section.' : ''}
          </div>
        )}
      </div>
    </div>
  );
};

export const DesignDocReviewView: React.FC = () => {
  const location = useLocation();
  const id = location.pathname.split('/').pop() ?? null;
  const navigate = useNavigate();
  const { can, userId } = useAppShell();

  const { data: doc, isLoading, isError } = useDesignDoc(id);
  const updateContent = useUpdateDesignDocContent();
  const submitDoc = useSubmitDesignDoc();
  const withdrawDoc = useWithdrawDesignDoc();
  const reviewDoc = useReviewDesignDoc();
  const deleteDoc = useDeleteDesignDoc();

  const [activeTab, setActiveTab] = useState<TabId>('design');

  // Per-tab edit state
  const [editingTab, setEditingTab] = useState<TabId | null>(null);
  const [designEdit, setDesignEdit] = useState('');
  const [techSpecEdit, setTechSpecEdit] = useState('');
  const [assumptionsEdit, setAssumptionsEdit] = useState('');
  const [dirtyTabs, setDirtyTabs] = useState<Set<TabId>>(new Set());

  const [reviewAction, setReviewAction] = useState<'reject' | 'request_revision' | null>(null);
  const [reviewComment, setReviewComment] = useState('');
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  const isGenerating = !!doc && (
    doc.designContent === '' || doc.techSpecContent === '' || doc.assumptionsContent === ''
  );

  const handleEditToggle = useCallback((tab: TabId) => {
    if (!doc) return;
    if (editingTab === tab) {
      // Toggle off — discard
      if (tab === 'design') setDesignEdit(doc.designContent);
      if (tab === 'tech-spec') setTechSpecEdit(doc.techSpecContent);
      if (tab === 'assumptions') setAssumptionsEdit(doc.assumptionsContent);
      setDirtyTabs((prev) => { const s = new Set(prev); s.delete(tab); return s; });
      setEditingTab(null);
    } else {
      // Toggle on
      if (tab === 'design') setDesignEdit(doc.designContent);
      if (tab === 'tech-spec') setTechSpecEdit(doc.techSpecContent);
      if (tab === 'assumptions') setAssumptionsEdit(doc.assumptionsContent);
      setEditingTab(tab);
    }
  }, [doc, editingTab]);

  const handleEditChange = useCallback((tab: TabId, value: string) => {
    if (tab === 'design') setDesignEdit(value);
    if (tab === 'tech-spec') setTechSpecEdit(value);
    if (tab === 'assumptions') setAssumptionsEdit(value);
    setDirtyTabs((prev) => new Set(prev).add(tab));
  }, []);

  const handleSave = useCallback(async (tab: TabId) => {
    if (!id || !doc) return;
    const body: { designContent?: string; techSpecContent?: string; assumptionsContent?: string } = {};
    if (tab === 'design') body.designContent = designEdit;
    if (tab === 'tech-spec') body.techSpecContent = techSpecEdit;
    if (tab === 'assumptions') body.assumptionsContent = assumptionsEdit;
    await updateContent.mutateAsync({ designDocId: id, ...body });
    setDirtyTabs((prev) => { const s = new Set(prev); s.delete(tab); return s; });
    setEditingTab(null);
  }, [id, doc, designEdit, techSpecEdit, assumptionsEdit, updateContent]);

  const handleDiscard = useCallback((tab: TabId) => {
    if (!doc) return;
    if (tab === 'design') setDesignEdit(doc.designContent);
    if (tab === 'tech-spec') setTechSpecEdit(doc.techSpecContent);
    if (tab === 'assumptions') setAssumptionsEdit(doc.assumptionsContent);
    setDirtyTabs((prev) => { const s = new Set(prev); s.delete(tab); return s; });
    setEditingTab(null);
  }, [doc]);

  const handleSubmit = useCallback(async () => {
    if (!id) return;
    await submitDoc.mutateAsync(id);
  }, [id, submitDoc]);

  const handleWithdraw = useCallback(async () => {
    if (!id) return;
    await withdrawDoc.mutateAsync(id);
  }, [id, withdrawDoc]);

  const handleApprove = useCallback(async () => {
    if (!id) return;
    await reviewDoc.mutateAsync({ designDocId: id, action: 'approve' });
  }, [id, reviewDoc]);

  const handleRejectOrRevision = useCallback(async () => {
    if (!id || !reviewAction) return;
    await reviewDoc.mutateAsync({
      designDocId: id,
      action: reviewAction,
      comment: reviewComment,
    });
    setReviewAction(null);
    setReviewComment('');
  }, [id, reviewAction, reviewComment, reviewDoc]);

  if (isLoading) return <div className={styles.loadingState}>Loading Design Doc…</div>;
  if (isError || !doc) return <div className={styles.errorState}>Design doc not found.</div>;

  const isAuthor = doc.authorId === userId;
  const canManage = can('interviews:manage');
  const isReviewer = canManage && !isAuthor;
  const canEdit = canManage && isAuthor && doc.status !== 'approved';

  const hasAnyContent = !!(doc.designContent || doc.techSpecContent || doc.assumptionsContent);

  const tabLabel: Record<TabId, string> = {
    design: 'Design',
    'tech-spec': 'Tech Spec',
    assumptions: 'Assumptions',
  };

  const tabContent: Record<TabId, string> = {
    design: editingTab === 'design' ? designEdit : doc.designContent,
    'tech-spec': editingTab === 'tech-spec' ? techSpecEdit : doc.techSpecContent,
    assumptions: editingTab === 'assumptions' ? assumptionsEdit : doc.assumptionsContent,
  };

  const tabPlaceholder: Record<TabId, string> = {
    design: 'Write the main design doc in Markdown…',
    'tech-spec': 'Write the technical spec in Markdown…',
    assumptions: 'Write the shared assumptions in Markdown…',
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <button className={styles.backBtn} onClick={() => navigate('/backlog?tab=design-docs')} type="button">
            ← Back
          </button>
          <div className={styles.headerInfo}>
            <div className={styles.titleRow}>
              <h1 className={styles.title}>{doc.title}</h1>
              <span className={`${styles.statusBadge} ${statusBadgeClass(doc.status)}`}>
                {statusLabel(doc.status)}
              </span>
            </div>
            {doc.reviewerId && doc.reviewedAt && (
              <div className={styles.reviewInfo}>
                <span className={styles.reviewInfoRow}>
                  Reviewed by {doc.reviewerId} on {formatDate(doc.reviewedAt)}
                </span>
                {doc.reviewComment && (
                  <span className={styles.reviewInfoRow}>"{doc.reviewComment}"</span>
                )}
              </div>
            )}
          </div>
        </div>

        <div className={styles.headerRight}>
          {doc.status === 'approved' && (
            <span className={styles.reviewOnlyBadge}>Read-only — approved</span>
          )}

          {canManage && isAuthor && (
            <>
              {(doc.status === 'draft' || doc.status === 'revision_requested' || doc.status === 'rejected') && (
                <button
                  className={styles.actionBtnPrimary}
                  onClick={() => void handleSubmit()}
                  disabled={submitDoc.isPending || !hasAnyContent}
                  type="button"
                >
                  Submit for Review
                </button>
              )}
              {doc.status === 'pending_review' && (
                <button
                  className={styles.actionBtn}
                  onClick={() => void handleWithdraw()}
                  disabled={withdrawDoc.isPending}
                  type="button"
                >
                  Withdraw
                </button>
              )}
              <button
                className={styles.btnDeleteDoc}
                onClick={() => setShowDeleteModal(true)}
                disabled={deleteDoc.isPending}
                title="Delete Design Doc"
                type="button"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="2 4 4 4 14 4" />
                  <path d="M13 4l-.7 9.3A1 1 0 0 1 12.3 14H3.7a1 1 0 0 1-1-.7L2 4" />
                  <path d="M6.5 7v4M9.5 7v4" />
                  <path d="M5.5 4V2.7A.7.7 0 0 1 6.2 2h3.6a.7.7 0 0 1 .7.7V4" />
                </svg>
                Delete
              </button>
            </>
          )}

          {canManage && isReviewer && doc.status === 'pending_review' && (
            <div className={styles.reviewControls}>
              <button
                className={styles.btnApprove}
                onClick={() => void handleApprove()}
                disabled={reviewDoc.isPending}
                type="button"
              >
                Approve
              </button>
              {reviewAction === null ? (
                <>
                  <button
                    className={styles.btnRevision}
                    onClick={() => setReviewAction('request_revision')}
                    type="button"
                  >
                    Request Revision
                  </button>
                  <button
                    className={styles.btnReject}
                    onClick={() => setReviewAction('reject')}
                    type="button"
                  >
                    Reject
                  </button>
                </>
              ) : (
                <div className={styles.commentBox}>
                  <textarea
                    className={styles.commentInput}
                    rows={2}
                    placeholder={reviewAction === 'reject' ? 'Reason for rejection…' : 'What needs to change?'}
                    value={reviewComment}
                    onChange={(e) => setReviewComment(e.target.value)}
                    autoFocus
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      className={reviewAction === 'reject' ? styles.btnReject : styles.btnRevision}
                      onClick={() => void handleRejectOrRevision()}
                      disabled={!reviewComment.trim() || reviewDoc.isPending}
                      type="button"
                    >
                      {reviewAction === 'reject' ? 'Confirm Reject' : 'Confirm Revision Request'}
                    </button>
                    <button
                      className={styles.btnSecondary}
                      onClick={() => { setReviewAction(null); setReviewComment(''); }}
                      type="button"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {isGenerating ? (
        /* ── Generating skeleton ─────────────────────────────────────── */
        <>
          <div className={styles.tabs}>
            {(['design', 'tech-spec', 'assumptions'] as TabId[]).map((t) => (
              <button key={t} className={`${styles.tab} ${t === 'design' ? styles.active : ''}`} disabled type="button">
                {tabLabel[t]}
              </button>
            ))}
          </div>
          <div className={styles.tabContent}>
            <div className={styles.skeletonArea}>
              <div className={styles.generatingBanner}>
                <svg
                  className={styles.bannerSpinner}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
                <div>
                  <div className={styles.bannerTitle}>Generating your Design Doc…</div>
                  <div className={styles.bannerSub}>This may take a few minutes. You can navigate away and return.</div>
                </div>
              </div>

              <div className={styles.skeletonSection}>
                <div className={styles.skeletonHeader} style={{ width: '75%' }} />
                <div className={styles.skeletonLine} style={{ width: '100%' }} />
                <div className={styles.skeletonLine} style={{ width: '65%' }} />
                <div className={styles.skeletonLine} style={{ width: '100%' }} />
              </div>

              <div className={styles.skeletonSection}>
                <div className={styles.skeletonHeader} style={{ width: '45%' }} />
                <div className={styles.skeletonLine} style={{ width: '100%' }} />
                <div className={styles.skeletonLine} style={{ width: '70%' }} />
              </div>

              <div className={styles.skeletonSection}>
                <div className={styles.skeletonHeader} style={{ width: '60%' }} />
                <div className={styles.skeletonLine} style={{ width: '100%' }} />
                <div className={styles.skeletonLine} style={{ width: '100%' }} />
                <div className={styles.skeletonLine} style={{ width: '40%' }} />
              </div>
            </div>
          </div>
        </>
      ) : (
        /* ── Normal tabs ─────────────────────────────────────────────── */
        <>
          <div className={styles.tabs}>
            {(['design', 'tech-spec', 'assumptions'] as TabId[]).map((t) => (
              <button
                key={t}
                className={`${styles.tab} ${activeTab === t ? styles.active : ''} ${dirtyTabs.has(t) ? styles.tabDirty : ''}`}
                onClick={() => setActiveTab(t)}
                type="button"
              >
                {tabLabel[t]}
                {editingTab === t && <span className={styles.editingIndicator}> ✎</span>}
              </button>
            ))}
          </div>

          <div className={styles.tabContent}>
            <ContentPane
              content={tabContent[activeTab]}
              isEditing={editingTab === activeTab}
              editValue={
                activeTab === 'design' ? designEdit :
                activeTab === 'tech-spec' ? techSpecEdit :
                assumptionsEdit
              }
              isDirty={dirtyTabs.has(activeTab)}
              isSaving={updateContent.isPending}
              canEdit={canEdit}
              placeholder={tabPlaceholder[activeTab]}
              onEditToggle={() => handleEditToggle(activeTab)}
              onEditChange={(v) => handleEditChange(activeTab, v)}
              onSave={() => void handleSave(activeTab)}
              onDiscard={() => handleDiscard(activeTab)}
            />
          </div>
        </>
      )}

      {showDeleteModal && doc && (
        <ConfirmDeleteModal
          title="Delete Design Doc"
          itemName={doc.title}
          description="Are you sure you want to permanently delete the design doc"
          isPending={deleteDoc.isPending}
          onConfirm={() => {
            deleteDoc.mutate(doc.id, {
              onSuccess: () => navigate('/backlog?tab=design-docs'),
            });
          }}
          onCancel={() => setShowDeleteModal(false)}
        />
      )}
    </div>
  );
};

export default DesignDocReviewView;

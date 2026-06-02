import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAppShell } from '../hooks/useAppShell';
import {
  usePrd,
  useInterview,
  useUpdatePrdContent,
  useSubmitPrd,
  useWithdrawPrd,
  useReopenPrd,
  useReviewPrd,
  useDeletePrd,
  useDesignDocsByPrd,
  useCreatePrdAdoItems,
  useSyncPrdAdoStatus,
  useDocumentAssignments,
  useReassignApprovers,
} from '../hooks/useInterviews';
import {
  useReviewComments,
  useUnresolvedCommentCount,
  useCreateComment,
  useResolveComment,
  useReopenComment as useReopenReviewComment,
  useDeleteComment,
} from '../hooks/useReviewComments';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { ApproverSelectModal } from './ApproverSelectModal';
import { AnnotationLayer } from './AnnotationLayer';
import { ReviewCommentSidebar } from './ReviewCommentSidebar';
import { BacklogViewer } from './BacklogViewer';
import { CreateAdoItemsModal } from './CreateAdoItemsModal';
import type { PrdStatus } from '../../shared/types/interview';
import type { ReviewSectionKey, TextSelector } from '../../shared/types/reviewComments';
import styles from './PrdReviewView.module.css';

type TabId = 'preview' | 'edit' | 'backlog';

function statusBadgeClass(status: PrdStatus): string {
  switch (status) {
    case 'generating': return styles.badgeGenerating;
    case 'draft': return styles.badgeDraft;
    case 'pending_review': return styles.badgePendingReview;
    case 'approved': return styles.badgeApproved;
    case 'revision_requested': return styles.badgeRevisionRequested;
  }
}

function statusLabel(status: PrdStatus): string {
  switch (status) {
    case 'generating': return 'Generating';
    case 'draft': return 'Draft';
    case 'pending_review': return 'Pending Review';
    case 'approved': return 'Approved';
    case 'revision_requested': return 'Revision Requested';
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export const PrdReviewView: React.FC = () => {
  const location = useLocation();
  const id = location.pathname.split('/').pop() ?? null;
  const navigate = useNavigate();
  const { can, userId, isAdmin } = useAppShell();

  const { data: prd, isLoading, isError } = usePrd(id);
  const { data: relatedDesignDocs } = useDesignDocsByPrd(prd?.status === 'approved' ? id : undefined);
  const { data: sourceInterview } = useInterview(prd?.interviewId ?? null);

  const updateContent = useUpdatePrdContent();
  const submitPrd = useSubmitPrd();
  const withdrawPrd = useWithdrawPrd();
  const reopenPrd = useReopenPrd();
  const reviewPrd = useReviewPrd();
  const deletePrd = useDeletePrd();
  const createAdoItems = useCreatePrdAdoItems();
  const syncAdoStatus = useSyncPrdAdoStatus(id);

  const [activeTab, setActiveTab] = useState<TabId>('preview');
  const [editContent, setEditContent] = useState('');
  const [isDirty, setIsDirty] = useState(false);

  const reassignApprovers = useReassignApprovers();

  const { data: reviewComments = [] } = useReviewComments(id, 'prd');
  const { data: unresolvedData } = useUnresolvedCommentCount(id, 'prd');
  const unresolvedCount = unresolvedData?.count ?? 0;
  const createComment = useCreateComment('prd', id);
  const resolveComment = useResolveComment(userId ?? '');
  const reopenReviewComment = useReopenReviewComment();
  const deleteComment = useDeleteComment();

  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [pendingSelector, setPendingSelector] = useState<{ sectionKey: ReviewSectionKey; selector: TextSelector } | null>(null);
  const [newCommentBody, setNewCommentBody] = useState('');

  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showAdoModal, setShowAdoModal] = useState(false);
  const [showApproverModal, setShowApproverModal] = useState(false);
  const [showReassignModal, setShowReassignModal] = useState(false);
  const [showAllLinks, setShowAllLinks] = useState(false);

  const { data: assignments = [] } = useDocumentAssignments(id, 'prd');

  const isGenerating = !!prd && prd.status === 'generating' && prd.content === '';
  const generationFailed = !!prd && prd.status === 'draft' && prd.content === '';

  const handleSaveContent = useCallback(async () => {
    if (!id || !prd) return;
    await updateContent.mutateAsync({ prdId: id, content: editContent });
    setIsDirty(false);
  }, [id, prd, editContent, updateContent]);

  const handleDiscard = useCallback(() => {
    if (!prd) return;
    setEditContent(prd.content);
    setIsDirty(false);
    setActiveTab('preview');
  }, [prd]);

  const handleSubmit = useCallback(() => {
    if (!id) return;
    setShowApproverModal(true);
  }, [id]);

  const handleApproverConfirm = useCallback(async (selections: { prdApproverIds?: string[]; designDocApproverIds?: string[] }) => {
    if (!id) return;
    await submitPrd.mutateAsync({
      prdId: id,
      prdApproverIds: selections.prdApproverIds ?? [],
      designDocApproverIds: selections.designDocApproverIds ?? [],
    });
    setShowApproverModal(false);
  }, [id, submitPrd]);

  const handleReassignConfirm = useCallback(async (selections: { prdApproverIds?: string[] }) => {
    if (!id) return;
    await reassignApprovers.mutateAsync({
      documentId: id,
      documentType: 'prd',
      approverUserIds: selections.prdApproverIds ?? [],
    });
    setShowReassignModal(false);
  }, [id, reassignApprovers]);

  const handleWithdraw = useCallback(async () => {
    if (!id) return;
    await withdrawPrd.mutateAsync(id);
  }, [id, withdrawPrd]);

  const handleApprove = useCallback(async () => {
    if (!id) return;
    const data = await reviewPrd.mutateAsync({ prdId: id, action: 'approve' });
    if (data.designDocId) {
      navigate(`/backlog/design-doc/${data.designDocId}`);
    }
  }, [id, reviewPrd, navigate]);

  const handleAddComment = useCallback((sectionKey: ReviewSectionKey, selector: TextSelector) => {
    setPendingSelector({ sectionKey, selector });
    setNewCommentBody('');
  }, []);

  const handleSubmitComment = useCallback(async () => {
    if (!pendingSelector || !newCommentBody.trim()) return;
    await createComment.mutateAsync({
      sectionKey: pendingSelector.sectionKey,
      body: newCommentBody.trim(),
      selector: pendingSelector.selector,
    });
    setPendingSelector(null);
    setNewCommentBody('');
  }, [pendingSelector, newCommentBody, createComment]);

  const handleReply = useCallback(async (commentId: string, body: string) => {
    await fetch(`/api/review-comments/${commentId}/replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ body }),
    });
  }, []);

  const handleTabChange = useCallback((tab: TabId) => {
    if (tab === 'edit' && prd) {
      setEditContent(prd.content);
      setIsDirty(false);
    }
    setActiveTab(tab);
  }, [prd]);

  const handleCommentClick = useCallback((commentId: string) => {
    const comment = reviewComments.find((c) => c.id === commentId);
    if (comment) {
      const targetTab: TabId = comment.sectionKey === 'backlog' ? 'backlog' : 'preview';
      setActiveTab(targetTab);
    }
    setActiveCommentId(commentId);
  }, [reviewComments]);

  // Auto-verify ADO IDs once when an approved PRD with backlog ADO items loads.
  // Silently clears any IDs that were deleted in ADO.
  useEffect(() => {
    if (!prd || prd.status !== 'approved' || !prd.backlogJson) return;
    const backlog = prd.backlogJson as { epics?: Array<{ adoWorkItemId?: number }> };
    const hasAnyAdoIds = (backlog.epics ?? []).some(e => e.adoWorkItemId);
    if (!hasAnyAdoIds) return;
    syncAdoStatus.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prd?.id, prd?.status]);

  const hasUnpushedItems = useMemo(() => {
    if (!prd?.backlogJson) return false;
    const backlog = prd.backlogJson as { epics?: Array<{ adoWorkItemId?: number }> };
    return (backlog.epics ?? []).some(e => !e.adoWorkItemId);
  }, [prd?.backlogJson]);

  if (isLoading) return <div className={styles.loadingState}>Loading PRD…</div>;
  if (isError || !prd) return <div className={styles.errorState}>PRD not found.</div>;

  const isAuthor = prd.authorId === userId;
  const canManage = can('interviews:manage');
  const canReview = can('prds:review');
  const isAssignedApprover = assignments.some((a) => a.approverUserId === userId);
  const canPerformReview = canReview && (isAssignedApprover || isAdmin) && (!isAuthor || isAdmin);
  const anyDesignDocApproved = relatedDesignDocs
    && relatedDesignDocs.some(d => d.status === 'approved');

  const canCreateAdoItems = prd.status === 'approved'
    && anyDesignDocApproved
    && can('workitems:write')
    && hasUnpushedItems;

  const showCommentLayer =
    (prd.status === 'pending_review' || prd.status === 'revision_requested') &&
    (canPerformReview || isAuthor || isAdmin);

  const sectionComments = reviewComments.filter((c) => c.sectionKey === 'prd');
  const backlogComments = reviewComments.filter((c) => c.sectionKey === 'backlog');

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <button className={styles.backBtn} onClick={() => navigate('/backlog?tab=prds')} type="button">
            ←
          </button>
          <div className={styles.headerInfo}>
            <div className={styles.titleRow}>
              <h1 className={styles.title}>{prd.title}</h1>
              <span className={`${styles.statusBadge} ${statusBadgeClass(prd.status)}`}>
                {statusLabel(prd.status)}
              </span>
              {prd.reviewerId && prd.reviewedAt && (
                <span className={styles.reviewBadge}>
                  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10 3L4.5 8.5 2 6" />
                  </svg>
                  {prd.reviewerName ?? prd.reviewerId} &middot; {formatDate(prd.reviewedAt)}
                </span>
              )}
            </div>
            <div className={styles.metaRow}>
              <span className={styles.metaItem}>
                <span className={styles.metaLabel}>Owner:</span>
                <span className={styles.metaValue}>{prd.ownerName ?? prd.ownerId ?? prd.authorName ?? prd.authorId}</span>
              </span>
              {assignments.length > 0 && (
                <span className={styles.metaItem}>
                  <span className={styles.metaLabel}>Reviewer(s):</span>
                  <span className={styles.metaValue}>
                    {assignments.map((a) => a.approverDisplayName ?? a.approverUserId).join(', ')}
                  </span>
                </span>
              )}
            </div>
            {(sourceInterview || (prd.status === 'approved' && relatedDesignDocs && relatedDesignDocs.length > 0)) && (() => {
              const MAX_VISIBLE = 3;
              const docs = (prd.status === 'approved' && relatedDesignDocs) ? relatedDesignDocs : [];
              const totalChips = (sourceInterview ? 1 : 0) + docs.length;
              const needsCollapse = totalChips > MAX_VISIBLE;
              const visibleDocs = needsCollapse && !showAllLinks
                ? docs.slice(0, MAX_VISIBLE - (sourceInterview ? 1 : 0))
                : docs;
              const hiddenCount = docs.length - visibleDocs.length;

              return (
                <div className={styles.parentLinks}>
                  {sourceInterview && (
                    <button
                      className={styles.parentLinkChip}
                      onClick={() => navigate(`/backlog/interview/${sourceInterview.id}`)}
                      type="button"
                      title={`View Interview: ${sourceInterview.title}`}
                    >
                      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="7" cy="5" r="2.5" />
                        <path d="M2 12c0-2.76 2.24-5 5-5s5 2.24 5 5" />
                      </svg>
                      {sourceInterview.title}
                      <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 8, height: 8, opacity: 0.6 }}>
                        <path d="M2 8L8 2M5 2h3v3" />
                      </svg>
                    </button>
                  )}
                  {visibleDocs.map((doc) => (
                    <button
                      key={doc.id}
                      className={styles.parentLinkChip}
                      onClick={() => navigate(`/backlog/design-doc/${doc.id}`)}
                      type="button"
                      title={`View Design Doc: ${doc.title}`}
                    >
                      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="2" y="1" width="10" height="12" rx="1.5" />
                        <path d="M4.5 4.5h5M4.5 7h5M4.5 9.5h3" />
                      </svg>
                      {doc.title}
                      <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 8, height: 8, opacity: 0.6 }}>
                        <path d="M2 8L8 2M5 2h3v3" />
                      </svg>
                    </button>
                  ))}
                  {needsCollapse && !showAllLinks && (
                    <button
                      className={styles.showMoreChip}
                      onClick={() => setShowAllLinks(true)}
                      type="button"
                    >
                      +{hiddenCount} more
                    </button>
                  )}
                  {needsCollapse && showAllLinks && (
                    <button
                      className={styles.showMoreChip}
                      onClick={() => setShowAllLinks(false)}
                      type="button"
                    >
                      Show less
                    </button>
                  )}
                </div>
              );
            })()}
          </div>
        </div>

        <div className={styles.headerRight}>
          {prd.status === 'approved' && !canManage && (
            <span className={styles.reviewOnlyBadge}>Read-only</span>
          )}

          {canManage && (isAuthor || isAdmin) && (
            <>
              {(prd.status === 'draft' || prd.status === 'revision_requested') && (
                <button
                  className={styles.actionBtnPrimary}
                  onClick={handleSubmit}
                  disabled={submitPrd.isPending || !prd.content}
                  type="button"
                >
                  Submit for Review
                </button>
              )}
              {prd.status === 'pending_review' && (
                <button
                  className={styles.actionBtn}
                  onClick={() => void handleWithdraw()}
                  disabled={withdrawPrd.isPending}
                  type="button"
                >
                  Withdraw
                </button>
              )}
              <button
                className={styles.btnDeletePrd}
                onClick={() => setShowDeleteModal(true)}
                disabled={deletePrd.isPending}
                title="Delete PRD"
                type="button"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="2 4 4 4 14 4" />
                  <path d="M13 4l-.7 9.3A1 1 0 0 1 12.3 14H3.7a1 1 0 0 1-1-.7L2 4" />
                  <path d="M6.5 7v4M9.5 7v4" />
                  <path d="M5.5 4V2.7A.7.7 0 0 1 6.2 2h3.6a.7.7 0 0 1 .7.7V4" />
                </svg>
              </button>
            </>
          )}

          {isAdmin && prd.status !== 'pending_review' && (
            <button
              className={styles.actionBtn}
              onClick={() => reopenPrd.mutate(prd.id)}
              disabled={reopenPrd.isPending || prd.status === 'approved'}
              type="button"
              title={prd.status === 'approved' ? 'Cannot reopen an approved PRD' : 'Admin: force this PRD back to Pending Review'}
            >
              {reopenPrd.isPending ? 'Reopening…' : 'Reopen for Review'}
            </button>
          )}

          {canReview && (!isAuthor || isAdmin) && prd.status === 'pending_review' && (
            <>
              <span className={styles.actionDivider} />
              <div className={styles.reviewControls}>
                <button
                  className={styles.btnApprove}
                  onClick={() => void handleApprove()}
                  disabled={reviewPrd.isPending || !canPerformReview || unresolvedCount > 0}
                  title={
                    !canPerformReview
                      ? 'You are not an assigned approver for this document'
                      : unresolvedCount > 0
                        ? 'Resolve all comments before approving'
                        : undefined
                  }
                  type="button"
                >
                  Approve
                </button>
              </div>
            </>
          )}

          {prd.status === 'approved' && can('workitems:write') && hasUnpushedItems && (
            <button
              className={styles.actionBtnPrimary}
              onClick={() => setShowAdoModal(true)}
              disabled={!canCreateAdoItems || createAdoItems.isPending}
              title={!anyDesignDocApproved ? 'At least one design doc must be approved first' : 'Create work items in Azure DevOps'}
              type="button"
            >
              {createAdoItems.isPending ? 'Creating…' : 'Create in ADO'}
            </button>
          )}

          {prd.status === 'pending_review' && (
            <>
              <span className={styles.actionDivider} />
              <button
                className={styles.actionBtn}
                onClick={() => setShowReassignModal(true)}
                type="button"
                title={assignments.length > 0
                  ? `Approvers: ${assignments.map(a => a.approverDisplayName ?? a.approverUserId).join(', ')}`
                  : 'Assign approvers'}
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="6" cy="5" r="2.5" />
                  <path d="M1 13c0-2.5 2.24-4.5 5-4.5s5 2 5 4.5" />
                  <path d="M12 5.5l2 2 2-2" />
                </svg>
                {assignments.length > 0 ? `${assignments.length} Approver${assignments.length > 1 ? 's' : ''}` : 'Approvers'}
              </button>
            </>
          )}
        </div>
      </div>

      {createAdoItems.isSuccess && createAdoItems.data && (
        <div className={styles.adoSuccessBanner}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={styles.adoSuccessIcon}>
            <polyline points="3 8 6.5 11.5 13 5" />
          </svg>
          <span>
            {createAdoItems.data.totalCreated} work item{createAdoItems.data.totalCreated !== 1 ? 's' : ''} created in ADO
            {createAdoItems.data.created.epics.length > 0 && ` — ${createAdoItems.data.created.epics.length} epic${createAdoItems.data.created.epics.length !== 1 ? 's' : ''}, ${createAdoItems.data.created.features.length} feature${createAdoItems.data.created.features.length !== 1 ? 's' : ''}, ${createAdoItems.data.created.pbis.length} PBI${createAdoItems.data.created.pbis.length !== 1 ? 's' : ''}`}
          </span>
        </div>
      )}

      {isGenerating ? (
        /* ── Generating skeleton ─────────────────────────────────────── */
        <>
          <div className={styles.tabs}>
            <button className={`${styles.tab} ${styles.active}`} disabled type="button">Preview</button>
            <button className={styles.tab} disabled type="button">Edit</button>
            <button className={styles.tab} disabled type="button">Backlog</button>
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
                  <div className={styles.bannerTitle}>Generating your PRD…</div>
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
      ) : generationFailed ? (
        /* ── Generation failed banner ────────────────────────────────── */
        <div className={styles.tabContent}>
          <div className={styles.failedBanner}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              style={{ width: 24, height: 24, flexShrink: 0 }}
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <div>
              <div className={styles.bannerTitle}>PRD generation did not complete</div>
              <div className={styles.bannerSub}>
                The AI agent finished without producing output. You can return to the interview and try generating again.
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* ── Normal tabs ─────────────────────────────────────────────── */
        <>
          <div className={styles.tabs}>
            <button
              className={`${styles.tab} ${activeTab === 'preview' ? styles.active : ''}`}
              onClick={() => handleTabChange('preview')}
              type="button"
            >
              Preview
            </button>
            {canManage && (isAuthor || isAdmin) && prd.status !== 'approved' && (
              <button
                className={`${styles.tab} ${activeTab === 'edit' ? styles.active : ''}`}
                onClick={() => handleTabChange('edit')}
                type="button"
              >
                Edit
              </button>
            )}
            <button
              className={`${styles.tab} ${activeTab === 'backlog' ? styles.active : ''}`}
              onClick={() => handleTabChange('backlog')}
              type="button"
            >
              Backlog
            </button>
          </div>

          <div className={styles.tabContent}>
            {activeTab === 'preview' && (
              <div className={styles.previewWithSidebar}>
                <div className={styles.preview}>
                  {prd.content ? (
                    showCommentLayer ? (
                      <AnnotationLayer
                        sectionKey="prd"
                        comments={sectionComments}
                        activeCommentId={activeCommentId}
                        onAddComment={handleAddComment}
                        onCommentClick={handleCommentClick}
                      >
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{prd.content}</ReactMarkdown>
                      </AnnotationLayer>
                    ) : (
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{prd.content}</ReactMarkdown>
                    )
                  ) : (
                    <div className={styles.emptyPreview}>
                      No content yet.{canManage && (isAuthor || isAdmin) ? ' Use the Edit tab to write the PRD.' : ''}
                    </div>
                  )}
                </div>
                {showCommentLayer && (
                  <ReviewCommentSidebar
                    comments={reviewComments}
                    activeCommentId={activeCommentId}
                    currentUserId={userId ?? ''}
                    documentAuthorUserId={prd.authorId}
                    onCommentClick={handleCommentClick}
                    onReply={(commentId, body) => void handleReply(commentId, body)}
                    onResolve={(commentId) => resolveComment.mutate(commentId)}
                    onReopen={(commentId) => reopenReviewComment.mutate(commentId)}
                    onDelete={(commentId) => deleteComment.mutate(commentId)}
                  />
                )}
              </div>
            )}

            {activeTab === 'edit' && (
              <div className={styles.editArea}>
                <textarea
                  className={styles.textarea}
                  value={editContent}
                  onChange={(e) => { setEditContent(e.target.value); setIsDirty(true); }}
                  placeholder="Write your PRD in Markdown…"
                />
                <div className={styles.editActions}>
                  <button
                    className={styles.btnPrimary}
                    onClick={() => void handleSaveContent()}
                    disabled={!isDirty || updateContent.isPending}
                    type="button"
                  >
                    {updateContent.isPending ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    className={styles.btnSecondary}
                    onClick={handleDiscard}
                    type="button"
                  >
                    Discard
                  </button>
                </div>
              </div>
            )}

            {activeTab === 'backlog' && (
              <div className={styles.previewWithSidebar}>
                <div className={styles.backlogView}>
                  {prd.backlogJson ? (
                    showCommentLayer ? (
                      <AnnotationLayer
                        sectionKey="backlog"
                        comments={backlogComments}
                        activeCommentId={activeCommentId}
                        onAddComment={handleAddComment}
                        onCommentClick={handleCommentClick}
                      >
                        <BacklogViewer data={prd.backlogJson} />
                      </AnnotationLayer>
                    ) : (
                      <BacklogViewer data={prd.backlogJson} />
                    )
                  ) : (
                    <div className={styles.emptyPreview}>No backlog data yet.</div>
                  )}
                </div>
                {showCommentLayer && (
                  <ReviewCommentSidebar
                    comments={reviewComments}
                    activeCommentId={activeCommentId}
                    currentUserId={userId ?? ''}
                    documentAuthorUserId={prd.authorId}
                    onCommentClick={handleCommentClick}
                    onReply={(commentId, body) => void handleReply(commentId, body)}
                    onResolve={(commentId) => resolveComment.mutate(commentId)}
                    onReopen={(commentId) => reopenReviewComment.mutate(commentId)}
                    onDelete={(commentId) => deleteComment.mutate(commentId)}
                  />
                )}
              </div>
            )}
          </div>
        </>
      )}

      {showDeleteModal && prd && (
        <ConfirmDeleteModal
          title="Delete PRD"
          itemName={prd.title}
          description="Are you sure you want to permanently delete the PRD"
          isPending={deletePrd.isPending}
          onConfirm={() => {
            deletePrd.mutate(prd.id, {
              onSuccess: () => navigate('/backlog?tab=prds'),
            });
          }}
          onCancel={() => setShowDeleteModal(false)}
        />
      )}

      {pendingSelector && (
        <div className={styles.commentModal} onClick={(e) => { if (e.target === e.currentTarget) setPendingSelector(null); }} role="dialog" aria-modal="true">
          <div className={styles.commentModalCard}>
            <h3 className={styles.commentModalTitle}>Add Comment</h3>
            <blockquote className={styles.commentModalQuote}>{pendingSelector.selector.exact}</blockquote>
            <textarea
              className={styles.commentModalInput}
              value={newCommentBody}
              onChange={(e) => setNewCommentBody(e.target.value)}
              placeholder="Write your comment…"
              rows={3}
              autoFocus
            />
            <div className={styles.commentModalActions}>
              <button
                className={styles.btnSecondary}
                onClick={() => setPendingSelector(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                className={styles.btnPrimary}
                onClick={() => void handleSubmitComment()}
                disabled={!newCommentBody.trim() || createComment.isPending}
                type="button"
              >
                {createComment.isPending ? 'Posting…' : 'Post Comment'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showAdoModal && prd && (
        <CreateAdoItemsModal
          prd={prd}
          isPending={createAdoItems.isPending}
          designDocs={relatedDesignDocs ?? []}
          onSubmit={async (req) => {
            await createAdoItems.mutateAsync({ prdId: prd.id, ...req });
            setShowAdoModal(false);
          }}
          onCancel={() => setShowAdoModal(false)}
        />
      )}

      {showApproverModal && prd && (
        <ApproverSelectModal
          documentType="prd"
          project={prd.project}
          excludeSelf={!isAdmin}
          onConfirm={(selections) => void handleApproverConfirm(selections)}
          onCancel={() => setShowApproverModal(false)}
          isSubmitting={submitPrd.isPending}
        />
      )}

      {showReassignModal && prd && (
        <ApproverSelectModal
          documentType="prd"
          project={prd.project}
          initialPrdApproverIds={assignments.filter((a) => a.status === 'pending').map((a) => a.approverUserId)}
          confirmLabel="Update Approvers"
          excludeSelf={false}
          allowEmpty
          onConfirm={(selections) => void handleReassignConfirm(selections)}
          onCancel={() => setShowReassignModal(false)}
          isSubmitting={reassignApprovers.isPending}
        />
      )}
    </div>
  );
};

export default PrdReviewView;

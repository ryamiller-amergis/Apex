import React, { useState, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAppShell } from '../hooks/useAppShell';
import {
  usePrd,
  useUpdatePrdContent,
  useSubmitPrd,
  useWithdrawPrd,
  useReviewPrd,
  useDeletePrd,
  useDesignDocsByPrd,
} from '../hooks/useInterviews';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { PrdRejectModal } from './PrdRejectModal';
import { PrdRevisionModal } from './PrdRevisionModal';
import { BacklogViewer } from './BacklogViewer';
import type { PrdStatus } from '../../shared/types/interview';
import styles from './PrdReviewView.module.css';

type TabId = 'preview' | 'edit' | 'backlog';

function statusBadgeClass(status: PrdStatus): string {
  switch (status) {
    case 'generating': return styles.badgeGenerating;
    case 'draft': return styles.badgeDraft;
    case 'pending_review': return styles.badgePendingReview;
    case 'approved': return styles.badgeApproved;
    case 'rejected': return styles.badgeRejected;
    case 'revision_requested': return styles.badgeRevisionRequested;
  }
}

function statusLabel(status: PrdStatus): string {
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

export const PrdReviewView: React.FC = () => {
  const location = useLocation();
  const id = location.pathname.split('/').pop() ?? null;
  const navigate = useNavigate();
  const { can, userId } = useAppShell();

  const { data: prd, isLoading, isError } = usePrd(id);
  const { data: relatedDesignDocs } = useDesignDocsByPrd(prd?.status === 'approved' ? id : undefined);
  const linkedDesignDoc = relatedDesignDocs?.[0];

  const updateContent = useUpdatePrdContent();
  const submitPrd = useSubmitPrd();
  const withdrawPrd = useWithdrawPrd();
  const reviewPrd = useReviewPrd();
  const deletePrd = useDeletePrd();

  const [activeTab, setActiveTab] = useState<TabId>('preview');
  const [editContent, setEditContent] = useState('');
  const [isDirty, setIsDirty] = useState(false);

  const [showRevisionModal, setShowRevisionModal] = useState(false);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  const isGenerating = !!prd && prd.content === '';

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

  const handleSubmit = useCallback(async () => {
    if (!id) return;
    await submitPrd.mutateAsync(id);
  }, [id, submitPrd]);

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

  const handleRejectConfirm = useCallback(async (reason: string) => {
    if (!id) return;
    await reviewPrd.mutateAsync({ prdId: id, action: 'reject', comment: reason });
    setShowRejectModal(false);
  }, [id, reviewPrd]);

  const handleRevisionConfirm = useCallback(async (reason: string) => {
    if (!id) return;
    await reviewPrd.mutateAsync({ prdId: id, action: 'request_revision', comment: reason });
    setShowRevisionModal(false);
  }, [id, reviewPrd]);

  const handleTabChange = useCallback((tab: TabId) => {
    if (tab === 'edit' && prd) {
      setEditContent(prd.content);
      setIsDirty(false);
    }
    setActiveTab(tab);
  }, [prd]);

  if (isLoading) return <div className={styles.loadingState}>Loading PRD…</div>;
  if (isError || !prd) return <div className={styles.errorState}>PRD not found.</div>;

  const isAuthor = prd.authorId === userId;
  const canManage = can('interviews:manage');

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <button className={styles.backBtn} onClick={() => navigate('/backlog?tab=prds')} type="button">
            ← Back
          </button>
          <div className={styles.headerInfo}>
            <div className={styles.titleRow}>
              <h1 className={styles.title}>{prd.title}</h1>
              <span className={`${styles.statusBadge} ${statusBadgeClass(prd.status)}`}>
                {statusLabel(prd.status)}
              </span>
            </div>
            {prd.reviewerId && prd.reviewedAt && (
              <div className={styles.reviewInfo}>
                <span className={styles.reviewInfoRow}>
                  Reviewed by {prd.reviewerName ?? prd.reviewerId} on {formatDate(prd.reviewedAt)}
                </span>
                {prd.reviewComment && (
                  <span className={styles.reviewInfoRow}>"{prd.reviewComment}"</span>
                )}
              </div>
            )}
          </div>
        </div>

        <div className={styles.headerRight}>
          {prd.status === 'approved' && !canManage && (
            <span className={styles.reviewOnlyBadge}>Read-only — approved</span>
          )}

          {canManage && isAuthor && (
            <>
              {(prd.status === 'draft' || prd.status === 'revision_requested' || prd.status === 'rejected') && (
                <button
                  className={styles.actionBtnPrimary}
                  onClick={() => void handleSubmit()}
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
                Delete
              </button>
            </>
          )}

          {canManage && prd.status === 'pending_review' && (
            <div className={styles.reviewControls}>
              <button
                className={styles.btnApprove}
                onClick={() => void handleApprove()}
                disabled={reviewPrd.isPending}
                type="button"
              >
                Approve
              </button>
              <button
                className={styles.btnRevision}
                onClick={() => setShowRevisionModal(true)}
                type="button"
              >
                Request Revision
              </button>
              <button
                className={styles.btnReject}
                onClick={() => setShowRejectModal(true)}
                type="button"
              >
                Reject
              </button>
            </div>
          )}
        </div>
      </div>

      {prd.status === 'rejected' && prd.reviewComment && (
        <div className={styles.rejectionBanner}>
          <strong>Rejected:</strong> {prd.reviewComment}
        </div>
      )}

      {prd.status === 'approved' && linkedDesignDoc && (
        <div className={styles.designDocBanner}>
          <span className={styles.designDocBannerText}>
            A design doc was created from this PRD.
          </span>
          <button
            className={styles.designDocBannerLink}
            onClick={() => navigate(`/backlog/design-doc/${linkedDesignDoc.id}`)}
            type="button"
          >
            View Design Doc →
          </button>
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
            {canManage && isAuthor && prd.status !== 'approved' && (
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
              <div className={styles.preview}>
                {prd.content ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{prd.content}</ReactMarkdown>
                ) : (
                  <div className={styles.emptyPreview}>
                    No content yet.{canManage && isAuthor ? ' Use the Edit tab to write the PRD.' : ''}
                  </div>
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
              <div className={styles.backlogView}>
                {prd.backlogJson ? (
                  <BacklogViewer data={prd.backlogJson} />
                ) : (
                  <div className={styles.emptyPreview}>No backlog data yet.</div>
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

      {showRejectModal && prd && (
        <PrdRejectModal
          prdTitle={prd.title}
          isPending={reviewPrd.isPending}
          onConfirm={(reason) => void handleRejectConfirm(reason)}
          onCancel={() => setShowRejectModal(false)}
        />
      )}

      {showRevisionModal && prd && (
        <PrdRevisionModal
          prdTitle={prd.title}
          isPending={reviewPrd.isPending}
          onConfirm={(reason) => void handleRevisionConfirm(reason)}
          onCancel={() => setShowRevisionModal(false)}
        />
      )}
    </div>
  );
};

export default PrdReviewView;

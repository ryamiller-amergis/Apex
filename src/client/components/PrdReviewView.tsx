import React, { useState, useCallback, useMemo, useEffect, useReducer } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PrdAssistantPanel } from './PrdAssistantPanel';
import { useLocation, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAppShell } from '../hooks/useAppShell';
import {
  usePrd,
  useInterview,
  useUpdatePrdContent,
  useUpdatePrdBacklog,
  useSubmitPrd,
  useWithdrawPrd,
  useReopenPrd,
  useReviewPrd,
  useDeletePrd,
  useDesignDocsByPrd,
  usePrdTestCases,
  useCreatePrdAdoItems,
  useSyncPrdAdoStatus,
  useDocumentAssignments,
  useReassignApprovers,
  useFixPrdWithAi,
  useFixPrdCommentWithAi,
  useCreatePrdValidationThread,
  useCancelPrdValidation,
  useRefreshPrdValidation,
  useFixPrdValidation,
  useAcceptFixPrdValidation,
  useRevertPrdSection,
  usePrdValidationReport,
  useGenerateTestCases,
  useScreenInventoryRoutes,
  useCreateDesignDoc,
} from '../hooks/useInterviews';
import {
  useReviewComments,
  useUnresolvedCommentCount,
  useCreateComment,
  useResolveComment,
  useReopenComment as useReopenReviewComment,
  useDeleteComment,
} from '../hooks/useReviewComments';
import { ProposedChangesReview } from './ProposedChangesReview';
import { usePrototypesForPrd, useGeneratePrototypesForPrd } from '../hooks/useDesignPrototypes';
import { useDesignPlan } from '../hooks/useDesignPlan';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { ApproverSelectModal } from './ApproverSelectModal';
import { AnnotationLayer } from './AnnotationLayer';
import { ReviewCommentSidebar } from './ReviewCommentSidebar';
import { BacklogViewer } from './BacklogViewer';
import { CreateAdoItemsModal } from './CreateAdoItemsModal';
import { FixingProgressView } from './FixValidationPanel';
import { ApexFixRunningBanner } from './ApexFixRunningBanner';
import type { PrdStatus, PrdValidationBaseline, TestCaseCoverageSummary } from '../../shared/types/interview';
import {
  isPrdSingleCommentFixPending,
  prdHasProposedChanges,
} from '../utils/apexFixHelpers';
import {
  clearApexFixInProgress,
  fetchChatThreadStatus,
  markApexFixInProgress,
  readApexFixInProgress,
} from '../utils/apexFixSession';
import {
  derivePrdReadiness,
  type PrdReadiness,
  type PrdReadinessSeverity,
  type PrdReadinessStageStatus,
} from '../../shared/utils/prdReadiness';
import { buildPassingValidationReasonsMarkdown } from '../../shared/utils/validationReport';
import type {
  ReviewSectionKey,
  TextSelector,
} from '../../shared/types/reviewComments';
import styles from './PrdReviewView.module.css';

type TabId = 'preview' | 'backlog' | 'validation';

type PrdFixFlowState =
  | { phase: 'idle' }
  | { phase: 'fixing'; baseline: PrdValidationBaseline; threadId: string }
  | { phase: 'reviewing'; baseline: PrdValidationBaseline; threadId: string; agentError?: string };

type PrdFixFlowAction =
  | { type: 'START_FIX'; baseline: PrdValidationBaseline; threadId: string }
  | { type: 'FIX_COMPLETE'; agentError?: string }
  | { type: 'RESET' };

function prdFixFlowReducer(state: PrdFixFlowState, action: PrdFixFlowAction): PrdFixFlowState {
  switch (action.type) {
    case 'START_FIX':
      return { phase: 'fixing', baseline: action.baseline, threadId: action.threadId };
    case 'FIX_COMPLETE':
      if (state.phase !== 'fixing') return state;
      return {
        phase: 'reviewing',
        baseline: state.baseline,
        threadId: state.threadId,
        agentError: action.agentError,
      };
    case 'RESET':
      return { phase: 'idle' };
    default:
      return state;
  }
}

/* ── User-story projection (read-only, derived from the backlog) ──────────────── */

interface ProjectedUserStory {
  id: string;
  persona: string;
  iWant: string;
  soThat: string;
}

/**
 * Project user stories from the backlog JSON. Stories are single-owned by the
 * backlog (PBI `userStory` objects under epics[].features[].items[]); the PRD
 * view renders them read-only rather than the stored PRD markdown authoring them.
 */
function projectUserStories(backlogJson: unknown): ProjectedUserStory[] {
  if (typeof backlogJson !== 'object' || backlogJson === null) return [];
  const backlog = backlogJson as {
    epics?: Array<{
      features?: Array<{
        items?: Array<{
          type?: string;
          id?: string;
          userStory?: { persona?: string; iWant?: string; soThat?: string };
        }>;
      }>;
    }>;
  };

  const stories: ProjectedUserStory[] = [];
  for (const epic of backlog.epics ?? []) {
    for (const feature of epic.features ?? []) {
      for (const item of feature.items ?? []) {
        if (item.type !== 'PBI' || !item.userStory) continue;
        const { persona, iWant, soThat } = item.userStory;
        if (!persona && !iWant && !soThat) continue;
        stories.push({
          id: item.id ?? `story-${stories.length}`,
          persona: persona ?? '',
          iWant: iWant ?? '',
          soThat: soThat ?? '',
        });
      }
    }
  }
  return stories;
}

function formatUserStory(story: ProjectedUserStory): string {
  return `As a ${story.persona || 'user'}, I want ${story.iWant || '…'}, so that ${story.soThat || '…'}.`;
}

/* ── Section parsing helpers ─────────────────────────────────────────────────── */

function parsePrdSections(content: string): string[] {
  if (!content) return [];
  return content.split(/(?=\n## )/).filter((s) => s !== '');
}

function stitchSections(
  sections: string[],
  index: number,
  newContent: string
): string {
  const updated = [...sections];
  updated[index] = newContent;
  return updated.join('');
}

/* ── Status helpers ──────────────────────────────────────────────────────────── */

function statusBadgeClass(status: PrdStatus): string {
  switch (status) {
    case 'generating':
      return styles.badgeGenerating;
    case 'draft':
      return styles.badgeDraft;
    case 'validating':
      return styles.badgeGenerating;
    case 'pending_review':
      return styles.badgePendingReview;
    case 'approved':
      return styles.badgeApproved;
    case 'revision_requested':
      return styles.badgeRevisionRequested;
  }
}

function statusLabel(status: PrdStatus): string {
  switch (status) {
    case 'generating':
      return 'Generating';
    case 'draft':
      return 'Draft';
    case 'validating':
      return 'Validating';
    case 'pending_review':
      return 'Pending Review';
    case 'approved':
      return 'Approved';
    case 'revision_requested':
      return 'Revision Requested';
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function readinessBannerClass(severity: PrdReadinessSeverity): string {
  switch (severity) {
    case 'success':
      return styles.readinessSuccess;
    case 'error':
      return styles.readinessError;
    case 'warning':
      return styles.readinessWarning;
    case 'info':
      return styles.readinessInfo;
    case 'neutral':
      return styles.readinessNeutral;
  }
}

function readinessStepClass(status: PrdReadinessStageStatus): string {
  switch (status) {
    case 'complete':
      return styles.readinessStepComplete;
    case 'current':
      return styles.readinessStepActive;
    case 'blocked':
      return styles.readinessStepFailed;
    case 'pending':
      return styles.readinessStepPending;
  }
}

function formatCoverageSummary(summary: TestCaseCoverageSummary): string[] {
  return [
    `${summary.totalCases} total test case${summary.totalCases === 1 ? '' : 's'}`,
    `${summary.pbisCovered} PBI${summary.pbisCovered === 1 ? '' : 's'} covered`,
    `${summary.acCovered} acceptance criteria`,
    `${summary.brCovered} business rules`,
  ];
}

function shouldDefaultReadinessExpanded(readiness: PrdReadiness): boolean {
  if (readiness.blockingReason) return true;
  if (readiness.qaFailures.length > 0) return true;
  return readiness.severity === 'error' || readiness.severity === 'warning';
}

const PrdReadinessPanel: React.FC<{
  readiness: PrdReadiness;
  coverage?: TestCaseCoverageSummary | null;
}> = ({ readiness, coverage }) => {
  const [expanded, setExpanded] = useState(() => shouldDefaultReadinessExpanded(readiness));

  return (
    <div
      className={`${styles.readinessBanner} ${readinessBannerClass(readiness.severity)} ${expanded ? '' : styles.readinessBannerCollapsed}`}
    >
      <button
        type="button"
        className={styles.readinessToggle}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse PRD readiness' : 'Expand PRD readiness'}
      >
        <svg
          className={`${styles.readinessChevron} ${expanded ? styles.readinessChevronExpanded : ''}`}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="6 4 10 8 6 12" />
        </svg>
        <span className={styles.readinessTitle}>PRD readiness</span>
        <span className={styles.readinessStatus}>{readiness.label}</span>
        {!expanded && readiness.blockingReason && (
          <span className={styles.readinessCollapsedHint}>{readiness.blockingReason}</span>
        )}
      </button>

      {expanded && (
        <>
          <div className={styles.readinessHeader}>
            <div className={styles.readinessDescription}>{readiness.description}</div>
            {readiness.blockingReason && (
              <div className={styles.readinessBlocker}>{readiness.blockingReason}</div>
            )}
          </div>

          <div className={styles.readinessStages}>
            {readiness.stages.map((stage) => (
              <div
                key={stage.id}
                className={`${styles.readinessStep} ${readinessStepClass(stage.status)}`}
              >
                <span className={styles.readinessStepDot} />
                <span className={styles.readinessStepLabel}>{stage.label}</span>
                {stage.detail && (
                  <span className={styles.readinessStepDetail}>{stage.detail}</span>
                )}
              </div>
            ))}
          </div>

          {(coverage || readiness.qaFailures.length > 0) && (
            <div className={styles.qaSummary}>
              {coverage && (
                <div className={styles.qaSummaryItems}>
                  {formatCoverageSummary(coverage).map((item) => (
                    <span key={item} className={styles.qaSummaryItem}>
                      {item}
                    </span>
                  ))}
                </div>
              )}
              {readiness.qaFailures.length > 0 && (
                <ul className={styles.qaFailures}>
                  {readiness.qaFailures.map((failure) => (
                    <li key={failure}>{failure}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export const PrdReviewView: React.FC = () => {
  const location = useLocation();
  const id = location.pathname.split('/').pop() ?? null;
  const navigate = useNavigate();
  const { can, userId, isAdmin } = useAppShell();

  const queryClient = useQueryClient();
  const { data: prd, isLoading, isError } = usePrd(id);
  const { data: relatedDesignDocs } = useDesignDocsByPrd(
    prd?.status === 'approved' ? id : undefined
  );
  const { data: relatedPrototypes = [] } = usePrototypesForPrd(
    prd?.status === 'approved' ? id : null
  );
  const generatePrototypes = useGeneratePrototypesForPrd();
  const createDesignDoc = useCreateDesignDoc();
  const { data: testCaseRecord } = usePrdTestCases(id);
  const { data: designPlanResponse } = useDesignPlan(prd?.status === 'approved' ? (id ?? null) : null);
  const { data: sourceInterview } = useInterview(prd?.interviewId ?? null);
  const latestTestCase = testCaseRecord ?? prd?.latestTestCase ?? null;
  const readiness = prd ? derivePrdReadiness(prd, latestTestCase, prd.validationScoreThreshold ?? undefined) : null;

  const updateContent = useUpdatePrdContent();
  const updateBacklog = useUpdatePrdBacklog();
  const submitPrd = useSubmitPrd();
  const withdrawPrd = useWithdrawPrd();
  const reopenPrd = useReopenPrd();
  const reviewPrd = useReviewPrd();
  const deletePrd = useDeletePrd();
  const createAdoItems = useCreatePrdAdoItems();
  const syncAdoStatus = useSyncPrdAdoStatus(id);
  const fixWithAi = useFixPrdWithAi(id ?? '');
  const fixPrdCommentWithAi = useFixPrdCommentWithAi(id ?? '');

  const generateTestCases = useGenerateTestCases();

  // PRD Validation hooks
  const createPrdValidationThread = useCreatePrdValidationThread();
  const cancelPrdValidation = useCancelPrdValidation();
  const refreshPrdValidation = useRefreshPrdValidation();
  const fixPrdValidation = useFixPrdValidation();
  const acceptFixPrdValidation = useAcceptFixPrdValidation();
  const revertPrdSection = useRevertPrdSection();
  const { data: validationReport } = usePrdValidationReport(
    id,
    prd?.validationThreadId,
    prd?.status
  );

  const [prdFixFlow, prdFixFlowDispatch] = useReducer(prdFixFlowReducer, { phase: 'idle' });

  const [activeTab, setActiveTab] = useState<TabId>('preview');
  const [fixingCommentId, setFixingCommentId] = useState<string | null>(null);
  const [bulkCommentFixRunning, setBulkCommentFixRunning] = useState(false);

  /* ── Full-document edit modal ─────────────────────────────────────────────── */
  const [showEditModal, setShowEditModal] = useState(false);
  const [editModalContent, setEditModalContent] = useState('');

  /* ── Section-level edit modal ────────────────────────────────────────────── */
  const [editingSectionIndex, setEditingSectionIndex] = useState<number | null>(
    null
  );
  const [sectionEditContent, setSectionEditContent] = useState('');

  const parsedSections = useMemo(
    () => parsePrdSections(prd?.content ?? ''),
    [prd?.content]
  );

  const projectedUserStories = useMemo(
    () => projectUserStories(prd?.backlogJson),
    [prd?.backlogJson]
  );

  const reassignApprovers = useReassignApprovers();

  const { data: reviewComments = [] } = useReviewComments(id, 'prd');
  const { data: unresolvedData } = useUnresolvedCommentCount(id, 'prd');
  const unresolvedCount = unresolvedData?.count ?? 0;
  const createComment = useCreateComment('prd', id);
  const resolveComment = useResolveComment(userId ?? '');
  const reopenReviewComment = useReopenReviewComment();
  const deleteComment = useDeleteComment();

  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [pendingSelector, setPendingSelector] = useState<{
    sectionKey: ReviewSectionKey;
    selector: TextSelector;
  } | null>(null);
  const [newCommentBody, setNewCommentBody] = useState('');

  const [assistantOpen, setAssistantOpen] = useState(false);

  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showAdoModal, setShowAdoModal] = useState(false);
  const [showApproverModal, setShowApproverModal] = useState(false);
  const [showReassignModal, setShowReassignModal] = useState(false);
  const [showAllLinks, setShowAllLinks] = useState(false);

  const { data: assignments = [] } = useDocumentAssignments(id, 'prd');
  const { data: routeOptions = [] } = useScreenInventoryRoutes(!!prd && prd.status !== 'approved');

  const isGenerating =
    !!prd && prd.status === 'generating' && prd.content === '';
  const generationFailed =
    !!prd && prd.status === 'draft' && prd.content === '';

  /* ── Full-document edit handlers ─────────────────────────────────────────── */

  const handleOpenEditModal = useCallback(() => {
    if (!prd) return;
    setEditModalContent(prd.content);
    setShowEditModal(true);
  }, [prd]);

  const handleSaveEditModal = useCallback(async () => {
    if (!id || !prd) return;
    await updateContent.mutateAsync({ prdId: id, content: editModalContent });
    setShowEditModal(false);
  }, [id, prd, editModalContent, updateContent]);

  /* ── Section edit handlers ───────────────────────────────────────────────── */

  const handleEditSection = useCallback(
    (index: number) => {
      setSectionEditContent(parsedSections[index]);
      setEditingSectionIndex(index);
    },
    [parsedSections]
  );

  const handleSaveSectionEdit = useCallback(async () => {
    if (!id || !prd || editingSectionIndex === null) return;
    const updatedContent = stitchSections(
      parsedSections,
      editingSectionIndex,
      sectionEditContent
    );
    await updateContent.mutateAsync({ prdId: id, content: updatedContent });
    setEditingSectionIndex(null);
  }, [
    id,
    prd,
    editingSectionIndex,
    sectionEditContent,
    parsedSections,
    updateContent,
  ]);

  /* ── Other handlers ──────────────────────────────────────────────────────── */

  const handleSubmit = useCallback(() => {
    if (!id || !readiness?.readyForReviewActions) return;
    setShowApproverModal(true);
  }, [id, readiness?.readyForReviewActions]);

  const handleApproverConfirm = useCallback(
    async (selections: {
      prdApproverIds?: string[];
      designDocApproverIds?: string[];
    }) => {
      if (!id || !readiness?.readyForReviewActions) return;
      await submitPrd.mutateAsync({
        prdId: id,
        prdApproverIds: selections.prdApproverIds ?? [],
        designDocApproverIds: selections.designDocApproverIds ?? [],
      });
      setShowApproverModal(false);
    },
    [id, readiness?.readyForReviewActions, submitPrd]
  );

  const handleReassignConfirm = useCallback(
    async (selections: {
      prdApproverIds?: string[];
      designDocApproverIds?: string[];
    }) => {
      if (!id) return;
      await reassignApprovers.mutateAsync({
        documentId: id,
        documentType: 'prd',
        approverUserIds: selections.prdApproverIds ?? [],
        designDocApproverIds: selections.designDocApproverIds,
      });
      setShowReassignModal(false);
    },
    [id, reassignApprovers]
  );

  const handleWithdraw = useCallback(async () => {
    if (!id) return;
    await withdrawPrd.mutateAsync(id);
  }, [id, withdrawPrd]);

  const handleApprove = useCallback(async () => {
    if (!id || !readiness?.readyForReviewActions) return;
    const result = await reviewPrd.mutateAsync({
      prdId: id,
      action: 'approve',
    });
    if (result?.approved) {
      navigate(`/backlog/design-plan/${id}`);
    }
  }, [id, readiness?.readyForReviewActions, reviewPrd, navigate]);

  const handleAddComment = useCallback(
    (sectionKey: ReviewSectionKey, selector: TextSelector) => {
      setPendingSelector({ sectionKey, selector });
      setNewCommentBody('');
    },
    []
  );

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

  const handleReply = useCallback(
    async (commentId: string, body: string) => {
      await fetch(`/api/review-comments/${commentId}/replies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ body }),
      });
      void queryClient.invalidateQueries({
        queryKey: ['review-comments', 'prd', id],
      });
    },
    [queryClient, id]
  );

  const handleCommentClick = useCallback(
    (commentId: string) => {
      const comment = reviewComments.find((c) => c.id === commentId);
      if (comment) {
        const targetTab: TabId =
          comment.sectionKey === 'backlog' ? 'backlog' : 'preview';
        setActiveTab(targetTab);
      }
      setActiveCommentId(commentId);
    },
    [reviewComments]
  );

  const handleFixCommentWithAi = useCallback(
    async (commentId: string) => {
      if (!id) return;
      setFixingCommentId(commentId);
      try {
        await fixPrdCommentWithAi.mutateAsync({ commentId });
      } finally {
        setFixingCommentId(null);
      }
    },
    [id, fixPrdCommentWithAi]
  );

  const handleFixAllCommentsWithAi = useCallback(async () => {
    if (!id) return;
    markApexFixInProgress('prd-comments-bulk', id);
    setBulkCommentFixRunning(true);
    try {
      await fixWithAi.mutateAsync();
    } catch {
      clearApexFixInProgress('prd-comments-bulk', id);
      setBulkCommentFixRunning(false);
    }
  }, [id, fixWithAi]);

  const handleStartFixValidation = useCallback(async () => {
    if (!id || !prd) return;
    const baseline: PrdValidationBaseline = {
      content: prd.content || '',
      backlogJson: prd.backlogJson,
      capturedAt: new Date().toISOString(),
    };
    markApexFixInProgress('prd-validation', id);
    try {
      const result = await fixPrdValidation.mutateAsync(id);
      markApexFixInProgress('prd-validation', id, { threadId: result.threadId });
      prdFixFlowDispatch({ type: 'START_FIX', baseline, threadId: result.threadId });
    } catch {
      clearApexFixInProgress('prd-validation', id);
      prdFixFlowDispatch({ type: 'RESET' });
    }
  }, [id, prd, fixPrdValidation]);

  const handleFixValidationCancel = useCallback(() => {
    if (id) clearApexFixInProgress('prd-validation', id);
    prdFixFlowDispatch({ type: 'RESET' });
  }, [id]);

  const handleAcceptFixValidation = useCallback(async () => {
    if (!id) return;
    await acceptFixPrdValidation.mutateAsync(id);
    clearApexFixInProgress('prd-validation', id);
    prdFixFlowDispatch({ type: 'RESET' });
  }, [id, acceptFixPrdValidation]);

  const handleRevertFixValidation = useCallback(async () => {
    if (!id) return;
    await revertPrdSection.mutateAsync(id);
    clearApexFixInProgress('prd-validation', id);
    prdFixFlowDispatch({ type: 'RESET' });
  }, [id, revertPrdSection]);

  // Recover in-progress comment fixes after navigation.
  useEffect(() => {
    if (!prd || !id) return;
    if (isPrdSingleCommentFixPending(prd)) {
      setFixingCommentId(prd.fixCommentId ?? null);
    }
    const bulkSession = readApexFixInProgress('prd-comments-bulk', id);
    if (bulkSession && !prdHasProposedChanges(prd)) {
      setBulkCommentFixRunning(true);
    } else if (bulkSession && prdHasProposedChanges(prd)) {
      clearApexFixInProgress('prd-comments-bulk', id);
      setBulkCommentFixRunning(false);
    }
  }, [prd, id]);

  // Restore validation fix flow from server fixBaseline after navigation.
  useEffect(() => {
    if (!prd || prdFixFlow.phase !== 'idle') return;
    if (!prd.fixBaseline) return;

    const baseline = prd.fixBaseline;
    const threadId = baseline.fixThreadId ?? prd.prdAssistantThreadId;
    if (!threadId) return;

    let cancelled = false;

    (async () => {
      if (!readApexFixInProgress('prd-validation', prd.id)) {
        markApexFixInProgress('prd-validation', prd.id, { threadId });
      }
      const thread = await fetchChatThreadStatus(threadId);
      if (cancelled) return;
      if (thread && thread.status !== 'idle' && thread.status !== 'error') {
        prdFixFlowDispatch({ type: 'START_FIX', baseline, threadId });
        return;
      }
      if (thread && (thread.status === 'idle' || thread.status === 'error')) {
        await queryClient.refetchQueries({ queryKey: ['prd', prd.id] });
        if (cancelled) return;
        prdFixFlowDispatch({ type: 'START_FIX', baseline, threadId });
        prdFixFlowDispatch({
          type: 'FIX_COMPLETE',
          agentError: thread.status === 'error'
            ? (thread.lastError ?? 'The AI agent encountered an error and could not complete the fix.')
            : undefined,
        });
        return;
      }
      // Thread not found — treat as completed with error so the UI doesn't get stuck
      clearApexFixInProgress('prd-validation', prd.id);
      prdFixFlowDispatch({ type: 'START_FIX', baseline, threadId });
      prdFixFlowDispatch({
        type: 'FIX_COMPLETE',
        agentError: 'The fix session is no longer available. You can try again.',
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [prd?.id, prd?.fixBaseline, prd?.prdAssistantThreadId, prdFixFlow.phase, queryClient]);

  // Poll the assistant thread until Apex finishes applying validation fixes.
  useEffect(() => {
    if (prdFixFlow.phase !== 'fixing' || !id) return;
    const { threadId } = prdFixFlow;
    let cancelled = false;

    let notFoundCount = 0;
    const poll = async () => {
      try {
        const thread = await fetchChatThreadStatus(threadId);
        if (cancelled) return;
        if (!thread) {
          notFoundCount++;
          if (notFoundCount >= 3) {
            clearApexFixInProgress('prd-validation', id);
            prdFixFlowDispatch({
              type: 'FIX_COMPLETE',
              agentError: 'The fix session is no longer available. You can try again.',
            });
          }
          return;
        }
        notFoundCount = 0;
        if (thread.status === 'idle' || thread.status === 'error') {
          await queryClient.refetchQueries({ queryKey: ['prd', id] });
          if (!cancelled) {
            clearApexFixInProgress('prd-validation', id);
            prdFixFlowDispatch({
              type: 'FIX_COMPLETE',
              agentError: thread.status === 'error'
                ? (thread.lastError ?? 'The AI agent encountered an error and could not complete the fix.')
                : undefined,
            });
          }
        }
      } catch {
        /* keep polling */
      }
    };

    void poll();
    const interval = window.setInterval(() => {
      if (!cancelled) void poll();
    }, 5_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [prdFixFlow, id, queryClient]);

  // Clear bulk comment fix session once proposed changes land.
  useEffect(() => {
    if (!prd || !id || !bulkCommentFixRunning) return;
    if (prdHasProposedChanges(prd)) {
      clearApexFixInProgress('prd-comments-bulk', id);
      setBulkCommentFixRunning(false);
    }
  }, [prd, id, bulkCommentFixRunning]);

  // Poll while bulk comment fix is in flight (no server-side in-progress flag).
  useEffect(() => {
    if (!id || !bulkCommentFixRunning) return;
    const interval = window.setInterval(() => {
      void queryClient.refetchQueries({ queryKey: ['prd', id] });
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [id, bulkCommentFixRunning, queryClient]);

  // Poll until fixBaseline lands after validation fix was started (e.g. user navigated away early).
  useEffect(() => {
    if (!id || prdFixFlow.phase !== 'idle') return;
    const session = readApexFixInProgress('prd-validation', id);
    if (!session || prd?.fixBaseline) return;
    const interval = window.setInterval(() => {
      void queryClient.refetchQueries({ queryKey: ['prd', id] });
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [id, prd?.fixBaseline, prdFixFlow.phase, queryClient]);

  useEffect(() => {
    if (!prd || prd.status !== 'approved' || !prd.backlogJson) return;
    const backlog = prd.backlogJson as {
      epics?: Array<{ adoWorkItemId?: number }>;
    };
    const hasAnyAdoIds = (backlog.epics ?? []).some((e) => e.adoWorkItemId);
    if (!hasAnyAdoIds) return;
    syncAdoStatus.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prd?.id, prd?.status]);

  const hasUnpushedItems = useMemo(() => {
    if (!prd?.backlogJson) return false;
    const backlog = prd.backlogJson as {
      epics?: Array<{ adoWorkItemId?: number }>;
    };
    return (backlog.epics ?? []).some((e) => !e.adoWorkItemId);
  }, [prd?.backlogJson]);

  if (isLoading) return <div className={styles.loadingState}>Loading PRD…</div>;
  if (isError || !prd)
    return <div className={styles.errorState}>PRD not found.</div>;
  if (!readiness)
    return <div className={styles.errorState}>PRD readiness unavailable.</div>;

  const isAuthor = prd.authorId === userId;
  const isOwner = prd.ownerId === userId;
  const canManage = can('interviews:manage');
  const canReview = can('prds:review');
  const isAssignedApprover = assignments.some(
    (a) => a.approverUserId === userId
  );
  const canPerformReview =
    canReview && (isAssignedApprover || isAdmin) && (!isAuthor || isAdmin);
  const anyDesignDocApproved =
    relatedDesignDocs && relatedDesignDocs.some((d) => d.status === 'approved');

  const canCreateAdoItems =
    prd.status === 'approved' &&
    anyDesignDocApproved &&
    can('workitems:write') &&
    hasUnpushedItems;

  const showCommentLayer =
    (prd.status === 'pending_review' || prd.status === 'revision_requested') &&
    readiness.readyForReviewActions &&
    (canPerformReview || isAuthor || isOwner || isAdmin);

  const canEditContent =
    canManage && (isAuthor || isOwner || isAdmin) && prd.status !== 'approved';

  const sectionComments = reviewComments.filter((c) => c.sectionKey === 'prd');
  const validationFixSession = id ? readApexFixInProgress('prd-validation', id) : null;
  const apexFixRunningBanner = (() => {
    if (prdFixFlow.phase === 'fixing' || (validationFixSession && prdFixFlow.phase === 'idle')) {
      return {
        title: 'Apex is fixing validation gaps…',
        subtitle: 'You can leave this page — progress will resume when you return.',
      };
    }
    if (bulkCommentFixRunning || fixWithAi.isPending) {
      return {
        title: 'Apex is applying review comment fixes…',
        subtitle: 'Proposed changes will appear here when complete.',
      };
    }
    if (fixingCommentId || isPrdSingleCommentFixPending(prd)) {
      return {
        title: 'Apex is fixing a review comment…',
        subtitle: 'The proposed edit will appear when complete.',
      };
    }
    return null;
  })();
  const isBulkCommentFixing = bulkCommentFixRunning || fixWithAi.isPending;
  const backlogComments = reviewComments.filter(
    (c) => c.sectionKey === 'backlog'
  );

  /* ── Pencil SVG icon ─────────────────────────────────────────────────────── */
  const pencilIcon = (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M11.5 2.5l2 2L5 13H3v-2L11.5 2.5z" />
    </svg>
  );

  /* ── Preview content (with optional section editing) ────────────────────── */
  const previewContent = prd.content ? (
    canEditContent ? (
      <>
        {parsedSections.map((section, index) => (
          <div key={index} className={styles.sectionWrapper}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{section}</ReactMarkdown>
            <button
              type="button"
              className={styles.sectionEditBtn}
              aria-label="Edit section"
              onClick={() => handleEditSection(index)}
            >
              {pencilIcon}
            </button>
          </div>
        ))}
      </>
    ) : (
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{prd.content}</ReactMarkdown>
    )
  ) : (
    <div className={styles.emptyPreview}>
      No content yet.
      {canEditContent ? ' Use the Edit button to write the PRD.' : ''}
    </div>
  );

  /* ── User Stories (read-only projection from the backlog) ────────────────── */
  const userStoriesBody =
    projectedUserStories.length > 0 ? (
      <section className={styles.userStoriesProjection}>
        <div className={styles.userStoriesHeading}>
          <h2>User Stories</h2>
          <span
            className={styles.derivedBadge}
            title="User stories are owned by the backlog. Edit them on the Backlog tab — this view is read-only."
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="2" width="10" height="12" rx="1.5" />
              <path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" />
            </svg>
            Synced from backlog · read-only
          </span>
        </div>
        <ol className={styles.userStoryList}>
          {projectedUserStories.map((story) => (
            <li key={story.id} className={styles.userStoryItem}>
              {formatUserStory(story)}
            </li>
          ))}
        </ol>
      </section>
    ) : null;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <button
            className={styles.backBtn}
            onClick={() => navigate('/backlog?tab=prds')}
            type="button"
          >
            ←
          </button>
          <div className={styles.headerInfo}>
            <div className={styles.titleRow}>
              <h1 className={styles.title}>{prd.title}</h1>
              <span
                className={`${styles.statusBadge} ${statusBadgeClass(prd.status)}`}
              >
                {statusLabel(prd.status)}
              </span>
              {prd.prdValidationEnabled && (() => {
                const hasAllArtifacts = !!prd.content && !!prd.backlogJson && prd.latestTestCase?.status === 'ready';
                if (prd.status === 'validating') {
                  return (
                    <span className={`${styles.validationBadge} ${styles.badgeRunning}`}>
                      ⟳ Running
                    </span>
                  );
                }
                if (prd.validationScore !== null && prd.validationScore !== undefined && prd.validationScore >= (prd.validationScoreThreshold ?? 90)) {
                  return (
                    <span className={`${styles.validationBadge} ${styles.badgePassed}`}>
                      ✓ Passed ({prd.validationScore}%)
                    </span>
                  );
                }
                if (prd.validationScore !== null && prd.validationScore !== undefined) {
                  return (
                    <span className={`${styles.validationBadge} ${styles.badgeError}`}>
                      ✗ Error ({prd.validationScore}%)
                    </span>
                  );
                }
                if (!hasAllArtifacts && prd.validationScore == null) {
                  return (
                    <span className={`${styles.validationBadge} ${styles.badgeUnavailable}`}>
                      Validation unavailable
                    </span>
                  );
                }
                return null;
              })()}
              {prd.reviewerId && prd.reviewedAt && (
                <span className={styles.reviewBadge}>
                  <svg
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M10 3L4.5 8.5 2 6" />
                  </svg>
                  {prd.reviewerName ?? prd.reviewerId} &middot;{' '}
                  {formatDate(prd.reviewedAt)}
                </span>
              )}
            </div>
            <div className={styles.metaRow}>
              <span className={styles.metaItem}>
                <span className={styles.metaLabel}>Owner:</span>
                <span className={styles.metaValue}>
                  {prd.ownerName ??
                    prd.ownerId ??
                    prd.authorName ??
                    prd.authorId}
                </span>
              </span>
              {assignments.length > 0 && (
                <span className={styles.metaItem}>
                  <span className={styles.metaLabel}>Reviewer(s):</span>
                  <span className={styles.metaValue}>
                    {assignments
                      .map((a) => a.approverDisplayName ?? a.approverUserId)
                      .join(', ')}
                  </span>
                </span>
              )}
              {prd.model && (
                <span className={styles.metaItem}>
                  <span className={styles.metaLabel}>Model:</span>
                  <span className={styles.metaValue}>{prd.model}</span>
                </span>
              )}
            </div>
            {(sourceInterview ||
              (prd.status === 'approved' &&
                relatedDesignDocs &&
                relatedDesignDocs.length > 0)) &&
              (() => {
                const MAX_VISIBLE = 3;
                const docs =
                  prd.status === 'approved' && relatedDesignDocs
                    ? relatedDesignDocs
                    : [];
                const totalChips = (sourceInterview ? 1 : 0) + docs.length;
                const needsCollapse = totalChips > MAX_VISIBLE;
                const visibleDocs =
                  needsCollapse && !showAllLinks
                    ? docs.slice(0, MAX_VISIBLE - (sourceInterview ? 1 : 0))
                    : docs;
                const hiddenCount = docs.length - visibleDocs.length;

                return (
                  <div className={styles.parentLinks}>
                    {sourceInterview && (
                      <button
                        className={styles.parentLinkChip}
                        onClick={() =>
                          navigate(`/backlog/interview/${sourceInterview.id}`)
                        }
                        type="button"
                        title={`View Interview: ${sourceInterview.title}`}
                      >
                        <svg
                          viewBox="0 0 14 14"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <circle cx="7" cy="5" r="2.5" />
                          <path d="M2 12c0-2.76 2.24-5 5-5s5 2.24 5 5" />
                        </svg>
                        {sourceInterview.title}
                        <svg
                          viewBox="0 0 10 10"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          style={{ width: 8, height: 8, opacity: 0.6 }}
                        >
                          <path d="M2 8L8 2M5 2h3v3" />
                        </svg>
                      </button>
                    )}
                    {visibleDocs.map((doc) => (
                      <button
                        key={doc.id}
                        className={styles.parentLinkChip}
                        onClick={() =>
                          navigate(`/backlog/design-doc/${doc.id}`)
                        }
                        type="button"
                        title={`View Design Doc: ${doc.title}`}
                      >
                        <svg
                          viewBox="0 0 14 14"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <rect x="2" y="1" width="10" height="12" rx="1.5" />
                          <path d="M4.5 4.5h5M4.5 7h5M4.5 9.5h3" />
                        </svg>
                        {doc.title}
                        <svg
                          viewBox="0 0 10 10"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          style={{ width: 8, height: 8, opacity: 0.6 }}
                        >
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

          {prd.status !== 'approved' && (
            <button
              className={`${styles.actionBtn} ${assistantOpen ? styles.actionBtnActive : ''}`}
              onClick={() => setAssistantOpen((v) => !v)}
              type="button"
              aria-label="Apex Assistant"
              aria-expanded={assistantOpen}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              Apex Assistant
            </button>
          )}

          {canManage && prd.status !== 'approved' && prd.content && (readiness?.state === 'test_cases_pending' || readiness?.state === 'test_case_generation_failed') && (
            <button
              className={styles.actionBtn}
              onClick={() => void generateTestCases.mutateAsync(prd.id)}
              disabled={generateTestCases.isPending}
              type="button"
            >
              {readiness.state === 'test_case_generation_failed' ? 'Regenerate Test Cases' : 'Generate Test Cases'}
            </button>
          )}

          {canManage && prd.prdValidationEnabled && prd.status !== 'approved' && prd.status !== 'validating' && prd.content && !!prd.backlogJson && prd.latestTestCase?.status === 'ready' && (
            <button
              className={styles.actionBtn}
              onClick={() => void createPrdValidationThread.mutateAsync(prd.id)}
              disabled={createPrdValidationThread.isPending}
              type="button"
            >
              Run Validation
            </button>
          )}

          {canManage && prd.status === 'validating' && (
            <button
              className={styles.actionBtn}
              onClick={() => void cancelPrdValidation.mutateAsync(prd.id)}
              disabled={cancelPrdValidation.isPending}
              type="button"
            >
              Cancel Validation
            </button>
          )}

          {canEditContent && (
            <button
              className={styles.actionBtn}
              onClick={handleOpenEditModal}
              type="button"
              aria-label="Edit"
            >
              {pencilIcon}
              Edit
            </button>
          )}

          {canManage && (isAuthor || isOwner || isAdmin) && (
            <>
              {(prd.status === 'draft' ||
                prd.status === 'revision_requested') && (
                <button
                  className={styles.actionBtnPrimary}
                  onClick={handleSubmit}
                  disabled={
                    submitPrd.isPending ||
                    !prd.content ||
                    !readiness.readyForReviewActions
                  }
                  title={
                    !prd.content
                      ? 'PRD content is required before submitting'
                      : !readiness.readyForReviewActions
                        ? readiness.blockingReason
                        : undefined
                  }
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
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
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
              disabled={
                reopenPrd.isPending ||
                prd.status === 'approved' ||
                !readiness.readyForReviewActions
              }
              type="button"
              title={
                prd.status === 'approved'
                  ? 'Cannot reopen an approved PRD'
                  : !readiness.readyForReviewActions
                    ? readiness.blockingReason
                  : 'Admin: force this PRD back to Pending Review'
              }
            >
              {reopenPrd.isPending ? 'Reopening…' : 'Reopen for Review'}
            </button>
          )}

          {canReview &&
            (!isAuthor || isAdmin) &&
            prd.status === 'pending_review' && (
              <>
                <span className={styles.actionDivider} />
                <div className={styles.reviewControls}>
                  <button
                    className={styles.btnApprove}
                    onClick={() => void handleApprove()}
                    disabled={
                      reviewPrd.isPending ||
                      !canPerformReview ||
                      !readiness.readyForReviewActions ||
                      unresolvedCount > 0
                    }
                    title={
                      !canPerformReview
                        ? 'You are not an assigned reviewer for this document'
                        : !readiness.readyForReviewActions
                          ? readiness.blockingReason
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

          {prd.status === 'approved' &&
            can('workitems:write') &&
            hasUnpushedItems && (
              <button
                className={styles.actionBtnPrimary}
                onClick={() => setShowAdoModal(true)}
                disabled={!canCreateAdoItems || createAdoItems.isPending}
                title={
                  !anyDesignDocApproved
                    ? 'At least one design doc must be approved first'
                    : 'Create work items in Azure DevOps'
                }
                type="button"
              >
                {createAdoItems.isPending ? 'Creating…' : 'Create in ADO'}
              </button>
            )}

          {prd.status === 'pending_review' &&
            canManage &&
            (isAuthor || isOwner || isAdmin) && (
              <>
                <span className={styles.actionDivider} />
                <button
                  className={styles.actionBtn}
                  onClick={() => setShowReassignModal(true)}
                  type="button"
                  title={
                    assignments.length > 0
                      ? `Reviewers: ${assignments.map((a) => a.approverDisplayName ?? a.approverUserId).join(', ')}`
                      : 'Assign reviewers'
                  }
                >
                  <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <circle cx="6" cy="5" r="2.5" />
                    <path d="M1 13c0-2.5 2.24-4.5 5-4.5s5 2 5 4.5" />
                    <path d="M12 5.5l2 2 2-2" />
                  </svg>
                  {assignments.length > 0
                    ? `${assignments.length} Reviewer${assignments.length > 1 ? 's' : ''}`
                    : 'Reviewers'}
                </button>
              </>
            )}
        </div>
      </div>

      {apexFixRunningBanner && (
        <ApexFixRunningBanner
          title={apexFixRunningBanner.title}
          subtitle={apexFixRunningBanner.subtitle}
        />
      )}

      {/* Validation Banner */}
      {prd.validationScore !== null && prd.validationScore !== undefined && prd.validationScore < (prd.validationScoreThreshold ?? 90) && prd.status === 'draft' && prd.validationScorecard && (
        <div className={styles.validationPanel}>
          {prdFixFlow.phase === 'fixing' ? (
            <FixingProgressView onCancel={handleFixValidationCancel} />
          ) : (
            <div className={styles.validationBanner}>
              <div className={styles.validationBannerLeft}>
                <span className={styles.validationBannerText}>
                  Validation score: <strong>{prd.validationScore}%</strong> (needs ≥ {prd.validationScoreThreshold ?? 90}%).
                  {prdFixFlow.phase === 'reviewing'
                    ? prdFixFlow.agentError
                      ? ` ${prdFixFlow.agentError}`
                      : ' Review Apex\'s changes, then accept to re-validate.'
                    : ' Fix gaps to proceed.'}
                </span>
              </div>
              <div className={styles.validationActions}>
                {prdFixFlow.phase === 'idle' && canManage && (
                  <button
                    className={prd.validationScore < 70 ? styles.fixBtnRed : styles.fixBtnAmber}
                    onClick={() => void handleStartFixValidation()}
                    disabled={fixPrdValidation.isPending}
                    type="button"
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M8 2l1.09 3.26L12.36 6l-3.27 1.09L8 10.36 6.91 7.09 3.64 6l3.27-1.09z" />
                      <path d="M13 1l.54 1.63L15.18 3.18 13.54 3.72 13 5.35l-.54-1.63L10.82 3.18l1.64-.55z" />
                    </svg>
                    {fixPrdValidation.isPending ? 'Starting…' : 'Fix with Apex'}
                  </button>
                )}
                {prdFixFlow.phase === 'reviewing' && canManage && (
                  <>
                    <button
                      className={styles.fixBtnGreen}
                      onClick={() => void handleAcceptFixValidation()}
                      disabled={acceptFixPrdValidation.isPending}
                      type="button"
                    >
                      Accept & Re-validate
                    </button>
                    <button
                      className={styles.fixBtnSecondary}
                      onClick={() => void handleRevertFixValidation()}
                      disabled={revertPrdSection.isPending}
                      type="button"
                    >
                      Revert
                    </button>
                  </>
                )}
                <button
                  className={styles.fixBtnSecondary}
                  onClick={() => void createPrdValidationThread.mutateAsync(prd.id)}
                  disabled={createPrdValidationThread.isPending || prdFixFlow.phase !== 'idle'}
                  type="button"
                >
                  Re-run
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <PrdReadinessPanel
        readiness={readiness}
        coverage={latestTestCase?.coverageSummary ?? null}
      />

      {prd.status === 'approved' && designPlanResponse?.plan && (
        <div className={styles.designDocBanner}>
          <span className={styles.designDocBannerText}>
            {designPlanResponse.plan.status === 'generating'
              ? 'A design plan is being generated for this PRD.'
              : designPlanResponse.plan.status === 'consumed'
                ? 'The design plan has been used to generate prototypes.'
                : 'A design plan is ready. Review and edit it, then generate the designs.'}
          </span>
          <button
            className={styles.actionBtnPrimary}
            onClick={() => navigate(`/backlog/design-plan/${id}`)}
            type="button"
            style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}
          >
            View Design Plan →
          </button>
        </div>
      )}

      {prd.status === 'approved' && relatedPrototypes.length > 0 && (
        <div className={styles.designDocBanner}>
          <span className={styles.designDocBannerText}>
            {relatedPrototypes.length === 1
              ? '1 design prototype was generated for this PRD.'
              : `${relatedPrototypes.length} design prototypes were generated for this PRD.`}{' '}
            {relatedPrototypes.filter((p) => p.status === 'approved').length} of{' '}
            {relatedPrototypes.length} approved.
          </span>
          <button
            className={styles.actionBtnPrimary}
            onClick={() => navigate(`/backlog/design-prototypes/${id}`)}
            type="button"
            style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}
          >
            View Design Prototypes →
          </button>
        </div>
      )}

      {prd.status === 'approved' && relatedPrototypes.length === 0 && canManage && (
        <div className={styles.designDocBanner}>
          <span className={styles.designDocBannerText}>
            No design prototypes exist for this PRD. Generate them to continue the design flow.
          </span>
          <button
            className={styles.actionBtnPrimary}
            onClick={() => {
              if (!id) return;
              generatePrototypes.mutate(id, {
                onSuccess: () => navigate(`/backlog/design-prototypes/${id}`),
              });
            }}
            disabled={generatePrototypes.isPending}
            type="button"
            style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}
          >
            {generatePrototypes.isPending ? 'Generating…' : 'Generate prototypes'}
          </button>
        </div>
      )}

      {prd.status === 'approved' &&
        relatedDesignDocs &&
        relatedDesignDocs.length > 0 && (
          <div className={styles.designDocBanner}>
            <span className={styles.designDocBannerText}>
              {relatedDesignDocs.length === 1
                ? 'A design doc was created from this PRD.'
                : `${relatedDesignDocs.length} feature design docs were created from this PRD.`}
            </span>
          </div>
        )}

      {prd.status === 'approved' && (!relatedDesignDocs || relatedDesignDocs.length === 0) && canManage && (
        <div className={styles.designDocBanner}>
          <span className={styles.designDocBannerText}>
            Generate a design doc directly from the PRD and existing codebase, without requiring design prototypes.
          </span>
          <button
            className={styles.actionBtnPrimary}
            onClick={() => {
              if (!id) return;
              createDesignDoc.mutate({ prdId: id }, {
                onSuccess: (data) => {
                  if (data?.designDocId) {
                    navigate(`/backlog/design-doc/${data.designDocId}`);
                  }
                },
              });
            }}
            disabled={createDesignDoc.isPending}
            type="button"
            style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}
          >
            {createDesignDoc.isPending ? 'Generating…' : 'Generate Design Doc'}
          </button>
        </div>
      )}

      {(prd.proposedContent != null || prd.proposedBacklogJson != null) && (
        <ProposedChangesReview
          prdId={prd.id}
          currentContent={prd.content}
          currentBacklogJson={prd.backlogJson}
          proposedContent={prd.proposedContent}
          proposedBacklogJson={prd.proposedBacklogJson}
        />
      )}

      {isGenerating ? (
        /* ── Generating skeleton ─────────────────────────────────────────────── */
        <>
          <div className={styles.tabs}>
            <button
              className={`${styles.tab} ${styles.active}`}
              disabled
              type="button"
            >
              Preview
            </button>
            <button className={styles.tab} disabled type="button">
              Backlog
            </button>
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
                  <div className={styles.bannerSub}>
                    This may take a few minutes. You can navigate away and
                    return.
                  </div>
                </div>
              </div>

              <div className={styles.skeletonSection}>
                <div
                  className={styles.skeletonHeader}
                  style={{ width: '75%' }}
                />
                <div
                  className={styles.skeletonLine}
                  style={{ width: '100%' }}
                />
                <div className={styles.skeletonLine} style={{ width: '65%' }} />
                <div
                  className={styles.skeletonLine}
                  style={{ width: '100%' }}
                />
              </div>

              <div className={styles.skeletonSection}>
                <div
                  className={styles.skeletonHeader}
                  style={{ width: '45%' }}
                />
                <div
                  className={styles.skeletonLine}
                  style={{ width: '100%' }}
                />
                <div className={styles.skeletonLine} style={{ width: '70%' }} />
              </div>

              <div className={styles.skeletonSection}>
                <div
                  className={styles.skeletonHeader}
                  style={{ width: '60%' }}
                />
                <div
                  className={styles.skeletonLine}
                  style={{ width: '100%' }}
                />
                <div
                  className={styles.skeletonLine}
                  style={{ width: '100%' }}
                />
                <div className={styles.skeletonLine} style={{ width: '40%' }} />
              </div>
            </div>
          </div>
        </>
      ) : generationFailed ? (
        /* ── Generation failed banner ────────────────────────────────────────── */
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
              <div className={styles.bannerTitle}>
                PRD generation did not complete
              </div>
              <div className={styles.bannerSub}>
                The AI agent finished without producing output. You can return
                to the interview and try generating again.
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* ── Normal tabs ─────────────────────────────────────────────────────── */
        <>
          <div className={styles.tabs}>
            <button
              className={`${styles.tab} ${activeTab === 'preview' ? styles.active : ''}`}
              onClick={() => setActiveTab('preview')}
              type="button"
            >
              Preview
            </button>
            <button
              className={`${styles.tab} ${activeTab === 'backlog' ? styles.active : ''}`}
              onClick={() => setActiveTab('backlog')}
              type="button"
            >
              Backlog
            </button>
            {prd.validationScore !== null && prd.validationScore !== undefined && (
              <button
                className={`${styles.tab} ${activeTab === 'validation' ? styles.active : ''}`}
                onClick={() => setActiveTab('validation')}
                type="button"
              >
                Validation
              </button>
            )}
          </div>

          <div className={styles.tabContent}>
            {activeTab === 'preview' && (
              <div className={styles.previewWithSidebar}>
                <div className={styles.preview}>
                  {showCommentLayer ? (
                    <>
                      <AnnotationLayer
                        sectionKey="prd"
                        comments={sectionComments}
                        activeCommentId={activeCommentId}
                        onAddComment={handleAddComment}
                        onCommentClick={handleCommentClick}
                      >
                        {previewContent}
                      </AnnotationLayer>
                      {userStoriesBody && (
                        /* Stories are owned by the backlog — tag comments here
                           "backlog" so Fix-with-AI routes them to the backlog fixer. */
                        <AnnotationLayer
                          sectionKey="backlog"
                          comments={backlogComments}
                          activeCommentId={activeCommentId}
                          onAddComment={handleAddComment}
                          onCommentClick={handleCommentClick}
                        >
                          {userStoriesBody}
                        </AnnotationLayer>
                      )}
                    </>
                  ) : (
                    <>
                      {previewContent}
                      {userStoriesBody}
                    </>
                  )}
                </div>
                {showCommentLayer && (
                  <ReviewCommentSidebar
                    comments={reviewComments}
                    activeCommentId={activeCommentId}
                    currentUserId={userId ?? ''}
                    documentAuthorUserId={prd.authorId}
                    documentOwnerUserId={prd.ownerId}
                    isAssignedApprover={isAssignedApprover}
                    onCommentClick={handleCommentClick}
                    onReply={(commentId, body) =>
                      void handleReply(commentId, body)
                    }
                    onResolve={(commentId) => resolveComment.mutate(commentId)}
                    onReopen={(commentId) =>
                      reopenReviewComment.mutate(commentId)
                    }
                    onDelete={(commentId) => deleteComment.mutate(commentId)}
                    onFixWithAi={
                      canManage ? () => void handleFixAllCommentsWithAi() : undefined
                    }
                    isFixingWithAi={isBulkCommentFixing}
                    fixAiError={fixWithAi.error?.message}
                    onFixCommentWithAi={
                      canManage ? handleFixCommentWithAi : undefined
                    }
                    fixingCommentId={fixingCommentId}
                  />
                )}
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
                        <BacklogViewer
                          data={prd.backlogJson}
                          testCasesJson={testCaseRecord?.testCasesJson}
                          testCaseStatus={latestTestCase?.status}
                          editable={canEditContent}
                          routeOptions={routeOptions}
                          onSaveBacklog={(updatedData) => {
                            if (id)
                              void updateBacklog.mutateAsync({
                                prdId: id,
                                backlogData: updatedData,
                              });
                          }}
                        />
                      </AnnotationLayer>
                    ) : (
                      <BacklogViewer
                        data={prd.backlogJson}
                        testCasesJson={testCaseRecord?.testCasesJson}
                        testCaseStatus={latestTestCase?.status}
                        editable={canEditContent}
                        routeOptions={routeOptions}
                        onSaveBacklog={(updatedData) => {
                          if (id)
                            void updateBacklog.mutateAsync({
                              prdId: id,
                              backlogData: updatedData,
                            });
                        }}
                      />
                    )
                  ) : (
                    <div className={styles.emptyPreview}>
                      No backlog data yet.
                    </div>
                  )}
                </div>
                {showCommentLayer && (
                  <ReviewCommentSidebar
                    comments={reviewComments}
                    activeCommentId={activeCommentId}
                    currentUserId={userId ?? ''}
                    documentAuthorUserId={prd.authorId}
                    documentOwnerUserId={prd.ownerId}
                    isAssignedApprover={isAssignedApprover}
                    onCommentClick={handleCommentClick}
                    onReply={(commentId, body) =>
                      void handleReply(commentId, body)
                    }
                    onResolve={(commentId) => resolveComment.mutate(commentId)}
                    onReopen={(commentId) =>
                      reopenReviewComment.mutate(commentId)
                    }
                    onDelete={(commentId) => deleteComment.mutate(commentId)}
                    onFixWithAi={
                      canManage ? () => void handleFixAllCommentsWithAi() : undefined
                    }
                    isFixingWithAi={isBulkCommentFixing}
                    fixAiError={fixWithAi.error?.message}
                    onFixCommentWithAi={
                      canManage ? handleFixCommentWithAi : undefined
                    }
                    fixingCommentId={fixingCommentId}
                  />
                )}
              </div>
            )}

            {activeTab === 'validation' && (
              <div className={styles.previewWithSidebar}>
                <div className={styles.preview}>
                  {prd.validationScorecard ? (() => {
                    const sc = prd.validationScorecard;
                    const reportMarkdown = validationReport?.markdown ?? prd.validationReportMd ?? '';
                    const passingReasonsMarkdown = buildPassingValidationReasonsMarkdown(sc);
                    const reportAlreadyIncludesPassingReasons = /passing validation reasons|passing reasons|positive findings|strengths/i.test(reportMarkdown);
                    const effectiveThreshold = prd.validationScoreThreshold ?? 90;
                    const scoreColor = sc.overall_score >= effectiveThreshold ? 'var(--success-color)' : sc.overall_score >= 70 ? '#e6a817' : 'var(--error-color)';
                    const files = sc.files ?? [];
                    const features = sc.features ?? [];
                    const allGaps = files.length > 0
                      ? files.flatMap(f => (f.gaps ?? []))
                      : features.flatMap(f => (f.gaps ?? []));
                    const pendingGaps = allGaps.filter(g => g.resolution === 'pending');
                    const filledGaps = allGaps.filter(g => g.resolution === 'filled');
                    const deferredGaps = allGaps.filter(g => g.resolution === 'deferred' || g.resolution === 'accepted');
                    return (
                      <div className={styles.scorecardContainer}>
                        {/* Overall score header */}
                        <div className={styles.scorecardHeader}>
                          <div className={styles.scorecardOverall}>
                            <div className={styles.scoreRing} style={{ '--score-color': scoreColor, '--score-pct': `${sc.overall_score}%` } as React.CSSProperties}>
                              <span className={styles.scoreValue}>{Math.round(sc.overall_score)}</span>
                            </div>
                            <div className={styles.scoreDetails}>
                              <h3 className={styles.scorecardTitle}>PRD Spec Review</h3>
                              <div className={styles.scoreVerdict} data-verdict={sc.verdict}>
                                {sc.verdict === 'ready' ? 'Ready for review' : sc.verdict === 'gaps' ? 'Gaps identified' : 'Significant gaps'}
                              </div>
                              <div className={styles.scoreMeta}>
                                Threshold: {sc.ready_threshold}% &middot; Phase: {sc.review_phase}
                              </div>
                            </div>
                          </div>
                          {pendingGaps.length > 0 && (
                            <div className={styles.gapSummaryChips}>
                              <span className={styles.chipPending}>{pendingGaps.length} pending</span>
                              {filledGaps.length > 0 && <span className={styles.chipFilled}>{filledGaps.length} filled</span>}
                              {deferredGaps.length > 0 && <span className={styles.chipDeferred}>{deferredGaps.length} deferred</span>}
                            </div>
                          )}
                        </div>

                        {/* File-based breakdown (PRD validation) */}
                        {files.length > 0 && (
                          <div className={styles.featureGrid}>
                            {files.map((file) => {
                              const fColor = file.score >= 90 ? 'var(--success-color)' : file.score >= 70 ? '#e6a817' : 'var(--error-color)';
                              const fileLabel = file.file === 'prd' ? 'PRD Content' : file.file === 'backlog' ? 'Backlog' : file.file === 'test_cases' ? 'Test Cases' : file.file;
                              return (
                                <div key={file.file} className={styles.featureCard}>
                                  <div className={styles.featureCardHeader}>
                                    <span className={styles.featureTitle}>{fileLabel}</span>
                                    <span className={styles.featureScore} style={{ color: fColor }}>
                                      {Math.round(file.score)}%
                                    </span>
                                  </div>
                                  <div className={styles.featureBarContainer}>
                                    <div className={styles.featureBar} style={{ width: `${file.score}%`, background: fColor }} />
                                  </div>
                                  <div className={styles.featureDimensions}>
                                    <div className={styles.dimensionRow}>
                                      <span className={styles.dimensionLabel}>Verdict</span>
                                      <span className={styles.dimensionScore} style={{ color: file.verdict === 'ready' ? 'var(--success-color)' : fColor }}>
                                        {file.verdict === 'ready' ? 'Ready' : file.verdict === 'gaps' ? 'Gaps' : file.verdict}
                                      </span>
                                    </div>
                                  </div>
                                  {(file.gaps ?? []).length > 0 && (
                                    <div className={styles.featureGaps}>
                                      {(file.gaps ?? []).map((gap) => (
                                        <div key={gap.id} className={styles.gapItem} data-resolution={gap.resolution}>
                                          <span className={styles.gapIcon}>
                                            {gap.resolution === 'filled' ? '✓' : gap.resolution === 'pending' ? '○' : '—'}
                                          </span>
                                          <div className={styles.gapContent}>
                                            <span className={styles.gapDesc}>{gap.description}</span>
                                            <span className={styles.gapSection}>{gap.section}</span>
                                          </div>
                                          <span className={styles.gapScore}>{gap.score}/3</span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {/* Feature-based breakdown (design doc validation) */}
                        {features.length > 0 && files.length === 0 && (
                          <div className={styles.featureGrid}>
                            {features.map((feature) => {
                              const fColor = feature.overall_score >= 90 ? 'var(--success-color)' : feature.overall_score >= 70 ? '#e6a817' : 'var(--error-color)';
                              return (
                                <div key={feature.feature_slug} className={styles.featureCard}>
                                  <div className={styles.featureCardHeader}>
                                    <span className={styles.featureTitle}>{feature.feature_title}</span>
                                    <span className={styles.featureScore} style={{ color: fColor }}>
                                      {Math.round(feature.overall_score)}%
                                    </span>
                                  </div>
                                  <div className={styles.featureBarContainer}>
                                    <div className={styles.featureBar} style={{ width: `${feature.overall_score}%`, background: fColor }} />
                                  </div>
                                  <div className={styles.featureDimensions}>
                                    <div className={styles.dimensionRow}>
                                      <span className={styles.dimensionLabel}>Design</span>
                                      <span className={styles.dimensionScore}>{feature.design_score}/3</span>
                                    </div>
                                    <div className={styles.dimensionRow}>
                                      <span className={styles.dimensionLabel}>Tech Spec</span>
                                      <span className={styles.dimensionScore}>{feature.tech_spec_score}/3</span>
                                    </div>
                                    <div className={styles.dimensionRow}>
                                      <span className={styles.dimensionLabel}>Assumptions</span>
                                      <span className={styles.dimensionScore}>{feature.assumptions_score}/3</span>
                                    </div>
                                  </div>
                                  {(feature.gaps ?? []).length > 0 && (
                                    <div className={styles.featureGaps}>
                                      {(feature.gaps ?? []).map((gap) => (
                                        <div key={gap.id} className={styles.gapItem} data-resolution={gap.resolution}>
                                          <span className={styles.gapIcon}>
                                            {gap.resolution === 'filled' ? '✓' : gap.resolution === 'pending' ? '○' : '—'}
                                          </span>
                                          <div className={styles.gapContent}>
                                            <span className={styles.gapDesc}>{gap.description}</span>
                                            <span className={styles.gapSection}>{gap.section}</span>
                                          </div>
                                          <span className={styles.gapScore}>{gap.score}/3</span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {/* Cross-cutting checks */}
                        {sc.cross_cutting_checks && Object.keys(sc.cross_cutting_checks).length > 0 && (
                          <div className={styles.crossCuttingSection}>
                            <h4 className={styles.crossCuttingTitle}>Cross-Cutting Checks</h4>
                            <div className={styles.crossCuttingGrid}>
                              {Object.entries(sc.cross_cutting_checks).map(([key, value]) => (
                                <div key={key} className={styles.crossCuttingItem}>
                                  <span className={styles.crossCuttingKey}>{key.replace(/_/g, ' ')}</span>
                                  <span className={styles.crossCuttingValue} data-status={value.toLowerCase()}>{value}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Full markdown report toggle */}
                        {(passingReasonsMarkdown || validationReport?.markdown || prd.validationReportMd) && (
                          <details className={styles.reportDetails}>
                            <summary className={styles.reportSummary}>View full report</summary>
                            <div className={styles.markdownContent}>
                              {passingReasonsMarkdown && !reportAlreadyIncludesPassingReasons && (
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                  {passingReasonsMarkdown}
                                </ReactMarkdown>
                              )}
                              {validationReport?.markdown ? (
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                  {validationReport.markdown}
                                </ReactMarkdown>
                              ) : (
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                  {prd.validationReportMd ?? ''}
                                </ReactMarkdown>
                              )}
                            </div>
                          </details>
                        )}
                      </div>
                    );
                  })() : prd.status === 'validating' ? (
                    <div className={styles.emptyPreview}>
                      <div className={styles.validatingSpinner} />
                      <p style={{ marginTop: '0.75rem', color: 'var(--text-secondary)' }}>
                        Validation in progress&hellip;
                      </p>
                      <button
                        className={styles.actionBtn}
                        onClick={() => void refreshPrdValidation.mutateAsync(prd.id)}
                        disabled={refreshPrdValidation.isPending}
                        type="button"
                        style={{ marginTop: '0.5rem' }}
                      >
                        Refresh
                      </button>
                    </div>
                  ) : (
                    <div className={styles.emptyPreview}>
                      No validation report available yet.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Full-document edit modal ────────────────────────────────────────── */}
      {showEditModal && (
        <div
          className={styles.editModal}
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowEditModal(false);
          }}
          role="dialog"
          aria-modal="true"
          aria-label="Edit PRD"
        >
          <div className={styles.editModalCard}>
            <h3 className={styles.editModalTitle}>Edit PRD</h3>
            <textarea
              className={styles.textarea}
              value={editModalContent}
              onChange={(e) => setEditModalContent(e.target.value)}
              placeholder="Write your PRD in Markdown…"
            />
            <div className={styles.editActions}>
              <button
                className={styles.btnPrimary}
                onClick={() => void handleSaveEditModal()}
                disabled={updateContent.isPending}
                type="button"
              >
                {updateContent.isPending ? 'Saving…' : 'Save'}
              </button>
              <button
                className={styles.btnSecondary}
                onClick={() => setShowEditModal(false)}
                type="button"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Section edit modal ──────────────────────────────────────────────── */}
      {editingSectionIndex !== null && (
        <div
          className={styles.editModal}
          onClick={(e) => {
            if (e.target === e.currentTarget) setEditingSectionIndex(null);
          }}
          role="dialog"
          aria-modal="true"
          aria-label="Edit section"
        >
          <div className={styles.editModalCard}>
            <h3 className={styles.editModalTitle}>Edit Section</h3>
            <textarea
              className={styles.textarea}
              value={sectionEditContent}
              onChange={(e) => setSectionEditContent(e.target.value)}
              placeholder="Section content in Markdown…"
            />
            <div className={styles.editActions}>
              <button
                className={styles.btnPrimary}
                onClick={() => void handleSaveSectionEdit()}
                disabled={updateContent.isPending}
                type="button"
              >
                {updateContent.isPending ? 'Saving…' : 'Save section'}
              </button>
              <button
                className={styles.btnSecondary}
                onClick={() => setEditingSectionIndex(null)}
                type="button"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
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
        <div
          className={styles.commentModal}
          onClick={(e) => {
            if (e.target === e.currentTarget) setPendingSelector(null);
          }}
          role="dialog"
          aria-modal="true"
        >
          <div className={styles.commentModalCard}>
            <h3 className={styles.commentModalTitle}>Add Comment</h3>
            <blockquote className={styles.commentModalQuote}>
              {pendingSelector.selector.exact}
            </blockquote>
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
          initialPrdApproverIds={assignments
            .filter((a) => a.status === 'pending')
            .map((a) => a.approverUserId)}
          initialDesignDocApproverIds={prd.designDocApproverIds ?? []}
          confirmLabel="Update Reviewers"
          excludeSelf={false}
          allowEmpty
          onConfirm={(selections) => void handleReassignConfirm(selections)}
          onCancel={() => setShowReassignModal(false)}
          isSubmitting={reassignApprovers.isPending}
        />
      )}

      <PrdAssistantPanel
        prdId={prd.id}
        open={assistantOpen}
        onClose={() => setAssistantOpen(false)}
        existingThreadId={prd.prdAssistantThreadId}
      />
    </div>
  );
};

export default PrdReviewView;

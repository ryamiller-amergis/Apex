import React, { useState, useCallback, useMemo, useEffect, useReducer, useRef } from 'react';
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
  useReviewPrd,
  useReviewTestCases,
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
  useOwnerApprove,
  useOwnerApproval,
  useActiveUsers,
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
import { useProjectSkillConfig } from '../hooks/useProjectSkillConfig';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { ApproverSelectModal } from './ApproverSelectModal';
import { AnnotationLayer } from './AnnotationLayer';
import { ReviewerApprovalChecklist } from './ReviewerApprovalChecklist';
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
    case 'reviewer_approved':
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
    case 'reviewer_approved':
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
  const { data: relatedDesignDocs } = useDesignDocsByPrd(id);
  const { data: relatedPrototypes = [] } = usePrototypesForPrd(
    prd?.status === 'approved' ? id : null
  );
  const generatePrototypes = useGeneratePrototypesForPrd();
  const createDesignDoc = useCreateDesignDoc();
  const { data: testCaseRecord } = usePrdTestCases(id);
  const prevTestCaseStatusRef = useRef<string | undefined>(undefined);
  const actionMenuRef = useRef<HTMLDivElement>(null);
  const { data: designPlanResponse } = useDesignPlan(prd?.status === 'approved' ? (id ?? null) : null);
  const { data: sourceInterview } = useInterview(prd?.interviewId ?? null);
  const { data: ownerApproval } = useOwnerApproval(id, 'prd');
  const { data: projectConfig } = useProjectSkillConfig(prd?.project);
  const latestTestCase = testCaseRecord ?? prd?.latestTestCase ?? null;
  const readiness = prd ? derivePrdReadiness(prd, latestTestCase, prd.validationScoreThreshold ?? undefined) : null;

  const updateContent = useUpdatePrdContent();
  const updateBacklog = useUpdatePrdBacklog();
  const submitPrd = useSubmitPrd();
  const withdrawPrd = useWithdrawPrd();
  const reviewPrd = useReviewPrd();
  const reviewTestCases = useReviewTestCases();
  const ownerApprovePrd = useOwnerApprove(id ?? null, 'prd');
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
  const [showApprovalsModal, setShowApprovalsModal] = useState(false);
  const [showReassignModal, setShowReassignModal] = useState(false);
  const [showAllDocs, setShowAllDocs] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);

  const { data: assignments = [] } = useDocumentAssignments(id, 'prd');
  const { data: qaAssignments = [] } = useDocumentAssignments(id, 'test_case');
  const { data: designPrototypeAssignments = [] } = useDocumentAssignments(id, 'design_prototype');

  const reviewerApprovalComplete = useMemo(() => {
    if (assignments.length > 0) {
      const mode = projectConfig?.approvalMode ?? 'any_one';
      return mode === 'all_required'
        ? assignments.every((a) => a.status === 'approved')
        : assignments.some((a) => a.status === 'approved');
    }
    const kickoffReviewerIds = sourceInterview?.prdApproverIds;
    if (kickoffReviewerIds && kickoffReviewerIds.length > 0) return false;
    return true;
  }, [assignments, projectConfig?.approvalMode, sourceInterview?.prdApproverIds]);
  const { data: activeUsers = [] } = useActiveUsers();
  const { data: routeOptions = [] } = useScreenInventoryRoutes(!!prd && prd.status !== 'approved');

  /** Assigned reviewers from submit-for-review, or kick-off selections on the source interview. */
  const reviewerDisplayNames = useMemo(() => {
    if (assignments.length > 0) {
      return assignments.map((a) => a.approverDisplayName ?? a.approverUserId);
    }
    const kickoffReviewerIds = sourceInterview?.prdApproverIds;
    if (!kickoffReviewerIds?.length) return [];
    const nameById = new Map(
      activeUsers.map((u) => [u.oid, u.displayName ?? u.oid]),
    );
    return kickoffReviewerIds.map((oid) => nameById.get(oid) ?? oid);
  }, [assignments, sourceInterview?.prdApproverIds, activeUsers]);

  const prdReviewerRows = useMemo(() => {
    if (assignments.length > 0) {
      return assignments.map((a) => ({
        name: a.approverDisplayName ?? a.approverUserId,
        status: a.status,
        respondedAt: a.respondedAt ?? null,
      }));
    }
    const kickoffReviewerIds = sourceInterview?.prdApproverIds;
    if (!kickoffReviewerIds?.length) return [];
    const nameById = new Map(
      activeUsers.map((u) => [u.oid, u.displayName ?? u.oid]),
    );
    return kickoffReviewerIds.map((oid) => ({
      name: nameById.get(oid) ?? oid,
      status: 'pending' as const,
      respondedAt: null,
    }));
  }, [assignments, sourceInterview?.prdApproverIds, activeUsers]);

  const designDocReviewerRows = useMemo(() => {
    if (relatedDesignDocs && relatedDesignDocs.length > 0) {
      return relatedDesignDocs.map((doc) => {
        let status: 'pending' | 'approved' | 'revision_requested' = 'pending';
        let respondedAt: string | null = null;
        if (doc.status === 'approved') {
          status = 'approved';
          respondedAt = doc.reviewedAt ?? null;
        } else if (doc.status === 'reviewer_approved') {
          status = 'approved';
          respondedAt = doc.reviewedAt ?? null;
        } else if (doc.status === 'revision_requested') {
          status = 'revision_requested';
          respondedAt = doc.reviewedAt ?? null;
        }
        const ownerName = doc.ownerName ?? doc.authorName ?? doc.ownerId ?? doc.authorId;
        return {
          name: `${ownerName} — ${doc.title}`,
          status,
          respondedAt,
        };
      });
    }
    const ids = prd?.designDocApproverIds ?? sourceInterview?.designDocApproverIds;
    if (!ids?.length) return [];
    const nameById = new Map(
      activeUsers.map((u) => [u.oid, u.displayName ?? u.oid]),
    );
    return ids.map((oid) => ({
      name: nameById.get(oid) ?? oid,
      status: 'pending' as const,
      respondedAt: null,
    }));
  }, [relatedDesignDocs, prd?.designDocApproverIds, sourceInterview?.designDocApproverIds, activeUsers]);

  const designPrototypeReviewerRows = useMemo(() => {
    if (designPrototypeAssignments.length > 0) {
      return designPrototypeAssignments.map((a) => ({
        name: a.approverDisplayName ?? a.approverUserId,
        status: a.status,
        respondedAt: a.respondedAt ?? null,
      }));
    }
    const ids = sourceInterview?.designPrototypeApproverIds;
    if (!ids?.length) return [];
    const nameById = new Map(
      activeUsers.map((u) => [u.oid, u.displayName ?? u.oid]),
    );
    return ids.map((oid) => ({
      name: nameById.get(oid) ?? oid,
      status: 'pending' as const,
      respondedAt: null,
    }));
  }, [designPrototypeAssignments, sourceInterview?.designPrototypeApproverIds, activeUsers]);

  const qaReviewerRows = useMemo(() => {
    if (qaAssignments.length > 0) {
      return qaAssignments.map((a) => ({
        name: a.approverDisplayName ?? a.approverUserId,
        status: a.status,
        respondedAt: a.respondedAt ?? null,
      }));
    }
    const ids = sourceInterview?.testCaseApproverIds;
    if (!ids?.length) return [];
    const nameById = new Map(
      activeUsers.map((u) => [u.oid, u.displayName ?? u.oid]),
    );
    return ids.map((oid) => ({
      name: nameById.get(oid) ?? oid,
      status: 'pending' as const,
      respondedAt: null,
    }));
  }, [qaAssignments, sourceInterview?.testCaseApproverIds, activeUsers]);

  const approvalChecklistGroups = useMemo(() => {
    type GroupEntry = { label: string; informational?: boolean; subtitle?: string; rows: { name: string; status: 'pending' | 'approved' | 'revision_requested'; respondedAt?: string | null }[] };
    const groups: GroupEntry[] = [];
    const approvalMode = projectConfig?.approvalMode ?? 'any_one';

    const buildSubtitle = (count: number) => {
      if (count <= 1) return undefined;
      return approvalMode === 'all_required' ? 'All required' : `1 of ${count} required`;
    };

    if (prdReviewerRows.length > 0) {
      groups.push({ label: 'PRD Review', subtitle: buildSubtitle(prdReviewerRows.length), rows: prdReviewerRows });
    }
    if (designDocReviewerRows.length > 0) {
      const hasRealDocs = relatedDesignDocs && relatedDesignDocs.length > 0;
      groups.push({ label: 'Design Doc Review', informational: !hasRealDocs, subtitle: buildSubtitle(designDocReviewerRows.length), rows: designDocReviewerRows });
    }
    if (designPrototypeReviewerRows.length > 0) {
      groups.push({ label: 'Design Prototype Review', informational: designPrototypeAssignments.length === 0, subtitle: buildSubtitle(designPrototypeReviewerRows.length), rows: designPrototypeReviewerRows });
    }
    if (qaReviewerRows.length > 0) {
      groups.push({ label: 'QA Review', subtitle: buildSubtitle(qaReviewerRows.length), rows: qaReviewerRows });
    }

    const showOwnerApproval = prd && ['pending_review', 'reviewer_approved', 'approved', 'revision_requested'].includes(prd.status);
    if (showOwnerApproval) {
      const ownerName = prd.ownerName ?? prd.ownerId ?? prd.authorName ?? prd.authorId;
      const ownerStatus = ownerApproval?.status ?? (prd.status === 'approved' ? 'approved' : 'pending');
      groups.push({
        label: 'Owner Approval',
        rows: [{ name: ownerName, status: ownerStatus, respondedAt: ownerApproval?.respondedAt ?? null }],
      });
    }

    return groups;
  }, [prdReviewerRows, designDocReviewerRows, designPrototypeReviewerRows, designPrototypeAssignments, qaReviewerRows, prd, ownerApproval, projectConfig?.approvalMode, relatedDesignDocs]);

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

  const handleSubmit = useCallback(async () => {
    if (!id || !readiness?.readyForReviewActions) return;
    await submitPrd.mutateAsync({
      prdId: id,
      prdApproverIds: sourceInterview?.prdApproverIds ?? [],
      designDocApproverIds: sourceInterview?.designDocApproverIds ?? [],
      designPrototypeApproverIds: sourceInterview?.designPrototypeApproverIds ?? [],
      qaApproverIds: sourceInterview?.testCaseApproverIds ?? [],
    });
  }, [
    id,
    readiness?.readyForReviewActions,
    sourceInterview?.prdApproverIds,
    sourceInterview?.designDocApproverIds,
    sourceInterview?.designPrototypeApproverIds,
    sourceInterview?.testCaseApproverIds,
    submitPrd,
  ]);

  const handleReassignConfirm = useCallback(
    async (selections: {
      prdApproverIds?: string[];
      designDocApproverIds?: string[];
      designPrototypeApproverIds?: string[];
      qaApproverIds?: string[];
    }) => {
      if (!id) return;
      await reassignApprovers.mutateAsync({
        documentId: id,
        documentType: 'prd',
        approverUserIds: selections.prdApproverIds ?? [],
        designDocApproverIds: selections.designDocApproverIds,
        designPrototypeApproverIds: selections.designPrototypeApproverIds,
        qaApproverIds: selections.qaApproverIds,
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

  const handleQaApprove = useCallback(async () => {
    if (!id) return;
    await reviewTestCases.mutateAsync({ prdId: id, status: 'approved' });
  }, [id, reviewTestCases]);

  const handleOwnerApprove = useCallback(async () => {
    if (!id) return;
    await ownerApprovePrd.mutateAsync({ status: 'approved' });
    navigate(`/backlog/design-plan/${id}`);
  }, [id, ownerApprovePrd, navigate]);

  const handleOwnerRevision = useCallback(async () => {
    if (!id) return;
    await ownerApprovePrd.mutateAsync({ status: 'revision_requested', comment: 'Revision requested by owner' });
  }, [id, ownerApprovePrd]);

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

  // When test case generation finishes, immediately refetch the PRD to pick up
  // any server-side status transition (e.g. draft → validating when auto-validation kicks off).
  useEffect(() => {
    const prev = prevTestCaseStatusRef.current;
    const curr = testCaseRecord?.status;
    prevTestCaseStatusRef.current = curr;
    if (prev === 'generating' && curr !== 'generating' && id) {
      void queryClient.invalidateQueries({ queryKey: ['prd', id] });
    }
  }, [testCaseRecord?.status, id, queryClient]);

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

  useEffect(() => {
    if (!actionMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (actionMenuRef.current?.contains(event.target as Node)) return;
      setActionMenuOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActionMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [actionMenuOpen]);

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
  const isAssignedApprover = assignments.length > 0
    ? assignments.some((a) => a.approverUserId === userId)
    : (sourceInterview?.prdApproverIds ?? []).includes(userId ?? '');
  const hasAlreadyApprovedPrd = assignments.some(
    (a) => a.approverUserId === userId && a.status === 'approved'
  );
  const isAssignedQaApprover = qaAssignments.length > 0
    ? qaAssignments.some((a) => a.approverUserId === userId)
    : (sourceInterview?.testCaseApproverIds ?? []).includes(userId ?? '');
  const hasAlreadyApprovedQa = qaAssignments.some(
    (a) => a.approverUserId === userId && a.status === 'approved'
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
    (canPerformReview || isAssignedQaApprover || isAuthor || isOwner || isAdmin);

  const canEditContent =
    canManage && (isAuthor || isOwner || isAdmin) && prd.status !== 'approved';

  const canShowApprovalsAction = approvalChecklistGroups.length > 0;
  const canShowAssistantAction = prd.status !== 'approved';
  const canGenerateTestCasesAction =
    canManage &&
    prd.status !== 'approved' &&
    !!prd.content &&
    (readiness.state === 'test_cases_pending' ||
      readiness.state === 'test_case_generation_failed');
  const canRunValidationAction =
    canManage &&
    prd.prdValidationEnabled &&
    prd.status !== 'approved' &&
    prd.status !== 'validating' &&
    !!prd.content &&
    !!prd.backlogJson &&
    prd.latestTestCase?.status === 'ready';
  const canCancelValidationAction = canManage && prd.status === 'validating';
  const canManageDraftReviewAction =
    canManage && (isAuthor || isOwner || isAdmin);
  const canSubmitForReviewAction =
    canManageDraftReviewAction &&
    (prd.status === 'draft' || prd.status === 'revision_requested');
  const canWithdrawAction =
    canManageDraftReviewAction && prd.status === 'pending_review';
  const canDeletePrdAction = canManageDraftReviewAction;
  const canReassignReviewersAction =
    prd.status === 'pending_review' && canManageDraftReviewAction;
  const canShowHeaderActionMenu =
    canShowApprovalsAction ||
    canRunValidationAction ||
    canEditContent ||
    canWithdrawAction ||
    canDeletePrdAction ||
    canReassignReviewersAction;

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
              {prd.model && (
                <span className={styles.metaItem}>
                  <span className={styles.metaLabel}>Model:</span>
                  <span className={styles.metaValue}>{prd.model}</span>
                </span>
              )}
            </div>
            {sourceInterview && (
              <div className={styles.parentLinks}>
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
              </div>
            )}
          </div>
        </div>

        <div className={styles.headerRight}>
          {prd.status === 'approved' && !canManage && (
            <span className={styles.reviewOnlyBadge}>Read-only</span>
          )}

          {canGenerateTestCasesAction && (
            <button
              className={styles.actionBtn}
              onClick={() => void generateTestCases.mutateAsync(prd.id)}
              disabled={generateTestCases.isPending}
              type="button"
            >
              {readiness.state === 'test_case_generation_failed' ? 'Regenerate Test Cases' : 'Generate Test Cases'}
            </button>
          )}

          {canShowAssistantAction && (
            <button
              className={`${styles.actionBtn} ${assistantOpen ? styles.actionBtnActive : ''}`}
              onClick={() => setAssistantOpen((open) => !open)}
              type="button"
              title="Apex Assistant"
              aria-label="Apex Assistant"
              aria-expanded={assistantOpen}
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
                <path d="M14 10.667A2.667 2.667 0 0 1 11.333 13.333H4.667L2 16V4.667A2.667 2.667 0 0 1 4.667 2h6.666A2.667 2.667 0 0 1 14 4.667z" />
              </svg>
              Apex Assistant
            </button>
          )}

          {canCancelValidationAction && (
            <button
              className={styles.actionBtn}
              onClick={() => void cancelPrdValidation.mutateAsync(prd.id)}
              disabled={cancelPrdValidation.isPending}
              type="button"
            >
              Cancel Validation
            </button>
          )}

          {canSubmitForReviewAction && (
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

          {canPerformReview &&
            !hasAlreadyApprovedPrd &&
            prd.status === 'pending_review' && (
              <>
                <span className={styles.actionDivider} />
                <div className={styles.reviewControls}>
                  <button
                    className={styles.btnApprove}
                    onClick={() => void handleApprove()}
                    disabled={
                      reviewPrd.isPending ||
                      !readiness.readyForReviewActions ||
                      unresolvedCount > 0
                    }
                    title={
                      !readiness.readyForReviewActions
                        ? readiness.blockingReason
                        : unresolvedCount > 0
                          ? 'Resolve all comments before approving'
                          : undefined
                    }
                    type="button"
                  >
                    Approve PRD
                  </button>
                </div>
              </>
            )}

          {canReview &&
            isAssignedQaApprover &&
            !hasAlreadyApprovedQa &&
            prd.status === 'pending_review' && (
              <>
                <span className={styles.actionDivider} />
                <div className={styles.reviewControls}>
                  <button
                    className={styles.btnApprove}
                    onClick={() => void handleQaApprove()}
                    disabled={reviewTestCases.isPending}
                    type="button"
                  >
                    Approve QA
                  </button>
                </div>
              </>
            )}

          {prd.status === 'pending_review' && (isOwner || isAdmin) && (
            <>
              <span className={styles.actionDivider} />
              <div className={styles.reviewControls}>
                <button
                  className={styles.btnApprove}
                  onClick={() => void handleOwnerApprove()}
                  disabled={ownerApprovePrd.isPending || (!reviewerApprovalComplete && !isAdmin)}
                  title={!reviewerApprovalComplete && !isAdmin
                    ? 'Reviewers must approve the PRD before owner approval'
                    : undefined}
                  type="button"
                >
                  Approve as Owner
                </button>
                <button
                  className={styles.btnRevision}
                  onClick={() => void handleOwnerRevision()}
                  disabled={ownerApprovePrd.isPending}
                  type="button"
                >
                  Request Revision
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

          {canShowHeaderActionMenu && (
            <div className={styles.actionMenu} ref={actionMenuRef}>
              <button
                className={`${styles.actionBtn} ${actionMenuOpen ? styles.actionBtnActive : ''}`}
                onClick={() => setActionMenuOpen((open) => !open)}
                type="button"
                aria-haspopup="menu"
                aria-expanded={actionMenuOpen}
                aria-label="More actions"
              >
                More
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M4 6l4 4 4-4" />
                </svg>
              </button>

              {actionMenuOpen && (
                <div
                  className={styles.actionMenuPanel}
                  role="menu"
                  aria-label="More PRD actions"
                >
                  {canShowApprovalsAction && (
                    <button
                      className={styles.actionMenuItem}
                      onClick={() => {
                        setActionMenuOpen(false);
                        setShowApprovalsModal(true);
                      }}
                      type="button"
                      role="menuitem"
                    >
                      <span className={styles.actionMenuIcon}>
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <rect x="2" y="2" width="12" height="12" rx="2" />
                          <path d="M5 8l2 2 4-4" />
                        </svg>
                      </span>
                      <span className={styles.actionMenuLabel}>Approvals</span>
                    </button>
                  )}

                  {canRunValidationAction && (
                    <button
                      className={styles.actionMenuItem}
                      onClick={() => {
                        setActionMenuOpen(false);
                        void createPrdValidationThread.mutateAsync(prd.id);
                      }}
                      disabled={createPrdValidationThread.isPending}
                      type="button"
                      role="menuitem"
                    >
                      <span className={styles.actionMenuIcon}>
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <circle cx="8" cy="8" r="6" />
                          <path d="M5 8l2 2 4-4" />
                        </svg>
                      </span>
                      <span className={styles.actionMenuLabel}>Run Validation</span>
                    </button>
                  )}

                  {canEditContent && (
                    <button
                      className={styles.actionMenuItem}
                      onClick={() => {
                        setActionMenuOpen(false);
                        handleOpenEditModal();
                      }}
                      type="button"
                      role="menuitem"
                    >
                      <span className={styles.actionMenuIcon}>{pencilIcon}</span>
                      <span className={styles.actionMenuLabel}>Edit</span>
                    </button>
                  )}

                  {canWithdrawAction && (
                    <button
                      className={styles.actionMenuItem}
                      onClick={() => {
                        setActionMenuOpen(false);
                        void handleWithdraw();
                      }}
                      disabled={withdrawPrd.isPending}
                      type="button"
                      role="menuitem"
                    >
                      <span className={styles.actionMenuIcon}>
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <path d="M4 8h8" />
                          <path d="M7 5L4 8l3 3" />
                        </svg>
                      </span>
                      <span className={styles.actionMenuLabel}>Withdraw</span>
                    </button>
                  )}

                  {canReassignReviewersAction && (
                    <button
                      className={styles.actionMenuItem}
                      onClick={() => {
                        setActionMenuOpen(false);
                        setShowReassignModal(true);
                      }}
                      type="button"
                      role="menuitem"
                      title={
                        reviewerDisplayNames.length > 0
                          ? `Reviewers: ${reviewerDisplayNames.join(', ')}`
                          : 'Assign reviewers'
                      }
                    >
                      <span className={styles.actionMenuIcon}>
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <circle cx="6" cy="5" r="2.5" />
                          <path d="M1 13c0-2.5 2.24-4.5 5-4.5s5 2 5 4.5" />
                          <path d="M12 5.5l2 2 2-2" />
                        </svg>
                      </span>
                      <span className={styles.actionMenuLabel}>
                        {reviewerDisplayNames.length > 0
                          ? `${reviewerDisplayNames.length} Reviewer${reviewerDisplayNames.length > 1 ? 's' : ''}`
                          : 'Reviewers'}
                      </span>
                    </button>
                  )}

                  {canDeletePrdAction && (
                    <button
                      className={`${styles.actionMenuItem} ${styles.actionMenuItemDanger}`}
                      onClick={() => {
                        setActionMenuOpen(false);
                        setShowDeleteModal(true);
                      }}
                      disabled={deletePrd.isPending}
                      type="button"
                      role="menuitem"
                    >
                      <span className={styles.actionMenuIcon}>
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <polyline points="2 4 4 4 14 4" />
                          <path d="M13 4l-.7 9.3A1 1 0 0 1 12.3 14H3.7a1 1 0 0 1-1-.7L2 4" />
                          <path d="M6.5 7v4M9.5 7v4" />
                          <path d="M5.5 4V2.7A.7.7 0 0 1 6.2 2h3.6a.7.7 0 0 1 .7.7V4" />
                        </svg>
                      </span>
                      <span className={styles.actionMenuLabel}>Delete PRD</span>
                    </button>
                  )}
                </div>
              )}
            </div>
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

      <div className={styles.bannerRow}>
        {projectConfig?.prototypeStageEnabled !== false && prd.status === 'approved' && designPlanResponse?.plan && (
          <div className={styles.designDocBanner}>
            <span className={styles.designDocBannerText}>
              {designPlanResponse.plan.status === 'generating'
                ? 'A design plan is being generated for this PRD.'
                : designPlanResponse.plan.status === 'consumed'
                  ? 'The design plan has been used to generate prototypes.'
                  : 'A design plan is ready. Review and edit it, then generate the designs.'}
            </span>
            <button
              className={styles.designDocBannerLink}
              onClick={() => navigate(`/backlog/design-plan/${id}`)}
              type="button"
            >
              View Design Plan →
            </button>
          </div>
        )}

        {projectConfig?.prototypeStageEnabled !== false && prd.status === 'approved' && relatedPrototypes.length > 0 && (
          <div className={styles.designDocBanner}>
            <span className={styles.designDocBannerText}>
              {relatedPrototypes.length === 1
                ? '1 design prototype was generated for this PRD.'
                : `${relatedPrototypes.length} design prototypes were generated for this PRD.`}{' '}
              {relatedPrototypes.filter((p) => p.status === 'approved').length} of{' '}
              {relatedPrototypes.length} approved.
            </span>
            <button
              className={styles.designDocBannerLink}
              onClick={() => navigate(`/backlog/design-prototypes/${id}`)}
              type="button"
            >
              View Design Prototypes →
            </button>
          </div>
        )}

        {projectConfig?.prototypeStageEnabled !== false && prd.status === 'approved' && relatedPrototypes.length === 0 && canManage && (
          <div className={styles.designDocBanner}>
            <span className={styles.designDocBannerText}>
              No design prototypes exist for this PRD. Generate them to continue the design flow.
            </span>
            <button
              className={styles.designDocBannerLink}
              onClick={() => {
                if (!id) return;
                generatePrototypes.mutate(id, {
                  onSuccess: () => navigate(`/backlog/design-prototypes/${id}`),
                });
              }}
              disabled={generatePrototypes.isPending}
              type="button"
            >
              {generatePrototypes.isPending ? 'Generating…' : 'Generate prototypes'}
            </button>
          </div>
        )}

      </div>

      {prd.status === 'approved' &&
        relatedDesignDocs &&
        relatedDesignDocs.length > 0 && (() => {
          const MAX_DOCS = 3;
          const visibleDocs = showAllDocs
            ? relatedDesignDocs
            : relatedDesignDocs.slice(0, MAX_DOCS);
          const hiddenCount = relatedDesignDocs.length - visibleDocs.length;
          return (
            <div className={styles.designDocRow}>
              <div className={styles.designDocBanner}>
                <span className={styles.designDocBannerText}>
                  {relatedDesignDocs.length === 1
                    ? 'A design doc was created from this PRD.'
                    : `${relatedDesignDocs.length} feature design docs were created from this PRD.`}
                </span>
                <div className={styles.designDocLinks}>
                  {visibleDocs.map((doc) => (
                    <button
                      key={doc.id}
                      className={styles.designDocBannerLink}
                      onClick={() => navigate(`/backlog/design-doc/${doc.id}`)}
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
                        style={{ width: 11, height: 11, flexShrink: 0 }}
                      >
                        <rect x="2" y="1" width="10" height="12" rx="1.5" />
                        <path d="M4.5 4.5h5M4.5 7h5M4.5 9.5h3" />
                      </svg>
                      {doc.title}
                    </button>
                  ))}
                  {hiddenCount > 0 && (
                    <button
                      className={styles.showMoreChip}
                      onClick={() => setShowAllDocs(true)}
                      type="button"
                    >
                      +{hiddenCount} more
                    </button>
                  )}
                  {showAllDocs && relatedDesignDocs.length > MAX_DOCS && (
                    <button
                      className={styles.showMoreChip}
                      onClick={() => setShowAllDocs(false)}
                      type="button"
                    >
                      Show less
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })()}

      {prd.status === 'approved' && (!relatedDesignDocs || relatedDesignDocs.length === 0) && canManage && (
        <div className={styles.designDocRow}>
          <div className={styles.designDocBanner}>
            <span className={styles.designDocBannerText}>
              Generate design docs (one per feature) directly from the PRD and existing codebase, without requiring design prototypes.
            </span>
            <button
              className={styles.designDocBannerLink}
              onClick={() => {
                if (!id) return;
                createDesignDoc.mutate({ prdId: id });
              }}
              disabled={createDesignDoc.isPending}
              type="button"
            >
              {createDesignDoc.isPending ? 'Generating…' : 'Generate Design Docs'}
            </button>
          </div>
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
        <div className={[styles.tabArea, isFullscreen && styles.tabAreaFullscreen].filter(Boolean).join(' ')}>
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
            <button
              className={[styles.tabFullscreenBtn, isFullscreen && styles.tabFullscreenBtnActive].filter(Boolean).join(' ')}
              onClick={() => setIsFullscreen((v) => !v)}
              type="button"
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            >
              {isFullscreen ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
                </svg>
              )}
            </button>
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
        </div>
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
          onSubmit={async (req) =>
            createAdoItems.mutateAsync({ prdId: prd.id, ...req })
          }
          onCancel={() => setShowAdoModal(false)}
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
          initialDesignPrototypeApproverIds={sourceInterview?.designPrototypeApproverIds ?? []}
          initialQaApproverIds={sourceInterview?.testCaseApproverIds ?? []}
          confirmLabel="Update Reviewers"
          excludeSelf={false}
          allowEmpty
          onConfirm={(selections) => void handleReassignConfirm(selections)}
          onCancel={() => setShowReassignModal(false)}
          isSubmitting={reassignApprovers.isPending}
        />
      )}

      {showApprovalsModal && (
        <div
          className={styles.editModal}
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowApprovalsModal(false);
          }}
          role="dialog"
          aria-modal="true"
          aria-label="Approvals"
        >
          <div className={styles.editModalCard}>
            <h3 className={styles.editModalTitle}>Approvals</h3>
            <ReviewerApprovalChecklist groups={approvalChecklistGroups} />
            <div className={styles.editActions}>
              <button
                className={styles.btnSecondary}
                onClick={() => setShowApprovalsModal(false)}
                type="button"
              >
                Close
              </button>
            </div>
          </div>
        </div>
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

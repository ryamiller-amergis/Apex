import React, { useState, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAppShell } from '../hooks/useAppShell';
import {
  useInterviewList,
  usePrdList,
  useDesignDocList,
  useDeleteInterview,
  useDeletePrd,
  useDeleteDesignDoc,
} from '../hooks/useInterviews';
import { useDesignPrototypeList, useDeletePrototype } from '../hooks/useDesignPrototypes';
import type {
  InterviewStatus,
  PrdStatus,
  DesignDocStatus,
  InterviewSummary,
  PrdSummary,
  DesignDocSummary,
} from '../../shared/types/interview';
import type { DesignPrototypeSummary, DesignPrototypeStatus } from '../../shared/types/designPrototype';
import {
  derivePrdReadiness,
  type PrdReadinessSeverity,
} from '../../shared/utils/prdReadiness';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import styles from './InterviewsDashboard.module.css';

type TabId = 'interviews' | 'prds' | 'design-prototypes' | 'design-docs';

const INTERVIEW_FILTERS: { label: string; value: InterviewStatus | undefined }[] = [
  { label: 'All', value: undefined },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Complete', value: 'complete' },
  { label: 'Archived', value: 'archived' },
];

const PRD_FILTERS: { label: string; value: PrdStatus | undefined }[] = [
  { label: 'All', value: undefined },
  { label: 'Draft', value: 'draft' },
  { label: 'Pending Review', value: 'pending_review' },
  { label: 'Approved', value: 'approved' },
  { label: 'Revision Requested', value: 'revision_requested' },
];

const DESIGN_DOC_FILTERS: { label: string; value: DesignDocStatus | undefined }[] = [
  { label: 'All', value: undefined },
  { label: 'Generating', value: 'generating' },
  { label: 'Draft', value: 'draft' },
  { label: 'Pending Review', value: 'pending_review' },
  { label: 'Approved', value: 'approved' },
  { label: 'Revision Requested', value: 'revision_requested' },
];

function interviewBadgeClass(status: InterviewStatus): string {
  switch (status) {
    case 'in_progress': return styles.badgeInProgress;
    case 'complete': return styles.badgeComplete;
    case 'archived': return styles.badgeArchived;
  }
}

function interviewStatusLabel(status: InterviewStatus): string {
  switch (status) {
    case 'in_progress': return 'In Progress';
    case 'complete': return 'Complete';
    case 'archived': return 'Archived';
  }
}

function prdStatusLabel(status: PrdStatus): string {
  switch (status) {
    case 'generating': return 'Generating…';
    case 'validating': return 'Validating';
    case 'draft': return 'Draft';
    case 'pending_review': return 'Pending Review';
    case 'reviewer_approved': return 'Awaiting Owner Approval';
    case 'approved': return 'Approved';
    case 'revision_requested': return 'Revision Requested';
  }
}

function prdReadinessBadgeClass(severity: PrdReadinessSeverity): string {
  switch (severity) {
    case 'info': return styles.badgeGenerating;
    case 'warning': return styles.badgePendingReview;
    case 'error': return styles.badgeRevisionRequested;
    case 'success': return styles.badgeApproved;
    case 'neutral': return styles.badgeDraft;
  }
}

function designDocBadgeClass(status: DesignDocStatus): string {
  switch (status) {
    case 'generating': return styles.badgeGenerating;
    case 'validating': return styles.badgeValidating;
    case 'draft': return styles.badgeDraft;
    case 'pending_review': return styles.badgePendingReview;
    case 'reviewer_approved': return styles.badgePendingReview;
    case 'approved': return styles.badgeApproved;
    case 'revision_requested': return styles.badgeRevisionRequested;
  }
}

function designDocStatusLabel(status: DesignDocStatus): string {
  switch (status) {
    case 'generating': return 'Generating…';
    case 'validating': return 'Validating';
    case 'draft': return 'Draft';
    case 'pending_review': return 'Pending Review';
    case 'reviewer_approved': return 'Awaiting Owner Approval';
    case 'approved': return 'Approved';
    case 'revision_requested': return 'Revision Requested';
  }
}

const PROTOTYPE_FILTERS: { label: string; value: DesignPrototypeStatus | undefined }[] = [
  { label: 'All', value: undefined },
  { label: 'Generating', value: 'generating' },
  { label: 'Pending Review', value: 'pending_review' },
  { label: 'Approved', value: 'approved' },
  { label: 'Revision Requested', value: 'revision_requested' },
  { label: 'Failed', value: 'generation_failed' },
];

function prototypeBadgeClass(status: DesignPrototypeStatus): string {
  switch (status) {
    case 'generating': return styles.badgeGenerating;
    case 'generation_failed': return styles.badgeRevisionRequested;
    case 'pending_review': return styles.badgePendingReview;
    case 'revision_requested': return styles.badgeRevisionRequested;
    case 'regenerating': return styles.badgeGenerating;
    case 'reviewer_approved': return styles.badgePendingReview;
    case 'approved': return styles.badgeApproved;
  }
}

function prototypeStatusLabel(status: DesignPrototypeStatus): string {
  switch (status) {
    case 'generating': return 'Generating…';
    case 'generation_failed': return 'Failed';
    case 'pending_review': return 'Pending Review';
    case 'revision_requested': return 'Revision Requested';
    case 'regenerating': return 'Regenerating…';
    case 'reviewer_approved': return 'Awaiting Owner Approval';
    case 'approved': return 'Approved';
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}


interface InterviewCardProps {
  interview: InterviewSummary;
  canDelete: boolean;
  onDelete: (interview: InterviewSummary) => void;
}

const InterviewCard: React.FC<InterviewCardProps> = ({ interview, canDelete, onDelete }) => {
  const navigate = useNavigate();
  return (
    <div className={styles.card} onClick={() => navigate(`/backlog/interview/${interview.id}`)}>
      <div className={styles.cardHeader}>
        <h3 className={styles.cardTitle}>{interview.title}</h3>
        {canDelete && (
          <button
            className={styles.cardDeleteBtn}
            title="Delete interview"
            type="button"
            onClick={(e) => { e.stopPropagation(); onDelete(interview); }}
            aria-label={`Delete interview "${interview.title}"`}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="2 4 4 4 14 4" />
              <path d="M13 4l-.7 9.3A1 1 0 0 1 12.3 14H3.7a1 1 0 0 1-1-.7L2 4" />
              <path d="M6.5 7v4M9.5 7v4" />
              <path d="M5.5 4V2.7A.7.7 0 0 1 6.2 2h3.6a.7.7 0 0 1 .7.7V4" />
            </svg>
          </button>
        )}
      </div>
      <div className={styles.cardFooter}>
        <span className={`${styles.badge} ${interviewBadgeClass(interview.status)}`}>
          {interviewStatusLabel(interview.status)}
        </span>
        <div className={styles.cardFooterRight}>
          {interview.prdCount > 0 && (
            <span className={styles.cardPrdBadge}>{interview.prdCount} PRD{interview.prdCount !== 1 ? 's' : ''}</span>
          )}
          <span className={styles.cardDate}>{formatDate(interview.createdAt)}</span>
        </div>
      </div>
    </div>
  );
};

interface PrdCardProps {
  prd: PrdSummary;
  canDelete: boolean;
  onDelete: (prd: PrdSummary) => void;
}

const PrdCard: React.FC<PrdCardProps> = ({ prd, canDelete, onDelete }) => {
  const navigate = useNavigate();
  const readiness = derivePrdReadiness(prd, prd.latestTestCase, prd.validationScoreThreshold ?? undefined);
  const coverage = prd.latestTestCase?.coverageSummary;
  return (
    <div className={styles.card} onClick={() => navigate(`/backlog/prd/${prd.id}`)}>
      <div className={styles.cardHeader}>
        <h3 className={styles.cardTitle}>{prd.title}</h3>
        {canDelete && (
          <button
            className={styles.cardDeleteBtn}
            title="Delete PRD"
            type="button"
            onClick={(e) => { e.stopPropagation(); onDelete(prd); }}
            aria-label={`Delete PRD "${prd.title}"`}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="2 4 4 4 14 4" />
              <path d="M13 4l-.7 9.3A1 1 0 0 1 12.3 14H3.7a1 1 0 0 1-1-.7L2 4" />
              <path d="M6.5 7v4M9.5 7v4" />
              <path d="M5.5 4V2.7A.7.7 0 0 1 6.2 2h3.6a.7.7 0 0 1 .7.7V4" />
            </svg>
          </button>
        )}
      </div>
      <div className={styles.cardFooter}>
        <span
          className={`${styles.badge} ${prdReadinessBadgeClass(readiness.severity)}`}
          title={readiness.description}
        >
          {readiness.label}
        </span>
        <div className={styles.cardFooterRight}>
          {coverage && (
            <span
              className={styles.cardPrdBadge}
              title={`AC ${coverage.acCovered}, BR ${coverage.brCovered}`}
            >
              {coverage.totalCases} QA
            </span>
          )}
          {prd.reviewerId && (
            <span className={styles.cardPrdBadge}>Reviewer assigned</span>
          )}
          <span className={styles.cardPrdBadge} title="Human review lifecycle">
            PRD: {prdStatusLabel(prd.status)}
          </span>
          <span className={styles.cardDate}>{formatDate(prd.createdAt)}</span>
        </div>
      </div>
    </div>
  );
};

interface DesignDocCardProps {
  doc: DesignDocSummary;
  canDelete: boolean;
  onDelete: (doc: DesignDocSummary) => void;
}

const DesignDocCard: React.FC<DesignDocCardProps> = ({ doc, canDelete, onDelete }) => {
  const navigate = useNavigate();
  return (
    <div className={styles.card} onClick={() => navigate(`/backlog/design-doc/${doc.id}`)}>
      <div className={styles.cardHeader}>
        <h3 className={styles.cardTitle}>{doc.title}</h3>
        {canDelete && (
          <button
            className={styles.cardDeleteBtn}
            title="Delete design doc"
            type="button"
            onClick={(e) => { e.stopPropagation(); onDelete(doc); }}
            aria-label={`Delete design doc "${doc.title}"`}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="2 4 4 4 14 4" />
              <path d="M13 4l-.7 9.3A1 1 0 0 1 12.3 14H3.7a1 1 0 0 1-1-.7L2 4" />
              <path d="M6.5 7v4M9.5 7v4" />
              <path d="M5.5 4V2.7A.7.7 0 0 1 6.2 2h3.6a.7.7 0 0 1 .7.7V4" />
            </svg>
          </button>
        )}
      </div>
      <div className={styles.cardFooter}>
        <span className={`${styles.badge} ${designDocBadgeClass(doc.status)}`}>
          {designDocStatusLabel(doc.status)}
        </span>
        <div className={styles.cardFooterRight}>
          {doc.reviewerId && (
            <span className={styles.cardPrdBadge}>Reviewer assigned</span>
          )}
          <span className={styles.cardDate}>{formatDate(doc.createdAt)}</span>
        </div>
      </div>
    </div>
  );
};

interface DesignDocGroupCardProps {
  prdTitle: string;
  docs: DesignDocSummary[];
  expanded: boolean;
  onToggle: () => void;
  canDelete: boolean;
  onDelete: (doc: DesignDocSummary) => void;
  onDeleteAll: (docs: DesignDocSummary[]) => void;
}

const DesignDocGroupCard: React.FC<DesignDocGroupCardProps> = ({ prdTitle, docs, expanded, onToggle, canDelete, onDelete, onDeleteAll }) => {
  const statusCounts = useMemo(() => {
    const counts = new Map<DesignDocStatus, number>();
    for (const doc of docs) {
      counts.set(doc.status, (counts.get(doc.status) ?? 0) + 1);
    }
    return counts;
  }, [docs]);

  const approved = statusCounts.get('approved') ?? 0;
  const total = docs.length;
  const pct = total > 0 ? Math.round((approved / total) * 100) : 0;

  const summaryParts: string[] = [];
  if (approved > 0) summaryParts.push(`${approved} approved`);
  const pending = statusCounts.get('pending_review') ?? 0;
  if (pending > 0) summaryParts.push(`${pending} pending`);
  const remaining = total - approved - pending;
  if (remaining > 0) summaryParts.push(`${remaining} other`);

  return (
    <div className={styles.groupCard}>
      <div className={styles.groupCardHeaderRow}>
        <button className={styles.groupCardHeader} onClick={onToggle} type="button">
          <svg
            className={`${styles.expandChevron} ${expanded ? styles.expandChevronExpanded : ''}`}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="6 4 10 8 6 12" />
          </svg>
          <div className={styles.groupCardTitleArea}>
            <h3 className={styles.cardTitle}>{prdTitle}</h3>
            <span className={styles.groupCardMeta}>
              {total} design doc{total !== 1 ? 's' : ''}
              {summaryParts.length > 0 && ` \u2014 ${summaryParts.join(', ')}`}
            </span>
            <div className={styles.groupProgressRow}>
              <div className={styles.groupProgressBar}>
                <div className={styles.groupProgressFill} style={{ width: `${pct}%` }} />
              </div>
              <span className={styles.groupProgressLabel}>{approved}/{total} approved</span>
            </div>
          </div>
        </button>
        {canDelete && (
          <button
            className={styles.cardDeleteBtn}
            title={`Delete all ${docs.length} design docs`}
            type="button"
            onClick={(e) => { e.stopPropagation(); onDeleteAll(docs); }}
            aria-label={`Delete all design docs for "${prdTitle}"`}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="2 4 4 4 14 4" />
              <path d="M13 4l-.7 9.3A1 1 0 0 1 12.3 14H3.7a1 1 0 0 1-1-.7L2 4" />
              <path d="M6.5 7v4M9.5 7v4" />
              <path d="M5.5 4V2.7A.7.7 0 0 1 6.2 2h3.6a.7.7 0 0 1 .7.7V4" />
            </svg>
          </button>
        )}
      </div>
      {expanded && (
        <div className={styles.groupCardChildren}>
          {docs.map((doc) => (
            <DesignDocCard key={doc.id} doc={doc} canDelete={canDelete} onDelete={onDelete} />
          ))}
        </div>
      )}
    </div>
  );
};

interface DesignPrototypeCardProps {
  proto: DesignPrototypeSummary;
  canDelete: boolean;
  onDelete: (proto: DesignPrototypeSummary) => void;
}

const DesignPrototypeCard: React.FC<DesignPrototypeCardProps> = ({ proto, canDelete, onDelete }) => {
  const navigate = useNavigate();
  return (
    <div className={styles.card} onClick={() => navigate(`/backlog/design-prototypes/${proto.prdId}`)}>
      <div className={styles.cardHeader}>
        <h3 className={styles.cardTitle}>{proto.featureName}</h3>
        {canDelete && (
          <button
            className={styles.cardDeleteBtn}
            title="Delete prototype"
            type="button"
            onClick={(e) => { e.stopPropagation(); onDelete(proto); }}
            aria-label={`Delete prototype "${proto.featureName}"`}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="2 4 4 4 14 4" />
              <path d="M13 4l-.7 9.3A1 1 0 0 1 12.3 14H3.7a1 1 0 0 1-1-.7L2 4" />
              <path d="M6.5 7v4M9.5 7v4" />
              <path d="M5.5 4V2.7A.7.7 0 0 1 6.2 2h3.6a.7.7 0 0 1 .7.7V4" />
            </svg>
          </button>
        )}
      </div>
      <div className={styles.cardFooter}>
        <span className={`${styles.badge} ${prototypeBadgeClass(proto.status)}`}>
          {prototypeStatusLabel(proto.status)}
        </span>
        <div className={styles.cardFooterRight}>
          {proto.prdTitle && (
            <span className={styles.cardPrdBadge} title={proto.prdTitle}>
              {proto.prdTitle.length > 25 ? `${proto.prdTitle.slice(0, 25)}…` : proto.prdTitle}
            </span>
          )}
          <span className={styles.cardDate}>{formatDate(proto.updatedAt)}</span>
        </div>
      </div>
    </div>
  );
};

interface DesignPrototypeGroupCardProps {
  prdTitle: string;
  protos: DesignPrototypeSummary[];
  expanded: boolean;
  onToggle: () => void;
  canDelete: boolean;
  onDelete: (proto: DesignPrototypeSummary) => void;
  onDeleteAll: (protos: DesignPrototypeSummary[]) => void;
}

const DesignPrototypeGroupCard: React.FC<DesignPrototypeGroupCardProps> = ({ prdTitle, protos, expanded, onToggle, canDelete, onDelete, onDeleteAll }) => {
  const navigate = useNavigate();
  const statusCounts = useMemo(() => {
    const counts = new Map<DesignPrototypeStatus, number>();
    for (const p of protos) {
      counts.set(p.status, (counts.get(p.status) ?? 0) + 1);
    }
    return counts;
  }, [protos]);

  const summaryParts: string[] = [];
  const approved = statusCounts.get('approved') ?? 0;
  if (approved > 0) summaryParts.push(`${approved} approved`);
  const pending = statusCounts.get('pending_review') ?? 0;
  if (pending > 0) summaryParts.push(`${pending} pending`);
  const remaining = protos.length - approved - pending;
  if (remaining > 0) summaryParts.push(`${remaining} other`);

  return (
    <div className={styles.groupCard}>
      <div className={styles.groupCardHeaderRow}>
        <button className={styles.groupCardHeader} onClick={onToggle} type="button">
          <svg
            className={`${styles.expandChevron} ${expanded ? styles.expandChevronExpanded : ''}`}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="6 4 10 8 6 12" />
          </svg>
          <div className={styles.groupCardTitleArea}>
            <h3 className={styles.cardTitle}>{prdTitle}</h3>
            <span className={styles.groupCardMeta}>
              {protos.length} prototype{protos.length !== 1 ? 's' : ''}
              {summaryParts.length > 0 && ` \u2014 ${summaryParts.join(', ')}`}
            </span>
          </div>
        </button>
        {canDelete && (
          <button
            className={styles.cardDeleteBtn}
            title={`Delete all ${protos.length} prototypes`}
            type="button"
            onClick={(e) => { e.stopPropagation(); onDeleteAll(protos); }}
            aria-label={`Delete all prototypes for "${prdTitle}"`}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="2 4 4 4 14 4" />
              <path d="M13 4l-.7 9.3A1 1 0 0 1 12.3 14H3.7a1 1 0 0 1-1-.7L2 4" />
              <path d="M6.5 7v4M9.5 7v4" />
              <path d="M5.5 4V2.7A.7.7 0 0 1 6.2 2h3.6a.7.7 0 0 1 .7.7V4" />
            </svg>
          </button>
        )}
      </div>
      {expanded && (
        <div className={styles.groupCardChildren}>
          {protos.map((proto) => (
            <div key={proto.id} className={styles.card} onClick={() => navigate(`/backlog/design-prototypes/${proto.prdId}`)}>
              <div className={styles.cardHeader}>
                <h3 className={styles.cardTitle}>{proto.featureName}</h3>
                {canDelete && (
                  <button
                    className={styles.cardDeleteBtn}
                    title="Delete prototype"
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onDelete(proto); }}
                    aria-label={`Delete prototype "${proto.featureName}"`}
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="2 4 4 4 14 4" />
                      <path d="M13 4l-.7 9.3A1 1 0 0 1 12.3 14H3.7a1 1 0 0 1-1-.7L2 4" />
                      <path d="M6.5 7v4M9.5 7v4" />
                      <path d="M5.5 4V2.7A.7.7 0 0 1 6.2 2h3.6a.7.7 0 0 1 .7.7V4" />
                    </svg>
                  </button>
                )}
              </div>
              <div className={styles.cardFooter}>
                <span className={`${styles.badge} ${prototypeBadgeClass(proto.status)}`}>
                  {prototypeStatusLabel(proto.status)}
                </span>
                <span className={styles.cardDate}>{formatDate(proto.updatedAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

type OwnerFilter = 'all' | 'mine';

export const InterviewsDashboard: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { can, isInAnyGroup, selectedProject, permissionsLoaded } = useAppShell();

  const rawTab = searchParams.get('tab');
  const initialTab: TabId =
    rawTab === 'prds' ? 'prds' :
    rawTab === 'design-prototypes' ? 'design-prototypes' :
    rawTab === 'design-docs' ? 'design-docs' :
    'interviews';

  const [activeTab, setActiveTab] = useState<TabId>(initialTab);
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>('all');
  const [interviewFilter, setInterviewFilter] = useState<InterviewStatus | undefined>(undefined);
  const [prdFilter, setPrdFilter] = useState<PrdStatus | undefined>(undefined);
  const [protoFilter, setProtoFilter] = useState<DesignPrototypeStatus | undefined>(undefined);
  const [designDocFilter, setDesignDocFilter] = useState<DesignDocStatus | undefined>(undefined);
  const [interviewSearch, setInterviewSearch] = useState('');
  const [prdSearch, setPrdSearch] = useState('');
  const [protoSearch, setProtoSearch] = useState('');
  const [designDocSearch, setDesignDocSearch] = useState('');

  const [expandedPrdGroups, setExpandedPrdGroups] = useState<Set<string>>(new Set());
  const [expandedProtoGroups, setExpandedProtoGroups] = useState<Set<string>>(new Set());
  const [pendingDeleteInterview, setPendingDeleteInterview] = useState<InterviewSummary | null>(null);
  const [pendingDeletePrd, setPendingDeletePrd] = useState<PrdSummary | null>(null);
  const [pendingDeleteDesignDoc, setPendingDeleteDesignDoc] = useState<DesignDocSummary | null>(null);
  const [pendingDeletePrototype, setPendingDeletePrototype] = useState<DesignPrototypeSummary | null>(null);
  const [pendingDeleteGroup, setPendingDeleteGroup] = useState<{ prdTitle: string; docs: DesignDocSummary[] } | null>(null);
  const [pendingDeleteProtoGroup, setPendingDeleteProtoGroup] = useState<{ prdTitle: string; protos: DesignPrototypeSummary[] } | null>(null);
  const [isDeletingGroup, setIsDeletingGroup] = useState(false);

  const deleteInterview = useDeleteInterview();
  const deletePrd = useDeletePrd();
  const deleteDesignDoc = useDeleteDesignDoc();
  const deletePrototype = useDeletePrototype();

  const authorParam = ownerFilter === 'mine' ? 'me' as const : undefined;

  const { data: interviews = [], isLoading: ivLoading } = useInterviewList({
    ...(interviewFilter ? { status: interviewFilter } : {}),
    ...(selectedProject ? { project: selectedProject } : {}),
    ...(authorParam ? { author: authorParam } : {}),
  });
  const { data: prds = [], isLoading: prdLoading } = usePrdList({
    ...(prdFilter ? { status: prdFilter } : {}),
    ...(selectedProject ? { project: selectedProject } : {}),
    ...(authorParam ? { author: authorParam } : {}),
  });
  const { data: prototypes = [], isLoading: protoLoading } = useDesignPrototypeList({
    ...(protoFilter ? { status: protoFilter } : {}),
    ...(selectedProject ? { project: selectedProject } : {}),
    ...(authorParam ? { author: authorParam } : {}),
  });
  const { data: designDocs = [], isLoading: docLoading } = useDesignDocList({
    ...(designDocFilter ? { status: designDocFilter } : {}),
    ...(selectedProject ? { project: selectedProject } : {}),
    ...(authorParam ? { author: authorParam } : {}),
  });

  const canManage = can('interviews:manage');
  const canStartInterview = permissionsLoaded && canManage && isInAnyGroup(['BA', 'Manager', 'Product-Owner']);

  const filteredInterviews = interviewSearch.trim()
    ? interviews.filter((iv) => iv.title.toLowerCase().includes(interviewSearch.toLowerCase()))
    : interviews;

  const filteredPrds = prdSearch.trim()
    ? prds.filter((prd) => prd.title.toLowerCase().includes(prdSearch.toLowerCase()))
    : prds;

  const filteredPrototypes = protoSearch.trim()
    ? prototypes.filter((p) =>
        p.featureName.toLowerCase().includes(protoSearch.toLowerCase()) ||
        (p.prdTitle ?? '').toLowerCase().includes(protoSearch.toLowerCase()))
    : prototypes;

  const filteredDesignDocs = designDocSearch.trim()
    ? designDocs.filter((doc) => doc.title.toLowerCase().includes(designDocSearch.toLowerCase()))
    : designDocs;

  const groupedPrototypes = useMemo(() => {
    const byPrd = new Map<string, DesignPrototypeSummary[]>();
    for (const proto of filteredPrototypes) {
      const key = proto.prdId;
      if (!byPrd.has(key)) byPrd.set(key, []);
      byPrd.get(key)!.push(proto);
    }
    return byPrd;
  }, [filteredPrototypes]);

  const groupedDesignDocs = useMemo(() => {
    const byPrd = new Map<string, DesignDocSummary[]>();
    for (const doc of filteredDesignDocs) {
      const key = doc.prdId;
      if (!byPrd.has(key)) byPrd.set(key, []);
      byPrd.get(key)!.push(doc);
    }
    return byPrd;
  }, [filteredDesignDocs]);

  const togglePrdGroup = (prdId: string) => {
    setExpandedPrdGroups((prev) => {
      const next = new Set(prev);
      if (next.has(prdId)) next.delete(prdId);
      else next.add(prdId);
      return next;
    });
  };

  const toggleProtoGroup = (prdId: string) => {
    setExpandedProtoGroups((prev) => {
      const next = new Set(prev);
      if (next.has(prdId)) next.delete(prdId);
      else next.add(prdId);
      return next;
    });
  };

  return (
    <div className={styles.dashboard}>
      <div className={styles.header}>
        <h1 className={styles.heading}>Interviews & PRDs</h1>
        {canManage && (
          <div className={styles.startButtonWrap} title={!canStartInterview ? 'You must be a member of the BA, Manager, or Product-Owner group to start an interview.' : undefined}>
            <button
              className={styles.startButton}
              onClick={() => navigate('/backlog/interview/new')}
              type="button"
              disabled={!canStartInterview}
            >
              + Start New Interview
            </button>
          </div>
        )}
      </div>

      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${activeTab === 'interviews' ? styles.active : ''}`}
          onClick={() => setActiveTab('interviews')}
          type="button"
        >
          Interviews ({interviews.length})
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'prds' ? styles.active : ''}`}
          onClick={() => setActiveTab('prds')}
          type="button"
        >
          PRDs ({prds.length})
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'design-prototypes' ? styles.active : ''}`}
          onClick={() => setActiveTab('design-prototypes')}
          type="button"
        >
          Design Prototypes ({prototypes.length})
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'design-docs' ? styles.active : ''}`}
          onClick={() => setActiveTab('design-docs')}
          type="button"
        >
          Design Docs ({designDocs.length})
        </button>
      </div>

      <div className={styles.ownerFilters}>
        <button
          className={`${styles.ownerPill} ${ownerFilter === 'all' ? styles.active : ''}`}
          onClick={() => setOwnerFilter('all')}
          type="button"
        >
          All
        </button>
        <button
          className={`${styles.ownerPill} ${ownerFilter === 'mine' ? styles.active : ''}`}
          onClick={() => setOwnerFilter('mine')}
          type="button"
        >
          Mine
        </button>
      </div>

      {activeTab === 'interviews' && (
        <>
          <div className={styles.filtersRow}>
            <div className={styles.filters}>
              {INTERVIEW_FILTERS.map((f) => (
                <button
                  key={f.label}
                  className={`${styles.filterPill} ${interviewFilter === f.value ? styles.active : ''}`}
                  onClick={() => setInterviewFilter(f.value)}
                  type="button"
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className={styles.searchWrap}>
              <svg className={styles.searchIcon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="6.5" cy="6.5" r="4.5" />
                <line x1="10" y1="10" x2="14" y2="14" />
              </svg>
              <input
                className={styles.searchInput}
                type="search"
                placeholder="Search interviews…"
                value={interviewSearch}
                onChange={(e) => setInterviewSearch(e.target.value)}
              />
            </div>
          </div>
          {ivLoading ? (
            <div className={styles.emptyState}>Loading…</div>
          ) : filteredInterviews.length === 0 ? (
            <div className={styles.emptyState}>
              {interviewSearch.trim() ? (
                <p className={styles.emptyStateText}>No interviews match &ldquo;{interviewSearch}&rdquo;</p>
              ) : (
                <>
                  <div className={styles.emptyStateIconWrap}>
                    <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="14" y="5" width="12" height="20" rx="6" />
                      <path d="M8 19v1a12 12 0 0 0 24 0v-1" />
                      <line x1="20" x2="20" y1="32" y2="38" />
                      <line x1="14" x2="26" y1="38" y2="38" />
                    </svg>
                  </div>
                  <p className={styles.emptyStateText}>No interviews yet.{canStartInterview ? ' Start one above.' : ''}</p>
                </>
              )}
            </div>
          ) : (
            <div className={styles.grid}>
              {filteredInterviews.map((iv) => (
                <InterviewCard
                  key={iv.id}
                  interview={iv}
                  canDelete={canManage}
                  onDelete={setPendingDeleteInterview}
                />
              ))}
            </div>
          )}
        </>
      )}

      {activeTab === 'prds' && (
        <>
          <div className={styles.filtersRow}>
            <div className={styles.filters}>
              {PRD_FILTERS.map((f) => (
                <button
                  key={f.label}
                  className={`${styles.filterPill} ${prdFilter === f.value ? styles.active : ''}`}
                  onClick={() => setPrdFilter(f.value)}
                  type="button"
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className={styles.searchWrap}>
              <svg className={styles.searchIcon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="6.5" cy="6.5" r="4.5" />
                <line x1="10" y1="10" x2="14" y2="14" />
              </svg>
              <input
                className={styles.searchInput}
                type="search"
                placeholder="Search PRDs…"
                value={prdSearch}
                onChange={(e) => setPrdSearch(e.target.value)}
              />
            </div>
          </div>
          {prdLoading ? (
            <div className={styles.emptyState}>Loading…</div>
          ) : filteredPrds.length === 0 ? (
            <div className={styles.emptyState}>
              {prdSearch.trim() ? (
                <p className={styles.emptyStateText}>No PRDs match &ldquo;{prdSearch}&rdquo;</p>
              ) : (
                <>
                  <div className={styles.emptyStateIconWrap}>
                    <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="8" y="3" width="24" height="34" rx="3" />
                      <line x1="14" x2="26" y1="12" y2="12" />
                      <line x1="14" x2="26" y1="19" y2="19" />
                      <line x1="14" x2="21" y1="26" y2="26" />
                    </svg>
                  </div>
                  <p className={styles.emptyStateText}>No PRDs yet.</p>
                </>
              )}
            </div>
          ) : (
            <div className={styles.grid}>
              {filteredPrds.map((prd) => (
                <PrdCard
                  key={prd.id}
                  prd={prd}
                  canDelete={canManage}
                  onDelete={setPendingDeletePrd}
                />
              ))}
            </div>
          )}
        </>
      )}

      {activeTab === 'design-prototypes' && (
        <>
          <div className={styles.filtersRow}>
            <div className={styles.filters}>
              {PROTOTYPE_FILTERS.map((f) => (
                <button
                  key={f.label}
                  className={`${styles.filterPill} ${protoFilter === f.value ? styles.active : ''}`}
                  onClick={() => setProtoFilter(f.value)}
                  type="button"
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className={styles.searchWrap}>
              <svg className={styles.searchIcon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="6.5" cy="6.5" r="4.5" />
                <line x1="10" y1="10" x2="14" y2="14" />
              </svg>
              <input
                className={styles.searchInput}
                type="search"
                placeholder="Search prototypes…"
                value={protoSearch}
                onChange={(e) => setProtoSearch(e.target.value)}
              />
            </div>
          </div>
          {protoLoading ? (
            <div className={styles.emptyState}>Loading…</div>
          ) : filteredPrototypes.length === 0 ? (
            <div className={styles.emptyState}>
              {protoSearch.trim() ? (
                <p className={styles.emptyStateText}>No prototypes match &ldquo;{protoSearch}&rdquo;</p>
              ) : (
                <>
                  <div className={styles.emptyStateIconWrap}>
                    <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="4" y="4" width="32" height="32" rx="4" />
                      <rect x="10" y="10" width="8" height="8" rx="1" />
                      <rect x="22" y="10" width="8" height="3" rx="1" />
                      <rect x="22" y="16" width="8" height="2" rx="1" />
                      <rect x="10" y="22" width="20" height="8" rx="1" />
                    </svg>
                  </div>
                  <p className={styles.emptyStateText}>No design prototypes yet. Approve a PRD to generate prototypes.</p>
                </>
              )}
            </div>
          ) : (
            <div className={styles.grid}>
              {Array.from(groupedPrototypes.entries()).map(([prdId, protos]) =>
                protos.length >= 2 ? (
                  <DesignPrototypeGroupCard
                    key={prdId}
                    prdTitle={protos[0].prdTitle ?? 'Untitled PRD'}
                    protos={protos}
                    expanded={expandedProtoGroups.has(prdId)}
                    onToggle={() => toggleProtoGroup(prdId)}
                    canDelete={canManage}
                    onDelete={setPendingDeletePrototype}
                    onDeleteAll={(p) => setPendingDeleteProtoGroup({ prdTitle: p[0].prdTitle ?? 'Untitled PRD', protos: p })}
                  />
                ) : (
                  <DesignPrototypeCard
                    key={protos[0].id}
                    proto={protos[0]}
                    canDelete={canManage}
                    onDelete={setPendingDeletePrototype}
                  />
                ),
              )}
            </div>
          )}
        </>
      )}

      {activeTab === 'design-docs' && (
        <>
          <div className={styles.filtersRow}>
            <div className={styles.filters}>
              {DESIGN_DOC_FILTERS.map((f) => (
                <button
                  key={f.label}
                  className={`${styles.filterPill} ${designDocFilter === f.value ? styles.active : ''}`}
                  onClick={() => setDesignDocFilter(f.value)}
                  type="button"
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className={styles.searchWrap}>
              <svg className={styles.searchIcon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="6.5" cy="6.5" r="4.5" />
                <line x1="10" y1="10" x2="14" y2="14" />
              </svg>
              <input
                className={styles.searchInput}
                type="search"
                placeholder="Search design docs…"
                value={designDocSearch}
                onChange={(e) => setDesignDocSearch(e.target.value)}
              />
            </div>
          </div>
          {docLoading ? (
            <div className={styles.emptyState}>Loading…</div>
          ) : filteredDesignDocs.length === 0 ? (
            <div className={styles.emptyState}>
              {designDocSearch.trim() ? (
                <p className={styles.emptyStateText}>No design docs match &ldquo;{designDocSearch}&rdquo;</p>
              ) : (
                <>
                  <div className={styles.emptyStateIconWrap}>
                    <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="6" y="2" width="28" height="36" rx="3" />
                      <line x1="12" x2="28" y1="11" y2="11" />
                      <line x1="12" x2="28" y1="18" y2="18" />
                      <line x1="12" x2="20" y1="25" y2="25" />
                      <circle cx="28" cy="30" r="6" />
                      <line x1="26" x2="30" y1="30" y2="30" />
                      <line x1="28" x2="28" y1="28" y2="32" />
                    </svg>
                  </div>
                  <p className={styles.emptyStateText}>No design docs yet. Generate one from an approved PRD.</p>
                </>
              )}
            </div>
          ) : (
            <div className={styles.grid}>
              {Array.from(groupedDesignDocs.entries()).map(([prdId, docs]) =>
                docs.length >= 2 ? (
                  <DesignDocGroupCard
                    key={prdId}
                    prdTitle={docs[0].prdTitle ?? 'Untitled PRD'}
                    docs={docs}
                    expanded={expandedPrdGroups.has(prdId)}
                    onToggle={() => togglePrdGroup(prdId)}
                    canDelete={canManage}
                    onDelete={setPendingDeleteDesignDoc}
                    onDeleteAll={(d) => setPendingDeleteGroup({ prdTitle: d[0].prdTitle ?? 'Untitled PRD', docs: d })}
                  />
                ) : (
                  <DesignDocCard
                    key={docs[0].id}
                    doc={docs[0]}
                    canDelete={canManage}
                    onDelete={setPendingDeleteDesignDoc}
                  />
                ),
              )}
            </div>
          )}
        </>
      )}

      {pendingDeleteInterview && (
        <ConfirmDeleteModal
          title="Delete Interview"
          itemName={pendingDeleteInterview.title}
          description="Are you sure you want to permanently delete the interview"
          isPending={deleteInterview.isPending}
          onConfirm={() => {
            deleteInterview.mutate(pendingDeleteInterview.id, {
              onSuccess: () => setPendingDeleteInterview(null),
            });
          }}
          onCancel={() => setPendingDeleteInterview(null)}
        />
      )}

      {pendingDeletePrd && (
        <ConfirmDeleteModal
          title="Delete PRD"
          itemName={pendingDeletePrd.title}
          description="Are you sure you want to permanently delete the PRD"
          isPending={deletePrd.isPending}
          onConfirm={() => {
            deletePrd.mutate(pendingDeletePrd.id, {
              onSuccess: () => setPendingDeletePrd(null),
            });
          }}
          onCancel={() => setPendingDeletePrd(null)}
        />
      )}

      {pendingDeleteDesignDoc && (
        <ConfirmDeleteModal
          title="Delete Design Doc"
          itemName={pendingDeleteDesignDoc.title}
          description="Are you sure you want to permanently delete the design doc"
          isPending={deleteDesignDoc.isPending}
          onConfirm={() => {
            deleteDesignDoc.mutate(pendingDeleteDesignDoc.id, {
              onSuccess: () => setPendingDeleteDesignDoc(null),
            });
          }}
          onCancel={() => setPendingDeleteDesignDoc(null)}
        />
      )}

      {pendingDeletePrototype && (
        <ConfirmDeleteModal
          title="Delete Design Prototype"
          itemName={pendingDeletePrototype.featureName}
          description="Are you sure you want to permanently delete the design prototype"
          isPending={deletePrototype.isPending}
          onConfirm={() => {
            deletePrototype.mutate(pendingDeletePrototype.id, {
              onSuccess: () => setPendingDeletePrototype(null),
            });
          }}
          onCancel={() => setPendingDeletePrototype(null)}
        />
      )}

      {pendingDeleteGroup && (
        <ConfirmDeleteModal
          title="Delete All Design Docs"
          itemName={`${pendingDeleteGroup.docs.length} design docs for "${pendingDeleteGroup.prdTitle}"`}
          description={`Are you sure you want to permanently delete all ${pendingDeleteGroup.docs.length} design docs`}
          isPending={isDeletingGroup}
          onConfirm={async () => {
            setIsDeletingGroup(true);
            try {
              for (const doc of pendingDeleteGroup.docs) {
                await deleteDesignDoc.mutateAsync(doc.id);
              }
            } finally {
              setIsDeletingGroup(false);
              setPendingDeleteGroup(null);
            }
          }}
          onCancel={() => setPendingDeleteGroup(null)}
        />
      )}

      {pendingDeleteProtoGroup && (
        <ConfirmDeleteModal
          title="Delete All Prototypes"
          itemName={`${pendingDeleteProtoGroup.protos.length} prototypes for "${pendingDeleteProtoGroup.prdTitle}"`}
          description={`Are you sure you want to permanently delete all ${pendingDeleteProtoGroup.protos.length} prototypes`}
          isPending={isDeletingGroup}
          onConfirm={async () => {
            setIsDeletingGroup(true);
            try {
              for (const proto of pendingDeleteProtoGroup.protos) {
                await deletePrototype.mutateAsync(proto.id);
              }
            } finally {
              setIsDeletingGroup(false);
              setPendingDeleteProtoGroup(null);
            }
          }}
          onCancel={() => setPendingDeleteProtoGroup(null)}
        />
      )}
    </div>
  );
};

export default InterviewsDashboard;

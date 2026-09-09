import React, { useEffect, useMemo, useState } from 'react';
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
} from '../../shared/utils/prdReadiness';
import { useProjectSkillConfig } from '../hooks/useProjectSkillConfig';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import styles from './InterviewsDashboard.module.css';

type TabId = 'interviews' | 'prds' | 'designs';

type DesignStatusFilter =
  | 'generating'
  | 'generation_failed'
  | 'draft'
  | 'pending_review'
  | 'approved'
  | 'revision_requested';

function tabFromSearch(rawTab: string | null): TabId {
  if (rawTab === 'prds') return 'prds';
  if (rawTab === 'designs' || rawTab === 'design-prototypes' || rawTab === 'design-docs') {
    return 'designs';
  }
  return 'interviews';
}

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

const DESIGN_FILTERS: { label: string; value: DesignStatusFilter | undefined }[] = [
  { label: 'All', value: undefined },
  { label: 'Generating', value: 'generating' },
  { label: 'Failed', value: 'generation_failed' },
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

function prdBadgeClass(status: PrdStatus): string {
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

function designDocBadgeClass(status: DesignDocStatus): string {
  switch (status) {
    case 'generating': return styles.badgeGenerating;
    case 'generation_failed': return styles.badgeRevisionRequested;
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
    case 'generation_failed': return 'Failed';
    case 'validating': return 'Validating';
    case 'draft': return 'Draft';
    case 'pending_review': return 'Pending Review';
    case 'reviewer_approved': return 'Awaiting Owner Approval';
    case 'approved': return 'Approved';
    case 'revision_requested': return 'Revision Requested';
  }
}

function docMatchesStatus(status: DesignDocStatus, filter?: DesignStatusFilter): boolean {
  if (!filter) return true;
  switch (filter) {
    case 'generating':
      return status === 'generating' || status === 'validating';
    case 'generation_failed':
      return status === 'generation_failed';
    case 'draft':
      return status === 'draft';
    case 'pending_review':
      return status === 'pending_review' || status === 'reviewer_approved';
    case 'approved':
      return status === 'approved';
    case 'revision_requested':
      return status === 'revision_requested';
    default: {
      const _exhaustive: never = filter;
      return _exhaustive;
    }
  }
}

function protoMatchesStatus(status: DesignPrototypeStatus, filter?: DesignStatusFilter): boolean {
  if (!filter) return true;
  switch (filter) {
    case 'generating':
      return status === 'generating' || status === 'regenerating';
    case 'generation_failed':
      return status === 'generation_failed';
    case 'draft':
      return false;
    case 'pending_review':
      return status === 'pending_review' || status === 'reviewer_approved';
    case 'approved':
      return status === 'approved';
    case 'revision_requested':
      return status === 'revision_requested';
    default: {
      const _exhaustive: never = filter;
      return _exhaustive;
    }
  }
}

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

interface DesignPrdGroup {
  prdId: string;
  prdTitle: string;
  docs: DesignDocSummary[];
  prototypes: DesignPrototypeSummary[];
}

function groupDesignsByPrd(
  docs: DesignDocSummary[],
  prototypes: DesignPrototypeSummary[],
): DesignPrdGroup[] {
  const groups = new Map<string, DesignPrdGroup>();

  const ensureGroup = (prdId: string, prdTitle?: string): DesignPrdGroup => {
    const existing = groups.get(prdId);
    if (existing) {
      if (prdTitle && existing.prdTitle === 'Untitled PRD') existing.prdTitle = prdTitle;
      return existing;
    }
    const created: DesignPrdGroup = {
      prdId,
      prdTitle: prdTitle || 'Untitled PRD',
      docs: [],
      prototypes: [],
    };
    groups.set(prdId, created);
    return created;
  };

  for (const doc of docs) {
    ensureGroup(doc.prdId, doc.prdTitle).docs.push(doc);
  }
  for (const proto of prototypes) {
    ensureGroup(proto.prdId, proto.prdTitle).prototypes.push(proto);
  }

  for (const group of groups.values()) {
    group.docs.sort((a, b) => (a.featureIndex ?? 0) - (b.featureIndex ?? 0) || a.title.localeCompare(b.title));
    group.prototypes.sort((a, b) => a.featureIndex - b.featureIndex || a.featureName.localeCompare(b.featureName));
  }

  return [...groups.values()].sort((a, b) => a.prdTitle.localeCompare(b.prdTitle));
}

function filterDesignGroup(
  group: DesignPrdGroup,
  search: string,
  statusFilter?: DesignStatusFilter,
): DesignPrdGroup | null {
  const query = search.trim().toLowerCase();
  const docs = group.docs.filter((doc) => docMatchesStatus(doc.status, statusFilter));
  const prototypes = group.prototypes.filter((proto) => protoMatchesStatus(proto.status, statusFilter));
  if (!query) {
    if (docs.length === 0 && prototypes.length === 0) return null;
    return { ...group, docs, prototypes };
  }

  const titleHit = group.prdTitle.toLowerCase().includes(query);
  const filteredDocs = docs.filter((doc) => titleHit || doc.title.toLowerCase().includes(query));
  const filteredProtos = prototypes.filter((proto) => (
    titleHit || proto.featureName.toLowerCase().includes(query)
  ));
  if (filteredDocs.length === 0 && filteredProtos.length === 0) return null;
  return { ...group, docs: filteredDocs, prototypes: filteredProtos };
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}


interface InterviewCardProps {
  interview: InterviewSummary;
  canDelete: boolean;
  onDelete: (interview: InterviewSummary) => void;
  'data-testid'?: string;
}

const InterviewCard: React.FC<InterviewCardProps> = ({ interview, canDelete, onDelete }) => {
  const navigate = useNavigate();
  return (
    <div
      className={styles.card}
      {...{ 'data-testid': 'interview-card' }}
      onClick={() => navigate(`/backlog/interview/${interview.id}`)}
    >
      <div className={styles.cardHeader}>
        <h3 className={styles.cardTitle}>{interview.title}</h3>
        {canDelete && (
          <button
            className={styles.cardDeleteBtn}
            title="Delete interview"
            type="button"
            {...{ 'data-testid': `delete-interview-${interview.id}-btn` }}
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
          {interview.skillSettingsName && (
            <span className={styles.repoBadge}>{interview.skillSettingsName}</span>
          )}
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
  'data-testid'?: string;
}

const PrdCard: React.FC<PrdCardProps> = ({ prd, canDelete, onDelete }) => {
  const navigate = useNavigate();
  const readiness = derivePrdReadiness(prd, prd.latestTestCase, prd.validationScoreThreshold ?? undefined, {
    testCasesRequired: prd.testCasesRequired !== false,
    prdValidationEnabled: prd.prdValidationEnabled === true,
  });
  const coverage = prd.latestTestCase?.coverageSummary;
  return (
    <div
      className={styles.card}
      {...{ 'data-testid': 'prd-card' }}
      onClick={() => navigate(`/backlog/prd/${prd.id}`)}
    >
      <div className={styles.cardHeader}>
        <h3 className={styles.cardTitle}>{prd.title}</h3>
        {canDelete && (
          <button
            className={styles.cardDeleteBtn}
            title="Delete PRD"
            type="button"
            {...{ 'data-testid': `delete-prd-${prd.id}-btn` }}
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
        <span className={`${styles.badge} ${prdBadgeClass(prd.status)}`}>
          {prdStatusLabel(prd.status)}
        </span>
        <div className={styles.cardFooterRight}>
          {prd.skillSettingsName && (
            <span className={styles.repoBadge}>{prd.skillSettingsName}</span>
          )}
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
          {(readiness.severity === 'warning' || readiness.severity === 'error' || readiness.severity === 'info') && (
            <span className={styles.cardPrdBadge} title={readiness.description}>
              {readiness.label}
            </span>
          )}
          <span className={styles.cardDate}>{formatDate(prd.createdAt)}</span>
        </div>
      </div>
    </div>
  );
};

interface DesignDocRowProps {
  doc: DesignDocSummary;
  canDelete: boolean;
  onDelete: (doc: DesignDocSummary) => void;
}

const DesignDocRow: React.FC<DesignDocRowProps> = ({ doc, canDelete, onDelete }) => {
  const navigate = useNavigate();
  return (
    <div
      className={styles.childRow}
      role="button"
      tabIndex={0}
      {...{ 'data-testid': 'design-doc-card' }}
      onClick={() => navigate(`/backlog/design-doc/${doc.id}`)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          navigate(`/backlog/design-doc/${doc.id}`);
        }
      }}
    >
      <div className={styles.childRowMain}>
        <span className={styles.childKind}>Doc</span>
        <span className={styles.childTitle}>{doc.title}</span>
      </div>
      <div className={styles.childRowMeta}>
        <span className={`${styles.badge} ${designDocBadgeClass(doc.status)}`}>
          {designDocStatusLabel(doc.status)}
        </span>
        <span className={styles.cardDate}>{formatDate(doc.createdAt)}</span>
        {canDelete && (
          <button
            className={styles.childDeleteBtn}
            title="Delete design doc"
            type="button"
            {...{ 'data-testid': `delete-design-doc-${doc.id}-btn` }}
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
    </div>
  );
};

interface DesignPrototypeRowProps {
  proto: DesignPrototypeSummary;
  canDelete: boolean;
  onDelete: (proto: DesignPrototypeSummary) => void;
}

const DesignPrototypeRow: React.FC<DesignPrototypeRowProps> = ({ proto, canDelete, onDelete }) => {
  const navigate = useNavigate();
  return (
    <div
      className={styles.childRow}
      role="button"
      tabIndex={0}
      {...{ 'data-testid': 'design-prototype-card' }}
      onClick={() => navigate(`/backlog/design-prototypes/${proto.prdId}`)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          navigate(`/backlog/design-prototypes/${proto.prdId}`);
        }
      }}
    >
      <div className={styles.childRowMain}>
        <span className={styles.childKind}>Prototype</span>
        <span className={styles.childTitle}>{proto.featureName}</span>
      </div>
      <div className={styles.childRowMeta}>
        <span className={`${styles.badge} ${prototypeBadgeClass(proto.status)}`}>
          {prototypeStatusLabel(proto.status)}
        </span>
        <span className={styles.cardDate}>{formatDate(proto.updatedAt)}</span>
        {canDelete && (
          <button
            className={styles.childDeleteBtn}
            title="Delete prototype"
            type="button"
            {...{ 'data-testid': `delete-prototype-${proto.id}-btn` }}
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
    </div>
  );
};

interface DesignPrdGroupCardProps {
  group: DesignPrdGroup;
  expanded: boolean;
  onToggle: () => void;
  canDelete: boolean;
  onDeleteDoc: (doc: DesignDocSummary) => void;
  onDeletePrototype: (proto: DesignPrototypeSummary) => void;
}

const DesignPrdGroupCard: React.FC<DesignPrdGroupCardProps> = ({
  group,
  expanded,
  onToggle,
  canDelete,
  onDeleteDoc,
  onDeletePrototype,
}) => {
  const countParts = [
    group.docs.length > 0 ? countLabel(group.docs.length, 'doc', 'docs') : null,
    group.prototypes.length > 0 ? countLabel(group.prototypes.length, 'prototype', 'prototypes') : null,
  ].filter((part): part is string => part !== null);

  return (
    <section className={styles.group} {...{ 'data-testid': 'design-prd-group' }}>
      <button
        className={styles.groupHeader}
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        {...{ 'data-testid': `design-prd-group-toggle-${group.prdId}` }}
      >
        <span className={`${styles.groupChevron} ${expanded ? styles.groupChevronOpen : ''}`} aria-hidden="true">
          ▶
        </span>
        <span className={styles.groupTitle}>{group.prdTitle}</span>
        <span className={styles.groupCounts}>{countParts.join(' · ')}</span>
      </button>
      {expanded && (
        <div className={styles.groupBody} {...{ 'data-testid': `design-prd-group-body-${group.prdId}` }}>
          {group.docs.length > 0 && (
            <div className={styles.groupSection}>
              <h3 className={styles.groupSectionLabel}>Design docs</h3>
              {group.docs.map((doc) => (
                <DesignDocRow
                  key={doc.id}
                  doc={doc}
                  canDelete={canDelete}
                  onDelete={onDeleteDoc}
                />
              ))}
            </div>
          )}
          {group.prototypes.length > 0 && (
            <div className={styles.groupSection}>
              <h3 className={styles.groupSectionLabel}>Prototypes</h3>
              {group.prototypes.map((proto) => (
                <DesignPrototypeRow
                  key={proto.id}
                  proto={proto}
                  canDelete={canDelete}
                  onDelete={onDeletePrototype}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
};

type OwnerFilter = 'all' | 'mine';

export const InterviewsDashboard: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { can, isInAnyGroup, selectedProject, permissionsLoaded } = useAppShell();

  const [activeTab, setActiveTab] = useState<TabId>(() => tabFromSearch(searchParams.get('tab')));
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>('all');
  const [interviewFilter, setInterviewFilter] = useState<InterviewStatus | undefined>(undefined);
  const [prdFilter, setPrdFilter] = useState<PrdStatus | undefined>(undefined);
  const [designFilter, setDesignFilter] = useState<DesignStatusFilter | undefined>(undefined);
  const [interviewSearch, setInterviewSearch] = useState('');
  const [prdSearch, setPrdSearch] = useState('');
  const [designSearch, setDesignSearch] = useState('');
  const [openDesignPrds, setOpenDesignPrds] = useState<Set<string>>(() => new Set());

  const [pendingDeleteInterview, setPendingDeleteInterview] = useState<InterviewSummary | null>(null);
  const [pendingDeletePrd, setPendingDeletePrd] = useState<PrdSummary | null>(null);
  const [pendingDeleteDesignDoc, setPendingDeleteDesignDoc] = useState<DesignDocSummary | null>(null);
  const [pendingDeletePrototype, setPendingDeletePrototype] = useState<DesignPrototypeSummary | null>(null);

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
    ...(selectedProject ? { project: selectedProject } : {}),
    ...(authorParam ? { author: authorParam } : {}),
  });
  const { data: designDocs = [], isLoading: docLoading } = useDesignDocList({
    ...(selectedProject ? { project: selectedProject } : {}),
    ...(authorParam ? { author: authorParam } : {}),
  });

  const { data: skillConfig } = useProjectSkillConfig(selectedProject || null);
  const interviewSkillOptions = skillConfig?.interviewSkillOptions ?? [];
  const prototypeEnabled = interviewSkillOptions.length > 0
    ? interviewSkillOptions.some((o) => o.wantsDesignPrototype !== false)
    : skillConfig?.prototypeStageEnabled !== false;

  const canManage = can('interviews:manage');
  const canStartInterview = permissionsLoaded && canManage && isInAnyGroup(['BA', 'Manager', 'Product-Owner']);

  const filteredInterviews = interviewSearch.trim()
    ? interviews.filter((iv) => iv.title.toLowerCase().includes(interviewSearch.toLowerCase()))
    : interviews;

  const filteredPrds = prdSearch.trim()
    ? prds.filter((prd) => prd.title.toLowerCase().includes(prdSearch.toLowerCase()))
    : prds;

  const visiblePrototypes = prototypeEnabled ? prototypes : [];

  const designGroups = useMemo(
    () => groupDesignsByPrd(designDocs, visiblePrototypes)
      .map((group) => filterDesignGroup(group, designSearch, designFilter))
      .filter((group): group is DesignPrdGroup => group !== null),
    [designDocs, visiblePrototypes, designSearch, designFilter],
  );

  const singleGroupId = designGroups.length === 1 ? designGroups[0].prdId : null;
  useEffect(() => {
    if (!singleGroupId) return;
    setOpenDesignPrds((prev) => {
      if (prev.has(singleGroupId)) return prev;
      const next = new Set(prev);
      next.add(singleGroupId);
      return next;
    });
  }, [singleGroupId]);

  const isDesignGroupOpen = (prdId: string): boolean => openDesignPrds.has(prdId);
  const toggleDesignGroup = (prdId: string) => {
    setOpenDesignPrds((prev) => {
      const next = new Set(prev);
      if (next.has(prdId)) next.delete(prdId);
      else next.add(prdId);
      return next;
    });
  };

  return (
    <div className={styles.dashboard} {...{ 'data-testid': 'interviews-dashboard' }}>
      <div className={styles.header}>
        <h1 className={styles.heading}>Interviews & PRDs</h1>
        {canManage && (
          <div className={styles.startButtonWrap} title={!canStartInterview ? 'You must be a member of the BA, Manager, or Product-Owner group to start an interview.' : undefined}>
            <button
              className={styles.startButton}
              onClick={() => navigate('/backlog/interview/new')}
              type="button"
              disabled={!canStartInterview}
              {...{ 'data-testid': 'start-interview-btn' }}
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
          {...{ 'data-testid': 'tab-interviews' }}
        >
          Interviews ({interviews.length})
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'prds' ? styles.active : ''}`}
          onClick={() => setActiveTab('prds')}
          type="button"
          {...{ 'data-testid': 'tab-prds' }}
        >
          PRDs ({prds.length})
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'designs' ? styles.active : ''}`}
          onClick={() => setActiveTab('designs')}
          type="button"
          {...{ 'data-testid': 'tab-designs' }}
        >
          Designs ({designGroups.length})
        </button>
      </div>

      <div className={styles.ownerFilters}>
        <button
          className={`${styles.ownerPill} ${ownerFilter === 'all' ? styles.active : ''}`}
          onClick={() => setOwnerFilter('all')}
          type="button"
          {...{ 'data-testid': 'owner-filter-all' }}
        >
          All
        </button>
        <button
          className={`${styles.ownerPill} ${ownerFilter === 'mine' ? styles.active : ''}`}
          onClick={() => setOwnerFilter('mine')}
          type="button"
          {...{ 'data-testid': 'owner-filter-mine' }}
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
                  {...{ 'data-testid': `interview-filter-${(f.value ?? 'all').replace(/_/g, '-')}` }}
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
                {...{ 'data-testid': 'interview-search' }}
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
                  {...{ 'data-testid': 'interview-card' }}
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
                  {...{ 'data-testid': `prd-filter-${(f.value ?? 'all').replace(/_/g, '-')}` }}
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
                {...{ 'data-testid': 'prd-search' }}
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
                  {...{ 'data-testid': 'prd-card' }}
                />
              ))}
            </div>
          )}
        </>
      )}

      {activeTab === 'designs' && (
        <>
          <div className={styles.filtersRow}>
            <div className={styles.filters}>
              {DESIGN_FILTERS.map((f) => (
                <button
                  key={f.label}
                  className={`${styles.filterPill} ${designFilter === f.value ? styles.active : ''}`}
                  onClick={() => setDesignFilter(f.value)}
                  type="button"
                  {...{ 'data-testid': `design-filter-${(f.value ?? 'all').replace(/_/g, '-')}` }}
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
                placeholder="Search designs…"
                value={designSearch}
                onChange={(e) => setDesignSearch(e.target.value)}
                {...{ 'data-testid': 'design-search' }}
              />
            </div>
          </div>
          {docLoading || protoLoading ? (
            <div className={styles.emptyState}>Loading…</div>
          ) : designGroups.length === 0 ? (
            <div className={styles.emptyState}>
              {designSearch.trim() ? (
                <p className={styles.emptyStateText}>No designs match &ldquo;{designSearch}&rdquo;</p>
              ) : (
                <>
                  <div className={styles.emptyStateIconWrap}>
                    <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="6" y="2" width="28" height="36" rx="3" />
                      <line x1="12" x2="28" y1="11" y2="11" />
                      <line x1="12" x2="28" y1="18" y2="18" />
                      <line x1="12" x2="20" y1="25" y2="25" />
                    </svg>
                  </div>
                  <p className={styles.emptyStateText}>
                    No designs yet. Generate a prototype or design doc from an approved PRD.
                  </p>
                </>
              )}
            </div>
          ) : (
            <div className={styles.groupList}>
              {designGroups.map((group) => (
                <DesignPrdGroupCard
                  key={group.prdId}
                  group={group}
                  expanded={isDesignGroupOpen(group.prdId)}
                  onToggle={() => toggleDesignGroup(group.prdId)}
                  canDelete={canManage}
                  onDeleteDoc={setPendingDeleteDesignDoc}
                  onDeletePrototype={setPendingDeletePrototype}
                />
              ))}
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
          {...{ 'data-testid': 'delete-interview-modal' }}
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
          {...{ 'data-testid': 'delete-prd-modal' }}
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
          {...{ 'data-testid': 'delete-design-doc-modal' }}
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
          {...{ 'data-testid': 'delete-prototype-modal' }}
          onConfirm={() => {
            deletePrototype.mutate(pendingDeletePrototype.id, {
              onSuccess: () => setPendingDeletePrototype(null),
            });
          }}
          onCancel={() => setPendingDeletePrototype(null)}
        />
      )}
    </div>
  );
};

export default InterviewsDashboard;

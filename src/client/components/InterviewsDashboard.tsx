import React, { useState } from 'react';
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
import type {
  InterviewStatus,
  PrdStatus,
  DesignDocStatus,
  InterviewSummary,
  PrdSummary,
  DesignDocSummary,
} from '../../shared/types/interview';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import styles from './InterviewsDashboard.module.css';

type TabId = 'interviews' | 'prds' | 'design-docs';

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
  { label: 'Rejected', value: 'rejected' },
  { label: 'Revision Requested', value: 'revision_requested' },
];

const DESIGN_DOC_FILTERS: { label: string; value: DesignDocStatus | undefined }[] = [
  { label: 'All', value: undefined },
  { label: 'Interviewing', value: 'interviewing' },
  { label: 'Draft', value: 'draft' },
  { label: 'Pending Review', value: 'pending_review' },
  { label: 'Approved', value: 'approved' },
  { label: 'Rejected', value: 'rejected' },
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

function prdBadgeClass(status: PrdStatus): string {
  switch (status) {
    case 'generating': return styles.badgeGenerating;
    case 'draft': return styles.badgeDraft;
    case 'pending_review': return styles.badgePendingReview;
    case 'approved': return styles.badgeApproved;
    case 'rejected': return styles.badgeRejected;
    case 'revision_requested': return styles.badgeRevisionRequested;
  }
}

function prdStatusLabel(status: PrdStatus): string {
  switch (status) {
    case 'generating': return 'Generating…';
    case 'draft': return 'Draft';
    case 'pending_review': return 'Pending Review';
    case 'approved': return 'Approved';
    case 'rejected': return 'Rejected';
    case 'revision_requested': return 'Revision Requested';
  }
}

function designDocBadgeClass(status: DesignDocStatus): string {
  switch (status) {
    case 'interviewing': return styles.badgeInterviewing;
    case 'generating': return styles.badgeGenerating;
    case 'draft': return styles.badgeDraft;
    case 'pending_review': return styles.badgePendingReview;
    case 'approved': return styles.badgeApproved;
    case 'rejected': return styles.badgeRejected;
    case 'revision_requested': return styles.badgeRevisionRequested;
  }
}

function designDocStatusLabel(status: DesignDocStatus): string {
  switch (status) {
    case 'interviewing': return 'Interviewing';
    case 'generating': return 'Generating…';
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
        <span className={`${styles.badge} ${prdBadgeClass(prd.status)}`}>
          {prdStatusLabel(prd.status)}
        </span>
        <div className={styles.cardFooterRight}>
          {prd.reviewerId && (
            <span className={styles.cardPrdBadge}>Reviewer assigned</span>
          )}
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

export const InterviewsDashboard: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { can, selectedProject } = useAppShell();

  const rawTab = searchParams.get('tab');
  const initialTab: TabId =
    rawTab === 'prds' ? 'prds' :
    rawTab === 'design-docs' ? 'design-docs' :
    'interviews';

  const [activeTab, setActiveTab] = useState<TabId>(initialTab);
  const [interviewFilter, setInterviewFilter] = useState<InterviewStatus | undefined>(undefined);
  const [prdFilter, setPrdFilter] = useState<PrdStatus | undefined>(undefined);
  const [designDocFilter, setDesignDocFilter] = useState<DesignDocStatus | undefined>(undefined);
  const [interviewSearch, setInterviewSearch] = useState('');
  const [prdSearch, setPrdSearch] = useState('');
  const [designDocSearch, setDesignDocSearch] = useState('');

  const [pendingDeleteInterview, setPendingDeleteInterview] = useState<InterviewSummary | null>(null);
  const [pendingDeletePrd, setPendingDeletePrd] = useState<PrdSummary | null>(null);
  const [pendingDeleteDesignDoc, setPendingDeleteDesignDoc] = useState<DesignDocSummary | null>(null);

  const deleteInterview = useDeleteInterview();
  const deletePrd = useDeletePrd();
  const deleteDesignDoc = useDeleteDesignDoc();

  const { data: interviews = [], isLoading: ivLoading } = useInterviewList({
    ...(interviewFilter ? { status: interviewFilter } : {}),
    ...(selectedProject ? { project: selectedProject } : {}),
  });
  const { data: prds = [], isLoading: prdLoading } = usePrdList({
    ...(prdFilter ? { status: prdFilter } : {}),
    ...(selectedProject ? { project: selectedProject } : {}),
  });
  const { data: designDocs = [], isLoading: docLoading } = useDesignDocList({
    ...(designDocFilter ? { status: designDocFilter } : {}),
    ...(selectedProject ? { project: selectedProject } : {}),
  });

  const canManage = can('interviews:manage');

  const filteredInterviews = interviewSearch.trim()
    ? interviews.filter((iv) => iv.title.toLowerCase().includes(interviewSearch.toLowerCase()))
    : interviews;

  const filteredPrds = prdSearch.trim()
    ? prds.filter((prd) => prd.title.toLowerCase().includes(prdSearch.toLowerCase()))
    : prds;

  const filteredDesignDocs = designDocSearch.trim()
    ? designDocs.filter((doc) => doc.title.toLowerCase().includes(designDocSearch.toLowerCase()))
    : designDocs;

  return (
    <div className={styles.dashboard}>
      <div className={styles.header}>
        <h1 className={styles.heading}>Interviews & PRDs</h1>
        {canManage && (
          <button className={styles.startButton} onClick={() => navigate('/backlog/interview/new')} type="button">
            + Start New Interview
          </button>
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
          className={`${styles.tab} ${activeTab === 'design-docs' ? styles.active : ''}`}
          onClick={() => setActiveTab('design-docs')}
          type="button"
        >
          Design Docs ({designDocs.length})
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
                  <p className={styles.emptyStateText}>No interviews yet.{can('interviews:manage') ? ' Start one above.' : ''}</p>
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
              {filteredDesignDocs.map((doc) => (
                <DesignDocCard
                  key={doc.id}
                  doc={doc}
                  canDelete={canManage}
                  onDelete={setPendingDeleteDesignDoc}
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
    </div>
  );
};

export default InterviewsDashboard;

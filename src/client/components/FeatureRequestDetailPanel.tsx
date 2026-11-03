import React, { useEffect, useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppShell } from '../hooks/useAppShell';
import { ApexGenerateWorkItemsWizard } from './ApexGenerateWorkItemsWizard';
import type {
  FeatureRequest,
  FeatureRequestStatus,
  FeatureRequestPriority,
  FeatureRequestRisk,
} from '../../shared/types/featureRequest';
import type { WorkItemOwnerSummary } from '../../shared/types/apexWorkItem';
import {
  FEATURE_REQUEST_STATUSES,
  FEATURE_REQUEST_PRIORITIES,
  FEATURE_REQUEST_RISKS,
} from '../../shared/types/featureRequest';
import {
  isInterviewableWorkItemType,
  toFeatureRequestInterviewPrefill,
} from '../utils/featureRequestInterview';
import { MarkdownWithMermaid } from './MarkdownWithMermaid';
import listStyles from './FeatureRequestsView.module.css';
import styles from './FeatureRequestDetailPanel.module.css';

const DEFAULT_DRAWER_WIDTH = 560;
const MIN_DRAWER_WIDTH = 360;
const MAX_DRAWER_WIDTH = 1200;
const RESIZE_STEP = 32;

const STATUS_LABELS: Record<FeatureRequestStatus, string> = {
  new: 'New',
  'under-review': 'Under Review',
  'in-interview': 'In Interview',
  planned: 'Planned',
  declined: 'Declined',
  done: 'Done',
};

function priorityBadgeClass(p: FeatureRequestPriority): string {
  const map: Record<FeatureRequestPriority, string> = {
    critical: listStyles['priorityCritical'],
    high: listStyles['priorityHigh'],
    medium: listStyles['priorityMedium'],
    low: listStyles['priorityLow'],
  };
  return `${listStyles['badge']} ${map[p]}`;
}

function riskBadgeClass(r: FeatureRequestRisk): string {
  const map: Record<FeatureRequestRisk, string> = {
    high: listStyles['riskHigh'],
    medium: listStyles['riskMedium'],
    low: listStyles['riskLow'],
  };
  return `${listStyles['badge']} ${map[r]}`;
}

function aiStatusBadgeClass(s: string): string {
  const map: Record<string, string> = {
    pending: listStyles['aiStatusPending'],
    analyzing: listStyles['aiStatusAnalyzing'],
    complete: listStyles['aiStatusComplete'],
    failed: listStyles['aiStatusFailed'],
  };
  return `${listStyles['badge']} ${map[s] ?? listStyles['aiStatusPending']}`;
}

function statusBadgeClass(s: FeatureRequestStatus): string {
  const map: Record<FeatureRequestStatus, string> = {
    new: listStyles['statusNew'],
    'under-review': listStyles['statusUnderReview'],
    'in-interview': listStyles['statusInInterview'],
    planned: listStyles['statusPlanned'],
    declined: listStyles['statusDeclined'],
    done: listStyles['statusDone'],
  };
  return `${listStyles['statusBadge']} ${map[s]}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

interface FeatureRequestDetailPanelProps {
  fr: FeatureRequest;
  canManage: boolean;
  assignees: WorkItemOwnerSummary[];
  onClose: () => void;
  onUpdate: (
    id: string,
    patch: Partial<{
      status: FeatureRequestStatus;
      teamPriority: FeatureRequestPriority | null;
      teamRisk: FeatureRequestRisk | null;
      rank: number | null;
      assigneeId: string | null;
    }>,
  ) => void;
  onReanalyze: (id: string) => void;
  isReanalyzing: boolean;
}

export const FeatureRequestDetailPanel: React.FC<FeatureRequestDetailPanelProps> = ({
  fr,
  canManage,
  assignees,
  onClose,
  onUpdate,
  onReanalyze,
  isReanalyzing,
}) => {
  const [showGenerateWizard, setShowGenerateWizard] = useState(false);
  const [drawerWidth, setDrawerWidth] = useState(DEFAULT_DRAWER_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(DEFAULT_DRAWER_WIDTH);
  const resizeJustEndedRef = useRef(false);

  const handleClose = useCallback(() => onClose(), [onClose]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (resizeJustEndedRef.current) {
        resizeJustEndedRef.current = false;
        return;
      }
      if (e.target === e.currentTarget) handleClose();
    },
    [handleClose],
  );

  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragStartXRef.current = e.clientX;
      dragStartWidthRef.current = drawerWidth;
      setIsResizing(true);
    },
    [drawerWidth],
  );

  const handleResizeKeyDown = useCallback((e: React.KeyboardEvent) => {
    const maxAllowed = Math.min(
      MAX_DRAWER_WIDTH,
      Math.floor((typeof window !== 'undefined' ? window.innerWidth : MAX_DRAWER_WIDTH) * 0.9),
    );
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setDrawerWidth((w) => Math.min(maxAllowed, w + RESIZE_STEP));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setDrawerWidth((w) => Math.max(MIN_DRAWER_WIDTH, w - RESIZE_STEP));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setDrawerWidth(maxAllowed);
    } else if (e.key === 'End') {
      e.preventDefault();
      setDrawerWidth(MIN_DRAWER_WIDTH);
    }
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [handleClose]);

  useEffect(() => {
    if (!isResizing) return;
    const onMouseMove = (e: MouseEvent) => {
      const delta = dragStartXRef.current - e.clientX;
      const maxAllowed = Math.min(
        MAX_DRAWER_WIDTH,
        Math.floor(window.innerWidth * 0.9),
      );
      const next = Math.min(
        maxAllowed,
        Math.max(MIN_DRAWER_WIDTH, dragStartWidthRef.current + delta),
      );
      setDrawerWidth(next);
    };
    const onMouseUp = () => {
      resizeJustEndedRef.current = true;
      setIsResizing(false);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  const navigate = useNavigate();
  const { can, isSuperAdmin, isInAnyGroup, permissionsLoaded, selectedProject, workBoardEnabled } = useAppShell();
  const canKickOff = permissionsLoaded
    && can('interviews:manage')
    && isInAnyGroup(['BA', 'Manager', 'Product-Owner']);

  return (
    <>
      <div
        className={styles['overlay']}
        onClick={handleOverlayClick}
        aria-hidden="true"
       {...{ 'data-testid': 'feature-request-detail-overlay' }} />
      <aside
        className={`${styles['drawer']}${isResizing ? ` ${styles['drawerResizing']}` : ''}`}
        style={{ width: `${drawerWidth}px` }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="fr-detail-title"
       {...{ 'data-testid': 'feature-request-detail-drawer' }}>
        {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- WAI-ARIA separator resize handle */}
        <div
          className={styles['resizeHandle']}
          onMouseDown={handleResizeMouseDown}
          onKeyDown={handleResizeKeyDown}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize details panel"
          aria-valuemin={MIN_DRAWER_WIDTH}
          aria-valuemax={MAX_DRAWER_WIDTH}
          aria-valuenow={drawerWidth}
          tabIndex={0}
          {...{ 'data-testid': 'feature-request-detail-resize-handle' }}
        />
        {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
        <header className={styles['header']}>
          <div className={styles['headerLeft']}>
            <h2 className={styles['title']} id="fr-detail-title">
              {fr.title}
            </h2>
            <p className={styles['meta']}>
              {fr.submitterName ?? 'Unknown'} · {fr.sourceProject} · {formatDate(fr.createdAt)}
            </p>
          </div>
          <button className={styles['closeBtn']} type="button" onClick={handleClose} aria-label="Close" {...{ 'data-testid': 'feature-request-detail-close-btn' }}>
            ×
          </button>
        </header>

        <div className={styles['body']}>
          <section className={styles['section']}>
            <h3 className={styles['sectionTitle']}>Description</h3>
            <div className={styles['prose']} {...{ 'data-testid': 'feature-request-detail-description' }}>
              {/* data-testid-exempt — MarkdownWithMermaid renders inside feature-request-detail-description */}
              <MarkdownWithMermaid content={fr.request} skipHtml />
            </div>
          </section>

          <section className={styles['section']}>
            <h3 className={styles['sectionTitle']}>Advantage</h3>
            <div className={styles['prose']} {...{ 'data-testid': 'feature-request-detail-advantage' }}>
              {fr.advantage ? (
                /* data-testid-exempt — MarkdownWithMermaid renders inside feature-request-detail-advantage */
                <MarkdownWithMermaid content={fr.advantage} skipHtml />
              ) : null}
            </div>
          </section>

          {(fr.linkedAdrs?.length ?? 0) > 0 && (
            <section className={styles['section']}>
              <h3 className={styles['sectionTitle']}>Linked ADRs</h3>
              <div className={styles['adrChips']}>
                {fr.linkedAdrs.map((adr) => (
                  <button
                    className={styles['adrChip']}
                    key={adr.id}
                    type="button"
                    onClick={() => navigate(`/adr/${adr.id}`)}
                    title={`${adr.repo} / ${adr.slug ?? adr.id}`}
                   {...{ 'data-testid': `feature-request-detail-adr-chip-${adr.id}` }}>
                    {adr.title}
                  </button>
                ))}
              </div>
            </section>
          )}

          {isInterviewableWorkItemType(fr.type) && fr.interviewId && (
            <section className={styles['section']}>
              <h3 className={styles['sectionTitle']}>Interview</h3>
              <button
                className={styles['secondaryAction']}
                type="button"
                onClick={() => navigate(`/backlog/interview/${fr.interviewId}`)}
               {...{ 'data-testid': 'feature-request-detail-secondary-action-btn' }}>
                View Interview
              </button>
            </section>
          )}

          <section className={styles['section']}>
            <h3 className={styles['sectionTitle']}>Status</h3>
            {canManage ? (
              <select
                className={listStyles['controlSelect']}
                value={fr.status}
                onChange={(e) => onUpdate(fr.id, { status: e.target.value as FeatureRequestStatus })}
               {...{ 'data-testid': 'feature-request-detail-select' }}>
                {FEATURE_REQUEST_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            ) : (
              <span className={statusBadgeClass(fr.status)}>{STATUS_LABELS[fr.status]}</span>
            )}
          </section>

          <section className={styles['section']}>
            <h3 className={styles['sectionTitle']}>Assignee</h3>
            {canManage ? (
              <select
                className={listStyles['controlSelect']}
                value={fr.assignedTo?.oid ?? ''}
                onChange={(event) =>
                  onUpdate(fr.id, {
                    assigneeId: event.target.value || null,
                  })
                }
                data-testid="feature-request-detail-assignee"
              >
                <option value="">Unassigned</option>
                {assignees.map((assignee) => (
                  <option key={assignee.oid} value={assignee.oid}>
                    {assignee.displayName}
                  </option>
                ))}
              </select>
            ) : (
              <span data-testid="feature-request-detail-assignee-label">
                {fr.assignedTo?.displayName ?? 'Unassigned'}
              </span>
            )}
          </section>

          <section className={styles['section']}>
            <h3 className={styles['sectionTitle']}>AI Analysis</h3>
            <div className={listStyles['aiBadges']}>
              {fr.aiStatus === 'analyzing' && <span className={listStyles['spinner']} />}
              <span className={aiStatusBadgeClass(fr.aiStatus)}>{fr.aiStatus}</span>
              {fr.aiPriority && (
                <span className={priorityBadgeClass(fr.aiPriority)}>Priority: {fr.aiPriority}</span>
              )}
              {fr.aiRisk && <span className={riskBadgeClass(fr.aiRisk)}>Risk: {fr.aiRisk}</span>}
            </div>
            {fr.aiRationale && <p className={styles['rationale']}>{fr.aiRationale}</p>}
          </section>

          <section className={styles['section']}>
            <h3 className={styles['sectionTitle']}>Team Override</h3>
            {canManage ? (
              <div className={styles['overrideControls']}>
                <label className={styles['controlLabel']}>
                  Priority
                  <select
                    className={listStyles['controlSelect']}
                    value={fr.teamPriority ?? ''}
                    onChange={(e) =>
                      onUpdate(fr.id, {
                        teamPriority: (e.target.value || null) as FeatureRequestPriority | null,
                      })
                    }
                   {...{ 'data-testid': 'feature-request-detail-select-2' }}>
                    <option value="">Use AI suggestion</option>
                    {FEATURE_REQUEST_PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={styles['controlLabel']}>
                  Risk
                  <select
                    className={listStyles['controlSelect']}
                    value={fr.teamRisk ?? ''}
                    onChange={(e) =>
                      onUpdate(fr.id, {
                        teamRisk: (e.target.value || null) as FeatureRequestRisk | null,
                      })
                    }
                   {...{ 'data-testid': 'feature-request-detail-select-3' }}>
                    <option value="">Use AI suggestion</option>
                    {FEATURE_REQUEST_RISKS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ) : (
              <div className={listStyles['aiBadges']}>
                {fr.teamPriority && (
                  <span className={priorityBadgeClass(fr.teamPriority)}>{fr.teamPriority}</span>
                )}
                {fr.teamRisk && <span className={riskBadgeClass(fr.teamRisk)}>{fr.teamRisk}</span>}
                {!fr.teamPriority && !fr.teamRisk && (
                  <span className={styles['muted']}>No team override</span>
                )}
              </div>
            )}
          </section>

          {fr.rank != null && (
            <section className={styles['section']}>
              <h3 className={styles['sectionTitle']}>Rank</h3>
              <span className={styles['rankValue']}>#{fr.rank}</span>
            </section>
          )}
        </div>

        {(canManage || (isInterviewableWorkItemType(fr.type) && canKickOff && !fr.interviewId)) && (
          <footer className={styles['footer']}>
            {canManage && (
              <button
                className={listStyles['reanalyzeBtn']}
                type="button"
                disabled={isReanalyzing || fr.aiStatus === 'analyzing'}
                onClick={() => onReanalyze(fr.id)}
               {...{ 'data-testid': 'feature-request-detail-button-btn' }}>
                {fr.aiStatus === 'analyzing' ? 'Analyzing…' : 'Re-analyze'}
              </button>
            )}
            {workBoardEnabled && isSuperAdmin && fr.status !== 'declined' && (
              <button
                className={styles['secondaryAction']}
                type="button"
                onClick={() => setShowGenerateWizard(true)}
               {...{ 'data-testid': 'feature-request-detail-secondary-action-btn-2' }}>
                Generate Work Items
              </button>
            )}
            {isInterviewableWorkItemType(fr.type) && canKickOff && !fr.interviewId && (
              <button
                className={styles['primaryAction']}
                type="button"
                onClick={() => navigate('/backlog/interview/new', {
                  state: {
                    featureRequest: toFeatureRequestInterviewPrefill(fr),
                  },
                })}
               {...{ 'data-testid': 'feature-request-detail-primary-action-btn' }}>
                Kick Off Interview
              </button>
            )}
          </footer>
        )}
      </aside>
      {showGenerateWizard && (
        <ApexGenerateWorkItemsWizard
          featureRequest={fr}
          project={selectedProject || fr.sourceProject || 'Apex'}
          onClose={() => setShowGenerateWizard(false)}
        />
      )}
    </>
  );
};

export default FeatureRequestDetailPanel;

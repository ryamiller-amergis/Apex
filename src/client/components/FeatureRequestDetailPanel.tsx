import React, { useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppShell } from '../hooks/useAppShell';
import type {
  FeatureRequest,
  FeatureRequestStatus,
  FeatureRequestPriority,
  FeatureRequestRisk,
} from '../../shared/types/featureRequest';
import {
  FEATURE_REQUEST_STATUSES,
  FEATURE_REQUEST_PRIORITIES,
  FEATURE_REQUEST_RISKS,
} from '../../shared/types/featureRequest';
import listStyles from './FeatureRequestsView.module.css';
import styles from './FeatureRequestDetailPanel.module.css';

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

function formatBody(text: string): React.ReactNode {
  return text.split('\n').map((line, i) => (
    <p key={i} className={line.trim() === '' ? styles['paraSpacer'] : undefined}>
      {line || '\u00A0'}
    </p>
  ));
}

interface FeatureRequestDetailPanelProps {
  fr: FeatureRequest;
  canManage: boolean;
  onClose: () => void;
  onUpdate: (
    id: string,
    patch: Partial<{
      status: FeatureRequestStatus;
      teamPriority: FeatureRequestPriority | null;
      teamRisk: FeatureRequestRisk | null;
      rank: number | null;
    }>,
  ) => void;
  onReanalyze: (id: string) => void;
  isReanalyzing: boolean;
}

export const FeatureRequestDetailPanel: React.FC<FeatureRequestDetailPanelProps> = ({
  fr,
  canManage,
  onClose,
  onUpdate,
  onReanalyze,
  isReanalyzing,
}) => {
  const navigate = useNavigate();
  const { can, isInAnyGroup, permissionsLoaded } = useAppShell();
  const canKickOff = permissionsLoaded
    && can('interviews:manage')
    && isInAnyGroup(['BA', 'Manager', 'Product-Owner']);
  const handleClose = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [handleClose]);

  return (
    <>
      <div
        className={styles['overlay']}
        onClick={(e) => {
          if (e.target === e.currentTarget) handleClose();
        }}
        aria-hidden="true"
      />
      <aside
        className={styles['drawer']}
        role="dialog"
        aria-modal="true"
        aria-labelledby="fr-detail-title"
      >
        <header className={styles['header']}>
          <div className={styles['headerLeft']}>
            <h2 className={styles['title']} id="fr-detail-title">
              {fr.title}
            </h2>
            <p className={styles['meta']}>
              {fr.submitterName ?? 'Unknown'} · {fr.sourceProject} · {formatDate(fr.createdAt)}
            </p>
          </div>
          <button className={styles['closeBtn']} type="button" onClick={handleClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className={styles['body']}>
          <section className={styles['section']}>
            <h3 className={styles['sectionTitle']}>Request</h3>
            <div className={styles['prose']}>{formatBody(fr.request)}</div>
          </section>

          <section className={styles['section']}>
            <h3 className={styles['sectionTitle']}>Advantage</h3>
            <div className={styles['prose']}>{formatBody(fr.advantage)}</div>
          </section>

          {fr.interviewId && (
            <section className={styles['section']}>
              <h3 className={styles['sectionTitle']}>Interview</h3>
              <button
                className={styles['secondaryAction']}
                type="button"
                onClick={() => navigate(`/backlog/interview/${fr.interviewId}`)}
              >
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
              >
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
                  >
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
                  >
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

        {(canManage || (canKickOff && !fr.interviewId)) && (
          <footer className={styles['footer']}>
            {canManage && (
              <button
                className={listStyles['reanalyzeBtn']}
                type="button"
                disabled={isReanalyzing || fr.aiStatus === 'analyzing'}
                onClick={() => onReanalyze(fr.id)}
              >
                {fr.aiStatus === 'analyzing' ? 'Analyzing…' : 'Re-analyze'}
              </button>
            )}
            {canKickOff && !fr.interviewId && (
              <button
                className={styles['primaryAction']}
                type="button"
                onClick={() => navigate('/backlog/interview/new', {
                  state: {
                    featureRequest: {
                      id: fr.id,
                      title: fr.title,
                      request: fr.request,
                      advantage: fr.advantage,
                    },
                  },
                })}
              >
                Kick Off Interview
              </button>
            )}
          </footer>
        )}
      </aside>
    </>
  );
};

export default FeatureRequestDetailPanel;

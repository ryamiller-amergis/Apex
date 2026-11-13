import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAppShell } from '../hooks/useAppShell';
import {
  useApplyStandupProposal,
  useDismissStandupProposal,
  useStandupSessionDetail,
  useStandupSessionsList,
} from '../hooks/useStandupDeliveryPulse';
import {
  STANDUP_DELIVERY_MODEL_LABELS,
  type StandupActionProposal,
  type StandupOverallHealth,
} from '../../shared/types/standup';
import styles from './StandupSummaryView.module.css';

function shortUserLabel(userId: string, displayName?: string | null): string {
  if (displayName?.trim()) return displayName.trim();
  if (userId.length <= 12) return userId;
  return `${userId.slice(0, 8)}…`;
}

function healthLabel(health: StandupOverallHealth): string {
  if (health === 'at_risk') return 'At Risk';
  if (health === 'watch') return 'Watch';
  return 'On Track';
}

const StandupSubNav: React.FC = () => {
  const navigate = useNavigate();
  const { can } = useAppShell();
  return (
    <div className={styles.subNav}>
      <button
        type="button"
        className={styles.subNavBtn}
        onClick={() => navigate('/standup')}
        {...{ 'data-testid': 'standup-summary-sub-nav-btn' }}
      >
        My Standup
      </button>
      <button
        type="button"
        className={`${styles.subNavBtn} ${styles.subNavActive}`}
        onClick={() => navigate('/standup-summary')}
        {...{ 'data-testid': 'standup-summary-sub-nav-btn-2' }}
      >
        Summary
      </button>
      {can('standup:manage') && (
        <button
          type="button"
          className={styles.subNavBtn}
          onClick={() => navigate('/standup-manage')}
          {...{ 'data-testid': 'standup-summary-sub-nav-btn-3' }}
        >
          Manage
        </button>
      )}
    </div>
  );
};

export const StandupSummaryView: React.FC = () => {
  const [nameByOid, setNameByOid] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  const [searchParams, setSearchParams] = useSearchParams();
  const id = searchParams.get('session');
  const { can, selectedProject } = useAppShell();

  const {
    data: session,
    isLoading: loading,
  } = useStandupSessionDetail(id, selectedProject);
  const { data: recentSessions = [] } = useStandupSessionsList(selectedProject);
  const applyProposalMutation = useApplyStandupProposal();
  const dismissProposalMutation = useDismissStandupProposal();

  const handleSelectSession = useCallback(
    (nextId: string) => {
      if (!nextId) return;
      setSearchParams({ session: nextId });
    },
    [setSearchParams],
  );

  const handleApplyProposal = useCallback(
    async (proposal: StandupActionProposal) => {
      setActionError(null);
      try {
        await applyProposalMutation.mutateAsync({ proposal });
      } catch (err) {
        setActionError((err as Error).message);
      }
    },
    [applyProposalMutation],
  );

  const handleDismissProposal = useCallback(
    async (proposalId: string) => {
      setActionError(null);
      try {
        await dismissProposalMutation.mutateAsync({ proposalId });
      } catch (err) {
        setActionError((err as Error).message);
      }
    },
    [dismissProposalMutation],
  );

  useEffect(() => {
    if (!session) return;
    const missingOids = [
      ...new Set(
        session.participants
          .filter((p) => !p.displayName && p.userId)
          .map((p) => p.userId),
      ),
    ];
    if (missingOids.length === 0) return;

    let cancelled = false;
    void Promise.all(
      missingOids.map(async (oid) => {
        try {
          const res = await fetch(
            `/api/profile/users/${encodeURIComponent(oid)}/card`,
            { credentials: 'include' },
          );
          if (!res.ok) return [oid, ''] as const;
          const card = (await res.json()) as { displayName?: string };
          return [oid, card.displayName?.trim() ?? ''] as const;
        } catch {
          return [oid, ''] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const map: Record<string, string> = {};
      for (const [oid, name] of entries) {
        if (name) map[oid] = name;
      }
      setNameByOid(map);
    });

    return () => {
      cancelled = true;
    };
  }, [session]);

  if (loading) {
    return (
      <div className={styles.container}>
        <StandupSubNav />
        <div className={styles.stateMessage}>Loading session...</div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className={styles.container}>
        <StandupSubNav />
        <div className={styles.stateMessage}>
          {id ? 'Session not found.' : 'No standup sessions yet for this project.'}
        </div>
      </div>
    );
  }

  const pulse = session.teamPulse;
  const deliveryModel =
    pulse?.deliveryModel ?? session.config?.deliveryModel ?? 'flow';
  const deliveryModelLabel =
    STANDUP_DELIVERY_MODEL_LABELS[deliveryModel] ?? 'Flow';
  const overallHealth = pulse?.overallHealth ?? 'on_track';
  const teamGoal = pulse?.teamGoal ?? session.config?.teamGoal ?? null;
  const proposals = session.proposals ?? [];
  const pendingProposals = proposals.filter((p) => p.status === 'pending');
  const decidedProposals = proposals.filter((p) => p.status !== 'pending');
  const canWriteWorkItems = can('workitems:write');

  return (
    <div className={styles.container}>
      <StandupSubNav />
      <div className={styles.content}>
        <header className={styles.header}>
          <div className={styles.headerLeft}>
            <h1>Standup Summary</h1>
            <span className={styles.date}>{session.sessionDate}</span>
            <span className={`${styles.status} ${styles[session.status] ?? ''}`}>
              {session.status}
            </span>
            <span
              className={styles.modelBadge}
              {...{ 'data-testid': 'pulse-delivery-model' }}
            >
              {deliveryModelLabel}
            </span>
            <span
              className={`${styles.healthBadge} ${
                overallHealth === 'at_risk'
                  ? styles.healthAtRisk
                  : overallHealth === 'watch'
                  ? styles.healthWatch
                  : styles.healthOnTrack
              }`}
              {...{ 'data-testid': 'pulse-overall-health' }}
            >
              {healthLabel(overallHealth)}
            </span>
          </div>

          {recentSessions.length > 0 && (
            <label className={styles.sessionSwitcherLabel} htmlFor="pulse-session-select">
              Session
              <select
                id="pulse-session-select"
                className={styles.sessionSelect}
                value={session.id}
                onChange={(e) => handleSelectSession(e.target.value)}
                {...{ 'data-testid': 'pulse-session-selector' }}
              >
                {recentSessions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.sessionDate} ({item.status})
                  </option>
                ))}
              </select>
            </label>
          )}
        </header>

        <div
          className={styles.goalBanner}
          {...{ 'data-testid': 'pulse-team-goal' }}
        >
          <div className={styles.goalRow}>
            <span className={styles.goalTag}>Team Goal</span>
            <span className={styles.goalTitle}>
              {teamGoal ?? 'Maintain steady flow and unblock active work'}
            </span>
          </div>
          {pulse?.goalProgressSummary && (
            <div className={styles.goalSummary}>{pulse.goalProgressSummary}</div>
          )}
        </div>

        {actionError && <div className={styles.actionError}>{actionError}</div>}

        <div className={styles.pulseBoard}>
          {/* 1. Blockers & Decisions Needed */}
          <section
            className={styles.pulseSection}
            {...{ 'data-testid': 'pulse-blockers-section' }}
          >
            <h2>1. Blockers &amp; Decisions Needed</h2>
            {pulse && (pulse.blockers.length > 0 || pulse.decisionsNeeded.length > 0) ? (
              <div className={styles.cardStack}>
                {pulse.blockers.map((blocker, idx) => (
                  <div key={`blk-${idx}`} className={styles.blockerCard}>
                    <div className={styles.cardMetaRow}>
                      <span className={styles.blockerTypeBadge}>{blocker.blockerType}</span>
                      {blocker.ownerDisplayName && (
                        <span className={styles.ownerName}>{blocker.ownerDisplayName}</span>
                      )}
                    </div>
                    <div className={styles.cardMainText}>{blocker.summary}</div>
                  </div>
                ))}
                {pulse.decisionsNeeded.map((decision, idx) => (
                  <div key={`dec-${idx}`} className={styles.decisionCard}>
                    <span className={styles.decisionTag}>Decision</span>
                    <span>{decision}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className={styles.emptyHint}>No active blockers or pending huddle decisions.</p>
            )}
          </section>

          {/* 2. At-Risk Work & Commitment Carryover */}
          <section
            className={styles.pulseSection}
            {...{ 'data-testid': 'pulse-risks-section' }}
          >
            <h2>2. At-Risk Work &amp; Commitment Carryover</h2>
            {pulse && (pulse.carryoverAlerts.length > 0 || pulse.atRiskItems.length > 0) ? (
              <div className={styles.cardStack}>
                {pulse.carryoverAlerts.map((carry, idx) => (
                  <div key={`carry-${idx}`} className={styles.carryoverCard}>
                    <div className={styles.cardMetaRow}>
                      <span className={styles.carryoverBadge}>Carryover</span>
                      <span className={styles.ownerName}>
                        {shortUserLabel(carry.userId, carry.displayName ?? nameByOid[carry.userId])}
                      </span>
                    </div>
                    <div className={styles.cardMainText}>{carry.summary}</div>
                  </div>
                ))}
                {pulse.atRiskItems.map((risk) => (
                  <div key={`risk-${risk.workItemId}`} className={styles.riskCard}>
                    <div className={styles.cardMetaRow}>
                      <span className={styles.riskId}>#{risk.workItemId}</span>
                      <span className={styles.cardTitle}>{risk.title}</span>
                      <span
                        className={`${styles.confidenceChip} ${
                          risk.confidence === 'at_risk' ? styles.chipAtRisk : styles.chipUncertain
                        }`}
                      >
                        {risk.confidence === 'at_risk' ? 'At Risk' : 'Watch'}
                      </span>
                    </div>
                    <ul className={styles.reasonList}>
                      {risk.reasons.map((reason, idx) => (
                        <li key={idx}>{reason}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ) : (
              <p className={styles.emptyHint}>
                No carryover alerts or at-risk items under the {deliveryModelLabel} policy.
              </p>
            )}
          </section>

          {/* 3. Handoffs, PR Reviews & Team Capacity */}
          <section
            className={styles.pulseSection}
            {...{ 'data-testid': 'pulse-handoffs-capacity-section' }}
          >
            <h2>3. Handoffs, PR Reviews &amp; Team Capacity</h2>
            {pulse && (pulse.handoffsAndReviews.length > 0 || pulse.capacityNotes.length > 0) ? (
              <div className={styles.cardStack}>
                {pulse.handoffsAndReviews.map((handoff, idx) => (
                  <div key={`ho-${idx}`} className={styles.infoCard}>
                    <span className={styles.infoTag}>Handoff / Review</span>
                    <span>
                      {handoff.fromUser ? `${handoff.fromUser}: ` : ''}
                      {handoff.summary}
                    </span>
                  </div>
                ))}
                {pulse.capacityNotes.map((cap, idx) => (
                  <div key={`cap-${idx}`} className={styles.infoCard}>
                    <span className={styles.infoTag}>Capacity</span>
                    <span>
                      {shortUserLabel(cap.userId, cap.displayName ?? nameByOid[cap.userId])}:{' '}
                      {cap.note}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className={styles.emptyHint}>No handoffs, review waits, or capacity changes noted.</p>
            )}
          </section>

          {/* 4. Confirmation-Gated ADO Proposals */}
          <section
            className={styles.pulseSection}
            {...{ 'data-testid': 'pulse-proposals-section' }}
          >
            <h2>4. Confirmation-Gated ADO Proposals ({pendingProposals.length} pending)</h2>
            {proposals.length > 0 ? (
              <div className={styles.cardStack}>
                {[...pendingProposals, ...decidedProposals].map((proposal) => (
                  <div
                    key={proposal.id}
                    className={styles.proposalCard}
                    {...{ 'data-testid': `pulse-proposal-card-${proposal.id}` }}
                  >
                    <div className={styles.proposalHeader}>
                      <span className={styles.riskId}>#{proposal.workItemId}</span>
                      <span className={styles.cardTitle}>{proposal.workItemTitle}</span>
                      <span
                        className={`${styles.chip} ${styles[proposal.status] ?? ''}`}
                        {...{ 'data-testid': `proposal-status-${proposal.id}` }}
                      >
                        {proposal.status}
                      </span>
                    </div>
                    <div className={styles.proposalDiff}>
                      <strong>{proposal.fieldName}:</strong>{' '}
                      <span>{proposal.currentValue ?? '(unset)'}</span> →{' '}
                      <span className={styles.proposedVal}>{proposal.proposedValue}</span>
                    </div>
                    <div className={styles.proposalReason}>{proposal.reason}</div>
                    {proposal.status === 'pending' && (
                      <div className={styles.proposalActions}>
                        {canWriteWorkItems && (
                          <button
                            type="button"
                            className={styles.applyBtn}
                            onClick={() => {
                              void handleApplyProposal(proposal);
                            }}
                            disabled={applyProposalMutation.isPending}
                            {...{ 'data-testid': `proposal-apply-btn-${proposal.id}` }}
                          >
                            Confirm &amp; Apply
                          </button>
                        )}
                        <button
                          type="button"
                          className={styles.dismissBtn}
                          onClick={() => {
                            void handleDismissProposal(proposal.id);
                          }}
                          disabled={dismissProposalMutation.isPending}
                          {...{ 'data-testid': `proposal-dismiss-btn-${proposal.id}` }}
                        >
                          Dismiss
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className={styles.emptyHint}>No staged ADO proposals for this session.</p>
            )}
          </section>
        </div>

        {/* 5. Follow-ups, Facilitator Narrative & Participant Updates */}
        {session.followups.length > 0 && (
          <section className={styles.section}>
            <h2>Follow-ups ({session.followups.length})</h2>
            <div className={styles.followupList}>
              {session.followups.map((f) => (
                <div key={f.id} className={styles.followupCard}>
                  <div className={styles.followupTitle}>{f.title}</div>
                  {f.description && (
                    <div className={styles.followupDesc}>{f.description}</div>
                  )}
                  <div className={styles.followupMeta}>
                    <span className={`${styles.chip} ${styles[f.status] ?? ''}`}>
                      {f.status}
                    </span>
                    <span>{f.participantUserIds.length} participant(s)</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {session.summaryMarkdown && (
          <section className={styles.section}>
            <h2>Facilitator Summary</h2>
            <div className={styles.markdown}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {session.summaryMarkdown}
              </ReactMarkdown>
            </div>
          </section>
        )}

        <section className={styles.section}>
          <h2>Participants ({session.participants.length})</h2>
          <div className={styles.participantList}>
            {session.participants.map((p) => (
              <div key={p.id} className={styles.participantCard}>
                <div className={styles.participantHeader}>
                  <span className={styles.userId} title={p.userId}>
                    {shortUserLabel(p.userId, p.displayName ?? nameByOid[p.userId])}
                  </span>
                  <span className={`${styles.chip} ${styles[p.status] ?? ''}`}>
                    {p.status}
                  </span>
                </div>
                {p.structuredUpdate && (
                  <div className={styles.update}>
                    {p.structuredUpdate.yesterday && (
                      <div>
                        <strong>Yesterday:</strong> {p.structuredUpdate.yesterday}
                      </div>
                    )}
                    {p.structuredUpdate.today && (
                      <div>
                        <strong>Today:</strong> {p.structuredUpdate.today}
                      </div>
                    )}
                    {p.structuredUpdate.blockers && (
                      <div className={styles.blocker}>
                        <strong>Blockers:</strong> {p.structuredUpdate.blockers}
                      </div>
                    )}
                    {p.structuredUpdate.atRisk && (
                      <div className={styles.blocker}>
                        <strong>At risk:</strong> {p.structuredUpdate.atRisk}
                      </div>
                    )}
                    {p.structuredUpdate.handoffs && (
                      <div>
                        <strong>Handoffs:</strong> {p.structuredUpdate.handoffs}
                      </div>
                    )}
                    {p.structuredUpdate.capacity && (
                      <div>
                        <strong>Capacity:</strong> {p.structuredUpdate.capacity}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};

export default StandupSummaryView;

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
  STANDUP_WORK_DOMAIN_LABELS,
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
  const sdlcCallouts = pulse?.sdlcCallouts ?? [];
  const areaBreakdown = pulse?.areaBreakdown ?? [];
  const individualNarratives = pulse?.individualNarratives ?? [];
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

        {/* SDLC & Release Process Callouts */}
        <section
          className={styles.fullWidthSection}
          data-testid="pulse-sdlc-callouts-section"
        >
          <h2>SDLC &amp; Release Process Callouts ({sdlcCallouts.length})</h2>
          {sdlcCallouts.length > 0 ? (
            <div className={styles.sdlcGrid}>
              {sdlcCallouts.map((callout) => (
                <div
                  key={callout.id}
                  className={`${styles.sdlcCard} ${
                    callout.severity === 'critical'
                      ? styles.sdlcCritical
                      : styles.sdlcWarning
                  }`}
                  data-testid={`pulse-sdlc-callout-${callout.id}`}
                >
                  <div className={styles.cardMetaRow}>
                    <span
                      className={
                        callout.severity === 'critical'
                          ? styles.blockerTypeBadge
                          : styles.carryoverBadge
                      }
                    >
                      {callout.severity}
                    </span>
                    <span className={styles.domainBadge}>
                      {STANDUP_WORK_DOMAIN_LABELS[callout.domain] ?? callout.domain}
                    </span>
                    {callout.ownerDisplayName && (
                      <span className={styles.ownerName}>
                        {callout.ownerDisplayName}
                      </span>
                    )}
                  </div>
                  <div className={styles.cardTitle}>{callout.title}</div>
                  <div className={styles.cardMainText}>{callout.detail}</div>
                  {callout.filePaths && callout.filePaths.length > 0 && (
                    <div className={styles.filePathRow}>
                      {callout.filePaths.map((fp) => (
                        <code key={fp} className={styles.fileChip}>
                          {fp}
                        </code>
                      ))}
                    </div>
                  )}
                  <div className={styles.recommendationText}>
                    <strong>Facilitator check:</strong> {callout.recommendation}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className={styles.emptyHint}>
              No SQL migration, Terraform/IaC pipeline, or QA build process risks detected.
            </p>
          )}
        </section>

        <div className={styles.pulseBoard}>
          {/* 1. Blockers & Decisions Needed */}
          <section
            className={styles.pulseSection}
            {...{ 'data-testid': 'pulse-blockers-section' }}
          >
            <h2>Blockers &amp; Decisions Needed</h2>
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

          {/* 2. Engineering Area Breakdown */}
          <section
            className={styles.pulseSection}
            data-testid="pulse-area-breakdown-section"
          >
            <h2>Engineering Area Breakdown</h2>
            {areaBreakdown.length > 0 ? (
              <div className={styles.cardStack}>
                {areaBreakdown.map((area) => (
                  <div
                    key={area.domain}
                    className={styles.areaCard}
                    data-testid={`pulse-area-card-${area.domain}`}
                  >
                    <div className={styles.cardMetaRow}>
                      <span className={styles.domainBadge}>{area.label}</span>
                      <span className={styles.areaStat}>
                        {area.activeItemCount} active
                      </span>
                      {area.riskCount > 0 && (
                        <span className={styles.chipAtRiskSmall}>
                          {area.riskCount} risk{area.riskCount === 1 ? '' : 's'}
                        </span>
                      )}
                    </div>
                    <div className={styles.cardMainText}>
                      <strong>Focus:</strong> {area.keyFocus}
                    </div>
                    <div className={styles.areaContributors}>
                      Contributors: {area.contributors.join(', ')}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className={styles.emptyHint}>
                Engineering areas populate automatically from active items and PRs.
              </p>
            )}
          </section>
        </div>

        {/* Individual Standup Narratives (Multi-Day Aware) */}
        <section
          className={styles.fullWidthSection}
          data-testid="pulse-individual-narratives-section"
        >
          <h2>
            Individual Standup Narratives ({individualNarratives.length})
          </h2>
          {individualNarratives.length > 0 ? (
            <div className={styles.narrativeGrid}>
              {individualNarratives.map((narrative) => {
                const resolvedName = shortUserLabel(
                  narrative.userId,
                  nameByOid[narrative.userId] || narrative.displayName,
                );
                const isConfirmed = narrative.status === 'confirmed';
                return (
                  <div
                    key={narrative.userId}
                    className={styles.narrativeCard}
                    data-testid={`participant-narrative-${narrative.userId}`}
                  >
                    <div className={styles.narrativeHeader}>
                      <div className={styles.narrativeIdentity}>
                        <span className={styles.userId}>{resolvedName}</span>
                        {narrative.domains.map((domain) => (
                          <span key={domain} className={styles.domainBadge}>
                            {STANDUP_WORK_DOMAIN_LABELS[domain] ?? domain}
                          </span>
                        ))}
                      </div>
                      <div className={styles.narrativeBadges}>
                        {narrative.carryoverCount > 0 && (
                          <span className={styles.carryoverBadge}>
                            {narrative.carryoverCount} carryover
                          </span>
                        )}
                        <span
                          className={
                            isConfirmed
                              ? styles.confirmedNarrativeBadge
                              : styles.draftedNarrativeBadge
                          }
                          data-testid={`participant-narrative-status-${narrative.userId}`}
                        >
                          {isConfirmed ? 'Confirmed' : 'AI-Drafted from ADO'}
                        </span>
                      </div>
                    </div>

                    <div className={styles.arcLine}>{narrative.arcSummary}</div>

                    <div className={styles.narrativeBody}>
                      <div>
                        <strong>Yesterday:</strong> {narrative.yesterdaySummary}
                      </div>
                      <div>
                        <strong>Today&apos;s Focus:</strong> {narrative.todayFocus}
                      </div>
                      <div
                        className={
                          narrative.blockersSummary !== 'None' &&
                          narrative.blockersSummary !== 'None detected'
                            ? styles.blocker
                            : ''
                        }
                      >
                        <strong>Blockers:</strong> {narrative.blockersSummary}
                      </div>
                      {narrative.userCorrections && (
                        <div
                          className={styles.correctionBox}
                          data-testid={`participant-narrative-correction-${narrative.userId}`}
                        >
                          <strong>Member Correction / Addition:</strong>{' '}
                          {narrative.userCorrections}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className={styles.emptyHint}>No participants in this session.</p>
          )}
        </section>

        <div className={styles.pulseBoard}>
          {/* At-Risk Work & Commitment Carryover */}
          <section
            className={styles.pulseSection}
            {...{ 'data-testid': 'pulse-risks-section' }}
          >
            <h2>At-Risk Work &amp; Commitment Carryover</h2>
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

          {/* Handoffs, PR Reviews & Team Capacity */}
          <section
            className={styles.pulseSection}
            {...{ 'data-testid': 'pulse-handoffs-capacity-section' }}
          >
            <h2>Handoffs, PR Reviews &amp; Team Capacity</h2>
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

          {/* Confirmation-Gated ADO Proposals */}
          <section
            className={styles.pulseSection}
            {...{ 'data-testid': 'pulse-proposals-section' }}
          >
            <h2>Confirmation-Gated ADO Proposals ({pendingProposals.length} pending)</h2>
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

        {/* Follow-ups & Facilitator Narrative */}
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
      </div>
    </div>
  );
};

export default StandupSummaryView;

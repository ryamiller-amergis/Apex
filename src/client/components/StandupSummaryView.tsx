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

  const { data: session, isLoading: loading } = useStandupSessionDetail(
    id,
    selectedProject,
  );
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
        <div className={styles.stateMessage}>Loading standup readout...</div>
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
  const facilitatorPrompts = pulse?.facilitatorPrompts ?? [];
  const blockers = pulse?.blockers ?? [];
  const decisionsNeeded = pulse?.decisionsNeeded ?? [];
  const carryoverAlerts = pulse?.carryoverAlerts ?? [];
  const atRiskItems = pulse?.atRiskItems ?? [];
  const proposals = session.proposals ?? [];
  const pendingProposals = proposals.filter((p) => p.status === 'pending');
  const decidedProposals = proposals.filter((p) => p.status !== 'pending');
  const canWriteWorkItems = can('workitems:write');

  const submittedNarrativesCount = individualNarratives.filter(
    (n) => n.status === 'confirmed',
  ).length;

  const meaningfulAreas = areaBreakdown.filter(
    (area) => area.domain !== 'general' || area.riskCount > 0,
  );
  const deliverySignalCount =
    sdlcCallouts.length +
    pendingProposals.length +
    carryoverAlerts.length +
    atRiskItems.length;
  const hasDeliveryInsights =
    deliverySignalCount > 0 ||
    decidedProposals.length > 0 ||
    meaningfulAreas.length > 0;

  return (
    <div className={styles.container}>
      <StandupSubNav />
      <div className={styles.content}>
        <div className={styles.shell}>
          <header className={styles.header}>
            <div className={styles.headerLeft}>
              <h1>Standup Readout</h1>
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
              <label
                className={styles.sessionSwitcherLabel}
                htmlFor="pulse-session-select"
              >
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

          {/* 1. Team Goal & Check-In Progress */}
          <div
            className={styles.goalBanner}
            {...{ 'data-testid': 'pulse-team-goal' }}
          >
            <div className={styles.goalRow}>
              <span className={styles.goalTag}>
                {teamGoal ? 'Team Goal' : 'Daily Sync'}
              </span>
              <span className={styles.goalTitle}>
                {teamGoal ?? 'Quick team alignment & blocker check'}
              </span>
            </div>
            {pulse?.goalProgressSummary && (
              <div className={styles.goalSummary}>{pulse.goalProgressSummary}</div>
            )}
          </div>

          {actionError && (
            <div className={styles.actionError} role="alert">
              {actionError}
            </div>
          )}

          {/* 2. Blockers & AI Huddle Questions (First for the Scrum Master) */}
          <section
            className={styles.sectionCard}
            {...{ 'data-testid': 'pulse-blockers-section' }}
          >
            <div className={styles.sectionHeader}>
              <h2>Blockers &amp; Questions for Standup</h2>
              {blockers.length > 0 && (
                <span className={styles.blockerCountBadge}>
                  {blockers.length} blocker{blockers.length === 1 ? '' : 's'}
                </span>
              )}
            </div>

            {blockers.length > 0 || decisionsNeeded.length > 0 ? (
              <div className={styles.cardStack}>
                {blockers.map((blocker, idx) => (
                  <div key={`blk-${idx}`} className={styles.blockerCard}>
                    <div className={styles.cardMetaRow}>
                      <span className={styles.blockerTypeBadge}>
                        {blocker.blockerType}
                      </span>
                      {blocker.ownerDisplayName && (
                        <span className={styles.ownerName}>
                          {blocker.ownerDisplayName}
                        </span>
                      )}
                    </div>
                    <div className={styles.cardMainText}>{blocker.summary}</div>
                  </div>
                ))}
                {decisionsNeeded.map((decision, idx) => (
                  <div key={`dec-${idx}`} className={styles.decisionCard}>
                    <span className={styles.decisionTag}>Decision</span>
                    <span>{decision}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className={styles.emptyHint}>No blockers flagged today.</p>
            )}

            {facilitatorPrompts.length > 0 && (
              <div
                className={styles.promptsBox}
                data-testid="pulse-facilitator-prompts"
              >
                <span className={styles.promptsLabel}>
                  AI Suggested Questions to Ask
                </span>
                <ul className={styles.promptsList}>
                  {facilitatorPrompts.map((prompt, idx) => (
                    <li key={`fp-${idx}`}>{prompt}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          {/* 3. Team Readout — One Clear Read-Aloud Card Per Person */}
          <section
            className={styles.sectionCard}
            data-testid="pulse-individual-narratives-section"
          >
            <div className={styles.sectionHeader}>
              <h2>
                Team Readout ({submittedNarrativesCount} of{' '}
                {individualNarratives.length} checked in)
              </h2>
            </div>

            {individualNarratives.length > 0 ? (
              <div className={styles.readoutGrid}>
                {individualNarratives.map((narrative) => {
                  const resolvedName = shortUserLabel(
                    narrative.userId,
                    nameByOid[narrative.userId] || narrative.displayName,
                  );
                  const isConfirmed = narrative.status === 'confirmed';
                  const hasBlocker =
                    narrative.blockersSummary !== 'None' &&
                    narrative.blockersSummary !== 'None detected' &&
                    narrative.blockersSummary.trim().length > 0;

                  return (
                    <div
                      key={narrative.userId}
                      className={`${styles.readoutCard} ${
                        isConfirmed ? styles.readoutSubmitted : styles.readoutWaiting
                      }`}
                      data-testid={`participant-narrative-${narrative.userId}`}
                    >
                      <div className={styles.readoutHeader}>
                        <span className={styles.personName}>{resolvedName}</span>
                        <div className={styles.readoutBadges}>
                          {narrative.carryoverCount > 0 && (
                            <span className={styles.carryoverBadge}>
                              {narrative.carryoverCount} carryover
                            </span>
                          )}
                          <span
                            className={
                              isConfirmed
                                ? styles.submittedBadge
                                : styles.waitingBadge
                            }
                            data-testid={`participant-narrative-status-${narrative.userId}`}
                          >
                            {isConfirmed ? 'Submitted' : 'Waiting for check-in'}
                          </span>
                        </div>
                      </div>

                      {isConfirmed ? (
                        <div className={styles.readoutBody}>
                          <div className={styles.readoutLine}>
                            <span className={styles.lineLabel}>Done:</span>
                            <span>{narrative.yesterdaySummary}</span>
                          </div>
                          <div className={styles.readoutLine}>
                            <span className={styles.lineLabel}>Today:</span>
                            <span>{narrative.todayFocus}</span>
                          </div>
                          {hasBlocker && (
                            <div
                              className={`${styles.readoutLine} ${styles.blockerLine}`}
                            >
                              <span className={styles.lineLabel}>Blocker:</span>
                              <span>{narrative.blockersSummary}</span>
                            </div>
                          )}
                          {narrative.handoffsSummary && (
                            <div className={styles.readoutLine}>
                              <span className={styles.lineLabel}>Handoff:</span>
                              <span>{narrative.handoffsSummary}</span>
                            </div>
                          )}
                          {narrative.capacitySummary && (
                            <div className={styles.readoutLine}>
                              <span className={styles.lineLabel}>Availability:</span>
                              <span>{narrative.capacitySummary}</span>
                            </div>
                          )}
                          {narrative.userCorrections && (
                            <div
                              className={styles.noteBox}
                              data-testid={`participant-narrative-correction-${narrative.userId}`}
                            >
                              <strong>Note:</strong> {narrative.userCorrections}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className={styles.waitingBody}>
                          <span>Has not submitted today&apos;s check-in yet.</span>
                          {narrative.todayFocus &&
                            narrative.todayFocus !== 'Waiting for check-in.' && (
                              <span className={styles.waitingHint}>
                                Suggested focus: {narrative.todayFocus}
                              </span>
                            )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className={styles.emptyHint}>No participants in this session.</p>
            )}
          </section>

          {/* 4. Follow-ups & AI Facilitator Summary */}
          {session.followups.length > 0 && (
            <section className={styles.sectionCard}>
              <div className={styles.sectionHeader}>
                <h2>Follow-ups ({session.followups.length})</h2>
              </div>
              <div className={styles.cardStack}>
                {session.followups.map((f) => (
                  <div key={f.id} className={styles.followupCard}>
                    <div className={styles.followupTitle}>{f.title}</div>
                    {f.description && (
                      <div className={styles.followupDesc}>{f.description}</div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {session.summaryMarkdown && (
            <section className={styles.sectionCard}>
              <div className={styles.sectionHeader}>
                <h2>AI Facilitator Notes</h2>
              </div>
              <div className={styles.markdown}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {session.summaryMarkdown}
                </ReactMarkdown>
              </div>
            </section>
          )}

          {/* 5. Collapsed Supplemental Delivery & SDLC Insights */}
          {hasDeliveryInsights && (
            <details
              className={styles.insightsDrawer}
              data-testid="pulse-delivery-insights"
            >
              <summary className={styles.insightsSummary}>
                <span>Delivery &amp; SDLC Insights (optional)</span>
                {deliverySignalCount > 0 && (
                  <span className={styles.signalCountBadge}>
                    {deliverySignalCount} signal{deliverySignalCount === 1 ? '' : 's'}
                  </span>
                )}
              </summary>

              <div className={styles.insightsBody}>
                {sdlcCallouts.length > 0 && (
                  <div
                    className={styles.insightBlock}
                    data-testid="pulse-sdlc-callouts-section"
                  >
                    <h3>SDLC &amp; Release Checks ({sdlcCallouts.length})</h3>
                    <div className={styles.cardStack}>
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
                            <span className={styles.blockerTypeBadge}>
                              {callout.severity}
                            </span>
                            <span className={styles.domainBadge}>
                              {STANDUP_WORK_DOMAIN_LABELS[callout.domain] ??
                                callout.domain}
                            </span>
                            {callout.ownerDisplayName && (
                              <span className={styles.ownerName}>
                                {callout.ownerDisplayName}
                              </span>
                            )}
                          </div>
                          <div className={styles.cardTitle}>{callout.title}</div>
                          <div className={styles.cardMainText}>{callout.detail}</div>
                          <div className={styles.recommendationText}>
                            <strong>Check:</strong> {callout.recommendation}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {(carryoverAlerts.length > 0 || atRiskItems.length > 0) && (
                  <div
                    className={styles.insightBlock}
                    data-testid="pulse-risks-section"
                  >
                    <h3>Carryover &amp; Risk Signals</h3>
                    <div className={styles.cardStack}>
                      {carryoverAlerts.map((carry, idx) => (
                        <div key={`carry-${idx}`} className={styles.infoCard}>
                          <strong>
                            {shortUserLabel(
                              carry.userId,
                              carry.displayName ?? nameByOid[carry.userId],
                            )}
                            :
                          </strong>{' '}
                          {carry.summary}
                        </div>
                      ))}
                      {atRiskItems.map((risk) => (
                        <div
                          key={`risk-${risk.workItemId}`}
                          className={styles.infoCard}
                        >
                          <strong>
                            #{risk.workItemId} {risk.title}:
                          </strong>{' '}
                          {risk.reasons.join('; ')}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {meaningfulAreas.length > 0 && (
                  <div
                    className={styles.insightBlock}
                    data-testid="pulse-area-breakdown-section"
                  >
                    <h3>Active Areas</h3>
                    <div className={styles.areaGrid}>
                      {meaningfulAreas.map((area) => (
                        <div
                          key={area.domain}
                          className={styles.infoCard}
                          data-testid={`pulse-area-card-${area.domain}`}
                        >
                          <strong>{area.label}</strong> ({area.activeItemCount}) —{' '}
                          {area.keyFocus}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {proposals.length > 0 && (
                  <div
                    className={styles.insightBlock}
                    data-testid="pulse-proposals-section"
                  >
                    <h3>
                      Staged Ticket Updates ({pendingProposals.length} pending)
                    </h3>
                    <div className={styles.cardStack}>
                      {[...pendingProposals, ...decidedProposals].map(
                        (proposal) => (
                          <div
                            key={proposal.id}
                            className={styles.proposalCard}
                            data-testid={`pulse-proposal-card-${proposal.id}`}
                          >
                            <div className={styles.proposalHeader}>
                              <span className={styles.riskId}>
                                #{proposal.workItemId}
                              </span>
                              <span className={styles.cardTitle}>
                                {proposal.workItemTitle}
                              </span>
                              <span
                                className={styles.domainBadge}
                                data-testid={`proposal-status-${proposal.id}`}
                              >
                                {proposal.status}
                              </span>
                            </div>
                            <div className={styles.proposalDiff}>
                              <strong>{proposal.fieldName}:</strong>{' '}
                              <span>{proposal.currentValue ?? '(unset)'}</span> →{' '}
                              <span className={styles.proposedVal}>
                                {proposal.proposedValue}
                              </span>
                            </div>
                            <div className={styles.proposalReason}>
                              {proposal.reason}
                            </div>
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
                                    data-testid={`proposal-apply-btn-${proposal.id}`}
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
                                  data-testid={`proposal-dismiss-btn-${proposal.id}`}
                                >
                                  Dismiss
                                </button>
                              </div>
                            )}
                          </div>
                        ),
                      )}
                    </div>
                  </div>
                )}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
};

export default StandupSummaryView;

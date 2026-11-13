import React, { useState, useCallback } from 'react';
import {
  STANDUP_DELIVERY_MODEL_LABELS,
  type CalendarDeliveryPulseResponse,
  type CalendarItemHealth,
  type StandupActionProposal,
} from '../../shared/types/standup';
import styles from './CalendarDeliveryPulseBar.module.css';

export type CalendarPulseRiskFilter =
  | 'all'
  | 'at_risk'
  | 'blocked_or_stale'
  | 'proposals';

export interface WorkItemConfidenceBadgeProps {
  health?: CalendarItemHealth | null;
  compact?: boolean;
  'data-testid'?: string;
}

export const WorkItemConfidenceBadge: React.FC<WorkItemConfidenceBadgeProps> = ({
  health,
  compact = false,
  'data-testid': testId,
}) => {
  const [open, setOpen] = useState(false);

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setOpen((prev) => !prev);
  }, []);

  if (!health || health.confidence === 'on_track') return null;

  const isAtRisk = health.confidence === 'at_risk';
  const label = compact
    ? isAtRisk
      ? 'At Risk'
      : 'Uncertain'
    : isAtRisk
    ? 'At Risk · Why?'
    : 'Uncertain · Why?';

  return (
    <span className={styles.confidenceWrap}>
      <button
        type="button"
        className={`${styles.confidenceBadge} ${
          isAtRisk ? styles.confidenceAtRisk : styles.confidenceUncertain
        }`}
        onClick={handleToggle}
        aria-expanded={open}
        title={health.reasons.join(' • ')}
        {...{ 'data-testid': testId ?? `work-item-confidence-${health.workItemId}` }}
      >
        {label}
      </button>
      {open && health.reasons.length > 0 && (
        <div
          className={styles.reasonsPopover}
          role="region"
          aria-label={`Risk reasons for work item ${health.workItemId}`}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setOpen(false);
            }
          }}
          {...{ 'data-testid': `work-item-risk-reasons-${health.workItemId}` }}
        >
          <div className={styles.reasonsTitle}>Why {isAtRisk ? 'at risk' : 'uncertain'}?</div>
          <ul className={styles.reasonsList}>
            {health.reasons.map((reason, idx) => (
              <li key={idx}>{reason}</li>
            ))}
          </ul>
        </div>
      )}
    </span>
  );
};

export interface CalendarDeliveryPulseBarProps {
  pulse: CalendarDeliveryPulseResponse;
  activeFilter: CalendarPulseRiskFilter;
  onFilterChange: (filter: CalendarPulseRiskFilter) => void;
  canWriteWorkItems: boolean;
  onApplyProposal: (proposal: StandupActionProposal) => Promise<void>;
  onDismissProposal: (proposalId: string) => Promise<void>;
  isMutatingProposal?: boolean;
}

export const CalendarDeliveryPulseBar: React.FC<CalendarDeliveryPulseBarProps> = ({
  pulse,
  activeFilter,
  onFilterChange,
  canWriteWorkItems,
  onApplyProposal,
  onDismissProposal,
  isMutatingProposal = false,
}) => {
  const [drawerOpen, setDrawerOpen] = useState(false);

  const modelLabel =
    STANDUP_DELIVERY_MODEL_LABELS[pulse.deliveryModel] ?? 'Flow';
  const pendingProposals = pulse.proposals.filter((p) => p.status === 'pending');

  const handleProposalsPillClick = useCallback(() => {
    const nextOpen = !drawerOpen;
    setDrawerOpen(nextOpen);
    onFilterChange(nextOpen ? 'proposals' : 'all');
  }, [drawerOpen, onFilterChange]);

  const handleFilterClick = useCallback(
    (next: CalendarPulseRiskFilter) => {
      if (next !== 'proposals') {
        setDrawerOpen(false);
      }
      onFilterChange(activeFilter === next && next !== 'all' ? 'all' : next);
    },
    [activeFilter, onFilterChange],
  );

  return (
    <div
      className={styles.pulseBarContainer}
      {...{ 'data-testid': 'calendar-delivery-pulse-bar' }}
    >
      <div className={styles.topRow}>
        <div className={styles.goalCluster}>
          <span
            className={styles.modelBadge}
            {...{ 'data-testid': 'calendar-pulse-model' }}
          >
            {modelLabel} Pulse
          </span>
          <span
            className={styles.goalText}
            {...{ 'data-testid': 'calendar-pulse-goal' }}
          >
            {pulse.teamGoal
              ? `Goal: ${pulse.teamGoal}`
              : 'Delivery Pulse: active flow & standup signals'}
          </span>
        </div>

        <div className={styles.metricsCluster}>
          <span
            className={`${styles.metricPill} ${styles.metricOnTrack}`}
            {...{ 'data-testid': 'calendar-pulse-metric-on-track' }}
          >
            On Track: <strong>{pulse.counts.onTrack}</strong>
          </span>
          <span
            className={`${styles.metricPill} ${styles.metricUncertain}`}
            {...{ 'data-testid': 'calendar-pulse-metric-uncertain' }}
          >
            Uncertain: <strong>{pulse.counts.uncertain}</strong>
          </span>
          <span
            className={`${styles.metricPill} ${styles.metricAtRisk}`}
            {...{ 'data-testid': 'calendar-pulse-metric-at-risk' }}
          >
            At Risk: <strong>{pulse.counts.atRisk}</strong>
          </span>
          <span
            className={styles.metricPill}
            {...{ 'data-testid': 'calendar-pulse-metric-blocked-stale' }}
          >
            {pulse.enableTargetDateChecks
              ? 'Blocked / Stale:'
              : 'Flow Aging / Stale:'}{' '}
            <strong>{pulse.counts.blockedOrStale}</strong>
          </span>
          {pulse.enableTargetDateChecks && (
            <span
              className={`${styles.metricPill} ${styles.metricUncertain}`}
              {...{ 'data-testid': 'calendar-pulse-metric-missing-date' }}
            >
              Missing Target Date: <strong>{pulse.counts.missingTargetDate}</strong>
            </span>
          )}
        </div>
      </div>

      <div className={styles.filterRow} role="group" aria-label="Delivery Pulse risk filters">
        <button
          type="button"
          className={`${styles.filterPill} ${activeFilter === 'all' ? styles.filterPillActive : ''}`}
          onClick={() => handleFilterClick('all')}
          aria-pressed={activeFilter === 'all'}
          {...{ 'data-testid': 'calendar-pulse-filter-all' }}
        >
          All Items
        </button>
        <button
          type="button"
          className={`${styles.filterPill} ${activeFilter === 'at_risk' ? styles.filterPillActive : ''}`}
          onClick={() => handleFilterClick('at_risk')}
          aria-pressed={activeFilter === 'at_risk'}
          {...{ 'data-testid': 'calendar-pulse-filter-at-risk' }}
        >
          At Risk ({pulse.counts.atRisk + pulse.counts.uncertain})
        </button>
        <button
          type="button"
          className={`${styles.filterPill} ${
            activeFilter === 'blocked_or_stale' ? styles.filterPillActive : ''
          }`}
          onClick={() => handleFilterClick('blocked_or_stale')}
          aria-pressed={activeFilter === 'blocked_or_stale'}
          {...{ 'data-testid': 'calendar-pulse-filter-blocked-stale' }}
        >
          Blocked / Stale ({pulse.counts.blockedOrStale})
        </button>
        <button
          type="button"
          className={`${styles.filterPill} ${
            drawerOpen || activeFilter === 'proposals' ? styles.filterPillActive : ''
          }`}
          onClick={handleProposalsPillClick}
          aria-expanded={drawerOpen}
          {...{ 'data-testid': 'calendar-pulse-filter-proposals' }}
        >
          Pending Proposals ({pendingProposals.length})
        </button>
      </div>

      {drawerOpen && (
        <div
          className={styles.proposalsDrawer}
          {...{ 'data-testid': 'calendar-proposals-panel' }}
        >
          <div className={styles.drawerHeader}>
            <h3>Standup ADO Update Proposals ({pendingProposals.length} pending)</h3>
            <button
              type="button"
              className={styles.closeDrawerBtn}
              onClick={() => {
                setDrawerOpen(false);
                if (activeFilter === 'proposals') onFilterChange('all');
              }}
              {...{ 'data-testid': 'calendar-proposals-close-btn' }}
            >
              Close
            </button>
          </div>
          {pendingProposals.length === 0 ? (
            <p className={styles.emptyProposals}>
              No pending ADO update proposals for this project.
            </p>
          ) : (
            <div className={styles.proposalList}>
              {pendingProposals.map((proposal) => (
                <div
                  key={proposal.id}
                  className={styles.proposalItem}
                  {...{ 'data-testid': `calendar-proposal-card-${proposal.id}` }}
                >
                  <div className={styles.proposalInfo}>
                    <div className={styles.proposalTitleRow}>
                      <span className={styles.proposalWorkItemId}>
                        #{proposal.workItemId}
                      </span>
                      <span className={styles.proposalWorkItemTitle}>
                        {proposal.workItemTitle}
                      </span>
                    </div>
                    <div className={styles.proposalChange}>
                      <strong>{proposal.fieldName}:</strong>{' '}
                      <span>{proposal.currentValue ?? '(unset)'}</span> →{' '}
                      <span className={styles.proposedHighlight}>
                        {proposal.proposedValue}
                      </span>
                    </div>
                    <div className={styles.proposalReason}>{proposal.reason}</div>
                  </div>
                  <div className={styles.proposalBtns}>
                    {canWriteWorkItems && (
                      <button
                        type="button"
                        className={styles.applyBtn}
                        onClick={() => {
                          void onApplyProposal(proposal);
                        }}
                        disabled={isMutatingProposal}
                        {...{ 'data-testid': `calendar-proposal-apply-${proposal.id}` }}
                      >
                        Confirm &amp; Apply
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.dismissBtn}
                      onClick={() => {
                        void onDismissProposal(proposal.id);
                      }}
                      disabled={isMutatingProposal}
                      {...{ 'data-testid': `calendar-proposal-dismiss-${proposal.id}` }}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default CalendarDeliveryPulseBar;

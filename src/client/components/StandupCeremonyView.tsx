import React, {
  useState,
  useRef,
  useMemo,
  useCallback,
  useEffect,
  Suspense,
  lazy,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppShell } from '../hooks/useAppShell';
import {
  useMyStandupSession,
  useRefreshParticipantBrief,
  useSubmitStandupParticipant,
} from '../hooks/useStandupDeliveryPulse';
import {
  STANDUP_CHECK_IN_SCHEMA,
  STANDUP_DELIVERY_MODEL_LABELS,
  type ParticipantPreparedBrief,
  type StandupActionProposalInput,
  type StandupDraftedItem,
  type StandupItemDecision,
  type StandupSuggestedActivity,
} from '../../shared/types/standup';
import {
  MAX_PERSONAL_STANDUP_ITEMS,
  reconcileDraftedUpdate,
  validateStandupCheckIn,
} from '../../shared/utils/standupDeliveryPolicy';
import type { WorkItem } from '../types/workitem';
import styles from './StandupCeremonyView.module.css';

const DetailsPanel = lazy(() =>
  import('./DetailsPanel').then((m) => ({ default: m.DetailsPanel })),
);

const StandupSubNav: React.FC<{
  active: 'standup' | 'standup-summary' | 'standup-manage';
}> = ({ active }) => {
  const navigate = useNavigate();
  const { can } = useAppShell();
  return (
    <div className={styles.subNav}>
      <button
        type="button"
        className={`${styles.subNavBtn} ${active === 'standup' ? styles.subNavActive : ''}`}
        onClick={() => navigate('/standup')}
        {...{ 'data-testid': 'standup-subnav-my-standup' }}
      >
        My Standup
      </button>
      {can('standup:participate') && (
        <button
          type="button"
          className={`${styles.subNavBtn} ${active === 'standup-summary' ? styles.subNavActive : ''}`}
          onClick={() => navigate('/standup-summary')}
          {...{ 'data-testid': 'standup-subnav-summary' }}
        >
          Summary
        </button>
      )}
      {can('standup:manage') && (
        <button
          type="button"
          className={`${styles.subNavBtn} ${active === 'standup-manage' ? styles.subNavActive : ''}`}
          onClick={() => navigate('/standup-manage')}
          {...{ 'data-testid': 'standup-subnav-manage' }}
        >
          Manage
        </button>
      )}
    </div>
  );
};

async function fetchWorkItem(
  id: number,
  project: string,
  areaPath: string,
): Promise<WorkItem | null> {
  const params = new URLSearchParams({ project, areaPath });
  const res = await fetch(`/api/workitems/${id}?${params}`, {
    credentials: 'include',
  });
  if (!res.ok) return null;
  return res.json();
}

function resolveDraftedItemsFromBrief(
  brief: ParticipantPreparedBrief | null | undefined,
): StandupDraftedItem[] {
  if (!brief) return [];
  if (Array.isArray(brief.draftedItems)) {
    return brief.draftedItems;
  }

  const fallback: StandupDraftedItem[] = [];
  brief.accomplishedSinceLast
    .slice(0, MAX_PERSONAL_STANDUP_ITEMS)
    .forEach((acc, idx) => {
      fallback.push({
        id: acc.prId
          ? `draft-yesterday-pr-${acc.prId}`
          : acc.workItemId
          ? `draft-yesterday-wi-${acc.workItemId}`
          : `draft-yesterday-${idx}`,
        bucket: 'yesterday',
        summary: acc.prId
          ? `Merged PR !${acc.prId}: ${acc.title}`
          : `#${acc.workItemId} ${acc.title}${acc.state ? ` [${acc.state}]` : ''}`,
        workItemId: acc.workItemId,
        prId: acc.prId,
        evidence: acc.evidence,
        attribution: 'confirmed',
      });
    });

  brief.suggestedToday.slice(0, MAX_PERSONAL_STANDUP_ITEMS).forEach((item) => {
    fallback.push({
      id: `draft-today-wi-${item.workItemId}`,
      bucket: 'today',
      summary: `#${item.workItemId} ${item.title} [${item.state}]`,
      workItemId: item.workItemId,
      evidence: 'Assigned to you',
      attribution: 'confirmed',
    });
  });

  brief.detectedExceptions
    .filter((ex) => ex.kind === 'pipeline_failure' || ex.kind === 'sla_breach')
    .slice(0, 2)
    .forEach((ex) => {
      fallback.push({
        id: `draft-blocker-${ex.id}`,
        bucket: 'blocker',
        summary: ex.message,
        workItemId: ex.workItemId,
        prId: ex.prId,
        evidence: ex.kind,
        attribution: 'confirmed',
      });
    });

  return fallback;
}

function summarizeBucket(
  items: StandupDraftedItem[],
  decisions: Record<string, StandupItemDecision>,
  bucket: 'yesterday' | 'today' | 'blocker',
): string {
  return items
    .filter((item) => item.bucket === bucket && decisions[item.id] !== 'rejected')
    .map((item) => item.summary)
    .join('; ');
}

function appendLineSegment(current: string, addition: string): string {
  const cleanCurrent = current.trim();
  const cleanAdd = addition.trim();
  if (!cleanAdd) return cleanCurrent;
  if (!cleanCurrent) return cleanAdd;
  if (cleanCurrent.includes(cleanAdd)) return cleanCurrent;
  return `${cleanCurrent}; ${cleanAdd}`;
}

export const StandupCeremonyView: React.FC = () => {
  const [localSubmitted, setLocalSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<WorkItem | null>(null);
  const [panelLoading, setPanelLoading] = useState(false);

  const [itemDecisions, setItemDecisions] = useState<
    Record<string, StandupItemDecision>
  >({});
  const [yesterdayDraft, setYesterdayDraft] = useState('');
  const [todayDraft, setTodayDraft] = useState('');
  const [blockersDraft, setBlockersDraft] = useState('');
  const [handoffsDraft, setHandoffsDraft] = useState('');
  const [capacityDraft, setCapacityDraft] = useState('');
  const [userCorrections, setUserCorrections] = useState('');
  const [includedSuggestionIds, setIncludedSuggestionIds] = useState<string[]>([]);
  const [stagedExceptionIds, setStagedExceptionIds] = useState<string[]>([]);

  const initializedParticipantRef = useRef<string | null>(null);

  const navigate = useNavigate();
  const { can, selectedProject, selectedAreaPath } = useAppShell();
  const {
    data: session,
    isLoading: loading,
    error: queryError,
  } = useMyStandupSession(selectedProject);
  const refreshBriefMutation = useRefreshParticipantBrief();
  const submitMutation = useSubmitStandupParticipant();

  const draftedItems = useMemo(
    () => resolveDraftedItemsFromBrief(session?.preparedBrief),
    [session?.preparedBrief],
  );

  useEffect(() => {
    if (!session) return;
    if (initializedParticipantRef.current === session.participantId) return;
    initializedParticipantRef.current = session.participantId;

    const existing = session.structuredUpdate ?? null;
    const initialDecisions: Record<string, StandupItemDecision> = {};
    for (const item of draftedItems) {
      initialDecisions[item.id] =
        existing?.itemDecisions?.[item.id] ?? 'approved';
    }
    setItemDecisions(initialDecisions);
    setYesterdayDraft(
      existing?.yesterday ??
        summarizeBucket(draftedItems, initialDecisions, 'yesterday'),
    );
    setTodayDraft(
      existing?.today ?? summarizeBucket(draftedItems, initialDecisions, 'today'),
    );
    setBlockersDraft(
      existing?.blockers ??
        summarizeBucket(draftedItems, initialDecisions, 'blocker'),
    );
    setHandoffsDraft(existing?.handoffs ?? '');
    setCapacityDraft(existing?.capacity ?? '');
    setUserCorrections(existing?.userCorrections ?? '');
    setIncludedSuggestionIds([]);
    setStagedExceptionIds([]);
  }, [session, draftedItems]);

  const handleWorkItemClick = useCallback(
    async (id: number) => {
      setPanelLoading(true);
      const item = await fetchWorkItem(id, selectedProject, selectedAreaPath);
      if (item) setSelectedItem(item);
      setPanelLoading(false);
    },
    [selectedProject, selectedAreaPath],
  );

  const handleToggleDraftItem = useCallback(
    (item: StandupDraftedItem) => {
      setItemDecisions((prev) => {
        const current = prev[item.id] ?? 'approved';
        const nextDecision: StandupItemDecision =
          current === 'rejected' ? 'approved' : 'rejected';
        const next = { ...prev, [item.id]: nextDecision };

        if (item.bucket === 'yesterday') {
          setYesterdayDraft(summarizeBucket(draftedItems, next, 'yesterday'));
        } else if (item.bucket === 'today') {
          setTodayDraft(summarizeBucket(draftedItems, next, 'today'));
        } else {
          setBlockersDraft(summarizeBucket(draftedItems, next, 'blocker'));
        }
        return next;
      });
    },
    [draftedItems],
  );

  const handleIncludeSuggestedActivity = useCallback(
    (suggestion: StandupSuggestedActivity) => {
      setIncludedSuggestionIds((prev) =>
        prev.includes(suggestion.id) ? prev : [...prev, suggestion.id],
      );
      if (suggestion.bucket === 'yesterday') {
        setYesterdayDraft((prev) => appendLineSegment(prev, suggestion.summary));
      } else {
        setTodayDraft((prev) => appendLineSegment(prev, suggestion.summary));
      }
    },
    [],
  );

  const handleClearDraft = useCallback(() => {
    const rejectedAll: Record<string, StandupItemDecision> = {};
    for (const item of draftedItems) {
      rejectedAll[item.id] = 'rejected';
    }
    setItemDecisions(rejectedAll);
    setYesterdayDraft('');
    setTodayDraft('');
    setBlockersDraft('');
    setError(null);
  }, [draftedItems]);

  const toggleStagedException = useCallback((exceptionId: string) => {
    setStagedExceptionIds((prev) =>
      prev.includes(exceptionId)
        ? prev.filter((id) => id !== exceptionId)
        : [...prev, exceptionId],
    );
  }, []);

  const handleRefreshBrief = useCallback(async () => {
    if (!session) return;
    setError(null);
    try {
      const res = await refreshBriefMutation.mutateAsync({
        participantId: session.participantId,
      });
      const nextItems = resolveDraftedItemsFromBrief(res.preparedBrief);
      const nextDecisions: Record<string, StandupItemDecision> = {};
      for (const item of nextItems) {
        nextDecisions[item.id] = itemDecisions[item.id] ?? 'approved';
      }
      setItemDecisions(nextDecisions);
      setYesterdayDraft(summarizeBucket(nextItems, nextDecisions, 'yesterday'));
      setTodayDraft(summarizeBucket(nextItems, nextDecisions, 'today'));
      setBlockersDraft(summarizeBucket(nextItems, nextDecisions, 'blocker'));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [session, refreshBriefMutation, itemDecisions]);

  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!session) return;
      setError(null);

      const validation = validateStandupCheckIn({
        yesterday: yesterdayDraft,
        today: todayDraft,
        blockers: blockersDraft,
        handoffs: handoffsDraft,
        capacity: capacityDraft,
        userCorrections,
      });
      if (!validation.ok) {
        setError(validation.error);
        return;
      }

      try {
        const brief = session.preparedBrief;
        const proposals: StandupActionProposalInput[] = [];
        const riskMessages: string[] = [];

        if (brief) {
          for (const ex of brief.detectedExceptions) {
            if (ex.severity === 'critical') {
              riskMessages.push(ex.message);
            }
            if (
              stagedExceptionIds.includes(ex.id) &&
              ex.proposedAction &&
              ex.workItemId
            ) {
              proposals.push({
                workItemId: ex.workItemId,
                workItemTitle: ex.workItemTitle ?? `Work Item #${ex.workItemId}`,
                proposalType: ex.proposedAction.proposalType,
                fieldName: ex.proposedAction.fieldName,
                currentValue: ex.proposedAction.currentValue ?? null,
                proposedValue: ex.proposedAction.proposedValue,
                reason: ex.message,
                confidence: ex.severity === 'critical' ? 'at_risk' : 'uncertain',
              });
            }
          }
        }

        const structuredUpdate = reconcileDraftedUpdate({
          draftedItems,
          itemDecisions,
          userCorrections: validation.value.userCorrections,
          manualYesterday: validation.value.yesterday,
          manualToday: validation.value.today,
          manualBlockers: validation.value.blockers,
          atRisk: riskMessages.join('; '),
          handoffs: validation.value.handoffs,
          capacity: validation.value.capacity,
        });

        await submitMutation.mutateAsync({
          participantId: session.participantId,
          structuredUpdate,
          proposals,
        });
        setLocalSubmitted(true);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [
      session,
      yesterdayDraft,
      todayDraft,
      blockersDraft,
      handoffsDraft,
      capacityDraft,
      userCorrections,
      stagedExceptionIds,
      draftedItems,
      itemDecisions,
      submitMutation,
    ],
  );

  if (loading) {
    return (
      <div className={styles.container}>
        <StandupSubNav active="standup" />
        <div className={styles.loading}>Loading your standup check-in...</div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className={styles.container}>
        <StandupSubNav active="standup" />
        <div className={styles.empty}>
          <h2>No Standup Today</h2>
          <p>You don&apos;t have a standup check-in scheduled for today.</p>
          {can('standup:manage') && (
            <button
              type="button"
              className={styles.manageBtn}
              onClick={() => navigate('/standup-manage')}
              {...{ 'data-testid': 'standup-go-manage-btn' }}
            >
              Go to Standup Management →
            </button>
          )}
        </div>
      </div>
    );
  }

  const isSubmitted = localSubmitted || session.status === 'submitted';
  const isSessionClosed = session.sessionStatus === 'completed';
  const deliveryModel = session.config?.deliveryModel ?? 'flow';
  const deliveryModelLabel =
    STANDUP_DELIVERY_MODEL_LABELS[deliveryModel] ?? 'Flow';
  const teamGoal =
    session.config?.teamGoal ?? session.preparedBrief?.teamGoal ?? null;
  const brief = session.preparedBrief;
  const submitting = submitMutation.isPending;
  const combinedError = error ?? (queryError ? queryError.message : null);

  const yesterdayDraftItems = draftedItems
    .filter((i) => i.bucket === 'yesterday')
    .slice(0, MAX_PERSONAL_STANDUP_ITEMS);
  const todayDraftItems = draftedItems
    .filter((i) => i.bucket === 'today')
    .slice(0, MAX_PERSONAL_STANDUP_ITEMS);
  const blockerDraftItems = draftedItems
    .filter((i) => i.bucket === 'blocker')
    .slice(0, 2);

  const proposedQuestions =
    brief?.proposedQuestions && brief.proposedQuestions.length > 0
      ? brief.proposedQuestions.slice(0, 2)
      : [
          teamGoal
            ? `What moved forward since last check-in, and how does today's focus advance “${teamGoal}”?`
            : 'What moved forward since last check-in, what is your #1 focus today, and do you need help from anyone?',
        ];

  const conciseAlerts: Array<{ id: string; label: string }> = [];
  for (const streak of brief?.multiDayArc?.carryoverStreaks ?? []) {
    if (streak.daysCarried >= 2 && conciseAlerts.length < 2) {
      conciseAlerts.push({
        id: `streak-${streak.workItemId}`,
        label: `#${streak.workItemId} carried ${streak.daysCarried}d`,
      });
    }
  }
  for (const ex of brief?.detectedExceptions ?? []) {
    if (ex.severity === 'critical' && conciseAlerts.length < 2) {
      conciseAlerts.push({ id: ex.id, label: ex.message });
    }
  }

  const suggestedActivity = brief?.suggestedActivity ?? [];
  const actionableExceptions = (brief?.detectedExceptions ?? []).filter(
    (ex) => Boolean(ex.proposedAction && ex.workItemId),
  );
  const optionalActivityCount =
    suggestedActivity.length + actionableExceptions.length;

  const renderDraftChips = (items: StandupDraftedItem[]) => {
    if (items.length === 0) return null;
    return (
      <div className={styles.chipList}>
        {items.map((item) => {
          const isRejected = itemDecisions[item.id] === 'rejected';
          return (
            <div
              key={item.id}
              className={`${styles.draftChip} ${
                isRejected ? styles.draftChipExcluded : styles.draftChipIncluded
              }`}
              data-testid={`draft-item-row-${item.id}`}
            >
              {item.workItemId && (
                <button
                  type="button"
                  className={styles.workItemLink}
                  onClick={() => {
                    void handleWorkItemClick(item.workItemId!);
                  }}
                  data-testid={`standup-brief-item-${item.id}`}
                >
                  #{item.workItemId}
                </button>
              )}
              <span className={styles.draftChipText}>
                {item.workItemId
                  ? item.summary.replace(new RegExp(`^#${item.workItemId}\\s*`), '')
                  : item.summary}
              </span>
              <button
                type="button"
                className={styles.chipToggleBtn}
                onClick={() => handleToggleDraftItem(item)}
                disabled={isSessionClosed}
                aria-pressed={!isRejected}
                title={isRejected ? 'Include in check-in' : 'Remove from check-in'}
                data-testid={
                  isRejected
                    ? `draft-item-approve-${item.id}`
                    : `draft-item-reject-${item.id}`
                }
              >
                {isRejected ? '+ Include' : '× Remove'}
              </button>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className={styles.container}>
      <StandupSubNav active="standup" />
      <div className={styles.bodyWrapper}>
        <div
          className={`${styles.body} ${
            selectedItem || panelLoading ? styles.bodyWithPanel : ''
          }`}
        >
          <header className={styles.header}>
            <div className={styles.headerLeft}>
              <h1>My Standup</h1>
              <span className={styles.date}>{session.sessionDate}</span>
              <span
                className={styles.modelBadge}
                {...{ 'data-testid': 'standup-delivery-model-badge' }}
              >
                {deliveryModelLabel}
              </span>
              {isSubmitted && (
                <span
                  className={styles.submittedBadge}
                  {...{ 'data-testid': 'standup-submitted-badge' }}
                >
                  Submitted
                </span>
              )}
            </div>

            <div className={styles.headerRight}>
              <button
                type="button"
                className={styles.refreshBtn}
                onClick={() => {
                  void handleRefreshBrief();
                }}
                disabled={refreshBriefMutation.isPending || isSessionClosed}
                data-testid="standup-refresh-brief-btn"
              >
                {refreshBriefMutation.isPending ? 'Refreshing…' : 'Refresh AI Draft'}
              </button>
            </div>
          </header>

          <div className={styles.scrollArea}>
            <form
              className={styles.checkInCard}
              onSubmit={(e) => {
                void handleSubmit(e);
              }}
              data-testid="standup-checkin-form"
            >
              {isSubmitted && (
                <div
                  className={styles.submittedBanner}
                  {...{ 'data-testid': 'standup-submitted-banner' }}
                >
                  <span>
                    Your check-in is saved and ready for the Scrum Master readout.
                  </span>
                  <button
                    type="button"
                    className={styles.viewPulseBtn}
                    onClick={() =>
                      navigate(
                        `/standup-summary?session=${encodeURIComponent(session.sessionId)}`,
                      )
                    }
                    {...{ 'data-testid': 'standup-view-team-pulse-btn' }}
                  >
                    View Standup Readout →
                  </button>
                </div>
              )}

              {teamGoal && (
                <div
                  className={styles.teamGoalBanner}
                  {...{ 'data-testid': 'standup-team-goal' }}
                >
                  <span className={styles.teamGoalLabel}>Team Goal</span>
                  <span className={styles.teamGoalText}>{teamGoal}</span>
                </div>
              )}

              {/* AI-Led Prompt Banner */}
              <div
                className={styles.aiPromptBanner}
                data-testid="standup-ai-prompt-card"
              >
                <div className={styles.aiPromptHeader}>
                  <span className={styles.aiBadge}>AI Check-In Prompt</span>
                  {conciseAlerts.map((alert) => (
                    <span
                      key={alert.id}
                      className={styles.alertPill}
                      data-testid={`standup-alert-pill-${alert.id}`}
                    >
                      {alert.label}
                    </span>
                  ))}
                </div>
                <ul className={styles.questionList}>
                  {proposedQuestions.map((q, idx) => (
                    <li
                      key={`q-${idx}`}
                      data-testid={`standup-proposed-question-${idx}`}
                    >
                      {q}
                    </li>
                  ))}
                </ul>
              </div>

              {combinedError && (
                <div className={styles.error} role="alert">
                  {combinedError}
                </div>
              )}

              {/* 1. Since last standup */}
              <div
                className={styles.fieldGroup}
                data-testid="standup-draft-group-yesterday"
              >
                <label
                  className={styles.fieldLabel}
                  htmlFor="standup-quick-yesterday"
                >
                  {STANDUP_CHECK_IN_SCHEMA.properties.yesterday.title}
                </label>
                {renderDraftChips(yesterdayDraftItems)}
                <textarea
                  id="standup-quick-yesterday"
                  className={styles.textarea}
                  rows={2}
                  value={yesterdayDraft}
                  onChange={(e) => setYesterdayDraft(e.target.value)}
                  disabled={isSessionClosed}
                  placeholder="What did you finish or move forward since last standup?"
                  data-testid="standup-quick-yesterday"
                />
              </div>

              {/* 2. Today's focus */}
              <div
                className={styles.fieldGroup}
                data-testid="standup-draft-group-today"
              >
                <label
                  className={styles.fieldLabel}
                  htmlFor="standup-quick-today"
                >
                  {STANDUP_CHECK_IN_SCHEMA.properties.today.title}
                </label>
                {renderDraftChips(todayDraftItems)}
                <textarea
                  id="standup-quick-today"
                  className={styles.textarea}
                  rows={2}
                  value={todayDraft}
                  onChange={(e) => setTodayDraft(e.target.value)}
                  disabled={isSessionClosed}
                  placeholder="What is your primary focus today?"
                  data-testid="standup-quick-today"
                />
              </div>

              {/* 3. Blockers or help needed */}
              <div
                className={styles.fieldGroup}
                data-testid="standup-draft-group-blocker"
              >
                <label
                  className={styles.fieldLabel}
                  htmlFor="standup-quick-blockers"
                >
                  {STANDUP_CHECK_IN_SCHEMA.properties.blockers.title}{' '}
                  <span className={styles.optionalTag}>(optional)</span>
                </label>
                {renderDraftChips(blockerDraftItems)}
                <input
                  id="standup-quick-blockers"
                  type="text"
                  className={styles.input}
                  value={blockersDraft}
                  onChange={(e) => setBlockersDraft(e.target.value)}
                  disabled={isSessionClosed}
                  placeholder="Anything blocking you, waiting on a review, or needing a teammate?"
                  data-testid="standup-quick-blockers"
                />
              </div>

              {/* Optional secondary notes (collapsed by default) */}
              <details
                className={styles.optionalDrawer}
                open={Boolean(handoffsDraft || capacityDraft || userCorrections)}
                data-testid="standup-optional-notes-drawer"
              >
                <summary className={styles.drawerSummary}>
                  Add handoff, availability, or correction note (optional)
                </summary>
                <div className={styles.drawerBody}>
                  <div className={styles.twoColGrid}>
                    <label
                      className={styles.subFieldLabel}
                      htmlFor="standup-quick-handoffs"
                    >
                      Handoffs / reviews needed
                      <input
                        id="standup-quick-handoffs"
                        type="text"
                        className={styles.input}
                        value={handoffsDraft}
                        onChange={(e) => setHandoffsDraft(e.target.value)}
                        disabled={isSessionClosed}
                        placeholder="e.g., Ready for QA or waiting on design review"
                        data-testid="standup-quick-handoffs"
                      />
                    </label>
                    <label
                      className={styles.subFieldLabel}
                      htmlFor="standup-quick-capacity"
                    >
                      Availability / PTO
                      <input
                        id="standup-quick-capacity"
                        type="text"
                        className={styles.input}
                        value={capacityDraft}
                        onChange={(e) => setCapacityDraft(e.target.value)}
                        disabled={isSessionClosed}
                        placeholder="e.g., Available to pair, out at 3pm"
                        data-testid="standup-quick-capacity"
                      />
                    </label>
                  </div>
                  <label
                    className={styles.subFieldLabel}
                    htmlFor="standup-corrections-input"
                  >
                    Additional note or correction
                    <input
                      id="standup-corrections-input"
                      type="text"
                      className={styles.input}
                      value={userCorrections}
                      onChange={(e) => setUserCorrections(e.target.value)}
                      disabled={isSessionClosed}
                      placeholder="Anything else the Scrum Master should know?"
                      data-testid="standup-corrections-input"
                    />
                  </label>
                </div>
              </details>

              {/* Optional suggested activity (unowned ChangedBy items, overflow, or staged ADO proposals — never preselected) */}
              {optionalActivityCount > 0 && (
                <details
                  className={styles.optionalDrawer}
                  data-testid="standup-suggested-activity-drawer"
                >
                  <summary className={styles.drawerSummary}>
                    Review suggested activity ({optionalActivityCount} not included by default)
                  </summary>
                  <div className={styles.drawerBody}>
                    {suggestedActivity.length > 0 && (
                      <ul className={styles.suggestedList}>
                        {suggestedActivity.map((s) => {
                          const included = includedSuggestionIds.includes(s.id);
                          return (
                            <li
                              key={s.id}
                              className={styles.suggestedRow}
                              data-testid={`suggested-activity-row-${s.id}`}
                            >
                              <div className={styles.suggestedMeta}>
                                <span className={styles.suggestedSummary}>
                                  {s.summary}
                                </span>
                                <span className={styles.suggestedReason}>
                                  {s.reason}
                                </span>
                              </div>
                              <button
                                type="button"
                                className={styles.includeBtn}
                                disabled={included || isSessionClosed}
                                onClick={() => handleIncludeSuggestedActivity(s)}
                                data-testid={`suggested-activity-include-${s.id}`}
                              >
                                {included ? 'Added' : '+ Add'}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}

                    {actionableExceptions.length > 0 && (
                      <div
                        className={styles.proposalsWrap}
                        data-testid="standup-brief-exceptions"
                      >
                        {actionableExceptions.map((ex) => {
                          const staged = stagedExceptionIds.includes(ex.id);
                          return (
                            <label
                              key={ex.id}
                              className={styles.proposalCheckboxRow}
                              htmlFor={`stage-proposal-${ex.id}`}
                            >
                              <input
                                id={`stage-proposal-${ex.id}`}
                                type="checkbox"
                                checked={staged}
                                disabled={isSessionClosed}
                                onChange={() => toggleStagedException(ex.id)}
                                data-testid={`standup-stage-proposal-${ex.id}`}
                              />
                              <span>
                                Stage optional ticket update: {ex.proposedAction!.label}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </details>
              )}

              {!isSessionClosed && (
                <div className={styles.actionsBar}>
                  <button
                    type="button"
                    className={styles.clearBtn}
                    onClick={handleClearDraft}
                    disabled={submitting}
                    data-testid="standup-clear-draft-btn"
                  >
                    Clear Draft
                  </button>
                  <button
                    type="submit"
                    className={styles.submitBtn}
                    disabled={submitting}
                    data-testid="standup-quick-submit-btn"
                  >
                    {submitting
                      ? 'Saving…'
                      : isSubmitted
                      ? 'Update Check-In'
                      : 'Confirm & Submit'}
                  </button>
                </div>
              )}
            </form>
          </div>
        </div>

        {(selectedItem || panelLoading) && (
          <Suspense fallback={null}>
            {selectedItem && (
              <DetailsPanel
                workItem={selectedItem}
                onClose={() => setSelectedItem(null)}
                onUpdateDueDate={() => {}}
                onSelectItem={(item) => setSelectedItem(item)}
                project={selectedProject}
                areaPath={selectedAreaPath}
                {...{ 'data-testid': 'standup-work-item-details-panel' }}
              />
            )}
          </Suspense>
        )}
      </div>
    </div>
  );
};

export default StandupCeremonyView;

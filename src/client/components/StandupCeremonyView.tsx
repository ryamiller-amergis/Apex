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
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useChatThread } from '../hooks/useChatThreads';
import { useAgentChatSession } from '../hooks/useAgentChatSession';
import { useChatAttachments } from '../hooks/useChatAttachments';
import { useAppShell } from '../hooks/useAppShell';
import { useSpeechInput } from '../hooks/useSpeechInput';
import {
  useMyStandupSession,
  useRefreshParticipantBrief,
  useSubmitStandupParticipant,
} from '../hooks/useStandupDeliveryPulse';
import { AgentComposer } from './agentChat';
import {
  STANDUP_DELIVERY_MODEL_LABELS,
  STANDUP_WORK_DOMAIN_LABELS,
  type ParticipantPreparedBrief,
  type StandupActionProposalInput,
  type StandupDraftedItem,
  type StandupItemDecision,
} from '../../shared/types/standup';
import { reconcileDraftedUpdate } from '../../shared/utils/standupDeliveryPolicy';
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

function flattenText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join('');
  if (React.isValidElement(node)) return flattenText(node.props.children);
  return '';
}

function workItemTypeClass(type: string): string {
  const key = type.trim().toLowerCase().replace(/\s+/g, '-');
  const map: Record<string, string> = {
    epic: styles.typeEpic,
    feature: styles.typeFeature,
    bug: styles.typeBug,
    'product-backlog-item': styles.typePbi,
    'technical-backlog-item': styles.typeTbi,
    task: styles.typeTask,
  };
  return map[key] ?? styles.typeDefault;
}

function isReleaseLine(text: string): boolean {
  return /Release:\s*[\w.]+/.test(text) || text.includes('🎯');
}

function renderWorkItemLinks(
  text: string,
  onWorkItemClick: (id: number) => void,
  keyPrefix: string,
): React.ReactNode[] {
  const parts = text.split(/(#\d+)/g);
  return parts.map((part, i) => {
    const match = part.match(/^#(\d+)$/);
    if (match) {
      const id = parseInt(match[1], 10);
      return (
        <button
          key={`${keyPrefix}-id-${i}`}
          type="button"
          className={styles.workItemLink}
          onClick={(e) => {
            e.preventDefault();
            onWorkItemClick(id);
          }}
          title={`View work item #${id}`}
          {...{ 'data-testid': `standup-work-item-link-${id}` }}
        >
          {part}
        </button>
      );
    }
    return <React.Fragment key={`${keyPrefix}-txt-${i}`}>{part}</React.Fragment>;
  });
}

function processStandupText(
  text: string,
  onWorkItemClick: (id: number) => void,
  keyPrefix: string,
): React.ReactNode {
  const releaseSuffix = text.match(/( · Release: [^🎯\n]+)( 🎯)?$/u);
  const withoutRelease = releaseSuffix ? text.slice(0, releaseSuffix.index) : text;

  const typeMatch = withoutRelease.match(
    /^(#\d+)( · )([A-Za-z][A-Za-z ]*?)( — )(.*)$/,
  );
  if (typeMatch) {
    const [, idPart, sep1, type, sep2, rest] = typeMatch;
    return (
      <>
        {renderWorkItemLinks(idPart, onWorkItemClick, `${keyPrefix}-id`)}
        {sep1}
        <span className={`${styles.workItemTypeBadge} ${workItemTypeClass(type)}`}>
          {type.trim()}
        </span>
        {sep2}
        {renderWorkItemLinks(rest, onWorkItemClick, `${keyPrefix}-rest`)}
        {releaseSuffix && (
          <span className={styles.releaseBadge}>
            {releaseSuffix[1].replace(/^ · /, '')}
            {releaseSuffix[2] ?? ''}
          </span>
        )}
      </>
    );
  }

  const nodes = renderWorkItemLinks(withoutRelease, onWorkItemClick, keyPrefix);
  if (!releaseSuffix) return <>{nodes}</>;
  return (
    <>
      {nodes}
      <span className={styles.releaseBadge}>
        {releaseSuffix[1].replace(/^ · /, '')}
        {releaseSuffix[2] ?? ''}
      </span>
    </>
  );
}

function makeMarkdownComponents(onWorkItemClick: (id: number) => void) {
  const wrap = (
    Tag: 'p' | 'td' | 'strong',
    children: React.ReactNode,
    props: Record<string, unknown>,
  ) => {
    const processed = processChildren(children, onWorkItemClick);
    return React.createElement(Tag, props, processed);
  };

  return {
    p: ({ children, ...props }: React.ComponentProps<'p'>) =>
      wrap('p', children, props),
    td: ({ children, ...props }: React.ComponentProps<'td'>) =>
      wrap('td', children, props),
    strong: ({ children, ...props }: React.ComponentProps<'strong'>) =>
      wrap('strong', children, props),
    li: ({ children, ...props }: React.ComponentProps<'li'>) => {
      const text = flattenText(children);
      const processed = processChildren(children, onWorkItemClick);
      const className =
        [props.className, isReleaseLine(text) ? styles.releaseItem : '']
          .filter(Boolean)
          .join(' ') || undefined;
      return (
        <li {...props} className={className}>
          {processed}
        </li>
      );
    },
  };
}

function processChildren(
  children: React.ReactNode,
  onWorkItemClick: (id: number) => void,
): React.ReactNode {
  return React.Children.map(children, (child, index) => {
    if (typeof child !== 'string') return child;
    if (!/#\d+/.test(child) && !/Release:\s*[\w.]+/.test(child)) return child;
    return (
      <React.Fragment key={`standup-text-${index}`}>
        {processStandupText(child, onWorkItemClick, `seg-${index}`)}
      </React.Fragment>
    );
  });
}

function resolveDraftedItemsFromBrief(
  brief: ParticipantPreparedBrief | null | undefined,
): StandupDraftedItem[] {
  if (!brief) return [];
  if (Array.isArray(brief.draftedItems) && brief.draftedItems.length > 0) {
    return brief.draftedItems;
  }

  const fallback: StandupDraftedItem[] = [];
  brief.accomplishedSinceLast.forEach((acc, idx) => {
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
    });
  });

  brief.suggestedToday.slice(0, 5).forEach((item) => {
    fallback.push({
      id: `draft-today-wi-${item.workItemId}`,
      bucket: 'today',
      summary: `#${item.workItemId} ${item.title} [${item.state}]`,
      workItemId: item.workItemId,
      evidence: 'Assigned in ADO',
    });
  });

  brief.detectedExceptions
    .filter(
      (ex) =>
        ex.kind === 'pipeline_failure' ||
        ex.kind === 'sla_breach' ||
        ex.kind === 'pr_waiting_review',
    )
    .forEach((ex) => {
      fallback.push({
        id: `draft-blocker-${ex.id}`,
        bucket: 'blocker',
        summary: ex.message,
        workItemId: ex.workItemId,
        prId: ex.prId,
        evidence: ex.kind,
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

export const StandupCeremonyView: React.FC = () => {
  const [modeOverride, setModeOverride] = useState<'quick' | 'chat' | null>(null);
  const [localSubmitted, setLocalSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [selectedItem, setSelectedItem] = useState<WorkItem | null>(null);
  const [panelLoading, setPanelLoading] = useState(false);

  const [itemDecisions, setItemDecisions] = useState<
    Record<string, StandupItemDecision>
  >({});
  const [rejectionReasons, setRejectionReasons] = useState<Record<string, string>>({});
  const [userCorrections, setUserCorrections] = useState('');
  const [manualOverrideMode, setManualOverrideMode] = useState(false);

  const [yesterdayDraft, setYesterdayDraft] = useState('');
  const [todayDraft, setTodayDraft] = useState('');
  const [blockersDraft, setBlockersDraft] = useState('');
  const [handoffsDraft, setHandoffsDraft] = useState('');
  const [capacityDraft, setCapacityDraft] = useState('');
  const [stagedExceptionIds, setStagedExceptionIds] = useState<string[]>([]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const initializedParticipantRef = useRef<string | null>(null);

  const { can, selectedProject, selectedAreaPath } = useAppShell();
  const {
    data: session,
    isLoading: loading,
    error: queryError,
  } = useMyStandupSession(selectedProject);
  const refreshBriefMutation = useRefreshParticipantBrief();
  const submitMutation = useSubmitStandupParticipant();

  const threadId = session?.threadId ?? null;
  const { data: thread } = useChatThread(threadId);

  const draftedItems = useMemo(
    () => resolveDraftedItemsFromBrief(session?.preparedBrief),
    [session?.preparedBrief],
  );

  const mdComponents = useMemo(
    () =>
      makeMarkdownComponents((id: number) => {
        setPanelLoading(true);
        void fetchWorkItem(id, selectedProject, selectedAreaPath)
          .then((item) => {
            if (item) setSelectedItem(item);
          })
          .finally(() => setPanelLoading(false));
      }),
    [selectedProject, selectedAreaPath],
  );

  const syncToken = useCallback(async (tid: string) => {
    try {
      await fetch(`/api/standup/threads/${tid}/sync-token`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // non-fatal
    }
  }, []);

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
    setUserCorrections(existing?.userCorrections ?? '');
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
    setStagedExceptionIds([]);
    if (session.threadId) {
      void syncToken(session.threadId);
    }
  }, [session, draftedItems, syncToken]);

  const navigate = useNavigate();

  const chatSession = useAgentChatSession(threadId, {
    initialMessages: thread?.messages,
    initialStatus: thread?.status,
    beforeSend: async () => {
      if (threadId) await syncToken(threadId);
    },
  });

  const {
    messages,
    streamingText,
    thinkingText,
    isRetrying,
    retryReason,
    isRunning,
    status: streamStatus,
    showTypingIndicator,
  } = chatSession;

  const {
    attachments,
    attachmentError,
    addFiles,
    removeAttachment,
    clearAttachments,
  } = useChatAttachments();

  const speech = useSpeechInput(
    useCallback((text: string) => setInput(text), []),
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText, thinkingText, streamStatus]);

  const handleWorkItemClick = useCallback(
    async (id: number) => {
      setPanelLoading(true);
      const item = await fetchWorkItem(id, selectedProject, selectedAreaPath);
      if (item) setSelectedItem(item);
      setPanelLoading(false);
    },
    [selectedProject, selectedAreaPath],
  );

  const handleAttachmentChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      await addFiles(event.currentTarget.files);
      event.currentTarget.value = '';
    },
    [addFiles],
  );

  const handleSend = useCallback(async () => {
    const text = input.trim();
    const outgoing = [...attachments];
    if ((!text && outgoing.length === 0) || !threadId) return;
    if (speech.isListening) speech.stop();
    const message = text || 'Please use the attached files as additional context.';
    setInput('');
    const sent = await chatSession.send(
      message,
      outgoing.length > 0 ? { attachments: outgoing } : undefined,
    );
    if (sent && outgoing.length > 0) clearAttachments();
  }, [attachments, chatSession, clearAttachments, input, speech, threadId]);

  const handleItemDecision = useCallback(
    (itemId: string, decision: StandupItemDecision) => {
      setManualOverrideMode(false);
      setItemDecisions((prev) => {
        const next = { ...prev, [itemId]: decision };
        setYesterdayDraft(summarizeBucket(draftedItems, next, 'yesterday'));
        setTodayDraft(summarizeBucket(draftedItems, next, 'today'));
        setBlockersDraft(summarizeBucket(draftedItems, next, 'blocker'));
        return next;
      });
    },
    [draftedItems],
  );

  const handleRejectAllManual = useCallback(() => {
    const rejectedAll: Record<string, StandupItemDecision> = {};
    for (const item of draftedItems) {
      rejectedAll[item.id] = 'rejected';
    }
    setItemDecisions(rejectedAll);
    setManualOverrideMode(true);
    setYesterdayDraft('');
    setTodayDraft('');
    setBlockersDraft('');
  }, [draftedItems]);

  const toggleStagedException = useCallback((exceptionId: string) => {
    setStagedExceptionIds((prev) =>
      prev.includes(exceptionId)
        ? prev.filter((id) => id !== exceptionId)
        : [...prev, exceptionId],
    );
  }, []);

  const handleQuickSubmit = useCallback(async () => {
    if (!session) return;
    setError(null);
    try {
      const brief = session.preparedBrief;
      const proposals: StandupActionProposalInput[] = [];
      const riskMessages: string[] = [];

      if (brief) {
        for (const ex of brief.detectedExceptions) {
          if (
            ex.severity === 'critical' ||
            ex.kind === 'stale_state' ||
            ex.kind === 'target_date_at_risk'
          ) {
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
        rejectionReasons,
        userCorrections,
        manualYesterday: manualOverrideMode ? yesterdayDraft : yesterdayDraft,
        manualToday: manualOverrideMode ? todayDraft : todayDraft,
        manualBlockers: manualOverrideMode ? blockersDraft : blockersDraft,
        atRisk: riskMessages.join('; '),
        handoffs: handoffsDraft,
        capacity: capacityDraft,
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
  }, [
    session,
    stagedExceptionIds,
    draftedItems,
    itemDecisions,
    rejectionReasons,
    userCorrections,
    manualOverrideMode,
    yesterdayDraft,
    todayDraft,
    blockersDraft,
    handoffsDraft,
    capacityDraft,
    submitMutation,
  ]);

  const handleChatSubmit = useCallback(async () => {
    if (!session) return;
    setError(null);
    try {
      await submitMutation.mutateAsync({ participantId: session.participantId });
      setLocalSubmitted(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [session, submitMutation]);

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
      if (!manualOverrideMode) {
        setYesterdayDraft(summarizeBucket(nextItems, nextDecisions, 'yesterday'));
        setTodayDraft(summarizeBucket(nextItems, nextDecisions, 'today'));
        setBlockersDraft(summarizeBucket(nextItems, nextDecisions, 'blocker'));
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }, [session, refreshBriefMutation, itemDecisions, manualOverrideMode]);

  if (loading) {
    return (
      <div className={styles.container}>
        <StandupSubNav active="standup" />
        <div className={styles.loading}>Loading your standup session...</div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className={styles.container}>
        <StandupSubNav active="standup" />
        <div className={styles.empty}>
          <h2>No Standup Today</h2>
          <p>You don&apos;t have a standup session scheduled for today.</p>
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
  const deliveryModel = session.config?.deliveryModel ?? 'flow';
  const deliveryModelLabel =
    STANDUP_DELIVERY_MODEL_LABELS[deliveryModel] ?? 'Flow';
  const teamGoal =
    session.config?.teamGoal ?? session.preparedBrief?.teamGoal ?? null;
  const activeMode: 'quick' | 'chat' =
    modeOverride ?? (session.preparedBrief ? 'quick' : 'chat');
  const brief = session.preparedBrief;
  const submitting = submitMutation.isPending;

  const visibleMessages = messages.filter(
    (m) =>
      !m.hidden &&
      !(m.role === 'user' && m.text === 'Begin.') &&
      m.role !== 'tool' &&
      m.toolName !== '_thinking' &&
      m.toolName !== '_reasoning',
  );

  const combinedError = error ?? (queryError ? queryError.message : null);

  const yesterdayDraftItems = draftedItems.filter((i) => i.bucket === 'yesterday');
  const todayDraftItems = draftedItems.filter((i) => i.bucket === 'today');
  const blockerDraftItems = draftedItems.filter((i) => i.bucket === 'blocker');

  const renderDraftBucket = (
    title: string,
    testId: string,
    items: StandupDraftedItem[],
    emptyText: string,
  ) => (
    <section className={styles.briefCard} data-testid={testId}>
      <div className={styles.cardHeader}>
        <h2>{title}</h2>
      </div>
      {items.length === 0 ? (
        <p className={styles.cardHint}>{emptyText}</p>
      ) : (
        <ul className={styles.draftItemList}>
          {items.map((item) => {
            const decision = itemDecisions[item.id] ?? 'approved';
            const isRejected = decision === 'rejected';
            return (
              <li
                key={item.id}
                className={`${styles.draftItemRow} ${
                  isRejected ? styles.draftItemRejected : styles.draftItemApproved
                }`}
                data-testid={`draft-item-row-${item.id}`}
              >
                <div className={styles.draftItemTop}>
                  <div className={styles.draftItemInfo}>
                    {item.domain && (
                      <span className={styles.domainPill}>
                        {STANDUP_WORK_DOMAIN_LABELS[item.domain] ?? item.domain}
                      </span>
                    )}
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
                    <span
                      className={
                        isRejected
                          ? styles.draftSummaryRejected
                          : styles.draftSummaryText
                      }
                    >
                      {item.summary}
                    </span>
                    <span className={styles.evidenceMeta}>{item.evidence}</span>
                  </div>

                  <div
                    className={styles.decisionToggle}
                    role="group"
                    aria-label={`Decision for ${item.summary}`}
                  >
                    <button
                      type="button"
                      className={`${styles.decisionBtn} ${
                        !isRejected ? styles.decisionApproveActive : ''
                      }`}
                      onClick={() => handleItemDecision(item.id, 'approved')}
                      disabled={isSubmitted}
                      aria-pressed={!isRejected}
                      data-testid={`draft-item-approve-${item.id}`}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className={`${styles.decisionBtn} ${
                        isRejected ? styles.decisionRejectActive : ''
                      }`}
                      onClick={() => handleItemDecision(item.id, 'rejected')}
                      disabled={isSubmitted}
                      aria-pressed={isRejected}
                      data-testid={`draft-item-reject-${item.id}`}
                    >
                      Reject
                    </button>
                  </div>
                </div>

                {isRejected && (
                  <div className={styles.rejectReasonWrap}>
                    <input
                      type="text"
                      className={styles.rejectReasonInput}
                      placeholder="Optional note: why reject this item? (e.g. moved to next sprint, another dev owns it)"
                      value={rejectionReasons[item.id] ?? ''}
                      disabled={isSubmitted}
                      onChange={(e) =>
                        setRejectionReasons((prev) => ({
                          ...prev,
                          [item.id]: e.target.value,
                        }))
                      }
                      data-testid={`draft-item-reject-reason-${item.id}`}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );

  return (
    <div className={styles.container}>
      <StandupSubNav active="standup" />
      <div className={styles.bodyWrapper}>
        <div className={`${styles.body} ${selectedItem ? styles.bodyWithPanel : ''}`}>
          <header className={styles.header}>
            <div className={styles.headerLeft}>
              <h1>Daily Standup</h1>
              <span className={styles.date}>{session.sessionDate}</span>
              <span
                className={styles.modelBadge}
                {...{ 'data-testid': 'standup-delivery-model-badge' }}
              >
                {deliveryModelLabel}
              </span>
              {brief?.workDomains?.map((domain) => (
                <span key={domain} className={styles.domainPill}>
                  {STANDUP_WORK_DOMAIN_LABELS[domain] ?? domain}
                </span>
              ))}
            </div>

            <div className={styles.headerRight}>
              <div
                className={styles.modeSwitch}
                role="group"
                aria-label="Standup interaction mode"
              >
                <button
                  type="button"
                  className={`${styles.modeBtn} ${
                    activeMode === 'quick' ? styles.modeBtnActive : ''
                  }`}
                  onClick={() => setModeOverride('quick')}
                  aria-pressed={activeMode === 'quick'}
                  {...{ 'data-testid': 'standup-mode-quick' }}
                >
                  Review AI Draft
                </button>
                <button
                  type="button"
                  className={`${styles.modeBtn} ${
                    activeMode === 'chat' ? styles.modeBtnActive : ''
                  }`}
                  onClick={() => setModeOverride('chat')}
                  aria-pressed={activeMode === 'chat'}
                  {...{ 'data-testid': 'standup-mode-chat' }}
                >
                  Discuss with Coach
                </button>
              </div>
              {isSubmitted && (
                <span
                  className={styles.badge}
                  {...{ 'data-testid': 'standup-submitted-badge' }}
                >
                  Submitted
                </span>
              )}
            </div>
          </header>

          {teamGoal && (
            <div
              className={styles.teamGoalBanner}
              {...{ 'data-testid': 'standup-team-goal' }}
            >
              <span className={styles.teamGoalLabel}>Team Goal</span>
              <span className={styles.teamGoalText}>{teamGoal}</span>
            </div>
          )}

          {isSubmitted && (
            <div
              className={styles.submittedBanner}
              {...{ 'data-testid': 'standup-submitted-banner' }}
            >
              <span>
                Your standup update is submitted and included in today&apos;s Team Pulse.
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
                View Team Pulse →
              </button>
            </div>
          )}

          {activeMode === 'quick' ? (
            <div
              className={styles.quickConfirmScroll}
              {...{ 'data-testid': 'standup-quick-confirm-view' }}
            >
              {/* Multi-Day Arc & Recommended Focus */}
              <div className={styles.arcFocusGrid}>
                {brief?.multiDayArc && (
                  <div
                    className={styles.arcBanner}
                    data-testid="standup-multi-day-arc"
                  >
                    <div className={styles.arcHeader}>
                      <span className={styles.arcLabel}>Multi-Day Arc</span>
                      <button
                        type="button"
                        className={styles.refreshBtn}
                        onClick={() => {
                          void handleRefreshBrief();
                        }}
                        disabled={refreshBriefMutation.isPending}
                        data-testid="standup-refresh-brief-btn"
                      >
                        {refreshBriefMutation.isPending
                          ? 'Refreshing…'
                          : 'Refresh Evidence'}
                      </button>
                    </div>
                    <div className={styles.arcSummaryText}>
                      {brief.multiDayArc.summary}
                    </div>
                    {brief.multiDayArc.carryoverStreaks.length > 0 && (
                      <div className={styles.streakPills}>
                        {brief.multiDayArc.carryoverStreaks.map((s) => (
                          <span
                            key={s.workItemId}
                            className={styles.riskFlagPill}
                            data-testid={`standup-carryover-streak-${s.workItemId}`}
                          >
                            #{s.workItemId} carried {s.daysCarried}d
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {brief?.recommendedFocus && (
                  <div
                    className={styles.focusBanner}
                    data-testid="standup-recommended-focus"
                  >
                    <span className={styles.arcLabel}>Recommended Focus Today</span>
                    <div className={styles.arcSummaryText}>
                      {brief.recommendedFocus}
                    </div>
                  </div>
                )}
              </div>

              <div className={styles.quickGrid}>
                {/* Pre-Drafted Buckets with Approve / Reject */}
                {renderDraftBucket(
                  'Done Yesterday (AI-Drafted from ADO & PRs)',
                  'standup-draft-group-yesterday',
                  yesterdayDraftItems,
                  'No automatic ADO or PR completions detected since last standup.',
                )}

                {renderDraftBucket(
                  'Assigned & Focus Today',
                  'standup-draft-group-today',
                  todayDraftItems,
                  'No active ADO assignments pre-drafted for today.',
                )}

                {renderDraftBucket(
                  'Blockers & SDLC Alerts',
                  'standup-draft-group-blocker',
                  blockerDraftItems,
                  'No pipeline, SLA, or SDLC alerts detected.',
                )}

                {/* Prior Commitment Check */}
                {brief && brief.priorCommitments.length > 0 && (
                  <section
                    className={styles.briefCard}
                    {...{ 'data-testid': 'standup-brief-commitments' }}
                  >
                    <div className={styles.cardHeader}>
                      <h2>Prior Commitment Check</h2>
                    </div>
                    <ul className={styles.commitmentList}>
                      {brief.priorCommitments.map((commitment, idx) => (
                        <li
                          key={`commit-${idx}`}
                          className={styles.commitmentItem}
                          {...{ 'data-testid': `standup-commitment-${idx}` }}
                        >
                          <span
                            className={`${styles.commitmentBadge} ${
                              commitment.status === 'completed'
                                ? styles.commitmentCompleted
                                : commitment.status === 'progressed'
                                ? styles.commitmentProgressed
                                : styles.commitmentUntouched
                            }`}
                            {...{ 'data-testid': `standup-commitment-status-${idx}` }}
                          >
                            {commitment.status === 'untouched'
                              ? 'Carryover'
                              : commitment.status === 'completed'
                              ? 'Completed'
                              : 'Progressed'}
                          </span>
                          <div className={styles.commitmentBody}>
                            <div className={styles.commitmentSummary}>
                              {commitment.summary}
                            </div>
                            <div className={styles.commitmentNote}>
                              {commitment.note}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {/* Exceptions & Proposed ADO Updates */}
                <section
                  className={styles.briefCard}
                  {...{ 'data-testid': 'standup-brief-exceptions' }}
                >
                  <div className={styles.cardHeader}>
                    <h2>Exceptions &amp; Confirmation-Gated ADO Proposals</h2>
                  </div>
                  {brief && brief.detectedExceptions.length > 0 ? (
                    <ul className={styles.exceptionList}>
                      {brief.detectedExceptions.map((ex) => {
                        const staged = stagedExceptionIds.includes(ex.id);
                        return (
                          <li
                            key={ex.id}
                            className={`${styles.exceptionItem} ${
                              ex.severity === 'critical'
                                ? styles.exceptionCritical
                                : styles.exceptionWarning
                            }`}
                            {...{ 'data-testid': `standup-exception-${ex.id}` }}
                          >
                            <div className={styles.exceptionHeader}>
                              <span className={styles.exceptionSeverity}>
                                {ex.severity}
                              </span>
                              <span className={styles.exceptionMessage}>
                                {ex.message}
                              </span>
                            </div>
                            {ex.proposedAction && (
                              <label
                                className={styles.proposalCheckboxRow}
                                htmlFor={`stage-proposal-${ex.id}`}
                              >
                                <input
                                  id={`stage-proposal-${ex.id}`}
                                  type="checkbox"
                                  checked={staged}
                                  disabled={isSubmitted}
                                  onChange={() => toggleStagedException(ex.id)}
                                  {...{
                                    'data-testid': `standup-stage-proposal-${ex.id}`,
                                  }}
                                />
                                <span>
                                  Stage proposed update for confirmation:{' '}
                                  {ex.proposedAction.label}
                                </span>
                              </label>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className={styles.cardHint}>
                      No delivery exceptions detected under the {deliveryModelLabel} policy.
                    </p>
                  )}
                </section>

                {/* Corrections & Additions + Editable Update Fields */}
                <section
                  className={styles.briefCard}
                  data-testid="standup-corrections-card"
                >
                  <div className={styles.cardHeader}>
                    <h2>
                      Corrections, Additions &amp; Final Standup Text
                    </h2>
                  </div>
                  <label
                    className={styles.fieldLabel}
                    htmlFor="standup-corrections-input"
                  >
                    Corrections &amp; Additions (What did the agent miss or get wrong?)
                    <textarea
                      id="standup-corrections-input"
                      className={styles.quickTextarea}
                      rows={2}
                      value={userCorrections}
                      onChange={(e) => setUserCorrections(e.target.value)}
                      disabled={isSubmitted}
                      placeholder="Add untracked work, clarify status drift, or note context for the facilitator and tomorrow's standup..."
                      data-testid="standup-corrections-input"
                    />
                  </label>

                  <div className={styles.notesGrid}>
                    <label
                      className={styles.fieldLabel}
                      htmlFor="standup-quick-yesterday"
                    >
                      Yesterday summary (auto-synced from approved items)
                      <textarea
                        id="standup-quick-yesterday"
                        className={styles.quickTextarea}
                        rows={2}
                        value={yesterdayDraft}
                        onChange={(e) => {
                          setManualOverrideMode(true);
                          setYesterdayDraft(e.target.value);
                        }}
                        disabled={isSubmitted}
                        placeholder="What moved forward since last standup?"
                        data-testid="standup-quick-yesterday"
                      />
                    </label>
                    <label
                      className={styles.fieldLabel}
                      htmlFor="standup-quick-today"
                    >
                      Today&apos;s plan (auto-synced from approved items)
                      <textarea
                        id="standup-quick-today"
                        className={styles.quickTextarea}
                        rows={2}
                        value={todayDraft}
                        onChange={(e) => {
                          setManualOverrideMode(true);
                          setTodayDraft(e.target.value);
                        }}
                        disabled={isSubmitted}
                        placeholder="What are you focusing on today?"
                        data-testid="standup-quick-today"
                      />
                    </label>
                  </div>

                  <div className={styles.notesGrid}>
                    <label
                      className={styles.fieldLabel}
                      htmlFor="standup-quick-blockers"
                    >
                      Blockers (optional)
                      <input
                        id="standup-quick-blockers"
                        type="text"
                        className={styles.quickInput}
                        value={blockersDraft}
                        onChange={(e) => {
                          setManualOverrideMode(true);
                          setBlockersDraft(e.target.value);
                        }}
                        disabled={isSubmitted}
                        placeholder="Pipeline failure, review wait, external dependency, or none"
                        data-testid="standup-quick-blockers"
                      />
                    </label>
                    <label
                      className={styles.fieldLabel}
                      htmlFor="standup-quick-handoffs"
                    >
                      Handoffs / Reviews needed (optional)
                      <input
                        id="standup-quick-handoffs"
                        type="text"
                        className={styles.quickInput}
                        value={handoffsDraft}
                        onChange={(e) => setHandoffsDraft(e.target.value)}
                        disabled={isSubmitted}
                        placeholder="e.g., #104 ready for QA or PR review"
                        data-testid="standup-quick-handoffs"
                      />
                    </label>
                    <label
                      className={styles.fieldLabel}
                      htmlFor="standup-quick-capacity"
                    >
                      Capacity / Availability (optional)
                      <input
                        id="standup-quick-capacity"
                        type="text"
                        className={styles.quickInput}
                        value={capacityDraft}
                        onChange={(e) => setCapacityDraft(e.target.value)}
                        disabled={isSubmitted}
                        placeholder="Available to pair, off Friday afternoon, etc."
                        data-testid="standup-quick-capacity"
                      />
                    </label>
                  </div>
                </section>
              </div>

              {!isSubmitted && (
                <div className={styles.quickActionsBar}>
                  <div className={styles.leftActionGroup}>
                    <button
                      type="button"
                      className={styles.rejectAllBtn}
                      onClick={handleRejectAllManual}
                      disabled={submitting}
                      data-testid="standup-reject-all-btn"
                    >
                      Reject All &amp; Write Manually
                    </button>
                    <button
                      type="button"
                      className={styles.secondaryCoachBtn}
                      onClick={() => setModeOverride('chat')}
                      data-testid="standup-switch-coach-btn"
                    >
                      Discuss with Coach
                    </button>
                  </div>
                  <button
                    type="button"
                    className={styles.quickSubmitBtn}
                    onClick={() => {
                      void handleQuickSubmit();
                    }}
                    disabled={submitting}
                    data-testid="standup-quick-submit-btn"
                  >
                    {submitting ? 'Submitting…' : 'Approve & Submit Update'}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <>
              <div className={styles.messages}>
                {visibleMessages.map((msg, idx) => {
                  const prevRole = idx > 0 ? visibleMessages[idx - 1].role : null;
                  const nextRole =
                    idx < visibleMessages.length - 1
                      ? visibleMessages[idx + 1].role
                      : null;
                  const isFirstInGroup = prevRole !== msg.role;
                  const isLastInGroup = nextRole !== msg.role;
                  return (
                    <div
                      key={msg.id}
                      className={[
                        styles.message,
                        styles[msg.role],
                        !isFirstInGroup ? styles.messageGrouped : '',
                        !isLastInGroup ? styles.messageGroupedTop : '',
                      ].join(' ')}
                    >
                      {isFirstInGroup && (
                        <div className={styles.role}>
                          {msg.role === 'agent' ? 'Standup Coach' : 'You'}
                        </div>
                      )}
                      <div className={styles.bubble}>
                        {msg.role === 'agent' ? (
                          <div className={styles.mdContent}>
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm]}
                              components={mdComponents}
                            >
                              {msg.text}
                            </ReactMarkdown>
                          </div>
                        ) : (
                          msg.text
                        )}
                      </div>
                    </div>
                  );
                })}

                {streamingText && (
                  <div
                    className={`${styles.message} ${styles.agent} ${
                      visibleMessages.length > 0 &&
                      visibleMessages[visibleMessages.length - 1].role === 'agent'
                        ? styles.messageGrouped
                        : ''
                    }`}
                  >
                    {!(
                      visibleMessages.length > 0 &&
                      visibleMessages[visibleMessages.length - 1].role === 'agent'
                    ) && <div className={styles.role}>Standup Coach</div>}
                    <div className={styles.bubble}>
                      <div className={styles.mdContent}>
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={mdComponents}
                        >
                          {streamingText}
                        </ReactMarkdown>
                        <span className={styles.streamCursor} aria-hidden="true" />
                      </div>
                    </div>
                  </div>
                )}

                {showTypingIndicator && (
                  <div className={`${styles.message} ${styles.agent}`}>
                    <div className={styles.role}>Standup Coach</div>
                    <div className={styles.bubble}>
                      <div className={styles.thinkingBubble}>
                        {thinkingText ? (
                          <span className={styles.thinkingText}>{thinkingText}</span>
                        ) : (
                          <div
                            className={styles.typingIndicator}
                            aria-label="Agent is thinking"
                          >
                            <span className={styles.typingDot} />
                            <span className={styles.typingDot} />
                            <span className={styles.typingDot} />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {isRetrying && retryReason && (
                  <div className={styles.thinking}>{retryReason}</div>
                )}

                {panelLoading && (
                  <div className={styles.thinking}>Loading work item…</div>
                )}

                <div ref={messagesEndRef} />
              </div>

              {!isSubmitted && (
                <AgentComposer
                  className={styles.composerEmbed}
                  value={input}
                  onChange={setInput}
                  onSend={handleSend}
                  disabled={isRunning}
                  isRunning={isRunning}
                  allowEmptySend
                  placeholder="Type your response… (Enter to send, Shift+Enter for new line)"
                  testIdPrefix="standup"
                  {...{ 'data-testid': 'standup-composer' }}
                  rows={2}
                  attachments={attachments}
                  attachmentError={attachmentError}
                  onRemoveAttachment={removeAttachment}
                  onAttachClick={() => fileInputRef.current?.click()}
                  onPasteFiles={(files) => {
                    void addFiles(files);
                  }}
                  fileInput={
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      hidden
                      onChange={(event) => {
                        void handleAttachmentChange(event);
                      }}
                      disabled={isRunning}
                      {...{ 'data-testid': 'standup-file-input' }}
                    />
                  }
                  speech={{
                    isListening: speech.isListening,
                    isSpeechSupported: speech.isSpeechSupported,
                    speechError: speech.speechError,
                    onToggle: () => speech.toggle(input),
                  }}
                  trailingActions={
                    <button
                      className={styles.submitBtn}
                      onClick={() => {
                        void handleChatSubmit();
                      }}
                      disabled={submitting || isRunning}
                      type="button"
                      {...{ 'data-testid': 'standup-submit-btn' }}
                    >
                      {submitting ? 'Submitting…' : 'Submit Standup'}
                    </button>
                  }
                />
              )}
            </>
          )}

          {combinedError && <div className={styles.error}>{combinedError}</div>}
        </div>

        {selectedItem && (
          <Suspense fallback={null}>
            {/* data-testid-exempt — DetailsPanel owns its panel chrome */}
            <DetailsPanel
              workItem={selectedItem}
              onClose={() => setSelectedItem(null)}
              onUpdateDueDate={() => {}}
              onUpdateField={() => {}}
              isSaving={false}
              project={selectedProject}
              areaPath={selectedAreaPath}
              onSelectItem={(item) => setSelectedItem(item)}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
};

export default StandupCeremonyView;

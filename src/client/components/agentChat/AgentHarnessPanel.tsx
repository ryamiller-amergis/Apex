import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { HarnessAreaId } from '../../../shared/types/chatHarness';
import type {
  HarnessReceiptView,
  HarnessTranscriptItem,
} from '../../chatHarness/types';
import type { AgentChatSession } from '../../hooks/useAgentChatSession';
import {
  AgentComposer,
  type AgentComposerAttachment,
  type AgentComposerModelOption,
  type AgentComposerSpeechProps,
  type AgentComposerTestIds,
} from './AgentComposer';
import { AgentConnectionBanner } from './AgentConnectionBanner';
import { AgentLiveWorkBox } from './AgentLiveWorkBox';
import { AgentMessage } from './AgentMessage';
import { AgentMessageFailure } from './AgentMessageFailure';
import { AgentSummaryNotice } from './AgentSummaryNotice';
import { AgentThoughtProcess } from './AgentThoughtProcess';
import { SlotErrorBoundary } from './SlotErrorBoundary';
import chatStyles from './agentChat.module.css';
import styles from './AgentHarnessPanel.module.css';

export interface AgentHarnessPanelSlots {
  header?: React.ReactNode;
  sidePanel?: React.ReactNode;
  composerAccessory?: React.ReactNode;
  messageActions?: (item: HarnessTranscriptItem) => React.ReactNode;
  proposal?: React.ReactNode;
}

export interface AgentHarnessPanelTestIds {
  root?: string;
  transcript?: string;
  empty?: string;
  streaming?: string;
  progress?: string;
  progressLabel?: string;
  busy?: string;
  thinking?: string;
  steps?: string;
  toolGroup?: string;
  thoughtProcess?: string;
  thoughtProcessToggle?: string;
  failure?: string;
  failureBadge?: string;
  retry?: string;
  summaryNotice?: string;
  connectionBanner?: string;
  composer?: string;
  composerInput?: string;
  composerSend?: string;
  composerStop?: string;
  composerSteer?: string;
  composerSummarize?: string;
  composerReceipt?: string;
  composerAttach?: string;
  composerAttachments?: string;
  composerMicrophone?: string;
  composerModel?: string;
  readOnlyNotice?: string;
  slotHeader?: string;
  slotSidePanel?: string;
  slotComposerAccessory?: string;
  slotProposal?: string;
}

export interface AgentHarnessPanelComposerConfig {
  placeholder?: string;
  rows?: number;
  maxHeight?: number;
  autoFocus?: boolean;
  allowEmptySend?: boolean;
  canSend?: boolean;
  disabled?: boolean;
  shellDisabled?: boolean;
  maxLength?: number;
  attachments?: AgentComposerAttachment[];
  attachmentError?: string | null;
  onRemoveAttachment?: (id: string) => void;
  onAttachClick?: () => void;
  speech?: AgentComposerSpeechProps;
  model?: string;
  models?: AgentComposerModelOption[];
  modelsLoading?: boolean;
  onModelChange?: (modelId: string) => void;
  trailingActions?: React.ReactNode;
  sendButton?: React.ReactNode;
  before?: React.ReactNode;
  after?: React.ReactNode;
  fileInput?: React.ReactNode;
  modeBadge?: React.ReactNode;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null> | React.MutableRefObject<HTMLTextAreaElement | null>;
  onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste?: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onPasteFiles?: (files: File[]) => void;
  showSummarize?: boolean;
  readOnlyNotice?: string;
  hideComposer?: boolean;
}

export interface AgentHarnessPanelProps {
  area: HarnessAreaId;
  session: Partial<AgentChatSession>;
  testIdPrefix: string;
  testIds?: AgentHarnessPanelTestIds;
  /** Optional area-supplied transcript items (defaults to session.visibleMessages). */
  items?: HarnessTranscriptItem[];
  /** Optional custom transcript renderer (e.g. Brainstorm ledger or specialized message view) while still keeping harness live work, banners, slots, and composer. */
  renderTranscript?: (ctx: {
    items: HarnessTranscriptItem[];
    isWorking: boolean;
    liveWorkBox: React.ReactNode;
    streamingPreview: React.ReactNode;
    messageFailure: React.ReactNode;
  }) => React.ReactNode;
  slots?: AgentHarnessPanelSlots;
  composer?: AgentHarnessPanelComposerConfig;
  /** Optional controlled draft value; if omitted, panel manages its own draft state. */
  draft?: string;
  onDraftChange?: (value: string) => void;
  /** Optional custom send handler (overrides default session.send). */
  onSend?: (text: string) => Promise<boolean | void> | boolean | void;
  /** Optional custom steer handler (overrides default session.steer). */
  onSteer?: (text: string) => Promise<boolean | void> | boolean | void;
  /** Optional custom summarize handler (overrides default session.summarize). */
  onSummarize?: () => Promise<boolean | void> | boolean | void;
  /** Optional custom cancel handler (overrides default session.cancel). */
  onCancel?: () => Promise<void> | void;
  /** Optional custom retry handler (overrides default session.retryFailedRun). */
  onRetry?: () => Promise<void> | void;
  /** Optional sign-in callback for expired session banner. */
  onSignIn?: () => void;
  /** When true, locks composer & write actions (combined with server session.canWrite). */
  locked?: boolean;
  /** Optional empty state content (string or ReactNode). */
  emptyState?: React.ReactNode;
  /** Optional fallback progress label when turn is running without progressLabel. */
  fallbackProgressLabel?: string;
  /** Optional extra className on root. */
  className?: string;
  /** Optional choice click handler forwarded to AgentMessage. */
  onChoiceSelect?: (value: string) => void;
  /** Optional message copy / custom class for AgentMessage. */
  messageClassName?: string;
  /** Optional loading override. */
  isLoading?: boolean;
  /** Optional load error override. */
  loadError?: string | null;
  /** Optional retry load handler. */
  onRetryLoad?: () => void;
  /** Optional root data-testid override. */
  'data-testid'?: string;
}

const MessageActionsSlotContent: React.FC<{
  renderActions: (item: HarnessTranscriptItem) => React.ReactNode;
  item: HarnessTranscriptItem;
}> = ({ renderActions, item }) => <>{renderActions(item)}</>;

function hasSlotContent(node: React.ReactNode): boolean {
  return node !== undefined && node !== null && node !== false;
}

export const AgentHarnessPanel: React.FC<AgentHarnessPanelProps> = ({
  area,
  session,
  testIdPrefix,
  testIds,
  items,
  renderTranscript,
  slots,
  composer,
  draft,
  onDraftChange,
  onSend,
  onSteer,
  onSummarize,
  onCancel,
  onRetry,
  onSignIn,
  locked = false,
  emptyState,
  fallbackProgressLabel,
  className,
  onChoiceSelect,
  messageClassName,
  isLoading = false,
  loadError,
  onRetryLoad,
  'data-testid': dataTestId,
}) => {
  const [internalDraft, setInternalDraft] = useState('');
  const [steerPending, setSteerPending] = useState(false);
  const awaitingSteerReceiptRef = useRef(false);
  const receiptBeforeSteerRef = useRef<HarnessReceiptView | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  const isControlledDraft = draft !== undefined;
  const currentDraft = isControlledDraft ? draft : internalDraft;

  const visibleMessages = session.visibleMessages ?? [];
  const transcriptItems: HarnessTranscriptItem[] = useMemo(
    () => items ?? (visibleMessages as HarnessTranscriptItem[]),
    [items, visibleMessages],
  );
  const streamingText = session.streamingText ?? '';
  const toolProgress = session.toolProgress ?? [];
  const activity = session.activity ?? [];
  const connectionState = session.connectionState ?? 'open';
  const summaryNotice = session.summaryNotice ?? null;
  const lastReceipt = session.lastReceipt ?? null;
  const lastFailure = session.lastFailure ?? null;
  const canWrite = (session.canWrite ?? true) && !locked;
  const isRunning = Boolean(session.isRunning);
  const isSending = Boolean(session.isSending);
  const isCancelling = Boolean(session.isCancelling);
  const isAwaitingAgentResponse = Boolean(session.isAwaitingAgentResponse);
  const isWorking = isRunning || isSending || isAwaitingAgentResponse;
  const isSteerSupported = Boolean(
    session.isSteerSupported ?? (typeof session.steer === 'function' || typeof onSteer === 'function'),
  );
  const isSummarizeSupported = Boolean(
    session.isSummarizeSupported ?? (typeof session.summarize === 'function' || typeof onSummarize === 'function'),
  );

  const clearDraft = useCallback(() => {
    if (!isControlledDraft) {
      setInternalDraft('');
    } else {
      onDraftChange?.('');
    }
  }, [isControlledDraft, onDraftChange]);

  // Steer draft lifecycle: clear draft only once steer receipt is accepted/applied/queued; keep on rejected.
  useEffect(() => {
    if (!awaitingSteerReceiptRef.current) return;
    if (!lastReceipt || lastReceipt === receiptBeforeSteerRef.current) return;
    if (lastReceipt.kind !== 'steer') return;

    awaitingSteerReceiptRef.current = false;
    if (
      lastReceipt.status === 'accepted' ||
      lastReceipt.status === 'applied' ||
      lastReceipt.status === 'queued'
    ) {
      clearDraft();
    }
  }, [lastReceipt, clearDraft]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView?.({ behavior: 'smooth' });
  }, [transcriptItems.length, streamingText, isWorking]);

  const handleDraftChange = useCallback(
    (nextValue: string) => {
      if (lastReceipt?.status === 'rejected') {
        session.clearReceipt?.();
      }
      if (!isControlledDraft) {
        setInternalDraft(nextValue);
      }
      onDraftChange?.(nextValue);
    },
    [isControlledDraft, lastReceipt?.status, onDraftChange, session],
  );

  const exceedsMaxLength =
    typeof composer?.maxLength === 'number' && currentDraft.length > composer.maxLength;

  const handleSend = useCallback(() => {
    if (!canWrite || composer?.disabled) return;
    const trimmed = currentDraft.trim();
    const hasAttachments = (composer?.attachments?.length ?? 0) > 0;
    if (!trimmed && !(composer?.allowEmptySend && hasAttachments)) return;
    if (typeof composer?.maxLength === 'number' && trimmed.length > composer.maxLength) return;

    const sendFn = onSend ?? session.send;
    if (!sendFn) return;

    clearDraft();
    void Promise.resolve(sendFn(trimmed));
  }, [
    canWrite,
    clearDraft,
    composer?.allowEmptySend,
    composer?.attachments?.length,
    composer?.disabled,
    composer?.maxLength,
    currentDraft,
    onSend,
    session.send,
  ]);

  const handleSteer = useCallback(() => {
    if (!canWrite || !isRunning || !isSteerSupported || composer?.disabled || steerPending) {
      return;
    }
    const trimmed = currentDraft.trim();
    if (!trimmed) return;
    if (typeof composer?.maxLength === 'number' && trimmed.length > composer.maxLength) return;

    const steerFn = onSteer ?? session.steer;
    if (!steerFn) return;

    awaitingSteerReceiptRef.current = true;
    receiptBeforeSteerRef.current = lastReceipt;
    setSteerPending(true);
    void Promise.resolve(steerFn(trimmed)).finally(() => {
      setSteerPending(false);
    });
  }, [
    canWrite,
    composer?.disabled,
    composer?.maxLength,
    currentDraft,
    isRunning,
    isSteerSupported,
    lastReceipt,
    onSteer,
    session.steer,
    steerPending,
  ]);

  const showSummarize = composer?.showSummarize === true && isSummarizeSupported;
  const summarizeDisabled =
    !canWrite ||
    Boolean(composer?.disabled) ||
    summaryNotice?.status === 'running' ||
    transcriptItems.length === 0;

  const handleSummarize = useCallback(() => {
    if (!canWrite || summarizeDisabled) return;
    const summarizeFn = onSummarize ?? session.summarize;
    if (!summarizeFn) return;
    void Promise.resolve(summarizeFn());
  }, [canWrite, onSummarize, session.summarize, summarizeDisabled]);

  const handleCancel = useCallback(() => {
    if (!canWrite) return;
    const cancelFn = onCancel ?? session.cancel;
    if (!cancelFn) return;
    void Promise.resolve(cancelFn());
  }, [canWrite, onCancel, session.cancel]);

  const handleRetry = useCallback(() => {
    if (!canWrite) return;
    const retryFn = onRetry ?? (session.retryFailedRun ? () => session.retryFailedRun?.() : undefined);
    if (!retryFn) return;
    void Promise.resolve(retryFn());
  }, [canWrite, onRetry, session]);

  // Resolved test ids
  const rootTestId = dataTestId ?? testIds?.root ?? `${testIdPrefix}-harness-panel`;
  const transcriptTestId = testIds?.transcript ?? `${testIdPrefix}-transcript`;
  const emptyTestId = testIds?.empty ?? `${testIdPrefix}-empty`;
  const streamingTestId = testIds?.streaming ?? `${testIdPrefix}-streaming`;
  const progressTestId = testIds?.progress ?? `${testIdPrefix}-agent-progress`;
  const busyTestId = testIds?.busy ?? `${testIdPrefix}-agent-busy`;
  const thinkingTestId = testIds?.thinking ?? `${testIdPrefix}-agent-thinking`;
  const stepsTestId = testIds?.steps ?? `${testIdPrefix}-agent-steps`;
  const toolGroupTestId = testIds?.toolGroup ?? `${testIdPrefix}-tool-group`;
  const thoughtProcessTestId = testIds?.thoughtProcess ?? `${testIdPrefix}-thought-process`;
  const thoughtProcessToggleTestId =
    testIds?.thoughtProcessToggle ?? `${testIdPrefix}-thought-process-toggle`;
  const failureTestId = testIds?.failure ?? `${testIdPrefix}-message-failure`;
  const failureBadgeTestId = testIds?.failureBadge ?? `${testIdPrefix}-message-failed`;
  const retryTestId = testIds?.retry ?? `${testIdPrefix}-retry`;
  const composerTestId = testIds?.composer ?? `${testIdPrefix}-composer`;

  const slotHeaderTestId = testIds?.slotHeader ?? `${testIdPrefix}-slot-header`;
  const slotSidePanelTestId = testIds?.slotSidePanel ?? `${testIdPrefix}-slot-side-panel`;
  const slotComposerAccessoryTestId =
    testIds?.slotComposerAccessory ?? `${testIdPrefix}-slot-composer-accessory`;
  const slotProposalTestId = testIds?.slotProposal ?? `${testIdPrefix}-slot-proposal`;

  const composerTestIds: AgentComposerTestIds = {
    input: testIds?.composerInput,
    send: testIds?.composerSend,
    stop: testIds?.composerStop,
    steer: testIds?.composerSteer,
    summarize: testIds?.composerSummarize,
    receipt: testIds?.composerReceipt,
    attach: testIds?.composerAttach,
    attachments: testIds?.composerAttachments,
    microphone: testIds?.composerMicrophone,
    model: testIds?.composerModel,
    readOnlyNotice: testIds?.readOnlyNotice,
  };

  const thoughtProcessTestIds = {
    drawer: thoughtProcessTestId,
    toggle: thoughtProcessToggleTestId,
    thinking: thinkingTestId,
    steps: stepsTestId,
    toolGroup: toolGroupTestId,
  };

  // Live work vs streaming token preview
  const hasRunningTool =
    toolProgress.some((tool) => tool.status === 'running') ||
    activity.some(
      (entry) =>
        (entry.kind === 'tool' && entry.status === 'running') ||
        (entry.kind === 'tool-group' && entry.tools?.some((tool) => tool.status === 'running')),
    );

  const showLiveWorkBox = (isWorking || Boolean(session.isRetrying)) && (!streamingText || hasRunningTool);
  const showStreamingPreview = Boolean(streamingText);

  const liveWorkBox: React.ReactNode = showLiveWorkBox ? (
    <AgentLiveWorkBox
      activity={activity}
      progressLabel={
        session.isRetrying && session.retryReason
          ? session.retryReason
          : (session.progressLabel ?? null)
      }
      progressPhase={session.isRetrying ? null : (session.progressPhase ?? null)}
      toolProgress={session.isRetrying ? [] : toolProgress}
      fallbackLabel={fallbackProgressLabel}
      testIdPrefix={testIdPrefix}
      testIds={{
        root: streamingTestId,
        progress: progressTestId,
        progressLabel: testIds?.progressLabel,
        busy: busyTestId,
        thinking: thinkingTestId,
        steps: stepsTestId,
        toolGroup: toolGroupTestId,
      }}
    />
  ) : null;

  const streamingPreview: React.ReactNode = showStreamingPreview ? (
    <div
      className={styles.streamingWrap}
      aria-live={showLiveWorkBox ? undefined : 'polite'}
      {...(showLiveWorkBox ? {} : { 'data-testid': streamingTestId })}
    >
      {!hasRunningTool && activity.length > 0 ? (
        <AgentThoughtProcess
          items={activity}
          testIdPrefix={testIdPrefix}
          testIds={thoughtProcessTestIds}
        />
      ) : null}
      <AgentMessage
        text={streamingText}
        showReadAloud={false}
        isRunning={isRunning}
        locked
        className={messageClassName}
      />
    </div>
  ) : null;

  const hasFailure = Boolean(
    lastFailure || (session.retryableRunId && !isRunning && !isSending),
  );
  const messageFailure: React.ReactNode = hasFailure ? (
    <AgentMessageFailure
      reason={lastFailure?.reason ?? 'The previous reply did not finish.'}
      failedAt={lastFailure?.failedAt}
      canRetry={canWrite && Boolean(onRetry || session.retryFailedRun)}
      isRetrying={Boolean(session.isRetrying || isSending)}
      onRetry={handleRetry}
      testIdPrefix={testIdPrefix}
      testIds={{
        root: failureTestId,
        badge: failureBadgeTestId,
        retry: retryTestId,
      }}
    />
  ) : null;

  const hasHeaderSlot = hasSlotContent(slots?.header);
  const hasSidePanelSlot = hasSlotContent(slots?.sidePanel);
  const hasProposalSlot = hasSlotContent(slots?.proposal);
  const hasComposerAccessorySlot = hasSlotContent(slots?.composerAccessory);

  const effectiveLoadError = loadError ?? session.snapshotError ?? null;
  const showLoadingSkeleton = Boolean(
    isLoading ||
      (session.snapshotLoaded === false &&
        transcriptItems.length === 0 &&
        !effectiveLoadError),
  );
  const showLoadError = Boolean(effectiveLoadError && transcriptItems.length === 0);

  const retryLoadHandler = onRetryLoad ?? session.retrySnapshot;

  // Signed-out state: hide transcript and messages completely; show sign-in banner.
  if (connectionState === 'signed-out') {
    return (
      <div
        className={`${styles.panel} ${className ?? ''}`.trim()}
        data-harness-area={area}
        {...{ 'data-testid': rootTestId }}
      >
        {hasHeaderSlot ? (
          <div
            className={styles.headerSlot}
            {...{ 'data-testid': slotHeaderTestId }}
          >
            <SlotErrorBoundary slotName="header">
              {slots?.header}
            </SlotErrorBoundary>
          </div>
        ) : null}
        <div className={styles.signedOutBody}>
          {/* data-testid-exempt — AgentConnectionBanner owns data-testid via testId prop */}
          <AgentConnectionBanner
            connectionState="signed-out"
            onSignIn={onSignIn}
            testIdPrefix={testIdPrefix}
            testId={testIds?.connectionBanner}
          />
        </div>
      </div>
    );
  }

  const showBanners =
    connectionState === 'reconnecting' ||
    connectionState === 'restored' ||
    connectionState === 'unavailable' ||
    Boolean(summaryNotice && !(summaryNotice.status === 'completed' && !summaryNotice.isFallback));

  const resolvedCanSend =
    composer?.canSend !== undefined
      ? composer.canSend && !exceedsMaxLength
      : exceedsMaxLength
        ? false
        : undefined;

  const hasCancelHandler = Boolean(onCancel || session.cancel);

  const renderDefaultTranscript = () => (
    <div
      className={styles.transcript}
      {...{ 'data-testid': transcriptTestId }}
    >
      {transcriptItems.length === 0 &&
      !isWorking &&
      !streamingText &&
      !hasFailure &&
      hasSlotContent(emptyState) ? (
        <div
          className={styles.emptyState}
          {...{ 'data-testid': emptyTestId }}
        >
          {emptyState}
        </div>
      ) : null}

      {transcriptItems.map((item) => {
        if (item.hidden) return null;

        if (item.role === 'user') {
          return (
            <div
              key={item.id}
              data-message-id={item.id}
              className={styles.userRow}
            >
              <div className={chatStyles.userBubble}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
                {item.failed ? (
                  <span
                    className={chatStyles.messageFailureBadge}
                    {...{ 'data-testid': `${testIdPrefix}-message-failed-${item.id}` }}
                  >
                    Failed
                  </span>
                ) : null}
              </div>
            </div>
          );
        }

        if (item.role === 'system') {
          return (
            <div
              key={item.id}
              data-message-id={item.id}
              className={chatStyles.systemBubble}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
            </div>
          );
        }

        if (item.role === 'agent') {
          return (
            <div key={item.id} className={styles.agentRow}>
              {item.activity?.length || item.activityUnavailable ? (
                <AgentThoughtProcess
                  items={item.activity}
                  isUnavailable={item.activityUnavailable}
                  testIdPrefix={testIdPrefix}
                  testIds={{
                    drawer: thoughtProcessTestId,
                    toggle: thoughtProcessToggleTestId,
                    thinking: `${testIdPrefix}-saved-thinking-${item.id}`,
                    steps: `${testIdPrefix}-saved-steps-${item.id}`,
                    toolGroup: `${testIdPrefix}-saved-tool-group-${item.id}`,
                  }}
                />
              ) : null}
              <AgentMessage
                text={item.text}
                ts={item.ts}
                messageId={item.id}
                onChoiceSubmit={canWrite ? onChoiceSelect : undefined}
                isRunning={isRunning}
                locked={!canWrite}
                className={messageClassName}
              />
              {slots?.messageActions ? (
                <div
                  className={styles.messageActionsSlot}
                  {...{ 'data-testid': `${testIdPrefix}-message-actions-${item.id}` }}
                >
                  <SlotErrorBoundary slotName="messageActions">
                    <MessageActionsSlotContent
                      renderActions={slots.messageActions}
                      item={item}
                    />
                  </SlotErrorBoundary>
                </div>
              ) : null}
            </div>
          );
        }

        return null;
      })}

      {liveWorkBox}
      {streamingPreview}
      {messageFailure}
      <div ref={transcriptEndRef} />
    </div>
  );

  return (
    <div
      className={`${styles.panel} ${className ?? ''}`.trim()}
      data-harness-area={area}
      {...{ 'data-testid': rootTestId }}
    >
      {hasHeaderSlot ? (
        <div
          className={styles.headerSlot}
          {...{ 'data-testid': slotHeaderTestId }}
        >
          <SlotErrorBoundary slotName="header">
            {slots?.header}
          </SlotErrorBoundary>
        </div>
      ) : null}

      {showBanners ? (
        <div className={styles.banners}>
          {/* data-testid-exempt — AgentConnectionBanner owns data-testid via testId prop */}
          <AgentConnectionBanner
            connectionState={connectionState}
            onSignIn={onSignIn}
            testIdPrefix={testIdPrefix}
            testId={testIds?.connectionBanner}
          />
          <AgentSummaryNotice
            notice={summaryNotice}
            testIdPrefix={testIdPrefix}
            testId={testIds?.summaryNotice}
          />
        </div>
      ) : null}

      <div className={styles.body}>
        <div className={styles.mainColumn}>
          {showLoadingSkeleton ? (
            <div
              className={styles.skeletonContainer}
              role="status"
              aria-busy="true"
              aria-label="Loading conversation"
              {...{ 'data-testid': `${testIdPrefix}-loading` }}
            >
              <div className={styles.skeletonRow} />
              <div className={`${styles.skeletonRow} ${styles.skeletonRowShort}`} />
              <div className={styles.skeletonRow} />
            </div>
          ) : showLoadError ? (
            <div
              className={styles.loadError}
              role="alert"
              {...{ 'data-testid': `${testIdPrefix}-load-error` }}
            >
              <p>We could not load the conversation.</p>
              <button
                type="button"
                className={styles.loadErrorRetryBtn}
                onClick={() => {
                  void retryLoadHandler?.();
                }}
                {...{ 'data-testid': `${testIdPrefix}-snapshot-retry` }}
              >
                Try again
              </button>
            </div>
          ) : renderTranscript ? (
            <div
              className={styles.transcriptHost}
              {...{ 'data-testid': transcriptTestId }}
            >
              {renderTranscript({
                items: transcriptItems,
                isWorking,
                liveWorkBox,
                streamingPreview,
                messageFailure,
              })}
            </div>
          ) : (
            renderDefaultTranscript()
          )}

          {hasProposalSlot ? (
            <div
              className={styles.proposalSlot}
              {...{ 'data-testid': slotProposalTestId }}
            >
              <SlotErrorBoundary slotName="proposal">
                {slots?.proposal}
              </SlotErrorBoundary>
            </div>
          ) : null}

          {!composer?.hideComposer ? (
            <>
              {hasComposerAccessorySlot ? (
                <div
                  className={styles.composerAccessorySlot}
                  {...{ 'data-testid': slotComposerAccessoryTestId }}
                >
                  <SlotErrorBoundary slotName="composerAccessory">
                    {slots?.composerAccessory}
                  </SlotErrorBoundary>
                </div>
              ) : null}

              <AgentComposer
                value={currentDraft}
                onChange={handleDraftChange}
                onSend={handleSend}
                onCancel={hasCancelHandler ? handleCancel : undefined}
                disabled={composer?.disabled}
                isRunning={isRunning}
                isSending={isSending}
                shellDisabled={composer?.shellDisabled}
                isCancelling={isCancelling}
                placeholder={composer?.placeholder}
                rows={composer?.rows}
                maxHeight={composer?.maxHeight}
                autoFocus={composer?.autoFocus}
                allowEmptySend={composer?.allowEmptySend}
                canSend={resolvedCanSend}
                testIdPrefix={testIdPrefix}
                testIds={composerTestIds}
                textareaRef={composer?.textareaRef}
                attachments={composer?.attachments}
                attachmentError={composer?.attachmentError}
                onRemoveAttachment={composer?.onRemoveAttachment}
                onAttachClick={composer?.onAttachClick}
                speech={composer?.speech}
                model={composer?.model}
                models={composer?.models}
                modelsLoading={composer?.modelsLoading}
                onModelChange={composer?.onModelChange}
                steer={
                  isSteerSupported
                    ? {
                        enabled: true,
                        pending: steerPending,
                        onSteer: handleSteer,
                      }
                    : undefined
                }
                onSummarize={showSummarize ? handleSummarize : undefined}
                summarizeDisabled={summarizeDisabled}
                receipt={lastReceipt}
                readOnly={!canWrite}
                readOnlyNotice={composer?.readOnlyNotice}
                trailingActions={composer?.trailingActions}
                sendButton={composer?.sendButton}
                before={composer?.before}
                after={composer?.after}
                fileInput={composer?.fileInput}
                onKeyDown={composer?.onKeyDown}
                onPaste={composer?.onPaste}
                onPasteFiles={composer?.onPasteFiles}
                modeBadge={composer?.modeBadge}
                {...{ 'data-testid': composerTestId }}
              />
            </>
          ) : null}
        </div>

        {hasSidePanelSlot ? (
          <aside
            className={styles.sidePanelSlot}
            {...{ 'data-testid': slotSidePanelTestId }}
          >
            <SlotErrorBoundary slotName="sidePanel">
              {slots?.sidePanel}
            </SlotErrorBoundary>
          </aside>
        ) : null}
      </div>
    </div>
  );
};

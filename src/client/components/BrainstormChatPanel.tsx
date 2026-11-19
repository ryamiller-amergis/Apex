import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  BRAINSTORM_FAILURE_SUMMARIES,
  BRAINSTORM_MESSAGE_MAX_LENGTH,
  type BrainstormActivityItem,
  type BrainstormMessageDto,
  type BrainstormSessionDetail,
} from '../../shared/types/brainstorm';
import {
  BRAINSTORM_ARTIFACT_TYPE_LABELS,
  BRAINSTORM_COMPOSER_MODE_LABELS,
  BRAINSTORM_COMPOSER_MODE_SUBTITLES,
  BRAINSTORM_COMPOSER_MODES,
  BRAINSTORM_EXPLORE_MODE,
  isBrainstormArtifactType,
  isBrainstormComposerMode,
  type BrainstormActionId,
  type BrainstormComposerMode,
} from '../../shared/types/brainstormArtifact';
import type { AgentActivityItem } from '../chatHarness/types';
import { DEFAULT_MODEL_ID } from '../config/models';
import { useAvailableModelSelection } from '../hooks/useAvailableModelSelection';
import { useBrainstormArtifact } from '../hooks/useBrainstormArtifact';
import { useBrainstormChat } from '../hooks/useBrainstormChat';
import type { AgentChatSession } from '../hooks/useAgentChatSession';
import { brainstormKeys, useBrainstormMessages } from '../hooks/useBrainstormSessions';
import { useBrainstormCitations, useBrainstormSources } from '../hooks/useBrainstormSources';
import { useChatAttachments } from '../hooks/useChatAttachments';
import { useAvailableModels } from '../hooks/useProjectSkillConfig';
import { useSpeechInput } from '../hooks/useSpeechInput';
import {
  AgentHarnessPanel,
  AgentLiveWorkBox,
  AgentMessageFailure,
  AgentThoughtProcess,
} from './agentChat';
import { BrainstormCitationsRow } from './BrainstormCitationsRow';
import { BrainstormReadOnlyBanner } from './BrainstormReadOnlyBanner';
import { BrainstormSuggestionChips } from './BrainstormSuggestionChips';
import { MarkdownWithMermaid } from './MarkdownWithMermaid';
import styles from './BrainstormChatPanel.module.css';

interface BrainstormChatPanelProps {
  project: string;
  session: BrainstormSessionDetail;
  onSuggestion?: (actionId: BrainstormActionId) => void;
}

/** Latest failed or stopped collaborator reply that a retry has not replaced; the only row Retry may target. */
export function retryableBrainstormMessage(messages: BrainstormMessageDto[]): BrainstormMessageDto | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    if (message.supersededByMessageId) continue;
    return (message.status === 'failed' || message.status === 'cancelled') && message.runId ? message : null;
  }
  return null;
}

/**
 * Ensures the user prompt for a turn always appears above its collaborator
 * reply even when both rows share the same transaction timestamp.
 */
export function orderBrainstormMessages(messages: readonly BrainstormMessageDto[]): BrainstormMessageDto[] {
  return [...messages].sort((a, b) => {
    if (a.turnId === b.turnId && a.role !== b.role) {
      return a.role === 'user' ? -1 : 1;
    }
    const timeDiff = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    if (Number.isFinite(timeDiff) && timeDiff !== 0) return timeDiff;
    if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt);
    if (a.role !== b.role) return a.role === 'user' ? -1 : 1;
    return 0;
  });
}

const BRAINSTORM_THOUGHT_PROCESS_TEST_IDS = {
  drawer: 'brainstorm-thought-process',
  toggle: 'brainstorm-thought-process-toggle',
  thinking: 'brainstorm-agent-thinking',
  steps: 'brainstorm-agent-steps',
  toolGroup: 'brainstorm-tool-group',
} as const;

const BRAINSTORM_LIVE_WORK_TEST_IDS = {
  progress: 'brainstorm-agent-progress',
  busy: 'brainstorm-agent-busy',
  thinking: 'brainstorm-agent-thinking',
  steps: 'brainstorm-agent-steps',
  toolGroup: 'brainstorm-tool-group',
} as const;

function toolTarget(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const record = args as { target?: unknown; args?: unknown };
  if (typeof record.target === 'string' && record.target.trim()) return record.target.trim();
  return record.args ? toolTarget(record.args) : null;
}

function ModeIcon({ mode }: { mode: BrainstormComposerMode }) {
  switch (mode) {
    case 'explore':
      return (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6.2 7.5c-1.8 0-3.2 1.1-3.2 2.5s1.4 2.5 3.2 2.5c2.2 0 3.5-5 5.6-5 1.8 0 3.2 1.1 3.2 2.5s-1.4 2.5-3.2 2.5c-2.2 0-3.5-5-5.6-5z" />
        </svg>
      );
    case 'discovery_brief':
      return (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="10" cy="10" r="7" />
          <polygon points="12.8 7.2 11 11 7.2 12.8 9 9 12.8 7.2" />
        </svg>
      );
    case 'technical_design':
      return (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polygon points="10 3 17 6.8 10 10.6 3 6.8 10 3" />
          <polyline points="3 10.2 10 14 17 10.2" />
          <polyline points="3 13.4 10 17.2 17 13.4" />
        </svg>
      );
    case 'adr':
      return (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="6" cy="5.5" r="2" />
          <circle cx="6" cy="14.5" r="2" />
          <circle cx="14.5" cy="10" r="2" />
          <path d="M6 7.5v5" />
          <path d="M8 5.8c2.5 0 3 4.2 4.5 4.2" />
        </svg>
      );
    case 'implementation_plan':
      return (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 6l1.5 1.5L8.5 4.5" />
          <path d="M11 6h5" />
          <path d="M4 11l1.5 1.5L8.5 9.5" />
          <path d="M11 11h5" />
          <circle cx="6" cy="15.5" r="1.2" />
          <path d="M11 15.5h5" />
        </svg>
      );
  }
}

function BrainstormModePicker({
  value,
  disabled,
  onChange,
}: {
  value: BrainstormComposerMode;
  disabled: boolean;
  onChange: (next: BrainstormComposerMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleOutside = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className={styles.modePickerWrap} {...{ 'data-testid': 'brainstorm-composer-mode-badge' }}>
      <button
        type="button"
        className={`${styles.modeTrigger} ${open ? styles.modeTriggerOpen : ''}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Brainstorm mode: ${BRAINSTORM_COMPOSER_MODE_LABELS[value]}`}
        title={BRAINSTORM_COMPOSER_MODE_SUBTITLES[value]}
        onClick={() => setOpen((prev) => !prev)}
        {...{ 'data-testid': 'brainstorm-composer-mode-trigger' }}
      >
        <span className={styles.modeTriggerIcon} aria-hidden="true">
          <ModeIcon mode={value} />
        </span>
        <span className={styles.modeTriggerLabel}>{BRAINSTORM_COMPOSER_MODE_LABELS[value]}</span>
        <span className={styles.modeCaret} aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>

      {/* Hidden select kept for keyboard/programmatic form compatibility */}
      <select
        className={styles.srOnlySelect}
        tabIndex={-1}
        aria-hidden="true"
        value={value}
        disabled={disabled}
        onChange={(event) => {
          if (isBrainstormComposerMode(event.target.value)) {
            onChange(event.target.value);
            setOpen(false);
          }
        }}
        {...{ 'data-testid': 'brainstorm-composer-mode-select' }}
      >
        {BRAINSTORM_COMPOSER_MODES.map((mode) => (
          <option key={mode} value={mode}>{BRAINSTORM_COMPOSER_MODE_LABELS[mode]}</option>
        ))}
      </select>

      {open && (
        <div
          className={styles.modeMenu}
          role="listbox"
          aria-label="Select Brainstorm mode"
          {...{ 'data-testid': 'brainstorm-composer-mode-menu' }}
        >
          <div className={styles.modeMenuHeader}>Mode — shapes your next message</div>
          {BRAINSTORM_COMPOSER_MODES.map((mode) => {
            const active = mode === value;
            return (
              <button
                key={mode}
                type="button"
                role="option"
                aria-selected={active}
                className={`${styles.modeOption} ${active ? styles.modeOptionActive : ''}`}
                onClick={() => {
                  onChange(mode);
                  setOpen(false);
                }}
                {...{ 'data-testid': `brainstorm-composer-mode-option-${mode}` }}
              >
                <span className={styles.modeOptionIcon} aria-hidden="true">
                  <ModeIcon mode={mode} />
                </span>
                <span className={styles.modeOptionBody}>
                  <span className={styles.modeOptionTitleRow}>
                    <span className={styles.modeOptionTitle}>{BRAINSTORM_COMPOSER_MODE_LABELS[mode]}</span>
                    {mode === BRAINSTORM_EXPLORE_MODE && (
                      <span className={styles.modeOptionPill}>Chat</span>
                    )}
                  </span>
                  <span className={styles.modeOptionSubtitle}>
                    {BRAINSTORM_COMPOSER_MODE_SUBTITLES[mode]}
                  </span>
                </span>
                {active && (
                  <span className={styles.modeOptionCheck} aria-hidden="true">✓</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function BrainstormAgentWork({
  chat,
  text,
  persistedActivity,
  restoringSources,
}: {
  chat: AgentChatSession;
  text?: string;
  persistedActivity?: BrainstormActivityItem[];
  restoringSources?: boolean;
}) {
  const toolProgress = useMemo(() => chat.toolProgress ?? [], [chat.toolProgress]);
  const harnessActivity = useMemo(() => chat.activity ?? [], [chat.activity]);
  const toolRunning =
    toolProgress.some((tool) => tool.status === 'running') ||
    harnessActivity.some(
      (item) =>
        (item.kind === 'tool' && item.status === 'running') ||
        (item.kind === 'tool-group' && item.tools?.some((tool) => tool.status === 'running')),
    );
  const writing = Boolean(text && text.trim()) && !toolRunning;
  const activityLabel =
    chat.progressLabel ||
    (restoringSources
      ? 'Restoring attached repository…'
      : chat.isSending
        ? 'Preparing session sources…'
        : 'Working through your message');
  const [liveItems, setLiveItems] = useState<BrainstormActivityItem[]>([]);

  useEffect(() => {
    const incomingThinking = chat.thinkingText?.trim() ?? '';
    if (!incomingThinking) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- accumulate live stream thinking chunks into activity trace
    setLiveItems((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.kind === 'thinking') {
        if (incomingThinking === 'Analyzing') return prev;
        if (incomingThinking === last.text) return prev;
        return [...prev.slice(0, -1), { ...last, text: incomingThinking }];
      }
      return [
        ...prev,
        {
          id: `thinking-${prev.length + 1}`,
          kind: 'thinking',
          text: incomingThinking,
        },
      ];
    });
  }, [chat.thinkingText]);

  useEffect(() => {
    if (toolProgress.length === 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- accumulate live stream tool updates into activity trace
    setLiveItems((prev) => {
      let next = [...prev];
      for (const tool of toolProgress) {
        const innerToolName =
          tool.toolName === 'mcp' &&
          tool.args &&
          typeof tool.args === 'object' &&
          typeof (tool.args as { toolName?: unknown }).toolName === 'string'
            ? `mcp:${(tool.args as { toolName: string }).toolName}`
            : tool.toolName;
        const entry: BrainstormActivityItem = {
          id: tool.callId,
          kind: 'tool',
          toolName: innerToolName,
          status: tool.status,
          target: toolTarget(tool.args),
          result: tool.result,
        };
        const existingIdx = next.findIndex(
          (item) => item.kind === 'tool' && item.id === tool.callId,
        );
        if (existingIdx >= 0) {
          next[existingIdx] = {
            ...next[existingIdx],
            ...entry,
            target: entry.target ?? next[existingIdx]?.target ?? null,
          };
        } else {
          next = [...next, entry];
        }
      }
      return next;
    });
  }, [toolProgress]);

  const items: ReadonlyArray<AgentActivityItem> =
    harnessActivity.length > 0
      ? harnessActivity
      : liveItems.length > 0
        ? liveItems
        : persistedActivity && persistedActivity.length > 0
          ? persistedActivity
          : [];

  return (
    <div aria-live="polite" aria-busy="true" {...{ 'data-testid': 'brainstorm-streaming' }}>
      {!writing ? (
        <AgentLiveWorkBox
          activity={items}
          progressLabel={chat.progressLabel ?? null}
          progressPhase={chat.progressPhase ?? null}
          toolProgress={toolProgress}
          fallbackLabel={activityLabel}
          testIdPrefix="brainstorm"
          testIds={BRAINSTORM_LIVE_WORK_TEST_IDS}
          className={styles.liveWorkBox}
        />
      ) : items.length > 0 ? (
        <AgentThoughtProcess
          items={items}
          testIdPrefix="brainstorm"
          testIds={BRAINSTORM_THOUGHT_PROCESS_TEST_IDS}
        />
      ) : null}
      {text ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown> : null}
    </div>
  );
}

export const BrainstormChatPanel: React.FC<BrainstormChatPanelProps> = ({ project, session, onSuggestion }) => {
  const queryClient = useContext(QueryClientContext);
  const messagesQuery = useBrainstormMessages(project, session.id);
  const chat = useBrainstormChat(project, session);
  const [draft, setDraft] = useState('');
  const [selectedModel, setSelectedModel] = useState<string>(session.model || DEFAULT_MODEL_ID);
  const [composerMode, setComposerMode] = useState<BrainstormComposerMode>(() =>
    isBrainstormArtifactType(session.artifactType) ? session.artifactType : BRAINSTORM_EXPLORE_MODE,
  );
  const [userChoseMode, setUserChoseMode] = useState(false);
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const stickThreadToBottomRef = useRef(true);
  const { refetch } = messagesQuery;

  const {
    attachments,
    attachmentError,
    addFiles,
    removeAttachment,
    clearAttachments,
  } = useChatAttachments();

  const speech = useSpeechInput(useCallback((text: string) => setDraft(text), []));
  const { data: availableModels, isLoading: modelsLoading } = useAvailableModels();
  useAvailableModelSelection(selectedModel, setSelectedModel, availableModels);

  useEffect(() => {
    if (session.model) setSelectedModel(session.model);
  }, [session.id, session.model]);

  useEffect(() => {
    setUserChoseMode(false);
    setComposerMode(
      isBrainstormArtifactType(session.artifactType) ? session.artifactType : BRAINSTORM_EXPLORE_MODE,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset composer mode only when switching to a different session
  }, [session.id]);

  const handleThreadScroll = () => {
    const el = threadRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickThreadToBottomRef.current = distanceFromBottom <= 48;
  };

  const ledger = useMemo(
    () => orderBrainstormMessages(
      (messagesQuery.data ?? []).filter((message) => !message.supersededByMessageId),
    ),
    [messagesQuery.data],
  );
  const retryable = retryableBrainstormMessage(ledger);
  const hasStreamingRow = ledger.some((message) => message.status === 'streaming');
  const canMutate = session.canMutate;
  const artifactQuery = useBrainstormArtifact(project, session, hasStreamingRow);
  const artifact = artifactQuery.data;
  const citations = useBrainstormCitations(project, session.id);
  const sources = useBrainstormSources(project, session.id);
  const restoring = (sources.data ?? []).some((source) => source.state === 'restoring');

  useEffect(() => {
    if (!userChoseMode && artifact?.type && isBrainstormArtifactType(artifact.type)) {
      setComposerMode(artifact.type);
    }
  }, [artifact?.type, userChoseMode]);
  const latest = ledger[ledger.length - 1];
  const replySettled = Boolean(
    latest && latest.role === 'assistant' && latest.status !== 'streaming',
  );
  // The chat stream can stay "running" after the Brainstorm row is already
  // saved. The ledger is what decides whether another message can be sent.
  const turnInFlight =
    pendingText !== null
    || chat.isSending
    || hasStreamingRow
    || (!replySettled && chat.isInteractionBusy);
  const showStandaloneActivity = turnInFlight && !hasStreamingRow;
  const busy = turnInFlight || retryingId !== null;
  const latestCompletedReplyId = useMemo(() => {
    const latest = ledger[ledger.length - 1];
    return latest?.role === 'assistant' && latest.status === 'completed' ? latest.id : null;
  }, [ledger]);
  const showSuggestions = Boolean(onSuggestion) && canMutate && session.state === 'active' && !busy;

  useEffect(() => {
    if (canMutate) inputRef.current?.focus();
  }, [canMutate, session.id]);

  const invalidateLedger = useCallback(() => {
    if (queryClient) {
      const messagesKey = brainstormKeys?.messages
        ? brainstormKeys.messages(project, session.id)
        : (['brainstorm', project, 'messages', session.id] as const);
      const sessionKey = brainstormKeys?.session
        ? brainstormKeys.session(project, session.id)
        : (['brainstorm', project, 'session', session.id] as const);
      void queryClient.invalidateQueries({ queryKey: messagesKey });
      void queryClient.invalidateQueries({ queryKey: sessionKey });
      return;
    }
    void refetch();
  }, [project, queryClient, refetch, session.id]);

  const trackedSessionIdRef = useRef<string>(session.id);
  const lastTerminalRevisionRef = useRef<number>(chat.terminalRevision ?? 0);
  const prevStatusRef = useRef<AgentChatSession['status']>(chat.status);

  // Event-driven ledger refresh: invalidate Brainstorm queries once per terminal
  // run transition (driven by harness terminalRevision, or status leaving running
  // when mocked tests omit terminalRevision).
  useEffect(() => {
    if (trackedSessionIdRef.current !== session.id) {
      trackedSessionIdRef.current = session.id;
      lastTerminalRevisionRef.current = chat.terminalRevision ?? 0;
      prevStatusRef.current = chat.status;
      return;
    }

    const hasTerminalRevision = typeof chat.terminalRevision === 'number';
    const revisionAdvanced =
      hasTerminalRevision && chat.terminalRevision > lastTerminalRevisionRef.current;
    const statusLeftRunning =
      !hasTerminalRevision &&
      prevStatusRef.current === 'running' &&
      chat.status !== 'running';

    if (hasTerminalRevision) {
      lastTerminalRevisionRef.current = chat.terminalRevision;
    }
    prevStatusRef.current = chat.status;

    if (revisionAdvanced || statusLeftRunning) {
      invalidateLedger();
    }
  }, [chat.status, chat.terminalRevision, invalidateLedger, session.id]);

  const showPending = pendingText !== null
    && !ledger.some((message) => message.role === 'user' && message.content === pendingText);

  const toolProgressCount = chat.toolProgress?.length ?? 0;
  useEffect(() => {
    const el = threadRef.current;
    if (!el || !stickThreadToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [
    ledger.length,
    showPending,
    showStandaloneActivity,
    chat.thinkingText,
    chat.streamingText,
    toolProgressCount,
  ]);

  const trimmed = draft.trim();
  const hasMessageContent = trimmed.length > 0 || attachments.length > 0;
  const canSend =
    canMutate
    && hasMessageContent
    && trimmed.length <= BRAINSTORM_MESSAGE_MAX_LENGTH
    && !busy;

  const handleAttachmentChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    await addFiles(event.currentTarget.files);
    event.currentTarget.value = '';
  };

  const openFilePicker = () => {
    fileInputRef.current?.click();
  };

  const handleModeChange = (nextMode: BrainstormComposerMode) => {
    setUserChoseMode(true);
    setComposerMode(nextMode);
  };

  const handleSend = async (incomingText?: string) => {
    if (!canSend) return false;
    const outgoingAttachments = [...attachments];
    const previousDraft = draft;
    const rawTrimmed = typeof incomingText === 'string' ? incomingText.trim() : trimmed;
    const text = rawTrimmed || 'Please use the attached files as additional context.';
    speech.stop();
    setPendingText(text);
    setDraft('');
    try {
      const sent = await chat.send(text, {
        model: selectedModel,
        mode: composerMode,
        ...(replySettled ? { ignoreStaleStreamBusy: true } : {}),
        ...(outgoingAttachments.length > 0 ? { attachments: outgoingAttachments } : {}),
      });
      if (sent) {
        if (outgoingAttachments.length > 0) {
          clearAttachments();
        }
      } else {
        setDraft(previousDraft);
      }
      await refetch();
      return sent;
    } finally {
      setPendingText(null);
    }
  };

  const handleRetry = async (message: BrainstormMessageDto) => {
    if (!message.runId) return;
    setRetryingId(message.id);
    try {
      await chat.retryFailedRun(message.runId);
      await refetch();
    } finally {
      setRetryingId(null);
    }
  };

  const effectiveIsRunning = busy && Boolean(chat.isRunning);
  const effectiveIsSending = pendingText !== null || Boolean(chat.isSending) || retryingId !== null;
  const harnessSession = useMemo(
    () => ({
      ...chat,
      isRunning: effectiveIsRunning,
      isSending: effectiveIsSending,
      isAwaitingAgentResponse: busy && Boolean(chat.isAwaitingAgentResponse),
      canWrite: canMutate && (chat.canWrite ?? true),
      snapshotLoaded: true,
      snapshotError: null,
    }),
    [busy, canMutate, chat, effectiveIsRunning, effectiveIsSending],
  );

  let thread: React.ReactNode;
  if (messagesQuery.isLoading) {
    thread = (
      <div className={styles.skeleton} aria-busy="true" aria-label="Loading messages">
        <div className={styles.skeletonRow} />
        <div className={`${styles.skeletonRow} ${styles.skeletonShort}`} />
      </div>
    );
  } else if (messagesQuery.isError) {
    thread = (
      <div className={styles.centered} role="alert">
        <p>We could not load the conversation.</p>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => { void refetch(); }}
          {...{ 'data-testid': 'brainstorm-messages-retry' }}
        >
          Try again
        </button>
      </div>
    );
  } else if (ledger.length === 0 && !showPending) {
    thread = canMutate ? (
      <p className={styles.centered} {...{ 'data-testid': 'brainstorm-chat-empty' }}>
        Describe your idea to get started
      </p>
    ) : (
      <p className={styles.centered} {...{ 'data-testid': 'brainstorm-empty-readonly' }}>
        The creator has not added content to this session yet.
      </p>
    );
  } else {
    thread = (
      <>
        {ledger.map((message) => {
          const isUser = message.role === 'user';
          const isStreaming = message.status === 'streaming';
          const text = isStreaming ? chat.streamingText || message.content : message.content;
          const incomplete = !isUser && (message.status === 'failed' || message.status === 'cancelled');
          const failureReason =
            message.failureSummary
            ?? BRAINSTORM_FAILURE_SUMMARIES[message.failureCode ?? 'unknown'];
          return (
            <article
              key={message.id}
              className={`${styles.message} ${isUser ? styles.user : styles.collaborator}`}
              aria-label={isUser ? 'Your message' : 'Collaborator'}
            >
              {isStreaming ? (
                <BrainstormAgentWork
                  chat={chat}
                  text={text}
                  persistedActivity={message.activity}
                  restoringSources={restoring}
                />
              ) : text ? (
                <div className={incomplete ? styles.incomplete : undefined}>
                  {!isUser && message.activity && message.activity.length > 0 ? (
                    <AgentThoughtProcess
                      items={message.activity}
                      testIdPrefix="brainstorm"
                      testIds={BRAINSTORM_THOUGHT_PROCESS_TEST_IDS}
                    />
                  ) : null}
                  {/* data-testid-exempt — MarkdownWithMermaid renders message body inside BrainstormChatPanel */}
                  <MarkdownWithMermaid content={text} skipHtml />
                  {incomplete && <span className={styles.incompleteLabel}>Incomplete response</span>}
                </div>
              ) : !isUser && message.activity && message.activity.length > 0 ? (
                <AgentThoughtProcess
                  items={message.activity}
                  testIdPrefix="brainstorm"
                  testIds={BRAINSTORM_THOUGHT_PROCESS_TEST_IDS}
                />
              ) : null}
              {!isUser && message.status === 'completed' && (
                <BrainstormCitationsRow
                  messageId={message.id}
                  citations={(citations.data ?? []).filter((citation) => citation.messageId === message.id)}
                />
              )}
              {showSuggestions && message.id === latestCompletedReplyId && onSuggestion && (
                <BrainstormSuggestionChips project={project} sessionId={session.id} onSelect={onSuggestion} />
              )}
              {incomplete && (
                <AgentMessageFailure
                  reason={failureReason}
                  status={message.status === 'cancelled' ? 'cancelled' : 'failed'}
                  failedAt={message.createdAt}
                  canRetry={canMutate && retryable?.id === message.id}
                  isRetrying={retryingId === message.id}
                  onRetry={() => { void handleRetry(message); }}
                  testIdPrefix="brainstorm"
                  testIds={{
                    root: `brainstorm-message-failure-${message.id}`,
                    badge: 'brainstorm-message-failed',
                    retry: 'brainstorm-retry',
                  }}
                />
              )}
            </article>
          );
        })}
        {showPending && (
          <article className={`${styles.message} ${styles.user}`} aria-label="Your message">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{pendingText ?? ''}</ReactMarkdown>
          </article>
        )}
        {showStandaloneActivity && (
          <article className={`${styles.message} ${styles.collaborator}`} aria-label="Collaborator">
            <BrainstormAgentWork chat={chat} restoringSources={restoring} />
          </article>
        )}
      </>
    );
  }

  return (
    <section className={styles.panel} aria-label="Brainstorm chat">
      {restoring && (
        <p className={styles.typing} {...{ 'data-testid': 'brainstorm-restoring-indicator' }}>
          Restoring sources
        </p>
      )}
      <AgentHarnessPanel
        area="brainstorm"
        session={harnessSession}
        testIdPrefix="brainstorm"
        testIds={{
          root: 'brainstorm-harness-panel',
          streaming: 'brainstorm-streaming',
          progress: 'brainstorm-agent-progress',
          busy: 'brainstorm-agent-busy',
          thinking: 'brainstorm-agent-thinking',
          steps: 'brainstorm-agent-steps',
          toolGroup: 'brainstorm-tool-group',
          thoughtProcess: 'brainstorm-thought-process',
          thoughtProcessToggle: 'brainstorm-thought-process-toggle',
          failureBadge: 'brainstorm-message-failed',
          retry: 'brainstorm-retry',
          composer: 'brainstorm-composer',
          composerInput: 'brainstorm-composer-input',
          composerSend: 'brainstorm-composer-send',
          composerStop: 'brainstorm-composer-stop',
          composerAttach: 'brainstorm-composer-attach',
          composerAttachments: 'brainstorm-composer-attachments',
          composerMicrophone: 'brainstorm-composer-microphone',
          composerModel: 'brainstorm-composer-model',
        }}
        draft={draft}
        onDraftChange={(value) => setDraft(value.slice(0, BRAINSTORM_MESSAGE_MAX_LENGTH))}
        onSend={(text) => handleSend(text)}
        onCancel={() => { void chat.cancel(); }}
        locked={!canMutate}
        renderTranscript={() => (
          <div
            ref={threadRef}
            onScroll={handleThreadScroll}
            className={styles.thread}
            {...{ 'data-testid': 'brainstorm-chat-thread' }}
          >
            {thread}
          </div>
        )}
        composer={{
          hideComposer: !canMutate,
          textareaRef: inputRef,
          disabled: !canMutate,
          canSend,
          allowEmptySend: true,
          maxLength: BRAINSTORM_MESSAGE_MAX_LENGTH,
          rows: 3,
          maxHeight: 160,
          autoFocus: canMutate,
          placeholder:
            composerMode === BRAINSTORM_EXPLORE_MODE
              ? 'Explore an idea, ask a question, or paste a screenshot…'
              : `Describe what to draft or update in your ${BRAINSTORM_ARTIFACT_TYPE_LABELS[composerMode].toLowerCase()}, or switch back to Explore…`,
          before: chat.sendError ? (
            <p className={styles.sendError} role="alert">
              {chat.sendError}
            </p>
          ) : undefined,
          modeBadge: (
            // data-testid-exempt — BrainstormModePicker owns brainstorm-composer-mode-badge and option testids
            <BrainstormModePicker
              value={composerMode}
              disabled={!canMutate || busy}
              onChange={handleModeChange}
            />
          ),
          model: selectedModel,
          models: availableModels,
          modelsLoading,
          onModelChange: setSelectedModel,
          attachments,
          attachmentError,
          onRemoveAttachment: removeAttachment,
          onAttachClick: openFilePicker,
          onPasteFiles: (files) => { void addFiles(files); },
          speech: {
            isListening: speech.isListening,
            isSpeechSupported: speech.isSpeechSupported,
            speechError: speech.speechError,
            onToggle: () => speech.toggle(draft),
          },
          fileInput: (
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".txt,.md,.json,.csv,.ts,.tsx,.js,.jsx,.py,.sql,.yml,.yaml,.xml,.html,.css,.docx,.png,.jpg,.jpeg,.gif,.webp"
              onChange={(event) => { void handleAttachmentChange(event); }}
              style={{ display: 'none' }}
              {...{ 'data-testid': 'brainstorm-composer-file-input' }}
            />
          ),
        }}
        {...{ 'data-testid': 'brainstorm-harness-panel' }}
      />
      {!canMutate ? (
        // data-testid-exempt — BrainstormReadOnlyBanner owns brainstorm-readonly-banner
        <BrainstormReadOnlyBanner />
      ) : null}
    </section>
  );
};

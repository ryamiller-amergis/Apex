import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  BUILD_PROMPT_MAX_LENGTH,
  buildStatusLabel,
  type BuildRunStatus,
} from '../../shared/types/build';
import type { ChatMessage } from '../../shared/types/chat';
import { stripBuildIntakeMarkers } from '../../shared/utils/buildIntakeMarkers';
import { friendlyToolActivityLabel } from '../../shared/utils/chatProgressCopy';
import { DEFAULT_MODEL_ID } from '../config/models';
import {
  useAgentChatSession,
  type AgentChatSession,
} from '../hooks/useAgentChatSession';
import { useAvailableModelSelection } from '../hooks/useAvailableModelSelection';
import {
  BuildApiError,
  isBuildLive,
  useAcceptBuild,
  useBuild,
  useBuildEvents,
  useBuildRepositories,
  useCancelBuild,
  useConfirmBuildIntake,
  useEnsureBuildPlanning,
  useRequestBuildRevision,
  useResumeBuild,
  useStartBuild,
} from '../hooks/useBuilds';
import { useChatThread } from '../hooks/useChatThreads';
import { useInterview } from '../hooks/useInterviews';
import { useAvailableModels } from '../hooks/useProjectSkillConfig';
import { useSpeechInput } from '../hooks/useSpeechInput';
import {
  parseAgentMessage,
  type ChoiceBlock,
} from '../utils/parseAgentMessage';
import { stripInterviewPhaseMarkers } from '../utils/interviewPhaseProgress';
import { AgentComposer } from './agentChat';
import { ChatRunProgressLabel } from './ChatRunProgressLabel';
import { MarkdownWithMermaid } from './MarkdownWithMermaid';
import { buildProgressHeadline, userFacingBuildEvent } from './buildProgressCopy';
import styles from './BuildWorkspace.module.css';

export interface BuildWorkspaceProps {
  project: string;
  buildId?: string;
  initialTab?: string;
}

export interface BuildActivityItem {
  id: string;
  kind: 'thinking' | 'tool';
  text?: string;
  toolName?: string;
  status?: 'running' | 'completed' | 'error';
  target?: string | null;
}

export interface GroupedChatTurn {
  id: string;
  role: 'user' | 'agent';
  text: string;
  activity: BuildActivityItem[];
}

function newClientRequestId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  return `build-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toolTarget(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const record = args as {
    target?: unknown;
    path?: unknown;
    command?: unknown;
    args?: unknown;
  };
  for (const candidate of [record.target, record.path, record.command]) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim().slice(0, 140);
    }
  }
  return record.args ? toolTarget(record.args) : null;
}

function cleanTargetLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const sourcesIdx = trimmed.replace(/\\/g, '/').indexOf('sources/');
  if (sourcesIdx >= 0) {
    return trimmed.replace(/\\/g, '/').slice(sourcesIdx);
  }
  return trimmed;
}

export function activitySummaryLabel(items: BuildActivityItem[]): string {
  const toolCount = items.filter((item) => item.kind === 'tool').length;
  const hasThinking = items.some((item) => item.kind === 'thinking');
  if (toolCount > 0 && hasThinking) {
    return `Thought process · ${toolCount} ${toolCount === 1 ? 'step' : 'steps'}`;
  }
  if (toolCount > 0) {
    return `${toolCount} ${toolCount === 1 ? 'step' : 'steps'} evaluated`;
  }
  return 'Thought process';
}

function cleanDisplayText(raw: string): string {
  return stripBuildIntakeMarkers(stripInterviewPhaseMarkers(raw)).trim();
}

/**
 * Groups raw `ChatMessage[]` (including `_reasoning`, `_thinking`, and `role: 'tool'` rows)
 * into Brainstorm-style turns where each assistant message carries its `activity` trace,
 * and returns any trailing in-progress `pendingActivity` not yet attached to a final reply.
 */
export function groupChatMessagesIntoTurns(messages: readonly ChatMessage[]): {
  turns: GroupedChatTurn[];
  pendingActivity: BuildActivityItem[];
} {
  const turns: GroupedChatTurn[] = [];
  let stagedActivity: BuildActivityItem[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (msg.text === 'Begin.') continue;
      // Hide synthetic Confirm messages if any exist from older runs
      const cleanedUser = msg.text.trim();
      if (!cleanedUser) continue;
      turns.push({
        id: msg.id,
        role: 'user',
        text: cleanedUser,
        activity: [],
      });
      continue;
    }

    if (
      msg.role === 'agent' &&
      (msg.toolName === '_reasoning' || msg.toolName === '_thinking')
    ) {
      const text = msg.text?.trim();
      if (text) {
        stagedActivity.push({
          id: msg.id,
          kind: 'thinking',
          text,
        });
      }
      continue;
    }

    if (msg.role === 'tool') {
      stagedActivity.push({
        id: msg.id,
        kind: 'tool',
        toolName: msg.toolName ?? 'tool',
        status: 'completed',
        target: msg.text?.trim() || null,
      });
      continue;
    }

    if (msg.role === 'agent') {
      const cleaned = cleanDisplayText(msg.text ?? '');
      if (!cleaned && stagedActivity.length === 0) continue;
      turns.push({
        id: msg.id,
        role: 'agent',
        text: cleaned,
        activity: stagedActivity,
      });
      stagedActivity = [];
    }
  }

  return {
    turns,
    pendingActivity: stagedActivity,
  };
}

function BuildActivityLog({ items }: { items: BuildActivityItem[] }) {
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [items]);

  return (
    <div ref={scrollerRef} className={styles.activityScroller}>
      {items.map((item) => {
        if (item.kind === 'thinking') {
          if (!item.text) return null;
          return (
            <p
              key={item.id}
              className={styles.thinking}
              {...{ 'data-testid': 'build-workspace-agent-thinking' }}
            >
              {item.text}
            </p>
          );
        }
        const target = cleanTargetLabel(item.target);
        const label = friendlyToolActivityLabel(item.toolName ?? 'tool', {
          ...(item.target ? { target: item.target } : {}),
        });
        const status =
          item.status === 'running'
            ? 'Working: '
            : item.status === 'error'
              ? 'Could not finish: '
              : 'Finished: ';
        return (
          <div key={item.id} className={styles.stepRow}>
            <span className={styles.stepBullet} aria-hidden="true">
              •
            </span>
            <span>
              <span className={styles.stepStatus}>{status}</span>
              <span className={styles.stepLabel}>{label}</span>
              {target ? (
                <code className={styles.stepTarget}>{` — ${target}`}</code>
              ) : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function BuildCollapsibleTrace({
  items,
  defaultOpen = false,
}: {
  items: BuildActivityItem[];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (items.length === 0) return null;
  return (
    <details
      className={styles.traceDrawer}
      open={open}
      onToggle={(event) =>
        setOpen((event.currentTarget as HTMLDetailsElement).open)
      }
      {...{ 'data-testid': 'build-workspace-thought-process' }}
    >
      <summary
        className={styles.traceSummary}
        {...{ 'data-testid': 'build-workspace-thought-process-toggle' }}
      >
        <span className={styles.traceChevron} aria-hidden="true">
          {open ? '▼' : '▶'}
        </span>
        <span>{activitySummaryLabel(items)}</span>
      </summary>
      <BuildActivityLog items={items} />
    </details>
  );
}

function BuildAgentWork({
  chat,
  text,
  persistedActivity,
  fallbackStageLabel,
}: {
  chat: AgentChatSession;
  text?: string;
  persistedActivity?: BuildActivityItem[];
  fallbackStageLabel?: string;
}) {
  const toolProgress = useMemo(
    () => chat.toolProgress ?? [],
    [chat.toolProgress]
  );
  const toolRunning = toolProgress.some((tool) => tool.status === 'running');
  const writing = Boolean(text && text.trim()) && !toolRunning;
  const activityLabel =
    chat.progressLabel ||
    fallbackStageLabel ||
    (chat.isSending
      ? 'Preparing repository context…'
      : 'Working through your request…');
  const [liveItems, setLiveItems] = useState<BuildActivityItem[]>([]);

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
        const entry: BuildActivityItem = {
          id: tool.callId,
          kind: 'tool',
          toolName: innerToolName,
          status: tool.status,
          target: toolTarget(tool.args),
        };
        const existingIdx = next.findIndex(
          (item) => item.kind === 'tool' && item.id === tool.callId
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

  const items = useMemo(() => {
    const base = persistedActivity ?? [];
    if (liveItems.length === 0) return base;
    const seen = new Set(base.map((i) => i.id));
    return [...base, ...liveItems.filter((i) => !seen.has(i.id))];
  }, [liveItems, persistedActivity]);

  return (
    <div
      aria-live="polite"
      aria-busy="true"
      {...{ 'data-testid': 'build-workspace-agent-progress' }}
    >
      {!writing ? (
        <div className={styles.liveWorkBox}>
          <p className={styles.activity}>
            <span
              className={styles.spinner}
              aria-hidden="true"
              {...{ 'data-testid': 'build-workspace-agent-busy' }}
            />
            <ChatRunProgressLabel
              fallbackLabel={activityLabel}
              progressPhase={chat.progressPhase ?? null}
              toolProgress={toolProgress}
            />
          </p>
          {items.length > 0 ? <BuildActivityLog items={items} /> : null}
        </div>
      ) : items.length > 0 ? (
        <BuildCollapsibleTrace items={items} />
      ) : null}
      {text ? (
        // data-testid-exempt — MarkdownWithMermaid renders streaming message body
        <MarkdownWithMermaid content={text} skipHtml />
      ) : null}
    </div>
  );
}

interface PipelineStepItem {
  key: string;
  label: string;
  state: 'done' | 'active' | 'pending' | 'failed';
}

export function derivePipelineSteps(
  status: BuildRunStatus | undefined,
  hasPullRequest: boolean
): PipelineStepItem[] {
  const order: Array<{ key: string; label: string }> = [
    { key: 'intake', label: '1. Request understood' },
    { key: 'planning', label: '2. Preparing your build' },
    { key: 'building', label: '3. Building and testing' },
    { key: 'checking', label: '4. Opening pull request' },
    { key: 'pr', label: '5. Ready to review' },
  ];

  let activeIndex = -1;
  if (!status || status === 'queued' || status === 'intake') {
    activeIndex = 0;
  } else if (status === 'planning') {
    activeIndex = 1;
  } else if (status === 'building') {
    activeIndex = 2;
  } else if (
    status === 'checking' ||
    status === 'deploying' ||
    status === 'preview_ready' ||
    status === 'accepted'
  ) {
    activeIndex = 3;
  } else if (hasPullRequest) {
    activeIndex = 4;
  } else if (
    status === 'failed' ||
    status === 'deployment_failed' ||
    status === 'suspended' ||
    status === 'needs_developer'
  ) {
    activeIndex = 2;
  } else {
    activeIndex = 2;
  }

  const allComplete = hasPullRequest;
  const stopped =
    status === 'failed' ||
    status === 'deployment_failed' ||
    status === 'suspended' ||
    status === 'needs_developer' ||
    status === 'cancelled';

  return order.map((item, idx) => ({
    key: item.key,
    label: item.label,
    state: allComplete
      ? 'done'
      : stopped && idx === activeIndex
        ? 'failed'
        : stopped && idx < activeIndex
          ? 'done'
          : idx < activeIndex
            ? 'done'
            : idx === activeIndex
              ? 'active'
              : 'pending',
  }));
}

export const BuildWorkspace: React.FC<BuildWorkspaceProps> = ({
  project,
  buildId,
  initialTab,
}) => {
  const navigate = useNavigate();
  const isNewMode = !buildId;
  const requestIdRef = useRef(newClientRequestId());
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const stickThreadToBottomRef = useRef(true);
  const planningTriggeredRef = useRef<string | null>(null);

  const [sideTab, setSideTab] = useState<'preview' | 'plan'>(() =>
    initialTab === 'plan' ||
    initialTab === 'overview' ||
    initialTab === 'verification' ||
    initialTab === 'timeline'
      ? 'plan'
      : 'preview'
  );
  const [sidePanelState, setSidePanelState] = useState<
    'normal' | 'minimized' | 'expanded'
  >('normal');
  const [selectedRepo, setSelectedRepo] = useState('');
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL_ID);
  const [draft, setDraft] = useState('');
  const [rememberForProject, setRememberForProject] = useState(false);
  const [eventsOpen, setEventsOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const isMinimized = sidePanelState === 'minimized';
  const isExpanded = sidePanelState === 'expanded';

  const repositoriesQuery = useBuildRepositories(project);
  const repoOptions = useMemo(
    () => repositoriesQuery.data?.repositories ?? [],
    [repositoriesQuery.data?.repositories]
  );
  const effectiveRepo = selectedRepo || repoOptions[0]?.repository || '';

  const { data: availableModels, isLoading: modelsLoading } =
    useAvailableModels();
  useAvailableModelSelection(selectedModel, setSelectedModel, availableModels);

  const startBuildMutation = useStartBuild(project);
  const buildQuery = useBuild(project, buildId ?? '');
  const eventsQuery = useBuildEvents(project, buildId ?? '', {
    enabled: Boolean(buildId),
  });
  const confirmIntakeMutation = useConfirmBuildIntake(project, buildId ?? '');
  const ensurePlanningMutation = useEnsureBuildPlanning(project, buildId ?? '');
  const acceptBuildMutation = useAcceptBuild(project, buildId ?? '');
  const revisionMutation = useRequestBuildRevision(project, buildId ?? '');
  const cancelMutation = useCancelBuild(project, buildId ?? '');
  const resumeMutation = useResumeBuild(project, buildId ?? '');

  const detail = buildQuery.data ?? null;
  const buildStatus = detail?.build.status;
  const intakeInterviewId = detail?.build.intakeInterviewId ?? null;

  const interviewQuery = useInterview(intakeInterviewId ?? '');
  const chatThreadId = interviewQuery.data?.chatThreadId ?? null;
  const chatThreadQuery = useChatThread(chatThreadId);

  const chatSession = useAgentChatSession(chatThreadId, {
    initialMessages: chatThreadQuery.data?.messages,
    initialStatus: chatThreadQuery.data?.status,
    initialActiveRunId: chatThreadQuery.data?.activeRunId,
    enablePreparationState: Boolean(buildId) && isBuildLive(buildStatus),
    streamTransport: 'ws',
  });

  const speech = useSpeechInput(
    useCallback((text: string) => setDraft(text), [])
  );

  // Auto-kickoff planning if a build enters or is opened in `planning` state
  useEffect(() => {
    if (!buildId || buildStatus !== 'planning') return;
    if (planningTriggeredRef.current === buildId) return;
    planningTriggeredRef.current = buildId;
    ensurePlanningMutation.mutate({});
  }, [buildId, buildStatus, ensurePlanningMutation]);

  // Keep chat thread synced while autonomous stages run on the thread
  const refetchChatThread = chatThreadQuery.refetch;
  useEffect(() => {
    if (!chatThreadId || !isBuildLive(buildStatus)) return;
    const timer = window.setInterval(() => {
      void refetchChatThread();
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [buildStatus, chatThreadId, refetchChatThread]);

  const { turns, pendingActivity } = useMemo(
    () => groupChatMessagesIntoTurns(chatSession.messages ?? []),
    [chatSession.messages]
  );

  const streamingText = chatSession.streamingText
    ? cleanDisplayText(chatSession.streamingText)
    : '';
  const toolProgress = useMemo(
    () => chatSession.toolProgress ?? [],
    [chatSession.toolProgress]
  );
  const isTurnStreaming =
    chatSession.isRunning ||
    chatSession.isSending ||
    chatSession.isPreparing ||
    chatSession.isAwaitingAgentResponse ||
    Boolean(streamingText) ||
    pendingActivity.length > 0;
  const intakeBusy = isTurnStreaming || confirmIntakeMutation.isPending;
  const prUrl = detail?.pullRequest?.url ?? null;
  const hasPr = Boolean(prUrl);
  const live = isBuildLive(buildStatus);
  const tasks = detail?.currentRevision?.tasks ?? [];
  const events = eventsQuery.data?.events ?? [];
  const progress = buildProgressHeadline({
    status: buildStatus,
    events,
    hasPullRequest: hasPr,
    // eslint-disable-next-line react-hooks/purity -- staleness uses the time of this render
    nowMs: Date.now(),
  });
  const canAskBuildQuestion = progress.stale && Boolean(chatThreadId);

  const handleThreadScroll = () => {
    const el = threadRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickThreadToBottomRef.current = distanceFromBottom <= 48;
  };

  useEffect(() => {
    const el = threadRef.current;
    if (!el || !stickThreadToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [
    turns.length,
    pendingActivity.length,
    streamingText,
    chatSession.thinkingText,
    toolProgress.length,
    eventsQuery.data?.events.length,
    buildStatus,
  ]);

  const handleConfirmAndBuild = useCallback(async () => {
    if (!buildId || confirmIntakeMutation.isPending) return;
    setActionError(null);
    try {
      await confirmIntakeMutation.mutateAsync({});
      await buildQuery.refetch();
      await eventsQuery.refetch();
      void refetchChatThread();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Could not start planning.'
      );
    }
  }, [
    buildId,
    buildQuery,
    confirmIntakeMutation,
    eventsQuery,
    refetchChatThread,
  ]);

  const handleChoiceClick = useCallback(
    async (optionLetter: string, optionText: string) => {
      if (intakeBusy) return;
      const isConfirmChoice =
        optionLetter.toLowerCase() === 'a' && /confirm/i.test(optionText);
      if (isConfirmChoice && buildId) {
        // Transition directly into Planning without sending a duplicate chat turn to build-intake
        await handleConfirmAndBuild();
        return;
      }
      if (chatThreadId) {
        await chatSession.send(`${optionLetter}. ${optionText}`, {
          model: selectedModel,
        });
      }
    },
    [
      buildId,
      chatSession,
      chatThreadId,
      handleConfirmAndBuild,
      intakeBusy,
      selectedModel,
    ]
  );

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    setActionError(null);
    speech.stop();

    if (isNewMode) {
      if (!effectiveRepo) {
        setActionError('Choose a repository to start your build.');
        return;
      }
      try {
        const created = await startBuildMutation.mutateAsync({
          repository: effectiveRepo,
          prompt: text,
          clientRequestId: requestIdRef.current,
          model: selectedModel || undefined,
        });
        setDraft('');
        navigate(`/builds/${encodeURIComponent(created.buildRunId)}`);
      } catch (err) {
        requestIdRef.current = newClientRequestId();
        if (!(err instanceof BuildApiError)) {
          setActionError(
            err instanceof Error ? err.message : 'The build was not started.'
          );
        }
      }
      return;
    }

    if (buildStatus === 'intake') {
      if (
        /^(confirm|a\.?\s*confirm|yes|ship it|looks good|start build)$/i.test(
          text
        )
      ) {
        setDraft('');
        await handleConfirmAndBuild();
        return;
      }
      if (!chatThreadId) return;
      setDraft('');
      await chatSession.send(text, { model: selectedModel });
      return;
    }

    if (canAskBuildQuestion) {
      if (!chatThreadId) return;
      setDraft('');
      await chatSession.send(
        `Build status question: ${text}\n\nThe repository build is still running. Answer the requester in plain language using the build request and latest known context. Do not change the build or open a pull request.`,
        { model: selectedModel },
      );
      return;
    }

    if (buildStatus === 'preview_ready' || buildStatus === 'accepted') {
      try {
        setDraft('');
        await revisionMutation.mutateAsync({ feedback: text });
        if (rememberForProject && buildId) {
          await fetch(
            `/api/builds/${encodeURIComponent(buildId)}/design-preference-proposal?project=${encodeURIComponent(project)}`,
            {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ feedback: text }),
            },
          );
        }
        await buildQuery.refetch();
      } catch (err) {
        setDraft(text);
        setActionError(
          err instanceof Error ? err.message : 'Could not start revision.'
        );
      }
    }
  }, [
    buildId,
    buildQuery,
    buildStatus,
    canAskBuildQuestion,
    chatSession,
    chatThreadId,
    draft,
    effectiveRepo,
    handleConfirmAndBuild,
    isNewMode,
    navigate,
    project,
    rememberForProject,
    revisionMutation,
    selectedModel,
    speech,
    startBuildMutation,
  ]);

  const handleCreatePullRequest = useCallback(async () => {
    if (!detail || acceptBuildMutation.isPending) return;
    setActionError(null);
    try {
      await acceptBuildMutation.mutateAsync({
        revisionNumber: detail.build.currentRevisionNumber,
      });
      await buildQuery.refetch();
      await eventsQuery.refetch();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Could not create pull request.'
      );
    }
  }, [acceptBuildMutation, buildQuery, detail, eventsQuery]);

  const startError =
    startBuildMutation.error instanceof BuildApiError
      ? startBuildMutation.error
      : null;
  const pipelineSteps = derivePipelineSteps(buildStatus, hasPr);
  const previewUrl = detail?.currentRevision
    ? (detail.revisions.find(
        (revision) => revision.number === detail.currentRevision?.number
      )?.previewUrl ?? null)
    : null;

  const composerBusy =
    startBuildMutation.isPending ||
    intakeBusy ||
    revisionMutation.isPending ||
    (Boolean(buildId) &&
      buildStatus !== 'intake' &&
      buildStatus !== 'preview_ready' &&
      buildStatus !== 'accepted' &&
      buildStatus !== 'failed' &&
      buildStatus !== 'cancelled' &&
      buildStatus !== 'deployment_failed' &&
      buildStatus !== 'suspended' &&
      buildStatus !== 'needs_developer');

  const composerDisabled = composerBusy && !canAskBuildQuestion;

  const canSend =
    draft.trim().length > 0 &&
    draft.trim().length <= BUILD_PROMPT_MAX_LENGTH &&
    !composerDisabled &&
    (isNewMode ? Boolean(effectiveRepo) : true);

  const composerPlaceholder = isNewMode
    ? 'Describe what you want to build (e.g. Add a calendar component to the home page)…'
    : buildStatus === 'intake'
      ? 'Reply to the collaborator, or click Confirm & Start Build…'
      : canAskBuildQuestion
        ? 'Ask what is happening with this build…'
      : buildStatus === 'preview_ready' || buildStatus === 'accepted'
        ? 'Ask for a change or revision to this build…'
        : buildStatus === 'failed' ||
            buildStatus === 'deployment_failed' ||
            buildStatus === 'suspended' ||
            buildStatus === 'needs_developer'
          ? 'This build stopped. You can review what happened above.'
          : 'Apex is building and testing your feature…';

  const statusText = isNewMode
    ? 'New Build'
    : hasPr
      ? 'Ready to review'
      : progress.failed
        ? 'Failed'
        : buildStatus === 'cancelled'
          ? 'Cancelled'
          : buildStatus
            ? buildStatusLabel(buildStatus)
            : 'Loading…';

  const fallbackStageLabel =
    buildStatus === 'planning'
      ? 'Understanding the request and preparing the repository…'
      : buildStatus === 'building'
        ? 'Building the feature and running its checks…'
        : buildStatus === 'checking'
          ? 'Checking the finished feature and preparing the pull request…'
          : undefined;

  return (
    <main className={styles.root} {...{ 'data-testid': 'build-workspace' }}>
      <header
        className={styles.header}
        {...{ 'data-testid': 'build-workspace-header' }}
      >
        <div className={styles.identity}>
          <Link
            to="/builds"
            className={styles.back}
            {...{ 'data-testid': 'build-workspace-back' }}
          >
            ← Builds
          </Link>
          <h1
            className={styles.title}
            {...{ 'data-testid': 'build-workspace-title' }}
          >
            {isNewMode
              ? 'New build'
              : detail?.build.repository
                ? `${detail.build.repository} · Build #${detail.build.id.slice(0, 8)}`
                : 'Build workspace'}
          </h1>
          {isNewMode ? (
            <select
              aria-label="Repository"
              className={styles.repoSelect}
              value={effectiveRepo}
              disabled={repositoriesQuery.isLoading || repoOptions.length === 0}
              onChange={(e) => setSelectedRepo(e.target.value)}
              {...{ 'data-testid': 'build-workspace-repo-select' }}
            >
              {repoOptions.length === 0 ? (
                <option value="">
                  {repositoriesQuery.isLoading
                    ? 'Loading repositories…'
                    : 'No repositories available'}
                </option>
              ) : (
                repoOptions.map((opt) => (
                  <option key={opt.repository} value={opt.repository}>
                    {opt.label}
                  </option>
                ))
              )}
            </select>
          ) : (
            detail && (
              <span
                className={styles.repoBadge}
                {...{ 'data-testid': 'build-workspace-repo-badge' }}
              >
                {detail.build.repository}
              </span>
            )
          )}
        </div>

        <div
          className={styles.meta}
          {...{ 'data-testid': 'build-workspace-meta' }}
        >
          <span
            role="status"
            aria-live="polite"
            className={`${styles.statusChip}${live && !progress.failed && !progress.stale ? ` ${styles.statusChipLive}` : ''}${hasPr ? ` ${styles.statusChipDone}` : ''}${progress.failed ? ` ${styles.statusChipFailed}` : ''}`}
            {...{ 'data-testid': 'build-workspace-status-chip' }}
          >
            {live && !progress.stale && !progress.failed && (
              <span className={styles.spinner} aria-hidden="true" />
            )}
            {statusText}
          </span>
          {detail && (
            <span {...{ 'data-testid': 'build-workspace-cost' }}>
              {`$${Number(detail.caps.cost.usedUsd).toFixed(2)} / $${Number(detail.caps.cost.limitUsd).toFixed(2)}`}
            </span>
          )}
          {detail && buildStatus === 'suspended' && (
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={resumeMutation.isPending}
              onClick={() => {
                void resumeMutation.mutateAsync({});
              }}
              {...{ 'data-testid': 'build-workspace-resume' }}
            >
              {resumeMutation.isPending ? 'Resuming…' : 'Resume build'}
            </button>
          )}
          {detail && live && (
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={cancelMutation.isPending}
              onClick={() => {
                void cancelMutation.mutateAsync({});
              }}
              {...{ 'data-testid': 'build-workspace-cancel' }}
            >
              {cancelMutation.isPending ? 'Stopping…' : 'Stop build'}
            </button>
          )}
        </div>
      </header>

      <div
        className={`${styles.split}${isMinimized ? ` ${styles.splitMinimized}` : ''}${isExpanded ? ` ${styles.splitExpanded}` : ''}`}
        data-side-state={sidePanelState}
      >
        {/* Left Pane: Continuous Brainstorm-style AI Collaborator & Agent Stream */}
        <div className={styles.chat}>
          <section
            className={styles.chatPanel}
            aria-label="Build collaborator chat"
            {...{ 'data-testid': 'build-workspace-chat-panel' }}
          >
            <div
              ref={threadRef}
              onScroll={handleThreadScroll}
              className={styles.thread}
              {...{ 'data-testid': 'build-workspace-thread' }}
            >
              {isNewMode && (
                <div
                  className={styles.emptyHero}
                  {...{ 'data-testid': 'build-workspace-empty' }}
                >
                  <h2 className={styles.emptyTitle}>What should we build?</h2>
                  <p className={styles.emptySub}>
                    Describe your feature in plain language. Your AI
                    collaborator will clarify any gaps, write the technical
                    plan, implement the code with tests, and open a Pull Request
                    automatically.
                  </p>
                  <p
                    className={styles.secretsNote}
                    {...{ 'data-testid': 'build-workspace-secrets-note' }}
                  >
                    Do not paste passwords, keys or customer data. The build
                    agent can read this request.
                  </p>
                </div>
              )}

              {/* Grouped Conversation Turns (with collapsible Thought process traces on every assistant message) */}
              {turns.map((turn, idx) => {
                const isUser = turn.role === 'user';
                const parsedParts =
                  !isUser && turn.text ? parseAgentMessage(turn.text) : [];
                const choiceBlocks = parsedParts.filter(
                  (part): part is ChoiceBlock => part.type === 'choices'
                );
                const isLatestAgentTurn = !isUser && idx === turns.length - 1;

                return (
                  <article
                    key={turn.id}
                    className={`${styles.message} ${isUser ? styles.user : styles.collaborator}`}
                    aria-label={isUser ? 'Your message' : 'Collaborator'}
                    {...{
                      'data-testid': isUser
                        ? 'build-workspace-user-msg'
                        : 'build-workspace-agent-msg',
                    }}
                  >
                    {!isUser && turn.activity.length > 0 && (
                      <BuildCollapsibleTrace items={turn.activity} />
                    )}
                    {turn.text ? (
                      // data-testid-exempt — MarkdownWithMermaid renders turn body
                      <MarkdownWithMermaid content={turn.text} skipHtml />
                    ) : null}
                    {isLatestAgentTurn &&
                      choiceBlocks.length > 0 &&
                      buildStatus === 'intake' && (
                        <div className={styles.choiceRow}>
                          {choiceBlocks.flatMap((block) =>
                            block.options.map((opt) => (
                              <button
                                key={`${block.id}-${opt.letter}`}
                                type="button"
                                className={styles.choiceButton}
                                disabled={intakeBusy}
                                onClick={() => {
                                  void handleChoiceClick(opt.letter, opt.text);
                                }}
                                {...{
                                  'data-testid': `build-workspace-choice-${opt.letter}`,
                                }}
                              >
                                {`${opt.letter.toUpperCase()}. ${opt.text}`}
                              </button>
                            ))
                          )}
                        </div>
                      )}
                  </article>
                );
              })}

              {/* Live Streaming Agent Work Box (identical to BrainstormAgentWork across Intake, Planning, and Building) */}
              {isTurnStreaming && (
                <article
                  className={`${styles.message} ${styles.collaborator}`}
                  aria-label="Collaborator"
                >
                  <BuildAgentWork
                    chat={chatSession}
                    text={streamingText}
                    persistedActivity={pendingActivity}
                    fallbackStageLabel={fallbackStageLabel}
                  />
                </article>
              )}

              {/* One-click Confirm & Start Build bar during Intake */}
              {buildStatus === 'intake' &&
                turns.some((t) => t.role === 'agent') &&
                !isTurnStreaming && (
                  <div
                    className={styles.confirmBar}
                    {...{ 'data-testid': 'build-workspace-confirm-bar' }}
                  >
                    <p className={styles.confirmText}>
                      Confirm that this captures what you want. Apex will build
                      it, run the checks, fix what it can, and open a pull
                      request.
                    </p>
                    <button
                      type="button"
                      className={styles.primaryButton}
                      disabled={intakeBusy}
                      onClick={() => {
                        void handleConfirmAndBuild();
                      }}
                      {...{ 'data-testid': 'build-workspace-confirm-button' }}
                    >
                      {confirmIntakeMutation.isPending
                        ? 'Starting build…'
                        : 'Confirm & Start Build'}
                    </button>
                  </div>
                )}

              {/* Build Pipeline Stage Progress Card (Planning / Building / Checking) */}
              {buildId && buildStatus && buildStatus !== 'intake' && (
                <article
                  className={`${styles.message} ${styles.collaborator}`}
                  aria-label="Autonomous build status"
                  {...{ 'data-testid': 'build-workspace-autonomous-card' }}
                >
                  <div className={styles.liveWorkBox}>
                    <p className={styles.activity}>
                      {live && !isTurnStreaming && !progress.stale && !progress.failed && (
                        <span className={styles.spinner} aria-hidden="true" />
                      )}
                      <span
                        {...{ 'data-testid': 'build-workspace-stage-headline' }}
                      >
                        {progress.headline}
                      </span>
                    </p>

                    <details
                      className={styles.traceDrawer}
                      open={eventsOpen}
                      onToggle={(e) =>
                        setEventsOpen(
                          (e.currentTarget as HTMLDetailsElement).open
                        )
                      }
                      {...{ 'data-testid': 'build-workspace-events-trace' }}
                    >
                      <summary
                        className={styles.traceSummary}
                        {...{
                          'data-testid': 'build-workspace-events-trace-toggle',
                        }}
                      >
                        <span
                          className={styles.traceChevron}
                          aria-hidden="true"
                        >
                          {eventsOpen ? '▼' : '▶'}
                        </span>
                        <span>{`Build details · ${events.length} ${events.length === 1 ? 'update' : 'updates'}`}</span>
                      </summary>
                      <div className={styles.activityScroller}>
                        {events.length === 0 ? (
                          <div className={styles.stepRow}>
                            <span>Preparing agent workspace…</span>
                          </div>
                        ) : (
                          events.map((ev) => (
                            <div
                              key={ev.id}
                              className={styles.stepRow}
                              {...{
                                'data-testid': 'build-workspace-event-row',
                              }}
                            >
                              <span
                                className={styles.stepBullet}
                                aria-hidden="true"
                              >
                                •
                              </span>
                              <span>
                                <span>{userFacingBuildEvent(ev.message)}</span>
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                    </details>

                    {(buildStatus === 'planning' ||
                      buildStatus === 'building') &&
                      !isTurnStreaming &&
                      tasks.some((t) => t.status === 'failed') && (
                        <div className={styles.choiceRow}>
                          <button
                            type="button"
                            className={styles.secondaryButton}
                            disabled={ensurePlanningMutation.isPending}
                            onClick={() => {
                              ensurePlanningMutation.mutate({});
                            }}
                            {...{
                              'data-testid': 'build-workspace-retry-planning',
                            }}
                          >
                            {ensurePlanningMutation.isPending
                              ? 'Retrying…'
                              : 'Retry build'}
                          </button>
                        </div>
                      )}
                  </div>
                </article>
              )}

              {/* Pull Request Finish Card (POC Target) */}
              {(hasPr ||
                buildStatus === 'preview_ready' ||
                buildStatus === 'accepted') && (
                <div
                  className={styles.confirmBar}
                  {...{ 'data-testid': 'build-workspace-pr-card' }}
                >
                  <div>
                    <strong>
                      {hasPr
                        ? 'Pull Request Created'
                        : buildStatus === 'accepted'
                          ? 'Opening Pull Request'
                          : 'Build Validated & Ready for Pull Request'}
                    </strong>
                    <p className={styles.confirmText}>
                      {hasPr
                        ? 'Your feature branch has been verified and a Pull Request is open in Azure DevOps.'
                        : buildStatus === 'accepted'
                          ? 'Apex is opening the Pull Request in Azure DevOps now.'
                          : 'All tasks and checks have completed. Create the Pull Request in Azure DevOps to finish.'}
                    </p>
                  </div>
                  {prUrl ? (
                    <a
                      href={prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={styles.primaryButton}
                      {...{ 'data-testid': 'build-workspace-pr-link' }}
                    >
                      View Pull Request in ADO ↗
                    </a>
                  ) : (
                    <button
                      type="button"
                      className={styles.primaryButton}
                      disabled={acceptBuildMutation.isPending}
                      onClick={() => {
                        void handleCreatePullRequest();
                      }}
                      {...{ 'data-testid': 'build-workspace-create-pr-button' }}
                    >
                      {acceptBuildMutation.isPending
                        ? 'Creating PR…'
                        : buildStatus === 'accepted'
                          ? 'Retry now'
                          : 'Create Pull Request'}
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className={styles.composerWrap}>
              {(startError || actionError || chatSession.sendError) && (
                <div
                  role="alert"
                  className={styles.errorBanner}
                  {...{ 'data-testid': 'build-workspace-error-banner' }}
                >
                  <strong>
                    {startError?.message ??
                      actionError ??
                      chatSession.sendError}
                  </strong>
                  {startError && startError.refusals.length > 0 && (
                    <ul
                      className={styles.errorList}
                      {...{ 'data-testid': 'build-workspace-refusal-list' }}
                    >
                      {startError.refusals.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {(buildStatus === 'preview_ready' || buildStatus === 'accepted') && (
                <label className={styles.rememberPreference}>
                  <input
                    type="checkbox"
                    checked={rememberForProject}
                    onChange={(event) => setRememberForProject(event.target.checked)}
                    data-testid="build-workspace-remember-preference"
                  />
                  Remember this feedback as a design preference proposal for project admins
                </label>
              )}

              {/* data-testid-exempt — AgentComposer owns build-workspace-composer testids */}
              <AgentComposer
                className={styles.composerEmbed}
                shellClassName={styles.composerShell}
                textareaRef={inputRef}
                value={draft}
                onChange={(value) =>
                  setDraft(value.slice(0, BUILD_PROMPT_MAX_LENGTH))
                }
                onSend={() => {
                  void handleSend();
                }}
                onCancel={() => {
                  void chatSession.cancel();
                }}
                disabled={composerDisabled}
                isRunning={chatSession.isRunning}
                isSending={
                  startBuildMutation.isPending || chatSession.isSending
                }
                isBusy={composerDisabled}
                isCancelling={chatSession.isCancelling}
                canSend={canSend}
                rows={3}
                maxHeight={160}
                placeholder={composerPlaceholder}
                testIdPrefix="build-workspace-composer"
                data-testid="build-workspace-composer"
                testIds={{
                  input: 'build-workspace-composer-input',
                  send: 'build-workspace-composer-send',
                  stop: 'build-workspace-composer-stop',
                  microphone: 'build-workspace-composer-microphone',
                  model: 'build-workspace-composer-model',
                }}
                model={selectedModel}
                models={availableModels}
                modelsLoading={modelsLoading}
                onModelChange={setSelectedModel}
                speech={{
                  isListening: speech.isListening,
                  isSpeechSupported: speech.isSpeechSupported,
                  speechError: speech.speechError,
                  onToggle: () => speech.toggle(draft),
                }}
              />
            </div>
          </section>
        </div>

        {/* Right Pane: live branch preview and optional build details */}
        <div
          className={`${styles.artifact}${isMinimized ? ` ${styles.artifactMinimized}` : ''}`}
          {...{ 'data-testid': 'build-workspace-side-panel' }}
        >
          <div className={styles.sideHeader}>
            <div className={styles.sideTabs} role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={!isMinimized && sideTab === 'preview'}
                className={styles.sideTab}
                onClick={() => {
                  setSideTab('preview');
                  if (isMinimized) setSidePanelState('normal');
                }}
                {...{ 'data-testid': 'build-workspace-preview-tab' }}
              >
                Preview
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={!isMinimized && sideTab === 'plan'}
                className={styles.sideTab}
                onClick={() => {
                  setSideTab('plan');
                  if (isMinimized) setSidePanelState('normal');
                }}
                {...{ 'data-testid': 'build-workspace-plan-tab' }}
              >
                Details
              </button>
            </div>
            <div className={styles.sideControls}>
              {!isMinimized && (
                <button
                  type="button"
                  className={styles.sideControlButton}
                  aria-pressed={isExpanded}
                  onClick={() =>
                    setSidePanelState((prev) =>
                      prev === 'expanded' ? 'normal' : 'expanded'
                    )
                  }
                  {...{ 'data-testid': 'build-workspace-side-expand' }}
                >
                  {isExpanded ? 'Restore' : 'Expand'}
                </button>
              )}
              <button
                type="button"
                className={styles.sideControlButton}
                aria-expanded={!isMinimized}
                onClick={() =>
                  setSidePanelState((prev) =>
                    prev === 'minimized' ? 'normal' : 'minimized'
                  )
                }
                {...{
                  'data-testid': isMinimized
                    ? 'build-workspace-side-expand'
                    : 'build-workspace-side-minimize',
                }}
              >
                {isMinimized ? 'Expand' : 'Minimize'}
              </button>
            </div>
          </div>

          {!isMinimized &&
            (sideTab === 'preview' ? (
              <section
                className={styles.sidePanelBody}
                aria-label="Preview"
                {...{ 'data-testid': 'build-workspace-preview-panel' }}
              >
                <div
                  className={styles.sandboxWindow}
                  {...{ 'data-testid': 'build-workspace-sandbox-frame' }}
                >
                  <div className={styles.sandboxChrome}>
                    <span className={styles.sandboxDots} aria-hidden="true">
                      <span className={styles.sandboxDot} />
                      <span className={styles.sandboxDot} />
                      <span className={styles.sandboxDot} />
                    </span>
                    <span className={styles.sandboxUrl}>
                      {previewUrl ??
                        `preview://building/${detail?.build.repository ?? (effectiveRepo || 'app')}`}
                    </span>
                  </div>
                  <div className={styles.sandboxViewport}>
                    {previewUrl ? (
                      <iframe
                        className={styles.previewFrame}
                        src={previewUrl}
                        title="Build preview"
                        sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
                        {...{ 'data-testid': 'build-workspace-preview-iframe' }}
                      />
                    ) : (
                      <>
                        <h3 className={styles.sectionHeading}>
                          {previewUrl
                            ? 'Preview'
                            : progress.failed
                              ? 'No preview'
                              : 'Your preview will appear here'}
                        </h3>
                        <p className={styles.emptySub}>
                          {progress.failed
                            ? 'This build stopped before a preview was available.'
                            : 'A preview appears here when this project provides one.'}
                        </p>
                        <ol
                          className={styles.stepperList}
                          {...{
                            'data-testid': 'build-workspace-pipeline-steps',
                          }}
                        >
                          {pipelineSteps.map((step) => (
                            <li
                              key={step.key}
                              className={`${styles.stepperItem}${step.state === 'active' ? ` ${styles.stepperItemActive}` : ''}${step.state === 'done' ? ` ${styles.stepperItemDone}` : ''}${step.state === 'failed' ? ` ${styles.stepperItemFailed}` : ''}`}
                              {...{
                                'data-testid': `build-workspace-step-${step.key}`,
                              }}
                            >
                              <span aria-hidden="true">
                                {step.state === 'done'
                                  ? '✓'
                                  : step.state === 'failed'
                                    ? '!'
                                    : step.state === 'active'
                                      ? '●'
                                      : '○'}
                              </span>
                              <span>{step.label}</span>
                            </li>
                          ))}
                        </ol>
                      </>
                    )}
                  </div>
                </div>

                {detail && (
                  <div
                    className={styles.metricsRow}
                    {...{ 'data-testid': 'build-workspace-metrics' }}
                  >
                    <div className={styles.metricCard}>
                      <span className={styles.metricValue}>{tasks.length}</span>
                      <span>Build Steps</span>
                    </div>
                    <div className={styles.metricCard}>
                      <span className={styles.metricValue}>
                        {detail.verificationSummary.pass}
                      </span>
                      <span>Checks Passed</span>
                    </div>
                    <div className={styles.metricCard}>
                      <span className={styles.metricValue}>
                        {detail.currentRevision?.brief.status === 'ok'
                          ? detail.currentRevision.brief.requirements.filter(
                              (r) => !r.retired
                            ).length
                          : 0}
                      </span>
                      <span>Requirements</span>
                    </div>
                  </div>
                )}
              </section>
            ) : (
              <section
                className={styles.sidePanelBody}
                aria-label="Build details"
                {...{ 'data-testid': 'build-workspace-plan-panel' }}
              >
                <div>
                  <h3 className={styles.sectionHeading}>Requirements</h3>
                  {detail?.currentRevision?.brief.status === 'ok' &&
                  detail.currentRevision.brief.requirements.length > 0 ? (
                    <ul
                      className={styles.reqList}
                      {...{
                        'data-testid': 'build-workspace-requirements-list',
                      }}
                    >
                      {detail.currentRevision.brief.requirements
                        .filter((r) => !r.retired)
                        .map((req) => (
                          <li key={req.id}>
                            <strong>{req.id}:</strong> {req.text}
                          </li>
                        ))}
                    </ul>
                  ) : (
                    <p
                      className={styles.emptySub}
                      {...{
                        'data-testid': 'build-workspace-requirements-empty',
                      }}
                    >
                      Requirements will appear here once intake confirms the
                      brief.
                    </p>
                  )}
                </div>

                <div>
                  <h3 className={styles.sectionHeading}>Build Activity</h3>
                  {tasks.length > 0 ? (
                    <ul
                      className={styles.reqList}
                      {...{ 'data-testid': 'build-workspace-tasks-list' }}
                    >
                      {tasks.map((t) => (
                        <li key={t.key}>
                          <strong>Feature build:</strong>{' '}
                          <span>{t.status}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p
                      className={styles.emptySub}
                      {...{ 'data-testid': 'build-workspace-tasks-empty' }}
                    >
                      Build activity will appear here after the request is
                      confirmed.
                    </p>
                  )}
                </div>
              </section>
            ))}
        </div>
      </div>
    </main>
  );
};

export default BuildWorkspace;

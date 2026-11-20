import { v4 as uuidv4 } from 'uuid';
import type {
  AgentRunEventStatus,
  AgentRunHealth,
  AgentRunPhase,
  ChatMessage,
  SseDoneEvent,
  SseErrorEvent,
  SseEvent,
  SseGroundingEvent,
  SseHealthEvent,
  SseMessageEvent,
  SsePhaseEvent,
  SseRetryingEvent,
  SseSummaryEvent,
  SseThinkingEvent,
  SseTokenEvent,
  SseToolStatusEvent,
} from '../../../shared/types/chat';
import type {
  AgentActivityItem,
  AgentActivityToolItem,
  HarnessAgentPhase,
  HarnessSummaryMarker,
} from '../../../shared/types/chatHarness';
import {
  friendlyChatErrorMessage,
  friendlyChatProgressLabel,
} from '../../../shared/utils/chatProgressCopy';
import type {
  RunHealthProgress,
  RunPhaseProgress,
  ToolProgress,
} from '../../hooks/useChatStream';
import type { HarnessSummaryNoticeState, RuntimeState } from '../types';

export const MAX_SEEN_EVENT_IDS = 2048;
export const MAX_PHASE_EVENTS = 200;

export const SUMMARY_RUNNING_TEXT = 'Summarizing conversation…';
export const SUMMARY_FALLBACK_TEXT =
  'Only a trimmed transcript was kept for this conversation.';
export const SUMMARY_ERROR_TEXT = 'Could not summarize this conversation.';

const RESTARTING_LABEL = 'Restarting your answer…';

/**
 * Only these SSE event types carry durable `id:` frames from the server.
 * Token/message/thinking frames often omit `id:`, and browsers/transports may
 * repeat a sticky previous id — deduping those by eventId alone would drop live text.
 */
export const DURABLE_SSE_EVENT_TYPES = new Set<SseEvent['type']>([
  'phase',
  'health',
  'tool_call',
  'tool_status',
  'status',
  'summary',
  'retrying',
  'error',
  'done',
]);

const RUN_PHASES = new Set<AgentRunPhase>([
  'queued',
  'dispatched',
  'setup',
  'planning',
  'approval',
  'dependencies',
  'analysis',
  'implementation',
  'testing',
  'typecheck',
  'push',
  'completion',
]);

const RUN_EVENT_STATUSES = new Set<AgentRunEventStatus>([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

const RUN_HEALTH_VALUES = new Set<AgentRunHealth>([
  'healthy',
  'progress_stale',
  'progress_timeout',
  'long_running',
  'worker_lost',
  'hard_timeout',
  'never_claimed',
]);

/** Chronological order for chat history (SSE replay + snapshot/optimistic merge). */
export function sortChatMessagesByTs(messages: ChatMessage[]): ChatMessage[] {
  return [...messages].sort((a, b) => {
    const byTs = a.ts.localeCompare(b.ts);
    if (byTs !== 0) return byTs;
    return a.id.localeCompare(b.id);
  });
}

export function durableTokenKey(eventId: string, event: SseTokenEvent): string {
  return `${eventId}:${event.streamOffset ?? 'legacy'}`;
}

export function safeDetail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim().slice(0, 500);
  return normalized || undefined;
}

function safeTimestamp(value: unknown, fallback: number): number {
  if (typeof value !== 'string') return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function mergeThinkingText(previous: string, incoming: string): string {
  const trimmed = incoming.trim();
  if (!trimmed) return previous;
  if (!previous || previous === 'Analyzing') return trimmed;
  if (trimmed === 'Analyzing') return previous;
  if (trimmed.startsWith(previous)) return trimmed;
  if (/^[.,!?;:)'"\]]/.test(trimmed) || /\s$/.test(previous)) {
    return `${previous}${trimmed}`;
  }
  return `${previous} ${trimmed}`;
}

/** Joins raw streamed pieces exactly; they carry their own spacing. */
export function appendThinkingPiece(previous: string, piece: string): string {
  if (!previous || previous === 'Analyzing') return piece.trimStart();
  return `${previous}${piece}`;
}

export function deriveSummaryNotice(
  phase: HarnessAgentPhase,
  latestSummary: HarnessSummaryMarker | null,
  current: HarnessSummaryNoticeState | null,
): HarnessSummaryNoticeState | null {
  if (phase === 'summarizing') {
    return {
      status: 'running',
      text: SUMMARY_RUNNING_TEXT,
      isFallback: false,
    };
  }
  if (latestSummary?.fallback) {
    return {
      status: 'fallback',
      text: SUMMARY_FALLBACK_TEXT,
      isFallback: true,
    };
  }
  if (current?.status === 'running') {
    return null;
  }
  return current;
}

export interface EventReducerMeta {
  streamBuffer: string;
  streamTrimOffset: number;
  lastThinkingSeq: number;
  pendingOffsetTokens: Map<number, { text: string; key: string }>;
  seenEventIds: Set<string>;
  seenEventIdOrder: string[];
  failedRunId: string | null;
  eventDrivenTermination: boolean;
  thinkingItemSeq: number;
  groupItemSeq: number;
  itemGroupIds: Map<string, string>;
}

export function createEventReducerMeta(): EventReducerMeta {
  return {
    streamBuffer: '',
    streamTrimOffset: 0,
    lastThinkingSeq: 0,
    pendingOffsetTokens: new Map(),
    seenEventIds: new Set(),
    seenEventIdOrder: [],
    failedRunId: null,
    eventDrivenTermination: false,
    thinkingItemSeq: 0,
    groupItemSeq: 0,
    itemGroupIds: new Map(),
  };
}

export function clearTurnBufferMeta(meta: EventReducerMeta): void {
  meta.streamBuffer = '';
  meta.streamTrimOffset = 0;
  meta.pendingOffsetTokens.clear();
  meta.lastThinkingSeq = 0;
  meta.thinkingItemSeq = 0;
  meta.groupItemSeq = 0;
  meta.itemGroupIds.clear();
}

function rememberEventId(meta: EventReducerMeta, eventId: string): boolean {
  if (!eventId) return true;
  if (meta.seenEventIds.has(eventId)) return false;

  meta.seenEventIds.add(eventId);
  meta.seenEventIdOrder.push(eventId);
  if (meta.seenEventIdOrder.length > MAX_SEEN_EVENT_IDS) {
    const evicted = meta.seenEventIdOrder.shift();
    if (evicted) meta.seenEventIds.delete(evicted);
  }
  return true;
}

function progressLabelForPhase(phase: AgentRunPhase, detail?: string): string {
  return friendlyChatProgressLabel(detail, phase);
}

function normalizePhaseEvent(
  event: SseEvent,
  eventId: string,
  now: number,
): RunPhaseProgress | null {
  const phase = event.type === 'phase' ? event.phase : event.semanticPhase;
  const status = event.type === 'phase' ? event.status : event.semanticStatus;
  if (
    !phase ||
    !status ||
    !RUN_PHASES.has(phase) ||
    !RUN_EVENT_STATUSES.has(status)
  ) {
    return null;
  }
  const phaseEvent = event.type === 'phase' ? (event as SsePhaseEvent) : null;
  const durationMs =
    typeof phaseEvent?.durationMs === 'number' &&
    Number.isFinite(phaseEvent.durationMs)
      ? Math.max(0, Math.min(phaseEvent.durationMs, 24 * 60 * 60_000))
      : undefined;
  const detail = safeDetail(phaseEvent?.detail ?? event.semanticDetail);
  return {
    id: eventId || uuidv4(),
    ...(typeof event.runId === 'string' && event.runId
      ? { runId: event.runId.slice(0, 200) }
      : {}),
    phase,
    status,
    ...(detail ? { detail } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    timestamp: safeTimestamp(event.eventTimestamp, now),
  };
}

function normalizeHealthEvent(
  event: SseHealthEvent,
  now: number,
): RunHealthProgress | null {
  if (!RUN_HEALTH_VALUES.has(event.health)) return null;
  const detail = safeDetail(event.detail);
  if (!detail) return null;
  return {
    health: event.health,
    detail,
    ...(typeof event.runId === 'string' && event.runId
      ? { runId: event.runId.slice(0, 200) }
      : {}),
    timestamp: safeTimestamp(event.eventTimestamp, now),
  };
}

function unwrapToolName(toolName: string, args?: unknown): string {
  if (
    toolName === 'mcp' &&
    args &&
    typeof args === 'object' &&
    typeof (args as { toolName?: unknown }).toolName === 'string'
  ) {
    const inner = (args as { toolName: string }).toolName.trim();
    if (inner) return `mcp:${inner}`;
  }
  return toolName;
}

function extractToolTarget(args: unknown, depth = 0): string | null {
  if (depth > 4 || !args || typeof args !== 'object') return null;
  const record = args as { target?: unknown; args?: unknown };
  if (typeof record.target === 'string') {
    const normalized = safeDetail(record.target);
    if (normalized) return normalized;
  }
  return record.args ? extractToolTarget(record.args, depth + 1) : null;
}

function computeGroupStatus(
  tools: ReadonlyArray<AgentActivityToolItem>,
): 'running' | 'completed' | 'error' {
  if (tools.some((t) => t.status === 'running')) return 'running';
  if (tools.some((t) => t.status === 'error')) return 'error';
  return 'completed';
}

function toToolSubItem(item: AgentActivityItem): AgentActivityToolItem {
  return {
    id: item.id,
    toolName: item.toolName ?? 'tool',
    status:
      item.status === 'running' || item.status === 'error'
        ? item.status
        : 'completed',
    target: item.target ?? null,
  };
}

function upsertThinkingActivity(
  activity: AgentActivityItem[],
  thinkingText: string,
  meta: EventReducerMeta,
): AgentActivityItem[] {
  const trimmed = thinkingText.trim();
  if (!trimmed) return activity;
  const last = activity[activity.length - 1];
  if (last && last.kind === 'thinking') {
    if (trimmed === 'Analyzing' || trimmed === last.text) return activity;
    return [...activity.slice(0, -1), { ...last, text: trimmed }];
  }
  meta.thinkingItemSeq += 1;
  return [
    ...activity,
    {
      id: `thinking-${meta.thinkingItemSeq}`,
      kind: 'thinking',
      text: trimmed,
    },
  ];
}

function upsertToolActivity(
  activity: AgentActivityItem[],
  event: SseToolStatusEvent,
  meta: EventReducerMeta,
): AgentActivityItem[] {
  const resolvedToolName = unwrapToolName(event.toolName, event.args);
  const extractedTarget = extractToolTarget(event.args);
  const explicitGroupId =
    typeof event.groupId === 'string' && event.groupId.trim()
      ? event.groupId.trim()
      : undefined;

  // 1. Update existing standalone tool item by callId
  const standaloneIdx = activity.findIndex(
    (item) => item.kind === 'tool' && item.id === event.callId,
  );
  if (standaloneIdx >= 0) {
    const existing = activity[standaloneIdx];
    const updated: AgentActivityItem = {
      id: existing.id,
      kind: 'tool',
      toolName: resolvedToolName,
      status: event.status,
      target: extractedTarget ?? existing.target ?? null,
    };
    const next = [...activity];
    next[standaloneIdx] = updated;
    return next;
  }

  // 2. Update existing tool inside a tool-group by callId
  for (let i = 0; i < activity.length; i += 1) {
    const item = activity[i];
    if (item.kind !== 'tool-group' || !item.tools) continue;
    const memberIdx = item.tools.findIndex((tool) => tool.id === event.callId);
    if (memberIdx < 0) continue;
    const prevMember = item.tools[memberIdx];
    const nextTools: AgentActivityToolItem[] = [...item.tools];
    nextTools[memberIdx] = {
      id: prevMember.id,
      toolName: resolvedToolName,
      status: event.status,
      target: extractedTarget ?? prevMember.target ?? null,
    };
    const next = [...activity];
    next[i] = {
      id: item.id,
      kind: 'tool-group',
      status: computeGroupStatus(nextTools),
      tools: nextTools,
    };
    return next;
  }

  // New tool item (never includes `result`)
  const newSubItem: AgentActivityToolItem = {
    id: event.callId,
    toolName: resolvedToolName,
    status: event.status,
    target: extractedTarget,
  };

  // 3. Explicit groupId match against existing tool-group or standalone tool
  if (explicitGroupId) {
    const groupIdx = activity.findIndex(
      (item) => item.kind === 'tool-group' && item.id === explicitGroupId,
    );
    if (groupIdx >= 0) {
      const existingGroup = activity[groupIdx];
      const nextTools = [...(existingGroup.tools ?? []), newSubItem];
      const next = [...activity];
      next[groupIdx] = {
        id: existingGroup.id,
        kind: 'tool-group',
        status: computeGroupStatus(nextTools),
        tools: nextTools,
      };
      return next;
    }

    const peerIdx = activity.findIndex(
      (item) =>
        item.kind === 'tool' && meta.itemGroupIds.get(item.id) === explicitGroupId,
    );
    if (peerIdx >= 0) {
      const peer = activity[peerIdx];
      const nextTools = [toToolSubItem(peer), newSubItem];
      const next = [...activity];
      next[peerIdx] = {
        id: explicitGroupId,
        kind: 'tool-group',
        status: computeGroupStatus(nextTools),
        tools: nextTools,
      };
      return next;
    }
  }

  // 4. Start-order concurrency grouping within the current consecutive tool run
  const lastIdx = activity.length - 1;
  const last = lastIdx >= 0 ? activity[lastIdx] : null;
  if (last && last.kind === 'tool-group' && last.status === 'running') {
    const nextTools = [...(last.tools ?? []), newSubItem];
    const next = [...activity];
    next[lastIdx] = {
      id: last.id,
      kind: 'tool-group',
      status: computeGroupStatus(nextTools),
      tools: nextTools,
    };
    return next;
  }

  if (last && last.kind === 'tool' && last.status === 'running') {
    const groupId =
      explicitGroupId ??
      meta.itemGroupIds.get(last.id) ??
      `group-${++meta.groupItemSeq}`;
    const nextTools = [toToolSubItem(last), newSubItem];
    const next = [...activity];
    next[lastIdx] = {
      id: groupId,
      kind: 'tool-group',
      status: computeGroupStatus(nextTools),
      tools: nextTools,
    };
    return next;
  }

  // 5. Standalone single tool call
  if (explicitGroupId) {
    meta.itemGroupIds.set(event.callId, explicitGroupId);
  }
  return [
    ...activity,
    {
      id: event.callId,
      kind: 'tool',
      toolName: resolvedToolName,
      status: event.status,
      target: extractedTarget,
    },
  ];
}

function clearTurnProgressFields(
  _state: RuntimeState,
  meta: EventReducerMeta,
): Partial<RuntimeState> {
  clearTurnBufferMeta(meta);
  return {
    streamingText: '',
    thinkingText: '',
    toolProgress: [],
    activity: [],
    isRetrying: false,
    retryReason: null,
    groundingPreparation: null,
    progressLabel: null,
    progressPhase: null,
  };
}

/** Drop turn-owning commands once the turn reaches a terminal event. */
function clearSettledTurnPendingCommands(
  pendingCommands: RuntimeState['pendingCommands'],
): RuntimeState['pendingCommands'] {
  const next = pendingCommands.filter(
    (item) =>
      item.kind !== 'send' &&
      item.kind !== 'retry' &&
      item.kind !== 'summarize' &&
      item.kind !== 'cancel',
  );
  return next.length === pendingCommands.length ? pendingCommands : next;
}

function clearStaleAcceptedSteerReceipt(
  lastReceipt: RuntimeState['lastReceipt'],
): RuntimeState['lastReceipt'] {
  if (lastReceipt && lastReceipt.kind === 'steer' && lastReceipt.status === 'accepted') {
    return null;
  }
  return lastReceipt;
}

function buildFailedEnding(
  state: RuntimeState,
  meta: EventReducerMeta,
  runId: string | null,
  detail: string | undefined,
  now: number,
): RuntimeState {
  const cleared = clearTurnProgressFields(state, meta);
  const friendlyReason = friendlyChatErrorMessage(detail);
  const alreadyRecorded = Boolean(runId && meta.failedRunId === runId);
  meta.failedRunId = runId;

  const nextMessages = alreadyRecorded
    ? state.messages
    : [
        ...state.messages,
        {
          id: uuidv4(),
          role: 'system' as const,
          text: `Error: ${friendlyReason}`,
          ts: new Date(now).toISOString(),
        },
      ];

  return {
    ...state,
    ...cleared,
    status: 'error',
    activeRunId: null,
    stopping: false,
    pendingCommands: clearSettledTurnPendingCommands(state.pendingCommands),
    lastReceipt: clearStaleAcceptedSteerReceipt(state.lastReceipt),
    retryableRunId: runId,
    messages: nextMessages,
    lastFailure: {
      runId,
      reason: friendlyReason,
      failedAt: new Date(now).toISOString(),
    },
    terminalRevision: state.terminalRevision + 1,
  };
}

export interface EventReduceResult {
  state: RuntimeState;
  changed: boolean;
}

export function reduceHarnessEvent(
  prevState: RuntimeState,
  meta: EventReducerMeta,
  event: SseEvent,
  eventId: string,
  now = Date.now(),
): EventReduceResult {
  if (DURABLE_SSE_EVENT_TYPES.has(event.type) && !rememberEventId(meta, eventId)) {
    return { state: prevState, changed: false };
  }

  // While user has pressed Stop locally, freeze streamingText/thinking/activity
  // against late token or thinking frames until the server confirms terminal state.
  if (
    prevState.stopping &&
    (event.type === 'token' || event.type === 'thinking')
  ) {
    return { state: prevState, changed: false };
  }

  let state: RuntimeState = eventId
    ? { ...prevState, lastEventId: eventId }
    : prevState;

  const capturesSemanticPhase =
    event.type === 'phase' ||
    event.type === 'tool_call' ||
    event.type === 'tool_status' ||
    event.type === 'error' ||
    event.type === 'done';

  const semanticPhase = capturesSemanticPhase
    ? normalizePhaseEvent(event, eventId, now)
    : null;

  if (semanticPhase) {
    const previousRunId = [...state.phaseEvents]
      .reverse()
      .find((item) => item.runId)?.runId;
    const sameRun =
      !semanticPhase.runId ||
      !previousRunId ||
      semanticPhase.runId === previousRunId;
    const base = sameRun ? state.phaseEvents : [];
    const nextPhaseEvents = [...base, semanticPhase].slice(-MAX_PHASE_EVENTS);
    state = {
      ...state,
      phaseEvents: nextPhaseEvents,
      progressPhase: semanticPhase.phase,
      progressLabel: progressLabelForPhase(
        semanticPhase.phase,
        semanticPhase.detail,
      ),
      ...(event.type === 'phase' ||
      event.type === 'tool_call' ||
      event.type === 'tool_status'
        ? { lastProgressAt: semanticPhase.timestamp }
        : {}),
    };
  }

  if (
    event.type === 'token' ||
    event.type === 'thinking' ||
    event.type === 'tool_call' ||
    event.type === 'tool_status'
  ) {
    meta.failedRunId = null;
  }

  switch (event.type) {
    case 'token': {
      const tokenEvent = event as SseTokenEvent;
      if (eventId) {
        const key = durableTokenKey(eventId, tokenEvent);
        if (!rememberEventId(meta, key)) {
          return { state: prevState, changed: false };
        }
      }

      const offset = tokenEvent.streamOffset;
      if (
        typeof offset !== 'number' ||
        !Number.isSafeInteger(offset) ||
        offset < 0
      ) {
        meta.streamBuffer += tokenEvent.text;
      } else {
        const current = meta.streamBuffer;
        const currentLen = current.length;
        if (offset === currentLen) {
          meta.streamBuffer = current + tokenEvent.text;
        } else if (offset < currentLen) {
          const overlapLen = Math.min(
            tokenEvent.text.length,
            currentLen - offset,
          );
          const existingOverlap = current.slice(offset, offset + overlapLen);
          const incomingOverlap = tokenEvent.text.slice(0, overlapLen);
          if (existingOverlap === incomingOverlap) {
            const suffix = tokenEvent.text.slice(overlapLen);
            if (suffix) {
              meta.streamBuffer = current + suffix;
            }
          } else {
            meta.streamBuffer = current.slice(0, offset) + tokenEvent.text;
          }
        } else {
          meta.pendingOffsetTokens.set(offset, {
            text: tokenEvent.text,
            key: eventId
              ? durableTokenKey(eventId, tokenEvent)
              : `pending:${offset}`,
          });
        }

        // Drain pending chunks the buffer has reached.
        let drained = true;
        while (drained) {
          drained = false;
          for (const [pendingOffset, pending] of meta.pendingOffsetTokens) {
            const bufferLength = meta.streamBuffer.length;
            if (pendingOffset > bufferLength) continue;
            meta.pendingOffsetTokens.delete(pendingOffset);
            if (pendingOffset + pending.text.length > bufferLength) {
              meta.streamBuffer += pending.text.slice(
                bufferLength - pendingOffset,
              );
            }
            drained = true;
          }
        }
      }

      state = {
        ...state,
        lastProgressAt: now,
        streamingText: meta.streamBuffer.slice(meta.streamTrimOffset),
        thinkingText: '',
        isRetrying: false,
        retryReason: null,
        status: state.status === 'idle' ? 'running' : state.status,
      };
      return { state, changed: true };
    }

    case 'message': {
      const messageEvent = event as SseMessageEvent;
      const incoming = messageEvent.message;

      if (incoming.role === 'user') {
        const nextOptimistic = state.optimisticMessages.filter(
          (entry) =>
            entry.commandId !== incoming.commandId &&
            entry.commandId !== incoming.id,
        );
        const alreadyInMessages = state.messages.some(
          (m) =>
            m.id === incoming.id ||
            (Boolean(incoming.commandId) && m.commandId === incoming.commandId),
        );
        const nextMessages = alreadyInMessages
          ? state.messages
          : sortChatMessagesByTs([...state.messages, incoming]);
        state = {
          ...state,
          lastProgressAt: now,
          optimisticMessages: nextOptimistic,
          messages: nextMessages,
          retryableRunId: null,
        };
        return { state, changed: true };
      }

      // Agent / system / tool message
      const withActivity: ChatMessage =
        incoming.role === 'agent' &&
        (!incoming.activity || incoming.activity.length === 0) &&
        state.activity.length > 0
          ? { ...incoming, activity: state.activity }
          : incoming;

      const existingIdx = state.messages.findIndex(
        (m) => m.id === withActivity.id,
      );
      let nextMessages: ChatMessage[];
      if (existingIdx >= 0) {
        const existing = state.messages[existingIdx];
        if (
          (!existing.activity || existing.activity.length === 0) &&
          withActivity.activity &&
          withActivity.activity.length > 0
        ) {
          nextMessages = [...state.messages];
          nextMessages[existingIdx] = {
            ...existing,
            activity: withActivity.activity,
          };
        } else {
          nextMessages = state.messages;
        }
      } else {
        nextMessages = sortChatMessagesByTs([...state.messages, withActivity]);
      }

      const cleared = clearTurnProgressFields(state, meta);
      state = {
        ...state,
        ...cleared,
        lastProgressAt: now,
        retryableRunId: null,
        messages: nextMessages,
      };
      return { state, changed: true };
    }

    case 'tool_call': {
      meta.streamTrimOffset = meta.streamBuffer.length;
      state = {
        ...state,
        lastProgressAt: now,
        streamingText: '',
        thinkingText: '',
        isRetrying: false,
        retryReason: null,
        status: state.status === 'idle' ? 'running' : state.status,
      };
      return { state, changed: true };
    }

    case 'thinking': {
      const thinkingEvent = event as SseThinkingEvent;
      let nextThinkingText: string;
      if (typeof thinkingEvent.seq === 'number') {
        if (thinkingEvent.seq <= meta.lastThinkingSeq) {
          return { state: prevState, changed: false };
        }
        meta.lastThinkingSeq = thinkingEvent.seq;
        nextThinkingText = appendThinkingPiece(
          state.thinkingText,
          thinkingEvent.text,
        );
      } else {
        nextThinkingText = mergeThinkingText(
          state.thinkingText,
          thinkingEvent.text,
        );
      }

      const nextActivity = upsertThinkingActivity(
        state.activity,
        nextThinkingText,
        meta,
      );
      const nextProgressPhase =
        state.progressPhase === null ||
        state.progressPhase === 'queued' ||
        state.progressPhase === 'dispatched'
          ? 'analysis'
          : state.progressPhase;
      const nextProgressLabel =
        !state.progressLabel ||
        state.progressLabel === 'Queued' ||
        state.progressLabel === 'Dispatched' ||
        state.progressLabel === 'Starting…' ||
        state.progressLabel === 'Sending…'
          ? progressLabelForPhase('analysis', thinkingEvent.text)
          : state.progressLabel;

      state = {
        ...state,
        lastProgressAt: now,
        thinkingText: nextThinkingText,
        activity: nextActivity,
        progressPhase: nextProgressPhase,
        progressLabel: nextProgressLabel,
        isRetrying: false,
        retryReason: null,
        status: state.status === 'idle' ? 'running' : state.status,
      };
      return { state, changed: true };
    }

    case 'phase': {
      const promoteToRunning =
        semanticPhase?.status === 'running' ||
        semanticPhase?.phase === 'queued' ||
        semanticPhase?.phase === 'dispatched';
      if (promoteToRunning) {
        const nextStatus = state.status === 'idle' ? 'running' : state.status;
        if (nextStatus !== state.status || state.isRetrying || state.retryReason !== null) {
          state = {
            ...state,
            status: nextStatus,
            isRetrying: false,
            retryReason: null,
          };
        }
      }
      return { state, changed: state !== prevState };
    }

    case 'health': {
      if (meta.eventDrivenTermination) {
        return { state, changed: state !== prevState };
      }
      const normalized = normalizeHealthEvent(event as SseHealthEvent, now);
      if (normalized) {
        state = { ...state, runHealth: normalized };
      }
      return { state, changed: state !== prevState };
    }

    case 'tool_status': {
      const toolStatusEvent = event as SseToolStatusEvent;
      let streamingText = state.streamingText;
      let thinkingText = state.thinkingText;
      if (toolStatusEvent.status === 'running') {
        meta.streamTrimOffset = meta.streamBuffer.length;
        streamingText = '';
        thinkingText = '';
      }

      const entry: ToolProgress = {
        callId: toolStatusEvent.callId,
        toolName: toolStatusEvent.toolName,
        status: toolStatusEvent.status,
        args: toolStatusEvent.args,
        ts: now,
      };
      const existingIdx = state.toolProgress.findIndex(
        (t) => t.callId === toolStatusEvent.callId,
      );
      const nextToolProgress =
        existingIdx >= 0
          ? state.toolProgress.map((item, idx) =>
              idx === existingIdx ? entry : item,
            )
          : [...state.toolProgress, entry];

      const nextActivity = upsertToolActivity(
        state.activity,
        toolStatusEvent,
        meta,
      );

      state = {
        ...state,
        lastProgressAt: now,
        streamingText,
        thinkingText,
        toolProgress: nextToolProgress,
        activity: nextActivity,
        isRetrying: false,
        retryReason: null,
        status: state.status === 'idle' ? 'running' : state.status,
      };
      return { state, changed: true };
    }

    case 'status': {
      let runHealth = state.runHealth;
      if (typeof event.eventDrivenTermination === 'boolean') {
        meta.eventDrivenTermination = event.eventDrivenTermination;
        if (event.eventDrivenTermination) {
          runHealth = null;
        }
      }

      const isTerminalStatus =
        event.status === 'idle' ||
        event.status === 'error' ||
        event.status === 'closed';
      const transitionedFromRunning =
        isTerminalStatus && state.status === 'running';
      const cleared = isTerminalStatus
        ? clearTurnProgressFields(state, meta)
        : {};
      const nextTerminalRevision = transitionedFromRunning
        ? state.terminalRevision + 1
        : state.terminalRevision;
      const shouldClearTurnCommands =
        transitionedFromRunning || event.status === 'error';

      state = {
        ...state,
        ...cleared,
        runHealth,
        status: event.status,
        activeRunId: isTerminalStatus ? null : state.activeRunId,
        stopping: isTerminalStatus ? false : state.stopping,
        pendingCommands: shouldClearTurnCommands
          ? clearSettledTurnPendingCommands(state.pendingCommands)
          : state.pendingCommands,
        terminalRevision: nextTerminalRevision,
      };
      return { state, changed: true };
    }

    case 'grounding': {
      const groundingEvent = event as SseGroundingEvent;
      const message =
        safeDetail(groundingEvent.message) ?? 'Preparing project repository…';
      state = {
        ...state,
        groundingPreparation: {
          status: groundingEvent.status,
          message,
          ...(typeof groundingEvent.retryAfterMs === 'number' &&
          Number.isFinite(groundingEvent.retryAfterMs)
            ? {
                retryAfterMs: Math.max(
                  0,
                  Math.min(groundingEvent.retryAfterMs, 60_000),
                ),
              }
            : {}),
        },
        progressLabel: friendlyChatProgressLabel(message, 'setup'),
      };
      return { state, changed: true };
    }

    case 'summary': {
      const summaryEvent = event as SseSummaryEvent;
      let summaryNotice: HarnessSummaryNoticeState | null;
      if (summaryEvent.status === 'running') {
        summaryNotice = {
          status: 'running',
          text: SUMMARY_RUNNING_TEXT,
          isFallback: false,
        };
      } else if (summaryEvent.status === 'fallback') {
        summaryNotice = {
          status: 'fallback',
          text: SUMMARY_FALLBACK_TEXT,
          isFallback: true,
        };
      } else if (summaryEvent.status === 'error') {
        const detail = safeDetail(event.semanticDetail) ?? SUMMARY_ERROR_TEXT;
        summaryNotice = {
          status: 'error',
          text: SUMMARY_ERROR_TEXT,
          isFallback: false,
          error: detail,
        };
      } else {
        summaryNotice = null;
      }

      state = {
        ...state,
        summaryNotice,
      };
      return { state, changed: true };
    }

    case 'retrying': {
      const retryEvent = event as SseRetryingEvent;
      state = {
        ...state,
        lastProgressAt: now,
        isRetrying: true,
        retryReason:
          retryEvent.reason === 'reconnecting'
            ? 'Reconnecting to the agent…'
            : `Retrying… (attempt ${retryEvent.attempt} of ${retryEvent.maxAttempts})`,
      };
      return { state, changed: true };
    }

    case 'error': {
      const errorEvent = event as SseErrorEvent;
      const code = errorEvent.errorCode;
      const durableRunId =
        typeof errorEvent.runId === 'string' && errorEvent.runId.trim()
          ? errorEvent.runId.slice(0, 200)
          : null;

      if (code === 'transient' || code === 'rate_limit') {
        state = {
          ...state,
          lastProgressAt: now,
          isRetrying: true,
          retryReason:
            code === 'rate_limit' ? 'Rate limited, retrying…' : 'Retrying…',
        };
        return { state, changed: true };
      }

      if (code === 'auth') {
        const cleared = clearTurnProgressFields(state, meta);
        const authMsg: ChatMessage = {
          id: uuidv4(),
          role: 'system',
          text: 'Session expired, please refresh the page.',
          ts: new Date(now).toISOString(),
        };
        state = {
          ...state,
          ...cleared,
          lastProgressAt: now,
          retryableRunId: null,
          activeRunId: null,
          stopping: false,
          pendingCommands: clearSettledTurnPendingCommands(state.pendingCommands),
          status: 'error',
          messages: [...state.messages, authMsg],
          terminalRevision: state.terminalRevision + 1,
        };
        return { state, changed: true };
      }

      state = buildFailedEnding(
        { ...state, lastProgressAt: now },
        meta,
        durableRunId,
        errorEvent.error,
        now,
      );
      return { state, changed: true };
    }

    case 'done': {
      const doneEvent = event as SseDoneEvent;
      const doneRunId =
        typeof doneEvent.runId === 'string' && doneEvent.runId.trim()
          ? doneEvent.runId.slice(0, 200)
          : null;

      if (doneEvent.autoRetry) {
        const cleared = clearTurnProgressFields(state, meta);
        state = {
          ...state,
          ...cleared,
          lastProgressAt: now,
          status: 'running',
          isRetrying: true,
          retryReason: RESTARTING_LABEL,
        };
        return { state, changed: true };
      }

      if (event.semanticStatus === 'failed') {
        state = buildFailedEnding(
          { ...state, lastProgressAt: now },
          meta,
          doneRunId,
          event.semanticDetail,
          now,
        );
      } else {
        const cleared = clearTurnProgressFields(state, meta);
        state = {
          ...state,
          ...cleared,
          lastProgressAt: now,
          status: 'idle',
          activeRunId: null,
          stopping: false,
          pendingCommands: clearSettledTurnPendingCommands(state.pendingCommands),
          lastReceipt: clearStaleAcceptedSteerReceipt(state.lastReceipt),
          terminalRevision: state.terminalRevision + 1,
        };
      }

      if (doneEvent.prdReady) {
        state = { ...state, prdReady: true };
      }
      if (doneEvent.backlogReady) {
        state = { ...state, backlogReady: true };
      }
      return { state, changed: true };
    }

    default:
      return { state, changed: state !== prevState };
  }
}

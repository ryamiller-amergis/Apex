import { useState, useEffect, useRef, useCallback } from 'react';
import type {
  AgentRunEventStatus,
  AgentRunHealth,
  AgentRunPhase,
  AgentRunStatusResponse,
  ChatMessage,
  ChatThreadStatus,
  SseErrorEvent,
  SseEvent,
  SseHealthEvent,
  SseMessageEvent,
  SsePhaseEvent,
  SseRetryingEvent,
  SseThinkingEvent,
  SseToolStatusEvent,
} from '../../shared/types/chat';
import { v4 as uuidv4 } from 'uuid';

export interface ToolProgress {
  callId: string;
  toolName: string;
  status: 'running' | 'completed' | 'error';
  args?: unknown;
  result?: string;
  ts: number;
}

export interface RunPhaseProgress {
  id: string;
  runId?: string;
  phase: AgentRunPhase;
  status: AgentRunEventStatus;
  detail?: string;
  durationMs?: number;
  timestamp: number;
}

export interface RunHealthProgress {
  health: AgentRunHealth;
  detail: string;
  runId?: string;
  timestamp: number;
}

interface ChatStreamState {
  messages: ChatMessage[];
  streamingText: string;
  thinkingText: string;
  toolProgress: ToolProgress[];
  status: ChatThreadStatus;
  isConnected: boolean;
  /** Client-observed timestamp of the latest semantic run progress event. */
  lastProgressAt: number | null;
  phaseEvents: RunPhaseProgress[];
  runHealth: RunHealthProgress | null;
  progressLabel: string | null;
  progressPhase: AgentRunPhase | null;
  prdReady: boolean;
  backlogReady: boolean;
  /** True when the server is retrying a transient/rate-limited error */
  isRetrying: boolean;
  /** Human-readable reason shown during retry (e.g. "Rate limited, retrying…") */
  retryReason: string | null;
}

interface UseChatStreamOptions {
  /** Initial messages to seed from the persisted thread */
  initialMessages?: ChatMessage[];
  initialStatus?: ChatThreadStatus;
  /** Set to true when the thread was loaded and a durable PRD file already exists */
  initialPrdReady?: boolean;
}

const MAX_SEEN_EVENT_IDS = 512;
const MAX_PHASE_EVENTS = 200;
/**
 * Only these SSE event types carry durable `id:` frames from the server.
 * Token/message/thinking frames often omit `id:`, but the browser still reports
 * the previous id via MessageEvent.lastEventId — deduping those would drop the
 * live reply until the page is refreshed.
 */
const DURABLE_SSE_EVENT_TYPES = new Set<SseEvent['type']>([
  'phase',
  'health',
  'tool_call',
  'tool_status',
  'status',
  'retrying',
  'error',
  'done',
]);
const RUN_PHASES = new Set<AgentRunPhase>([
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
  'long_running',
  'worker_lost',
  'hard_timeout',
  'never_claimed',
]);

function safeDetail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim().slice(0, 500);
  return normalized || undefined;
}

function safeTimestamp(value: unknown, fallback = Date.now()): number {
  if (typeof value !== 'string') return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizePhaseEvent(
  event: SseEvent,
  eventId: string,
): RunPhaseProgress | null {
  const phase = event.type === 'phase' ? event.phase : event.semanticPhase;
  const status = event.type === 'phase' ? event.status : event.semanticStatus;
  if (!phase || !status || !RUN_PHASES.has(phase) || !RUN_EVENT_STATUSES.has(status)) return null;
  const phaseEvent = event.type === 'phase' ? event as SsePhaseEvent : null;
  const durationMs = typeof phaseEvent?.durationMs === 'number' && Number.isFinite(phaseEvent.durationMs)
    ? Math.max(0, Math.min(phaseEvent.durationMs, 24 * 60 * 60_000))
    : undefined;
  const detail = safeDetail(phaseEvent?.detail ?? event.semanticDetail);
  return {
    id: eventId || uuidv4(),
    ...(typeof event.runId === 'string' && event.runId ? { runId: event.runId.slice(0, 200) } : {}),
    phase,
    status,
    ...(detail ? { detail } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    timestamp: safeTimestamp(event.eventTimestamp),
  };
}

function normalizeHealthEvent(event: SseHealthEvent): RunHealthProgress | null {
  if (!RUN_HEALTH_VALUES.has(event.health)) return null;
  const detail = safeDetail(event.detail);
  if (!detail) return null;
  return {
    health: event.health,
    detail,
    ...(typeof event.runId === 'string' && event.runId ? { runId: event.runId.slice(0, 200) } : {}),
    timestamp: safeTimestamp(event.eventTimestamp),
  };
}

export function useChatStream(
  threadId: string | null,
  options: UseChatStreamOptions = {},
): ChatStreamState {
  const [messages, setMessages] = useState<ChatMessage[]>(options.initialMessages ?? []);
  const [streamingText, setStreamingText] = useState('');
  const [thinkingText, setThinkingText] = useState('');
  const [toolProgress, setToolProgress] = useState<ToolProgress[]>([]);
  const [status, setStatus] = useState<ChatThreadStatus>(options.initialStatus ?? 'idle');
  const [isConnected, setIsConnected] = useState(false);
  const [lastProgressAt, setLastProgressAt] = useState<number | null>(null);
  const [phaseEvents, setPhaseEvents] = useState<RunPhaseProgress[]>([]);
  const [runHealth, setRunHealth] = useState<RunHealthProgress | null>(null);
  const [progressLabel, setProgressLabel] = useState<string | null>(null);
  const [progressPhase, setProgressPhase] = useState<AgentRunPhase | null>(null);
  const [prdReady, setPrdReady] = useState(options.initialPrdReady ?? false);
  const [backlogReady, setBacklogReady] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryReason, setRetryReason] = useState<string | null>(null);

  const esRef = useRef<EventSource | null>(null);
  // Buffer tokens into the in-progress message
  const streamBufferRef = useRef('');
  const retryTimeoutRef = useRef<number | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const seenEventIdsRef = useRef<Set<string>>(new Set());
  const seenEventIdOrderRef = useRef<string[]>([]);
  // Keep latest seed options in refs so REST refetches (new array identity after
  // sendMessage) do not recreate `reset` and tear down a live EventSource mid-run.
  const initialMessagesRef = useRef(options.initialMessages);
  const initialStatusRef = useRef(options.initialStatus);
  const initialPrdReadyRef = useRef(options.initialPrdReady);
  initialMessagesRef.current = options.initialMessages;
  initialStatusRef.current = options.initialStatus;
  initialPrdReadyRef.current = options.initialPrdReady;

  const rememberEventId = useCallback((eventId: string): boolean => {
    if (!eventId) return true;
    if (seenEventIdsRef.current.has(eventId)) return false;

    seenEventIdsRef.current.add(eventId);
    seenEventIdOrderRef.current.push(eventId);
    if (seenEventIdOrderRef.current.length > MAX_SEEN_EVENT_IDS) {
      const evicted = seenEventIdOrderRef.current.shift();
      if (evicted) seenEventIdsRef.current.delete(evicted);
    }
    return true;
  }, []);

  const clearRetryTimeout = useCallback(() => {
    if (retryTimeoutRef.current !== null) {
      window.clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
  }, []);

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    setMessages(initialMessagesRef.current ?? []);
    setStreamingText('');
    setThinkingText('');
    setToolProgress([]);
    setStatus(initialStatusRef.current ?? 'idle');
    setIsConnected(false);
    setLastProgressAt(null);
    setPhaseEvents([]);
    setRunHealth(null);
    setProgressLabel(null);
    setProgressPhase(null);
    setPrdReady(initialPrdReadyRef.current ?? false);
    setBacklogReady(false);
    setIsRetrying(false);
    setRetryReason(null);
    streamBufferRef.current = '';
    seenEventIdsRef.current.clear();
    seenEventIdOrderRef.current = [];
    clearRetryTimeout();
    clearPollTimer();
  }, [clearRetryTimeout, clearPollTimer]);

  // Merge REST thread snapshots into live state without reconnecting SSE.
  // Covers the common case where useChatThread loads after EventSource opens,
  // and later invalidations after sendMessage that would otherwise wipe progress.
  useEffect(() => {
    const snapshot = options.initialMessages;
    if (!snapshot || snapshot.length === 0) return;
    setMessages((prev) => {
      if (prev.length === 0) return snapshot;
      const known = new Set(prev.map((message) => message.id));
      const missing = snapshot.filter((message) => !known.has(message.id));
      if (missing.length === 0) return prev;
      return [...prev, ...missing].sort((a, b) => a.ts.localeCompare(b.ts));
    });
  }, [options.initialMessages]);

  useEffect(() => {
    // Always reset derived state (streaming buffer, prdReady, backlogReady) when
    // the thread changes — including switching from one thread to another.
    reset();

    if (!threadId) {
      return;
    }

    const es = new EventSource(`/api/chat/threads/${threadId}/stream`, {
      withCredentials: true,
    } as EventSourceInit);

    esRef.current = es;

    es.addEventListener('open', () => setIsConnected(true));

    es.addEventListener('error', () => {
      setIsConnected(false);
      // EventSource will auto-reconnect; don't close it here
    });

    es.addEventListener('message', (e: MessageEvent) => {
      let event: SseEvent;
      try {
        event = JSON.parse(e.data) as SseEvent;
      } catch {
        return;
      }

      if (
        DURABLE_SSE_EVENT_TYPES.has(event.type)
        && !rememberEventId(e.lastEventId)
      ) {
        return;
      }

      const capturesSemanticPhase = event.type === 'phase'
        || event.type === 'tool_call'
        || event.type === 'tool_status'
        || event.type === 'error'
        || event.type === 'done';
      const semanticPhase = capturesSemanticPhase
        ? normalizePhaseEvent(event, e.lastEventId)
        : null;
      if (semanticPhase) {
        setPhaseEvents((previous) => {
          const previousRunId = [...previous].reverse().find((item) => item.runId)?.runId;
          const sameRun = !semanticPhase.runId
            || !previousRunId
            || semanticPhase.runId === previousRunId;
          const base = sameRun ? previous : [];
          return [...base, semanticPhase].slice(-MAX_PHASE_EVENTS);
        });
        setProgressPhase(semanticPhase.phase);
        setProgressLabel(semanticPhase.detail ?? semanticPhase.phase);
        if (event.type === 'phase' || event.type === 'tool_call' || event.type === 'tool_status') {
          setLastProgressAt(semanticPhase.timestamp);
        }
      }

      switch (event.type) {
        case 'token': {
          setLastProgressAt(Date.now());
          streamBufferRef.current += event.text;
          setStreamingText(streamBufferRef.current);
          setIsRetrying(false);
          setRetryReason(null);
          clearRetryTimeout();
          setStatus((prev) => prev === 'idle' ? 'running' : prev);
          break;
        }
        case 'message': {
          const messageEvent = event as SseMessageEvent;
          setLastProgressAt(Date.now());
          streamBufferRef.current = '';
          setStreamingText('');
          setThinkingText('');
          setToolProgress([]);
          setIsRetrying(false);
          setRetryReason(null);
          clearRetryTimeout();
          setMessages((prev) => {
            const exists = prev.some((m) => m.id === messageEvent.message.id);
            return exists ? prev : [...prev, messageEvent.message];
          });
          break;
        }
        case 'tool_call': {
          setLastProgressAt(Date.now());
          setThinkingText('');
          setStatus((prev) => prev === 'idle' ? 'running' : prev);
          break;
        }
        case 'thinking': {
          const thinkingEvent = event as SseThinkingEvent;
          setThinkingText(thinkingEvent.text);
          setStatus((prev) => prev === 'idle' ? 'running' : prev);
          break;
        }
        case 'phase': {
          if (semanticPhase?.status === 'running') {
            setStatus((previous) => previous === 'idle' ? 'running' : previous);
          }
          break;
        }
        case 'health': {
          const normalized = normalizeHealthEvent(event as SseHealthEvent);
          if (normalized) setRunHealth(normalized);
          break;
        }
        case 'tool_status': {
          const toolStatusEvent = event as SseToolStatusEvent;
          setLastProgressAt(Date.now());
          setToolProgress((prev) => {
            const existing = prev.findIndex((t) => t.callId === toolStatusEvent.callId);
            const entry: ToolProgress = {
              callId: toolStatusEvent.callId,
              toolName: toolStatusEvent.toolName,
              status: toolStatusEvent.status,
              args: toolStatusEvent.args,
              result: toolStatusEvent.result,
              ts: Date.now(),
            };
            if (existing >= 0) {
              const next = [...prev];
              next[existing] = entry;
              return next;
            }
            return [...prev, entry];
          });
          break;
        }
        case 'status': {
          setStatus(event.status);
          break;
        }
        case 'retrying': {
          const retryEvent = event as SseRetryingEvent;
          setLastProgressAt(Date.now());
          setIsRetrying(true);
          setRetryReason(`Retrying… (attempt ${retryEvent.attempt} of ${retryEvent.maxAttempts})`);
          clearRetryTimeout();
          break;
        }
        case 'error': {
          const errorEvent = event as SseErrorEvent;
          setLastProgressAt(Date.now());
          const code = errorEvent.errorCode;

          if (code === 'transient' || code === 'rate_limit') {
            const reason = code === 'rate_limit' ? 'Rate limited, retrying…' : 'Retrying…';
            setIsRetrying(true);
            setRetryReason(reason);
            clearRetryTimeout();
            const errorText = errorEvent.error;
            retryTimeoutRef.current = window.setTimeout(() => {
              setIsRetrying(false);
              setRetryReason(null);
              const fallbackMsg: ChatMessage = {
                id: uuidv4(),
                role: 'system',
                text: `Error: ${errorText}`,
                ts: new Date().toISOString(),
              };
              setMessages((prev) => [...prev, fallbackMsg]);
              setStatus('error');
            }, 5000);
            break;
          }

          if (code === 'auth') {
            const authMsg: ChatMessage = {
              id: uuidv4(),
              role: 'system',
              text: 'Session expired, please refresh the page.',
              ts: new Date().toISOString(),
            };
            setMessages((prev) => [...prev, authMsg]);
            setStatus('error');
            break;
          }

          const errMsg: ChatMessage = {
            id: uuidv4(),
            role: 'system',
            text: `Error: ${event.error}`,
            ts: new Date().toISOString(),
          };
          setMessages((prev) => [...prev, errMsg]);
          setStatus('error');
          break;
        }
        case 'done': {
          setLastProgressAt(Date.now());
          streamBufferRef.current = '';
          setStreamingText('');
          setThinkingText('');
          setToolProgress([]);
          setIsRetrying(false);
          setRetryReason(null);
          clearRetryTimeout();
          clearPollTimer();
          setStatus('idle');
          if ((event as any).error) {
            const errMsg: ChatMessage = {
              id: uuidv4(),
              role: 'system',
              text: `Error: ${(event as any).error}`,
              ts: new Date().toISOString(),
            };
            setMessages((prev) => [...prev, errMsg]);
          }
          if (event.prdReady) setPrdReady(true);
          if (event.backlogReady) setBacklogReady(true);
          break;
        }
      }
    });

    return () => {
      es.close();
      esRef.current = null;
      setIsConnected(false);
      clearRetryTimeout();
      clearPollTimer();
    };
  }, [threadId, reset, rememberEventId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Polling fallback: when status is 'running' and SSE is disconnected, poll
  // the server every 5 seconds to detect terminal status from Postgres.
  useEffect(() => {
    if (!threadId || status !== 'running' || isConnected) {
      clearPollTimer();
      return;
    }

    const poll = async () => {
      try {
        const res = await fetch(`/api/chat/threads/${threadId}/run-status`, {
          credentials: 'include',
        });
        if (!res.ok) return;
        const data = (await res.json()) as AgentRunStatusResponse;
        const persistedProgressAt = data.progressAt ? Date.parse(data.progressAt) : Number.NaN;
        if (Number.isFinite(persistedProgressAt)) setLastProgressAt(persistedProgressAt);
        setProgressLabel(safeDetail(data.progressLabel) ?? null);
        setProgressPhase(RUN_PHASES.has(data.progressPhase as AgentRunPhase) ? data.progressPhase : null);
        if (RUN_HEALTH_VALUES.has(data.health)) {
          setRunHealth({
            health: data.health,
            detail: safeDetail(data.lastError)
              ?? (data.health === 'healthy' ? 'Run is healthy' : data.health.replace(/_/g, ' ')),
            ...(data.runId ? { runId: data.runId.slice(0, 200) } : {}),
            timestamp: Date.now(),
          });
        }
        if (
          data.runId
          && data.progressPhase
          && RUN_PHASES.has(data.progressPhase)
          && Number.isFinite(persistedProgressAt)
        ) {
          const polledPhase: RunPhaseProgress = {
            id: `poll-${data.runId}-${data.progressPhase}-${data.progressAt}`,
            runId: data.runId,
            phase: data.progressPhase,
            status: data.status === 'running' ? 'running' : data.status === 'failed' ? 'failed' : 'completed',
            ...(safeDetail(data.progressLabel) ? { detail: safeDetail(data.progressLabel) } : {}),
            timestamp: persistedProgressAt,
          };
          setPhaseEvents((previous) => {
            if (previous.some((item) => item.id === polledPhase.id)) return previous;
            const previousRunId = [...previous].reverse().find((item) => item.runId)?.runId;
            const base = previousRunId && previousRunId !== data.runId ? [] : previous;
            return [...base, polledPhase].slice(-MAX_PHASE_EVENTS);
          });
        }
        const isTerminal = ['idle', 'error', 'closed', 'completed', 'failed', 'cancelled'].includes(data.status);
        if (isTerminal) {
          const mappedStatus: ChatThreadStatus = (data.status === 'completed' || data.status === 'cancelled') ? 'idle'
            : data.status === 'failed' ? 'error'
            : data.status as ChatThreadStatus;
          setStatus(mappedStatus);
          clearPollTimer();
          streamBufferRef.current = '';
          setStreamingText('');
          setThinkingText('');
          setToolProgress([]);
          setIsRetrying(false);
          setRetryReason(null);
          if ((data.status === 'error' || data.status === 'failed') && data.lastError) {
            const errMsg: ChatMessage = {
              id: uuidv4(),
              role: 'system',
              text: `Error: ${data.lastError}`,
              ts: new Date().toISOString(),
            };
            setMessages((prev) => [...prev, errMsg]);
          }
        }
      } catch {
        // Network error during poll — retry next interval
      }
    };

    // Delay first poll by 4 seconds to give SSE time to reconnect after a
    // page refresh — avoids surfacing a stale "Worker lost" reaper row before
    // the SSE stream re-establishes and clears the polling condition.
    const initialPollDelay = window.setTimeout(() => {
      poll();
      pollTimerRef.current = window.setInterval(poll, 5_000);
    }, 4_000);
    return () => {
      window.clearTimeout(initialPollDelay);
      clearPollTimer();
    };
  }, [threadId, status, isConnected, clearPollTimer]);

  return {
    messages,
    streamingText,
    thinkingText,
    toolProgress,
    status,
    isConnected,
    lastProgressAt,
    phaseEvents,
    runHealth,
    progressLabel,
    progressPhase,
    prdReady,
    backlogReady,
    isRetrying,
    retryReason,
  };
}

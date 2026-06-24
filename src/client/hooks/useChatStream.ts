import { useState, useEffect, useRef, useCallback } from 'react';
import type { ChatMessage, SseEvent, SseErrorEvent, SseRetryingEvent, SseThinkingEvent, SseToolStatusEvent, ChatThreadStatus } from '../../shared/types/chat';
import { v4 as uuidv4 } from 'uuid';

export interface ToolProgress {
  callId: string;
  toolName: string;
  status: 'running' | 'completed' | 'error';
  args?: unknown;
  result?: string;
  ts: number;
}

interface ChatStreamState {
  messages: ChatMessage[];
  streamingText: string;
  thinkingText: string;
  toolProgress: ToolProgress[];
  status: ChatThreadStatus;
  isConnected: boolean;
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
  const [prdReady, setPrdReady] = useState(options.initialPrdReady ?? false);
  const [backlogReady, setBacklogReady] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryReason, setRetryReason] = useState<string | null>(null);

  const esRef = useRef<EventSource | null>(null);
  // Buffer tokens into the in-progress message
  const streamBufferRef = useRef('');
  const retryTimeoutRef = useRef<number | null>(null);

  const clearRetryTimeout = useCallback(() => {
    if (retryTimeoutRef.current !== null) {
      window.clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    setMessages(options.initialMessages ?? []);
    setStreamingText('');
    setThinkingText('');
    setToolProgress([]);
    setStatus(options.initialStatus ?? 'idle');
    setIsConnected(false);
    setPrdReady(options.initialPrdReady ?? false);
    setBacklogReady(false);
    setIsRetrying(false);
    setRetryReason(null);
    streamBufferRef.current = '';
    clearRetryTimeout();
  }, [options.initialMessages, options.initialStatus, options.initialPrdReady, clearRetryTimeout]);

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

      switch (event.type) {
        case 'token': {
          streamBufferRef.current += event.text;
          setStreamingText(streamBufferRef.current);
          setIsRetrying(false);
          setRetryReason(null);
          clearRetryTimeout();
          break;
        }
        case 'message': {
          streamBufferRef.current = '';
          setStreamingText('');
          setThinkingText('');
          setToolProgress([]);
          setIsRetrying(false);
          setRetryReason(null);
          clearRetryTimeout();
          setMessages((prev) => {
            const exists = prev.some((m) => m.id === event.message.id);
            return exists ? prev : [...prev, event.message];
          });
          break;
        }
        case 'tool_call': {
          setThinkingText('');
          break;
        }
        case 'thinking': {
          const thinkingEvent = event as SseThinkingEvent;
          setThinkingText(thinkingEvent.text);
          break;
        }
        case 'tool_status': {
          const toolStatusEvent = event as SseToolStatusEvent;
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
          setIsRetrying(true);
          setRetryReason(`Retrying… (attempt ${retryEvent.attempt} of ${retryEvent.maxAttempts})`);
          clearRetryTimeout();
          break;
        }
        case 'error': {
          const errorEvent = event as SseErrorEvent;
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
          streamBufferRef.current = '';
          setStreamingText('');
          setThinkingText('');
          setToolProgress([]);
          setIsRetrying(false);
          setRetryReason(null);
          clearRetryTimeout();
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
    };
  }, [threadId, reset]); // eslint-disable-line react-hooks/exhaustive-deps

  return { messages, streamingText, thinkingText, toolProgress, status, isConnected, prdReady, backlogReady, isRetrying, retryReason };
}

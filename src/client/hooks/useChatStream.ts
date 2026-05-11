import { useState, useEffect, useRef, useCallback } from 'react';
import type { ChatMessage, SseEvent, ChatThreadStatus } from '../../shared/types/chat';
import { v4 as uuidv4 } from 'uuid';

interface ChatStreamState {
  messages: ChatMessage[];
  streamingText: string;
  status: ChatThreadStatus;
  isConnected: boolean;
  prdReady: boolean;
  backlogReady: boolean;
}

interface UseChatStreamOptions {
  /** Initial messages to seed from the persisted thread */
  initialMessages?: ChatMessage[];
  initialStatus?: ChatThreadStatus;
}

export function useChatStream(
  threadId: string | null,
  options: UseChatStreamOptions = {},
): ChatStreamState {
  const [messages, setMessages] = useState<ChatMessage[]>(options.initialMessages ?? []);
  const [streamingText, setStreamingText] = useState('');
  const [status, setStatus] = useState<ChatThreadStatus>(options.initialStatus ?? 'idle');
  const [isConnected, setIsConnected] = useState(false);
  const [prdReady, setPrdReady] = useState(false);
  const [backlogReady, setBacklogReady] = useState(false);

  const esRef = useRef<EventSource | null>(null);
  // Buffer tokens into the in-progress message
  const streamBufferRef = useRef('');

  const reset = useCallback(() => {
    setMessages(options.initialMessages ?? []);
    setStreamingText('');
    setStatus(options.initialStatus ?? 'idle');
    setIsConnected(false);
    setPrdReady(false);
    setBacklogReady(false);
    streamBufferRef.current = '';
  }, [options.initialMessages, options.initialStatus]);

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
          break;
        }
        case 'message': {
          // Commit the full message, clear the streaming buffer
          streamBufferRef.current = '';
          setStreamingText('');
          setMessages((prev) => {
            // Avoid duplicates if the server re-sends on reconnect
            const exists = prev.some((m) => m.id === event.message.id);
            return exists ? prev : [...prev, event.message];
          });
          break;
        }
        case 'tool_call': {
          const toolMsg: ChatMessage = {
            id: uuidv4(),
            role: 'tool',
            text: `→ ${event.toolName}`,
            toolName: event.toolName,
            ts: new Date().toISOString(),
          };
          setMessages((prev) => [...prev, toolMsg]);
          break;
        }
        case 'status': {
          setStatus(event.status);
          break;
        }
        case 'error': {
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
    };
  }, [threadId, reset]);

  return { messages, streamingText, status, isConnected, prdReady, backlogReady };
}

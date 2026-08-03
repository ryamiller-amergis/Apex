import { useCallback, useEffect, useRef, useState } from 'react';
import { useChatStream } from './useChatStream';
import type {
  LoadTestAiGenerateRequest,
  LoadTestAiGenerateResult,
  LoadTestAiGenerateResultResponse,
  LoadTestAiGenerateStartResponse,
} from '../../shared/types/loadTestAi';

/**
 * FEAT-011 / PBI-014 — client orchestration for AI-generated k6 scripts.
 *
 * Composition (per PBI contract):
 *   1. start   → POST ai-generate
 *   2. subscribe useChatStream(threadId) for streamingText/progressLabel while pending
 *   3. poll GET result every ~1.5s while pending until ready/failed/cancelled
 *   4. cancel  → POST cancel
 *
 * This hook never touches form state — callers apply `result` themselves
 * (e.g. LoadTestAiGeneratePanel's onApply) so errors/cancellation can never
 * wipe prior builder content (AC-1).
 */

export type LoadTestAiGenerateStatus =
  | 'idle'
  | 'starting'
  | 'pending'
  | 'ready'
  | 'failed'
  | 'cancelled';

export interface UseLoadTestAiGenerateResult {
  start: (input: LoadTestAiGenerateRequest) => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
  status: LoadTestAiGenerateStatus;
  streamingText: string;
  progressLabel: string | null;
  result: LoadTestAiGenerateResult | null;
  error: string | null;
  isGenerating: boolean;
}

const POLL_INTERVAL_MS = 1500;

function aiGenerateUrl(projectId: string, suffix = ''): string {
  return `/api/projects/${encodeURIComponent(projectId)}/load-tests/ai-generate${suffix}`;
}

async function parseErrorBody(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `Request failed: ${res.status}`;
  } catch {
    return `Request failed: ${res.status}`;
  }
}

export function useLoadTestAiGenerate(projectId: string | null): UseLoadTestAiGenerateResult {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [status, setStatus] = useState<LoadTestAiGenerateStatus>('idle');
  const [result, setResult] = useState<LoadTestAiGenerateResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pollTimerRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;

  const chatStream = useChatStream(status === 'pending' ? threadId : null);

  const clearPoll = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const fetchResult = useCallback(
    async (id: string) => {
      if (!projectId) return;
      try {
        const res = await fetch(aiGenerateUrl(projectId, `/${encodeURIComponent(id)}/result`), {
          credentials: 'include',
        });
        if (!res.ok) {
          const message = await parseErrorBody(res);
          clearPoll();
          setStatus('failed');
          setError(message);
          return;
        }
        const data = (await res.json()) as LoadTestAiGenerateResultResponse;
        if (data.status === 'ready' && data.result) {
          clearPoll();
          setResult(data.result);
          setStatus('ready');
        } else if (data.status === 'failed') {
          clearPoll();
          setError(data.error ?? 'Generation failed.');
          setStatus('failed');
        } else if (data.status === 'cancelled') {
          clearPoll();
          setStatus('cancelled');
        }
        // 'pending' — keep polling on the existing interval
      } catch {
        // Transient network hiccup during poll — retry on the next interval tick.
      }
    },
    [projectId, clearPoll],
  );

  const start = useCallback(
    async (input: LoadTestAiGenerateRequest) => {
      if (!projectId) return;
      clearPoll();
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setThreadId(null);
      setResult(null);
      setError(null);
      setStatus('starting');

      try {
        const res = await fetch(aiGenerateUrl(projectId), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
          signal: controller.signal,
        });
        if (!res.ok) {
          const message = await parseErrorBody(res);
          setStatus('failed');
          setError(message);
          return;
        }
        const data = (await res.json()) as LoadTestAiGenerateStartResponse;
        setThreadId(data.threadId);
        setStatus('pending');
        pollTimerRef.current = window.setInterval(() => {
          void fetchResult(data.threadId);
        }, POLL_INTERVAL_MS);
        void fetchResult(data.threadId);
      } catch (err) {
        if (controller.signal.aborted) return;
        setStatus('failed');
        setError(err instanceof Error ? err.message : 'Failed to start generation.');
      }
    },
    [projectId, clearPoll, fetchResult],
  );

  const cancel = useCallback(async () => {
    abortRef.current?.abort();
    clearPoll();
    const idToCancel = threadId;
    if (!idToCancel || !projectId) {
      setStatus('cancelled');
      return;
    }
    try {
      await fetch(aiGenerateUrl(projectId, `/${encodeURIComponent(idToCancel)}/cancel`), {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // Best-effort — still reflect cancellation locally so the UI unblocks.
    }
    setStatus('cancelled');
  }, [threadId, projectId, clearPoll]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    clearPoll();
    setThreadId(null);
    setStatus('idle');
    setResult(null);
    setError(null);
  }, [clearPoll]);

  // If the SSE stream surfaces an error while we're still waiting, poll immediately
  // rather than waiting out the interval — the result endpoint is the source of truth.
  useEffect(() => {
    if (chatStream.status === 'error' && statusRef.current === 'pending' && threadId) {
      void fetchResult(threadId);
    }
  }, [chatStream.status, threadId, fetchResult]);

  useEffect(
    () => () => {
      clearPoll();
      abortRef.current?.abort();
    },
    [clearPoll],
  );

  return {
    start,
    cancel,
    reset,
    status,
    streamingText: chatStream.streamingText,
    progressLabel: chatStream.progressLabel,
    result,
    error,
    isGenerating: status === 'starting' || status === 'pending',
  };
}

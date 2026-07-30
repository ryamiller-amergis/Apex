import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  LoadTestRunProgressEvent,
  RunStatus,
  ThresholdResult,
} from '../../shared/types/loadTest';
import { loadTestRunQueryKey } from './useLoadTestRuns';

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set([
  'passed',
  'failed',
  'errored',
  'cancelled',
]);

export function isTerminalRunStatus(status: RunStatus | string | null | undefined): boolean {
  return Boolean(status && TERMINAL_STATUSES.has(status as RunStatus));
}

export type LoadTestRunStreamState = {
  status: RunStatus | null;
  cancelRequested: boolean;
  progress: { vu?: number; iteration?: number; message?: string } | null;
  thresholdResults: ThresholdResult[] | null;
  overallResult: 'passed' | 'failed' | null;
  reconnecting: boolean;
  lastEventAt: string | null;
  error: string | null;
};

const INITIAL: LoadTestRunStreamState = {
  status: null,
  cancelRequested: false,
  progress: null,
  thresholdResults: null,
  overallResult: null,
  reconnecting: false,
  lastEventAt: null,
  error: null,
};

function streamUrl(projectId: string, runId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/load-tests/runs/${encodeURIComponent(runId)}/stream`;
}

/**
 * Live SSE progress for a load-test run (FEAT-009 / TBI-009 DoD-0, PBI-011 AC-0/1).
 * Reconnects while non-terminal; invalidates the run query on terminal events.
 */
export function useLoadTestRunStream(
  projectId: string | null,
  runId: string | null,
  options?: { enabled?: boolean; initialStatus?: RunStatus | null },
): LoadTestRunStreamState {
  const enabled = options?.enabled !== false && Boolean(projectId && runId);
  const queryClient = useQueryClient();
  const [state, setState] = useState<LoadTestRunStreamState>({
    ...INITIAL,
    status: options?.initialStatus ?? null,
  });

  const esRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const attemptRef = useRef(0);
  const statusRef = useRef<RunStatus | null>(options?.initialStatus ?? null);
  const closedRef = useRef(false);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current != null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const applyEvent = useCallback(
    (event: LoadTestRunProgressEvent) => {
      statusRef.current = event.status;
      setState((prev) => ({
        ...prev,
        status: event.status,
        cancelRequested: event.cancelRequested ?? prev.cancelRequested,
        progress: event.progress ?? prev.progress,
        thresholdResults:
          event.thresholdResults !== undefined
            ? event.thresholdResults
            : prev.thresholdResults,
        overallResult:
          event.overallResult !== undefined ? event.overallResult : prev.overallResult,
        reconnecting: false,
        lastEventAt: event.at,
        error: null,
      }));

      if (isTerminalRunStatus(event.status) && projectId && runId) {
        void queryClient.invalidateQueries({
          queryKey: loadTestRunQueryKey(projectId, runId),
        });
      }
    },
    [projectId, queryClient, runId],
  );

  const connect = useCallback(() => {
    if (!projectId || !runId || closedRef.current) return;

    esRef.current?.close();
    const es = new EventSource(streamUrl(projectId, runId), { withCredentials: true });
    esRef.current = es;

    es.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as LoadTestRunProgressEvent;
        if (!event?.runId || event.runId !== runId) return;
        attemptRef.current = 0;
        applyEvent(event);
        if (isTerminalRunStatus(event.status)) {
          es.close();
          esRef.current = null;
        }
      } catch {
        // ignore malformed frames
      }
    };

    es.onerror = () => {
      es.close();
      esRef.current = null;
      if (closedRef.current || isTerminalRunStatus(statusRef.current)) return;

      setState((prev) => ({
        ...prev,
        reconnecting: true,
        error: 'Connection lost — reconnecting…',
      }));

      if (projectId && runId) {
        void queryClient.invalidateQueries({
          queryKey: loadTestRunQueryKey(projectId, runId),
        });
      }

      const delay = Math.min(5_000, 500 * 2 ** attemptRef.current);
      attemptRef.current += 1;
      clearReconnectTimer();
      reconnectTimerRef.current = window.setTimeout(() => {
        if (!closedRef.current && !isTerminalRunStatus(statusRef.current)) {
          connect();
        }
      }, delay);
    };
  }, [applyEvent, clearReconnectTimer, projectId, queryClient, runId]);

  useEffect(() => {
    statusRef.current = options?.initialStatus ?? statusRef.current;
    if (options?.initialStatus) {
      setState((prev) =>
        prev.status ? prev : { ...prev, status: options.initialStatus ?? null },
      );
    }
  }, [options?.initialStatus]);

  useEffect(() => {
    closedRef.current = false;
    if (!enabled) {
      esRef.current?.close();
      esRef.current = null;
      clearReconnectTimer();
      return;
    }

    connect();

    return () => {
      closedRef.current = true;
      clearReconnectTimer();
      esRef.current?.close();
      esRef.current = null;
    };
  }, [clearReconnectTimer, connect, enabled, projectId, runId]);

  return state;
}

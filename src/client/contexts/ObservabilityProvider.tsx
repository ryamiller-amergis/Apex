import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useFeatureFlag } from '../hooks/useFeatureFlags';
import { useRouteViewCapture } from '../hooks/useRouteViewCapture';
import { useBrowserErrorCapture } from '../hooks/useBrowserErrorCapture';
import { BrowserEventQueue } from '../observability/browserQueue';
import { sendBrowserBatch } from '../observability/browserTransport';
import { installRequestInstrumentation } from '../observability/requestInstrumentation';
import {
  BROWSER_FLUSH_INTERVAL_MS,
  OBSERVABILITY_CAPTURE_FLAG,
  type BrowserTraceEventCandidate,
} from '../../shared/types/observability';
import {
  getSelectedApexProject,
  SELECTED_PROJECT_CHANGE_EVENT,
} from '../utils/apiFetch';

export interface ObservabilityProviderProps {
  project?: string;
  children: React.ReactNode;
}

function useResolvedProject(project: string | undefined): string | undefined {
  const [stored, setStored] = useState<string | undefined>(
    () => project ?? getSelectedApexProject() ?? undefined,
  );

  useEffect(() => {
    if (project) return undefined;
    const sync = () => {
      const next = getSelectedApexProject() ?? undefined;
      setStored((prev) => (prev === next ? prev : next));
    };
    window.addEventListener('storage', sync);
    window.addEventListener(SELECTED_PROJECT_CHANGE_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(SELECTED_PROJECT_CHANGE_EVENT, sync);
    };
  }, [project]);

  return project ?? stored;
}

export const ObservabilityProvider: React.FC<ObservabilityProviderProps> = ({ project, children }) => {
  const resolvedProject = useResolvedProject(project);
  const enabled = useFeatureFlag(OBSERVABILITY_CAPTURE_FLAG, resolvedProject);
  const location = useLocation();
  const traceIdRef = useRef<string | null>(null);
  const queueRef = useRef<BrowserEventQueue | null>(null);
  const projectRef = useRef(resolvedProject);
  const flushRef = useRef<(mode: 'interval' | 'pagehide') => void>(() => undefined);

  projectRef.current = resolvedProject;
  if (enabled && !queueRef.current) {
    queueRef.current = new BrowserEventQueue();
  }
  if (!enabled) {
    queueRef.current = null;
  }

  const enqueue = useCallback((event: BrowserTraceEventCandidate) => {
    const queue = queueRef.current;
    if (!queue) return;
    queue.enqueue(event);
    if (queue.shouldFlush()) flushRef.current('interval');
  }, []);

  const setTraceId = useCallback((traceId: string) => {
    traceIdRef.current = traceId;
  }, []);

  const getTraceId = useCallback(() => traceIdRef.current, []);
  const getRouteTemplate = useCallback(() => location.pathname, [location.pathname]);

  const routeApi = useMemo(() => ({ enqueue, setTraceId }), [enqueue, setTraceId]);
  const errorApi = useMemo(
    () => ({ enqueue, getTraceId, getRouteTemplate }),
    [enqueue, getTraceId, getRouteTemplate],
  );

  useRouteViewCapture(enabled, routeApi);
  useBrowserErrorCapture(enabled, errorApi);

  useEffect(() => {
    if (!enabled) return undefined;
    const uninstall = installRequestInstrumentation({
      getTraceId: () => traceIdRef.current,
    });

    const flush = (mode: 'interval' | 'pagehide') => {
      const queue = queueRef.current;
      const currentProject = projectRef.current;
      if (!queue || !currentProject || queue.size === 0) return;
      const events = queue.drain();
      if (events.length === 0) return;
      void sendBrowserBatch({ project: currentProject, events }, mode).catch(() => undefined);
    };
    flushRef.current = flush;

    const timerId = window.setInterval(() => flush('interval'), BROWSER_FLUSH_INTERVAL_MS);
    const onPageHide = () => flush('pagehide');
    window.addEventListener('pagehide', onPageHide);

    return () => {
      window.clearInterval(timerId);
      window.removeEventListener('pagehide', onPageHide);
      uninstall();
      flushRef.current = () => undefined;
      queueRef.current = null;
      traceIdRef.current = null;
    };
  }, [enabled]);

  // @feature-flag:observability-capture start winner=enabled
  if (!enabled) {
    // @feature-flag:observability-capture disabled-start
    return <>{children}</>;
    // @feature-flag:observability-capture disabled-end
  }

  // @feature-flag:observability-capture enabled-start
  return (
    <>
      <span hidden {...{ 'data-testid': 'observability-provider' }} />
      {children}
    </>
  );
  // @feature-flag:observability-capture enabled-end
  // @feature-flag:observability-capture end
};

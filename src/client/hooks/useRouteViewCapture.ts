import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { generateSpanId, generateTraceId } from '../../shared/utils/w3cTrace';
import { normalizeApexRouteTemplate } from '../../shared/utils/observabilityRouteRegistry';
import type { BrowserTraceEventCandidate } from '../../shared/types/observability';

export interface RouteViewCaptureApi {
  enqueue: (event: BrowserTraceEventCandidate) => void;
  setTraceId: (traceId: string) => void;
}

export function useRouteViewCapture(enabled: boolean, api: RouteViewCaptureApi): void {
  const location = useLocation();
  const lastPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const path = `${location.pathname}${location.search}`;
    if (lastPathRef.current === path) return;
    lastPathRef.current = path;
    const traceId = generateTraceId();
    api.setTraceId(traceId);
    api.enqueue({
      type: 'route_view',
      occurredAt: new Date().toISOString(),
      traceId,
      spanId: generateSpanId(),
      routeTemplate: normalizeApexRouteTemplate(location.pathname),
    });
  }, [enabled, location.pathname, location.search, api]);
}

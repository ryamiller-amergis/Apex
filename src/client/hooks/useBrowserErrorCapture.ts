import { useEffect } from 'react';
import { generateSpanId, generateTraceId } from '../../shared/utils/w3cTrace';
import { normalizeApexRouteTemplate } from '../../shared/utils/observabilityRouteRegistry';
import { projectBrowserError } from '../../shared/utils/browserErrorProjection';
import { setBrowserErrorReporter } from '../observability/clientErrorReporter';
import type { BrowserTraceEventCandidate } from '../../shared/types/observability';

export interface BrowserErrorCaptureApi {
  enqueue: (event: BrowserTraceEventCandidate) => void;
  getTraceId: () => string | null;
  getRouteTemplate: () => string;
}

function toEvent(
  type: 'client_error' | 'unhandled_rejection',
  error: unknown,
  api: BrowserErrorCaptureApi,
): BrowserTraceEventCandidate {
  const details = projectBrowserError(error);
  const traceId = api.getTraceId();
  return {
    type,
    occurredAt: new Date().toISOString(),
    traceId: traceId ?? generateTraceId(),
    spanId: generateSpanId(),
    routeTemplate: normalizeApexRouteTemplate(api.getRouteTemplate()),
    severity: 'error',
    details,
  };
}

export function useBrowserErrorCapture(enabled: boolean, api: BrowserErrorCaptureApi): void {
  useEffect(() => {
    if (!enabled) {
      setBrowserErrorReporter(null);
      return;
    }

    setBrowserErrorReporter((error) => {
      api.enqueue(toEvent('client_error', error, api));
    });

    const onError = (event: ErrorEvent) => {
      api.enqueue(toEvent('client_error', event.error ?? event.message, api));
    };
    const onRejection = (event: Event) => {
      const reason = 'reason' in event ? (event as PromiseRejectionEvent).reason : 'unhandled rejection';
      api.enqueue(toEvent('unhandled_rejection', reason, api));
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      setBrowserErrorReporter(null);
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, [enabled, api]);
}

import { ApplicationInsights } from '@microsoft/applicationinsights-web';

let appInsights: ApplicationInsights | null = null;
let initPromise: Promise<void> | null = null;

export function initTelemetry(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const res = await fetch('/api/telemetry-config');
      if (!res.ok) return;
      const { connectionString } = await res.json();
      if (!connectionString) return;

      appInsights = new ApplicationInsights({
        config: {
          connectionString,
          enableAutoRouteTracking: true,
          enableCorsCorrelation: true,
          enableRequestHeaderTracking: true,
          enableResponseHeaderTracking: true,
        },
      });
      appInsights.loadAppInsights();
      appInsights.trackPageView();
    } catch {
      // Telemetry init failure should never break the app
    }
  })();
  return initPromise;
}

export function trackException(error: Error, properties?: Record<string, string>): void {
  appInsights?.trackException({ exception: error }, properties);
}

export function trackEvent(name: string, properties?: Record<string, string>): void {
  appInsights?.trackEvent({ name }, properties);
}

export function getAppInsights(): ApplicationInsights | null {
  return appInsights;
}

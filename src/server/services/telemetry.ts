import appInsights from 'applicationinsights';

const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;

if (connectionString) {
  appInsights
    .setup(connectionString)
    .setAutoCollectRequests(true)
    .setAutoCollectPerformance(true, true)
    .setAutoCollectExceptions(true)
    .setAutoCollectDependencies(true)
    .setAutoCollectConsole(true)
    .setDistributedTracingMode(appInsights.DistributedTracingModes.AI_AND_W3C)
    .start();
}

export const telemetryClient = connectionString
  ? appInsights.defaultClient
  : undefined;

export function trackAgentError(
  threadId: string,
  err: unknown,
  props?: Record<string, string>,
): void {
  if (!telemetryClient) return;
  telemetryClient.trackException({
    exception: err instanceof Error ? err : new Error(String(err)),
    properties: { threadId, ...props },
  });
}

export function trackEvent(
  name: string,
  props?: Record<string, string>,
  measurements?: Record<string, number>,
): void {
  if (!telemetryClient) return;
  telemetryClient.trackEvent({ name, properties: props, measurements });
}

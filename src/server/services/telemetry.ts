import * as appInsights from 'applicationinsights';

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
  props?: Record<string, string>
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
  measurements?: Record<string, number>
): void {
  if (!telemetryClient) return;
  telemetryClient.trackEvent({ name, properties: props, measurements });
}

/**
 * Events are batched, so a process that exits without flushing drops whatever
 * it recorded on the way out — which is exactly the telemetry that explains an
 * unexpected exit. The race bounds the wait: losing the event is better than
 * hanging past the shutdown grace period and being killed outright.
 */
export async function flushTelemetry(timeoutMs = 2_000): Promise<void> {
  if (!telemetryClient) return;
  try {
    await Promise.race([
      telemetryClient.flush(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs).unref();
      }),
    ]);
  } catch {
    // A failed flush must not mask the reason the caller is shutting down.
  }
}

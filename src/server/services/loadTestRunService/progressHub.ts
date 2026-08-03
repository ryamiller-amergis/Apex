/**
 * In-process SSE fan-out for load-test run progress (FEAT-007 / A-012).
 * FEAT-009 consumes these events; this module owns emission only.
 */
import { EventEmitter } from 'events';
import type { LoadTestRunProgressEvent } from '../../../shared/types/loadTest';

const hub = new EventEmitter();
hub.setMaxListeners(100);

function channelKey(projectId: string, runId: string): string {
  return `${projectId}:${runId}`;
}

export function publishRunProgress(event: LoadTestRunProgressEvent): void {
  hub.emit(channelKey(event.projectId, event.runId), event);
  hub.emit(`project:${event.projectId}`, event);
}

export function subscribeRunProgress(
  projectId: string,
  runId: string,
  listener: (event: LoadTestRunProgressEvent) => void,
): () => void {
  const key = channelKey(projectId, runId);
  hub.on(key, listener);
  return () => {
    hub.off(key, listener);
  };
}

/** Test helper — wipe listeners between suites. */
export function resetRunProgressHub(): void {
  hub.removeAllListeners();
}

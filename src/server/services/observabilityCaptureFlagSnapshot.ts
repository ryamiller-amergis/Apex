/**
 * Short-lived in-process snapshot of observability-capture.
 * Fail-closed: missing flag, archived flag, or lookup failure keeps capture off.
 * Refresh is asynchronous and never runs on the user-request path.
 */
import {
  CAPTURE_FLAG_SNAPSHOT_MS,
  OBSERVABILITY_CAPTURE_FLAG,
} from '../../shared/types/observability';
import { isFeatureOperational } from './featureFlagService';

let snapshotEnabled = false;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

export function isObservabilityCaptureEnabled(): boolean {
  return snapshotEnabled;
}

export async function refreshObservabilityCaptureSnapshot(): Promise<void> {
  try {
    snapshotEnabled = await isFeatureOperational(OBSERVABILITY_CAPTURE_FLAG);
  } catch {
    snapshotEnabled = false;
  }
}

export function startObservabilityCaptureFlagSnapshot(): void {
  void refreshObservabilityCaptureSnapshot();
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    void refreshObservabilityCaptureSnapshot();
  }, CAPTURE_FLAG_SNAPSHOT_MS);
  refreshTimer.unref?.();
}

export function stopObservabilityCaptureFlagSnapshot(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  snapshotEnabled = false;
}

export function setObservabilityCaptureSnapshotForTests(enabled: boolean): void {
  snapshotEnabled = enabled;
}

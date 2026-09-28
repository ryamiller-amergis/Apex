/** How many Container Apps executions may run at once. */
export const DEFAULT_CLOUD_AGENT_MAX_CONCURRENT = 8;

/** A queued run that never reaches a container fails after this wait. */
export const CLOUD_AGENT_QUEUE_WAIT_MS = 6 * 60 * 60 * 1000;

const MAX_CONCURRENT_CAP = 50;

export function resolveCloudAgentMaxConcurrent(
  raw = process.env.CLOUD_AGENT_MAX_CONCURRENT,
): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_CLOUD_AGENT_MAX_CONCURRENT;
  return Math.min(parsed, MAX_CONCURRENT_CAP);
}

/** Slots still open after counting executions that are already starting or running. */
export function cloudAgentLaunchSlots(inFlight: number, cap: number): number {
  const active = Number.isFinite(inFlight) && inFlight > 0 ? Math.floor(inFlight) : 0;
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 0;
  return Math.max(0, limit - active);
}

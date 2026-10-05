/** How many Container Apps executions may run at once. */
export const DEFAULT_CLOUD_AGENT_MAX_CONCURRENT = 8;

/** A queued run that never reaches a container fails after this wait. */
export const CLOUD_AGENT_QUEUE_WAIT_MS = 6 * 60 * 60 * 1000;

/**
 * Only the instance holding the developer's ADO token may claim the run
 * during this window. After it, any instance may launch without the token.
 */
export const CLOUD_AGENT_USER_TOKEN_CLAIM_MS = 15 * 60_000;

/**
 * Dispatched runs time out after this. Keep it above the Container Apps job
 * replica timeout (`cursor_pool_worker_timeout_seconds`, 6h) so the job ends first.
 */
export const DEFAULT_CLOUD_AGENT_RUN_LIMIT_MS = 6 * 60 * 60_000 + 15 * 60_000;

const MAX_CONCURRENT_CAP = 50;

export function resolveCloudAgentRunLimitMs(
  raw = process.env.CLOUD_AGENT_RUN_LIMIT_MS,
): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CLOUD_AGENT_RUN_LIMIT_MS;
}

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

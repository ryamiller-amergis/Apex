/** A saved run that never reaches Cursor fails after this wait. */
export const CLOUD_AGENT_QUEUE_WAIT_MS = 6 * 60 * 60 * 1000;

/**
 * Only the instance holding the developer's ADO token may launch the run
 * during this window. After it, any instance may launch without the token.
 */
export const CLOUD_AGENT_USER_TOKEN_CLAIM_MS = 15 * 60_000;

/** Running runs time out after this, past a long cloud-agent turn. */
export const DEFAULT_CLOUD_AGENT_RUN_LIMIT_MS = 6 * 60 * 60_000 + 15 * 60_000;

export function resolveCloudAgentRunLimitMs(
  raw = process.env.CLOUD_AGENT_RUN_LIMIT_MS,
): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CLOUD_AGENT_RUN_LIMIT_MS;
}

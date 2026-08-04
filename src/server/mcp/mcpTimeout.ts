/**
 * Timeouts for MCP Streamable HTTP mounts and tool handlers.
 * Keeps Cursor agent tool_calls from sitting in `running` forever when the
 * transport stalls or an upstream API ignores AbortSignal.
 */

export function resolvePositiveMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Outer bound for an entire MCP HTTP POST (initialize / tools/list / tools/call). */
export function resolveMcpHttpTimeoutMs(): number {
  return resolvePositiveMs(process.env.MCP_HTTP_TIMEOUT_MS, 45_000);
}

/** Bound for a single tool handler (should be >= GitHub/ADO fetch timeout). */
export function resolveMcpToolTimeoutMs(): number {
  return resolvePositiveMs(process.env.MCP_TOOL_TIMEOUT_MS, 35_000);
}

/**
 * Owner-side deadline for an MCP tool_call that never emits a terminal SDK
 * event. It must outlive both server-side MCP bounds so normal timeout results
 * can reach the agent before the run owner disposes it.
 */
export function resolveAgentMcpToolTimeoutMs(): number {
  const serverBoundMs = Math.max(resolveMcpHttpTimeoutMs(), resolveMcpToolTimeoutMs());
  const fallbackMs = serverBoundMs + 15_000;
  return Math.max(
    resolvePositiveMs(process.env.AGENT_MCP_TOOL_TIMEOUT_MS, fallbackMs),
    serverBoundMs + 5_000,
  );
}

export class McpTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'McpTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Race `work` against a wall-clock timeout. Clears the timer on settle so
 * short-lived tools do not keep the event loop pinned.
 */
export async function raceWithTimeout<T>(
  label: string,
  timeoutMs: number,
  work: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new McpTimeoutError(label, timeoutMs)), timeoutMs);
        // Do not keep the process alive solely for this watchdog.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface InFlightToolCall {
  toolName: string;
  mcpLabel: string | null;
  startedAtMs: number;
}

export interface ExpiredMcpToolCall extends InFlightToolCall {
  key: string;
  elapsedMs: number;
}

export interface McpToolDeadlineController {
  arm(key: string, toolName: string, input: unknown): void;
  complete(key: string, toolName: string, input: unknown): void;
  clear(): void;
}

function nestedToolName(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = (input as Record<string, unknown>).toolName;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Cursor represents MCP calls as a wrapper tool (`mcp`) with the actual tool
 * name in input.toolName. Some SDK versions instead expose an `mcp:*` name.
 */
export function identifyMcpTool(toolName: string, input: unknown): string | null {
  const normalizedName = toolName.trim();
  const nestedName = nestedToolName(input);
  const inputRecord =
    input && typeof input === 'object' && !Array.isArray(input)
      ? input as Record<string, unknown>
      : null;
  const hasProviderIdentifier =
    typeof inputRecord?.providerIdentifier === 'string'
    && inputRecord.providerIdentifier.trim().length > 0;
  const isMcpWrapper =
    normalizedName.toLowerCase() === 'mcp'
    || normalizedName.toLowerCase().startsWith('mcp:')
    || hasProviderIdentifier;

  if (!isMcpWrapper) return null;
  if (normalizedName.toLowerCase().startsWith('mcp:')) return normalizedName;
  return nestedName ? `${normalizedName || 'mcp'}:${nestedName}` : normalizedName || 'mcp';
}

export function markToolInFlight(
  calls: Map<string, InFlightToolCall>,
  key: string,
  toolName: string,
  input: unknown,
  nowMs = Date.now(),
): void {
  if (calls.has(key)) return;
  calls.set(key, {
    toolName,
    mcpLabel: identifyMcpTool(toolName, input),
    startedAtMs: nowMs,
  });
}

export function clearToolInFlight(
  calls: Map<string, InFlightToolCall>,
  key: string,
  toolName: string,
  input: unknown,
): void {
  const completedMcpLabel = identifyMcpTool(toolName, input);
  calls.delete(key);

  // The assistant tool_use id and the later tool_call call_id are not always
  // identical. Clear aliases by MCP identity, while leaving unrelated parallel
  // tools untouched. Older SDK terminal events can omit args and expose only
  // the generic `mcp` wrapper; in that case clear MCP aliases for the serial call.
  if (completedMcpLabel) {
    const isGenericMcpCompletion = completedMcpLabel.toLowerCase() === 'mcp';
    for (const [candidateKey, call] of calls) {
      if (
        call.mcpLabel === completedMcpLabel
        || (isGenericMcpCompletion && call.mcpLabel !== null)
      ) {
        calls.delete(candidateKey);
      }
    }
  }
}

export function findExpiredMcpTool(
  calls: Map<string, InFlightToolCall>,
  nowMs: number,
  timeoutMs: number,
): ExpiredMcpToolCall | null {
  let oldest: ExpiredMcpToolCall | null = null;
  for (const [key, call] of calls) {
    if (!call.mcpLabel) continue;
    const elapsedMs = Math.max(0, nowMs - call.startedAtMs);
    if (elapsedMs < timeoutMs) continue;
    if (!oldest || call.startedAtMs < oldest.startedAtMs) {
      oldest = { key, ...call, elapsedMs };
    }
  }
  return oldest;
}

/**
 * Arms one wall-clock timer per logical MCP call. Cursor can report the same
 * call under assistant and SDK identifiers, so MCP identity is the timer key.
 */
export function createMcpToolDeadlineController(
  timeoutMs: number,
  onExpired: (call: ExpiredMcpToolCall) => void,
): McpToolDeadlineController {
  const deadlines = new Map<string, {
    key: string;
    toolName: string;
    startedAtMs: number;
    timer: ReturnType<typeof setTimeout>;
  }>();

  return {
    arm(key, toolName, input) {
      const mcpLabel = identifyMcpTool(toolName, input);
      if (!mcpLabel || deadlines.has(mcpLabel)) return;
      const startedAtMs = Date.now();
      const timer = setTimeout(() => {
        deadlines.delete(mcpLabel);
        onExpired({
          key,
          toolName,
          mcpLabel,
          startedAtMs,
          elapsedMs: Math.max(timeoutMs, Date.now() - startedAtMs),
        });
      }, timeoutMs);
      deadlines.set(mcpLabel, { key, toolName, startedAtMs, timer });
    },
    complete(_key, toolName, input) {
      const completedMcpLabel = identifyMcpTool(toolName, input);
      if (!completedMcpLabel) return;
      const labels = completedMcpLabel.toLowerCase() === 'mcp'
        ? [...deadlines.keys()]
        : [completedMcpLabel];
      for (const label of labels) {
        const deadline = deadlines.get(label);
        if (!deadline) continue;
        clearTimeout(deadline.timer);
        deadlines.delete(label);
      }
    },
    clear() {
      for (const deadline of deadlines.values()) clearTimeout(deadline.timer);
      deadlines.clear();
    },
  };
}

/**
 * V2 interactive actor host custom-tool builder.
 *
 * Purely consumes the frozen `FrozenHarnessSpec` sent by App Service:
 * ZERO database imports, ZERO `chatHarness/` imports, ZERO policy defaults.
 */
import type { FrozenHarnessSpec } from '../../../shared/types/durableInteractiveTurn';
import type { SDKCustomTool, SDKJsonValue } from '../cursorSdkAdapter/types';

export type HarnessCustomToolProxyInvoker = (input: {
  serverName: string;
  toolName: string;
  args: Record<string, unknown>;
}) => Promise<unknown>;

export interface HarnessWritePermissionMode {
  readonly autoReview: false;
  readonly writeTools: ReadonlyArray<{ readonly tool: string; readonly mode: 'ask' }>;
}

function isContentResult(
  value: unknown,
): value is { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate.content);
}

function formatProxyResult(proxyResult: unknown) {
  if (isContentResult(proxyResult)) {
    return proxyResult;
  }
  const text =
    typeof proxyResult === 'string'
      ? proxyResult
      : JSON.stringify(proxyResult ?? {});
  return {
    content: [{ type: 'text' as const, text }],
  };
}

/**
 * Builds one `SDKCustomTool` wrapper per custom tool declared in the frozen
 * harness specification. Every call forwards arguments back to App Service
 * through the run-bound interactive tool proxy callback.
 */
export function buildHarnessSdkCustomTools(
  harness: FrozenHarnessSpec,
  invokeProxy: HarnessCustomToolProxyInvoker,
): Record<string, SDKCustomTool> {
  const tools: Record<string, SDKCustomTool> = {};
  for (const tool of harness.customTools) {
    tools[tool.name] = {
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, SDKJsonValue>,
      execute: async (rawArgs) => {
        const args =
          rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
            ? (rawArgs as Record<string, unknown>)
            : {};
        const proxyResult = await invokeProxy({
          serverName: tool.proxyTarget,
          toolName: tool.name,
          args,
        });
        return formatProxyResult(proxyResult);
      },
    };
  }
  return tools;
}

/**
 * Resolves the actor host's write-permission posture directly from the frozen
 * harness specification. Enforces BR-001: every `writes: true` tool runs in
 * `'ask'` mode and `autoReview` is unconditionally `false`.
 */
export function resolveHarnessWritePermissionMode(
  harness: FrozenHarnessSpec,
): HarnessWritePermissionMode {
  const confirmationByTool = new Map(
    harness.writeConfirmation.map((rule) => [rule.tool, rule]),
  );

  for (const rule of harness.writeConfirmation) {
    if (rule.writes && rule.mode !== 'ask') {
      throw new Error(
        `Write tool "${rule.tool}" must use writeConfirmation mode "ask" and cannot be auto-approved`,
      );
    }
  }

  const writeTools: Array<{ readonly tool: string; readonly mode: 'ask' }> = [];
  const seen = new Set<string>();

  for (const tool of harness.customTools) {
    if (!tool.writes) continue;
    const rule = confirmationByTool.get(tool.name);
    if (!rule || !rule.writes || rule.mode !== 'ask') {
      throw new Error(
        `Write tool "${tool.name}" is missing required writeConfirmation mode "ask"`,
      );
    }
    if (!seen.has(tool.name)) {
      seen.add(tool.name);
      writeTools.push({ tool: tool.name, mode: 'ask' });
    }
  }

  for (const rule of harness.writeConfirmation) {
    if (!rule.writes || seen.has(rule.tool)) continue;
    seen.add(rule.tool);
    writeTools.push({ tool: rule.tool, mode: 'ask' });
  }

  return {
    autoReview: false,
    writeTools,
  };
}

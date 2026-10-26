/**
 * Integration connector MCP server.
 *
 * Bound to one saved connection. The only tool calls a read operation from
 * that connection's allow-list. There is no generic HTTP tool.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpServerOperation } from '../../../shared/types/mcpServers';
import {
  executeMountedMcpServerRead,
  executeMountedMcpTool,
  listMountedMcpTools,
  supportsTimestampBoundarySearch,
} from '../../services/mcpServerReadService';

const MAX_MCP_CALLS_PER_TURN = 8;
const TURN_BUDGET_IDLE_RESET_MS = 12_000;

interface TurnCallBudgetEntry {
  count: number;
  lastCallAt: number;
}

const turnCallBudgets = new Map<string, TurnCallBudgetEntry>();

export function resetMcpTurnCallBudget(
  boundConnectionId: string,
  boundUserId: string,
): void {
  turnCallBudgets.delete(`${boundConnectionId}::${boundUserId}`);
}

function consumeMcpTurnCallBudget(
  boundConnectionId: string,
  boundUserId: string,
  now = Date.now(),
): boolean {
  const key = `${boundConnectionId}::${boundUserId}`;
  const existing = turnCallBudgets.get(key);
  if (!existing || now - existing.lastCallAt > TURN_BUDGET_IDLE_RESET_MS) {
    turnCallBudgets.set(key, { count: 1, lastCallAt: now });
    return true;
  }
  existing.lastCallAt = now;
  existing.count += 1;
  return existing.count <= MAX_MCP_CALLS_PER_TURN;
}

function jsonSchemaPropertyToZod(prop: unknown): z.ZodTypeAny {
  if (!prop || typeof prop !== 'object' || Array.isArray(prop)) {
    return z.unknown();
  }
  const record = prop as Record<string, unknown>;
  const rawType = Array.isArray(record.type)
    ? record.type.find((item) => item !== 'null')
    : record.type;

  let schema: z.ZodTypeAny;
  if (
    Array.isArray(record.enum) &&
    record.enum.length > 0 &&
    record.enum.every((item): item is string => typeof item === 'string')
  ) {
    schema = z.enum(record.enum as [string, ...string[]]);
  } else if (rawType === 'string') {
    schema = z.string();
  } else if (rawType === 'integer') {
    let num = z.number().int();
    if (typeof record.minimum === 'number') num = num.min(record.minimum);
    if (typeof record.maximum === 'number') num = num.max(record.maximum);
    schema = num;
  } else if (rawType === 'number') {
    let num = z.number();
    if (typeof record.minimum === 'number') num = num.min(record.minimum);
    if (typeof record.maximum === 'number') num = num.max(record.maximum);
    schema = num;
  } else if (rawType === 'boolean') {
    schema = z.boolean();
  } else if (rawType === 'array') {
    schema = z.array(jsonSchemaPropertyToZod(record.items));
  } else if (rawType === 'object') {
    schema = z.record(z.string(), z.unknown());
  } else {
    schema = z.unknown();
  }

  if (typeof record.description === 'string' && record.description.trim()) {
    schema = schema.describe(record.description.trim());
  }
  return schema;
}

export function buildMcpToolZodInputSchema(tool: McpServerOperation) {
  const inputSchema = tool.inputSchema;
  const shape: Record<string, z.ZodTypeAny> = {};

  if (inputSchema && typeof inputSchema === 'object' && !Array.isArray(inputSchema)) {
    const properties =
      inputSchema.properties &&
      typeof inputSchema.properties === 'object' &&
      !Array.isArray(inputSchema.properties)
        ? (inputSchema.properties as Record<string, unknown>)
        : {};
    const required = new Set(
      Array.isArray(inputSchema.required)
        ? inputSchema.required.filter((item): item is string => typeof item === 'string')
        : [],
    );

    for (const [name, prop] of Object.entries(properties)) {
      const base = jsonSchemaPropertyToZod(prop);
      if (name === 'context') {
        shape[name] = base.default('Answer user question in Apex');
      } else {
        shape[name] = required.has(name) ? base : base.optional();
      }
    }
  } else if (Array.isArray(tool.inputs) && tool.inputs.length > 0) {
    for (const input of tool.inputs) {
      const base = jsonSchemaPropertyToZod({
        type: input.type,
        description: input.description,
      });
      if (input.name === 'context') {
        shape[input.name] = base.default('Answer user question in Apex');
      } else {
        shape[input.name] = input.required ? base : base.optional();
      }
    }
  }

  if (supportsTimestampBoundarySearch(tool)) {
    shape.since_timestamp_ms ??= z
      .union([z.number(), z.string()])
      .optional()
      .describe(
        'Inclusive lower-bound timestamp (Unix ms or ISO-8601 string). Pass with a descending timestamp order_by (such as -last_sign_in_at, -last_active_at, or -created_at) to count all matching records in one call without manual pagination.',
      );
    shape.until_timestamp_ms ??= z
      .union([z.number(), z.string()])
      .optional()
      .describe(
        'Optional exclusive upper-bound timestamp (Unix ms or ISO-8601 string) for a bounded time-window count with since_timestamp_ms.',
      );
  }

  return z.object(shape).passthrough();
}

function unwrapMcpToolResult(raw: string): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  try {
    const parsed = JSON.parse(raw) as {
      content?: Array<{ type?: string; text?: unknown }>;
      isError?: boolean;
    };
    if (Array.isArray(parsed?.content)) {
      const textBlocks = parsed.content
        .filter(
          (item): item is { type: 'text'; text: string } =>
            item?.type === 'text' && typeof item.text === 'string',
        )
        .map((item) => ({ type: 'text' as const, text: item.text }));
      if (textBlocks.length > 0) {
        return {
          content: textBlocks,
          ...(parsed.isError ? { isError: true } : {}),
        };
      }
    }
  } catch {
    // Plain text or non-MCP JSON payload.
  }
  return { content: [{ type: 'text' as const, text: raw }] };
}

export async function createMcpServerRuntime(
  boundConnectionId: string,
  boundUserId: string
): Promise<McpServer> {
  const server = new McpServer({
    name: 'mcp-server',
    version: '1.0.0',
  });

  const mcpTools = await listMountedMcpTools(boundConnectionId);
  if (mcpTools.length > 0) {
    for (const tool of mcpTools) {
      server.registerTool(
        tool.id,
        {
          description: tool.summary,
          inputSchema: buildMcpToolZodInputSchema(tool),
          annotations: { readOnlyHint: true },
        },
        async (args) => {
          if (!consumeMcpTurnCallBudget(boundConnectionId, boundUserId)) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error:
                      'MCP call limit reached for this turn (8 calls maximum). Stop calling tools immediately and answer the user now with the best result from the data already gathered.',
                  }),
                },
              ],
            };
          }
          try {
            const text = await executeMountedMcpTool(
              boundConnectionId,
              boundUserId,
              tool.id,
              (args ?? {}) as Record<string, unknown>
            );
            return unwrapMcpToolResult(text);
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Integration tool failed';
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
            };
          }
        }
      );
    }
    return server;
  }

  server.tool(
    'read_operation',
    'Call one read operation that belongs to this connection. ' +
      'operationId must be one of the operations saved on the connection. ' +
      'This tool cannot call other providers or arbitrary URLs.',
    {
      operationId: z
        .string()
        .describe('Allow-listed operation id for this connection'),
      params: z
        .record(z.string(), z.string())
        .optional()
        .describe('Path and query parameters for that operation'),
    },
    async ({ operationId, params }) => {
      try {
        const result = await executeMountedMcpServerRead(
          boundConnectionId,
          boundUserId,
          operationId,
          params ?? {}
        );
        return {
          content: [{ type: 'text' as const, text: result.body }],
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Integration read failed';
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ error: message }) },
          ],
        };
      }
    }
  );

  return server;
}

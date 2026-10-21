/**
 * Integration connector MCP server.
 *
 * Bound to one saved connection. The only tool calls a read operation from
 * that connection's allow-list. There is no generic HTTP tool.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { executeMountedIntegrationRead } from '../../services/integrationReadService';

export function createIntegrationMcpServer(boundConnectionId: string): McpServer {
  const server = new McpServer({
    name: 'integration-connector',
    version: '1.0.0',
  });

  server.tool(
    'read_operation',
    'Call one read operation that belongs to this connection. ' +
      'operationId must be one of the operations saved on the connection. ' +
      'This tool cannot call other providers or arbitrary URLs.',
    {
      operationId: z.string().describe('Allow-listed operation id for this connection'),
      params: z.record(z.string(), z.string()).optional().describe('Path and query parameters for that operation'),
    },
    async ({ operationId, params }) => {
      try {
        const result = await executeMountedIntegrationRead(
          boundConnectionId,
          operationId,
          params ?? {},
        );
        return {
          content: [{ type: 'text' as const, text: result.body }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Integration read failed';
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
        };
      }
    },
  );

  return server;
}

/**
 * Mount the integration connector MCP server bound to one connection.
 *
 * URL pattern:  POST /mcp/mcp-servers/:connectionId
 * Health probe: GET  /mcp/mcp-servers/:connectionId/health
 */
import { Application, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServerRuntime } from './server';

function isLoopbackAddress(addr: string | undefined): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

export function mountMcpServers(
  app: Application,
  basePath = '/mcp/mcp-servers'
): void {
  app.post(`${basePath}/:connectionId`, async (req: Request, res: Response) => {
    const { connectionId } = req.params;
    const userId = typeof req.query.userId === 'string' ? req.query.userId : '';
    if (!connectionId) {
      res.status(400).json({ error: 'connectionId is required' });
      return;
    }
    if (!isLoopbackAddress(req.socket.remoteAddress) || !userId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const server = await createMcpServerRuntime(connectionId, userId);

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'MCP server error';
      console.error('[mcp/mcpServers] Request error:', message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'MCP server error' });
      }
    }
  });

  app.get(
    `${basePath}/:connectionId/health`,
    (_req: Request, res: Response) => {
      res.json({ ok: true, server: 'mcp-server', version: '1.0.0' });
    }
  );

  console.log(`[mcp/mcpServers] Mounted at POST ${basePath}/:connectionId`);
}

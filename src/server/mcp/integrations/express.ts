/**
 * Mount the integration connector MCP server bound to one connection.
 *
 * URL pattern:  POST /mcp/integrations/:connectionId
 * Health probe: GET  /mcp/integrations/:connectionId/health
 */
import { Application, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createIntegrationMcpServer } from './server';

export function mountIntegrationMcp(app: Application, basePath = '/mcp/integrations'): void {
  app.post(`${basePath}/:connectionId`, async (req: Request, res: Response) => {
    const { connectionId } = req.params;
    if (!connectionId) {
      res.status(400).json({ error: 'connectionId is required' });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const server = createIntegrationMcpServer(connectionId);

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'MCP server error';
      console.error('[mcp/integrations] Request error:', message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'MCP server error' });
      }
    }
  });

  app.get(`${basePath}/:connectionId/health`, (_req: Request, res: Response) => {
    res.json({ ok: true, server: 'integration-connector', version: '1.0.0' });
  });

  console.log(`[mcp/integrations] Mounted at POST ${basePath}/:connectionId`);
}

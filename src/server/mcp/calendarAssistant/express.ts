/**
 * Mount the Calendar Assistant MCP server as a session-bound Streamable HTTP
 * endpoint. Each session gets its own URL so the model cannot target
 * arbitrary sessions.
 *
 * URL pattern:  POST /mcp/calendar-assistant/:sessionId
 * Health probe: GET  /mcp/calendar-assistant/:sessionId/health
 */
import { Application, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createCalendarAssistantMcpServer } from './server';

export function mountCalendarAssistantMcp(app: Application, basePath = '/mcp/calendar-assistant'): void {
  app.post(`${basePath}/:sessionId`, async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless per-request
    });

    const server = createCalendarAssistantMcpServer(sessionId);

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err: any) {
      console.error('[mcp/calendar-assistant] Request error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'MCP server error' });
      }
    }
  });

  app.get(`${basePath}/:sessionId/health`, (_req: Request, res: Response) => {
    res.json({ ok: true, server: 'calendar-assistant', version: '1.0.0' });
  });

  console.log(`[mcp/calendar-assistant] Mounted at POST ${basePath}/:sessionId`);
}

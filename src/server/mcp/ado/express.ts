import { Application, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createAdoMcpServer } from './server';
import { mountCalendarAssistantMcp } from '../calendarAssistant/express';

/**
 * Mount the ADO MCP server as a Streamable HTTP transport on the given Express app.
 *
 * Registration in Cursor Desktop (.cursor/mcp.json):
 * {
 *   "mcpServers": {
 *     "ado-skills": { "url": "http://localhost:3001/mcp/ado-skills" }
 *   }
 * }
 */
export function mountAdoMcp(app: Application, basePath = '/mcp/ado-skills'): void {
  /**
   * Streamable HTTP transport uses a single POST endpoint.
   * Each request gets its own transport+server pair (stateless per-request model).
   * This is the recommended pattern for HTTP deployments without session persistence.
   */
  app.post(basePath, async (req: Request, res: Response) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });

    const server = createAdoMcpServer();

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err: any) {
      console.error('[mcp/ado] Request error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'MCP server error' });
      }
    }
  });

  // Health probe — useful for IDE and orchestrator registration checks
  app.get(`${basePath}/health`, (_req: Request, res: Response) => {
    res.json({ ok: true, server: 'ado-skills', version: '1.0.0' });
  });

  console.log(`[mcp/ado] Mounted at POST ${basePath}`);

  // Mount the session-bound calendar assistant MCP alongside ado-skills.
  // URL: POST /mcp/calendar-assistant/:sessionId
  mountCalendarAssistantMcp(app);
}

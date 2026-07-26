import { Application, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createGitHubMcpServer } from './server';
import { handleMcpPost } from '../mcpRequestLog';

/**
 * Mount the GitHub MCP server as a Streamable HTTP transport on the given Express app.
 * Provides read-only repo browsing tools for GitHub-backed projects.
 */
export function mountGitHubMcp(app: Application, basePath = '/mcp/github-repo'): void {
  app.post(basePath, async (req: Request, res: Response) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    const server = createGitHubMcpServer();

    try {
      await handleMcpPost('mcp/github', req.body, async () => {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[mcp/github] Request error:', message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'MCP server error' });
      }
    }
  });

  app.get(`${basePath}/health`, (_req: Request, res: Response) => {
    res.json({ ok: true, server: 'github-repo', version: '1.0.0' });
  });

  console.log(`[mcp/github] Mounted at POST ${basePath}`);
}

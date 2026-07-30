import { Application, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createGitHubMcpServer } from './server';
import { failMcpHttpResponse, handleMcpPost } from '../mcpRequestLog';
import { McpTimeoutError, resolveMcpHttpTimeoutMs } from '../mcpTimeout';

/**
 * Mount the GitHub MCP server as a Streamable HTTP transport on the given Express app.
 * Provides read-only repo browsing tools for GitHub-backed projects.
 *
 * Every POST is hard-capped (default 45s) so a stalled Streamable HTTP session cannot
 * leave the Cursor agent tool_call in `running` until the chat reaper fires (~5 min).
 */
export function mountGitHubMcp(app: Application, basePath = '/mcp/github-repo'): void {
  app.post(basePath, async (req: Request, res: Response) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // Keep headers uncommitted until the JSON-RPC result is ready. This lets
      // timeout handling return a terminal tools/call result without an SSE race.
      enableJsonResponse: true,
    });

    const server = createGitHubMcpServer({
      enableCodeSearch: req.query.profile !== 'interview',
    });
    const timeoutMs = resolveMcpHttpTimeoutMs();

    try {
      await handleMcpPost('mcp/github', req.body, async () => {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      }, { timeoutMs, res });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[mcp/github] Request error:', message);
      if (err instanceof McpTimeoutError) {
        // handleMcpPost already attempted to fail the response
        failMcpHttpResponse(res, req.body, message);
        await transport.close().catch(() => undefined);
        return;
      }
      if (!res.headersSent) {
        res.status(500).json({ error: 'MCP server error' });
      }
    }
  });

  app.get(`${basePath}/health`, (_req: Request, res: Response) => {
    res.json({ ok: true, server: 'github-repo', version: '1.0.0' });
  });

  console.log(`[mcp/github] Mounted at POST ${basePath} (httpTimeoutMs=${resolveMcpHttpTimeoutMs()})`);
}

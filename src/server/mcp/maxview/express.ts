import { Application, Request, Response } from 'express';
import http from 'http';
import https from 'https';
import {
  getMaxviewToken,
  isMaxviewConfigured,
  maxviewRejectUnauthorized,
} from '../../services/maxviewAuthService';

/**
 * MaxView MCP proxy.
 *
 * The Cursor SDK agent connects to this Apex-hosted endpoint (no upstream secret
 * required) and this proxy forwards the JSON-RPC / Streamable-HTTP traffic to the
 * real MaxView MCP server (`${MAXVIEW_MCP_BASE_URL}/mcp`), injecting a freshly
 * minted bearer token via `maxviewAuthService`. The upstream server is stateful
 * (it returns an `Mcp-Session-Id`), so the session header and the response body
 * (JSON or `text/event-stream`) are relayed transparently in both directions.
 *
 * Registration is automatic for the chat agent via `buildMcpServers()` in
 * `chatAgentService.ts` (gated by the `maxview-mcp` feature flag), which points at
 * `http://localhost:${PORT}/mcp/maxview`.
 */

/** Request headers passed through to the upstream MCP server. */
const FORWARD_REQUEST_HEADERS = [
  'accept',
  'content-type',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
];

/** Response headers relayed back to the MCP client. */
const RELAY_RESPONSE_HEADERS = ['content-type', 'mcp-session-id', 'cache-control'];

function upstreamMcpUrl(): string {
  return `${(process.env.MAXVIEW_MCP_BASE_URL ?? '').replace(/\/+$/, '')}/mcp`;
}

function sendUpstream(
  token: string,
  req: Request,
  bodyBuf: Buffer | null,
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const u = new URL(upstreamMcpUrl());
    const lib = u.protocol === 'https:' ? https : http;

    const headers: Record<string, string> = {};
    for (const h of FORWARD_REQUEST_HEADERS) {
      const v = req.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }
    headers['authorization'] = `Bearer ${token}`;
    if (bodyBuf) headers['content-length'] = String(bodyBuf.length);

    const upstreamReq = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: req.method,
        headers,
        ...(u.protocol === 'https:' ? { rejectUnauthorized: maxviewRejectUnauthorized() } : {}),
      },
      resolve,
    );
    upstreamReq.on('error', reject);
    if (bodyBuf) upstreamReq.write(bodyBuf);
    upstreamReq.end();
  });
}

function relay(upstreamRes: http.IncomingMessage, res: Response): void {
  res.status(upstreamRes.statusCode ?? 502);
  for (const h of RELAY_RESPONSE_HEADERS) {
    const v = upstreamRes.headers[h];
    if (typeof v === 'string') {
      res.setHeader(h === 'mcp-session-id' ? 'Mcp-Session-Id' : h, v);
    }
  }
  upstreamRes.on('error', () => {
    if (!res.writableEnded) res.end();
  });
  upstreamRes.pipe(res);
}

export function mountMaxviewMcp(app: Application, basePath = '/mcp/maxview'): void {
  const handler = async (req: Request, res: Response): Promise<void> => {
    if (!isMaxviewConfigured()) {
      res.status(503).json({ error: 'MaxView MCP is not configured on this server' });
      return;
    }

    // express.json() already parsed the JSON-RPC body; re-serialize for forwarding.
    const bodyBuf =
      req.method === 'GET' || req.method === 'HEAD'
        ? null
        : Buffer.from(JSON.stringify(req.body ?? {}), 'utf8');

    try {
      let token = await getMaxviewToken();
      let upstreamRes = await sendUpstream(token, req, bodyBuf);

      // Token may have expired — refresh once and retry before relaying the body.
      if (upstreamRes.statusCode === 401 || upstreamRes.statusCode === 403) {
        upstreamRes.resume(); // drain the failed response
        token = await getMaxviewToken({ forceRefresh: true });
        upstreamRes = await sendUpstream(token, req, bodyBuf);
      }

      const rpcMethod =
        req.body && typeof req.body === 'object' ? (req.body as { method?: string }).method : undefined;
      console.log(
        `[mcp/maxview] ${req.method} ${rpcMethod ? `(${rpcMethod}) ` : ''}-> ${upstreamRes.statusCode}`,
      );

      relay(upstreamRes, res);
    } catch (err: any) {
      console.error('[mcp/maxview] proxy error:', err?.message);
      if (!res.headersSent) {
        res.status(502).json({ error: 'MaxView MCP proxy error' });
      }
    }
  };

  app.post(basePath, handler);
  app.get(basePath, handler);
  app.delete(basePath, handler);

  app.get(`${basePath}/health`, (_req: Request, res: Response) => {
    res.json({ ok: true, server: 'maxview', configured: isMaxviewConfigured() });
  });

  console.log(`[mcp/maxview] Mounted at ${basePath} (configured=${isMaxviewConfigured()})`);
}

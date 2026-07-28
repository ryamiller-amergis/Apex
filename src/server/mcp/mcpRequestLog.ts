/**
 * Shared helpers for Streamable HTTP MCP Express mounts (github-repo, ado-skills, etc.).
 */

import type { Response } from 'express';
import { McpTimeoutError, raceWithTimeout } from './mcpTimeout';

export function summarizeMcpRpc(body: unknown): string {
  if (!body || typeof body !== 'object') return 'unknown';
  const record = body as Record<string, unknown>;
  const method = typeof record.method === 'string' ? record.method : 'request';
  const params = record.params && typeof record.params === 'object'
    ? record.params as Record<string, unknown>
    : undefined;
  const name = params && typeof params.name === 'string' ? params.name : undefined;
  return name ? `${method}:${name}` : method;
}

function extractJsonRpcId(body: unknown): string | number | null {
  if (!body || typeof body !== 'object') return null;
  const id = (body as Record<string, unknown>).id;
  if (typeof id === 'string' || typeof id === 'number') return id;
  return null;
}

/** Best-effort terminate a hung Streamable HTTP response so the Cursor SDK unblocks. */
export function failMcpHttpResponse(res: Response, reqBody: unknown, message: string): void {
  if (res.writableEnded || res.destroyed) return;
  if (!res.headersSent) {
    res.status(504).json({
      jsonrpc: '2.0',
      id: extractJsonRpcId(reqBody),
      error: { code: -32000, message },
    });
    return;
  }
  try {
    res.destroy(new Error(message));
  } catch {
    // ignore
  }
}

export async function handleMcpPost(
  label: string,
  reqBody: unknown,
  run: () => Promise<void>,
  options?: { timeoutMs?: number; res?: Response },
): Promise<void> {
  const started = Date.now();
  const summary = summarizeMcpRpc(reqBody);
  console.log(`[${label}] start ${summary}`);
  try {
    const execute = async () => {
      await run();
    };
    if (options?.timeoutMs && options.timeoutMs > 0) {
      await raceWithTimeout(`${label} ${summary}`, options.timeoutMs, execute);
    } else {
      await execute();
    }
    console.log(`[${label}] ok ${summary} (${Date.now() - started}ms)`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${label}] error ${summary} (${Date.now() - started}ms):`, message);
    if (err instanceof McpTimeoutError && options?.res) {
      failMcpHttpResponse(options.res, reqBody, message);
    }
    throw err;
  }
}

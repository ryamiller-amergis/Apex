import {
  McpTimeoutError,
  raceWithTimeout,
  resolveMcpHttpTimeoutMs,
  resolveMcpToolTimeoutMs,
  resolvePositiveMs,
} from '../mcp/mcpTimeout';
import { failMcpHttpResponse, handleMcpPost, summarizeMcpRpc } from '../mcp/mcpRequestLog';

describe('mcpTimeout', () => {
  const originalHttp = process.env.MCP_HTTP_TIMEOUT_MS;
  const originalTool = process.env.MCP_TOOL_TIMEOUT_MS;

  afterEach(() => {
    if (originalHttp === undefined) delete process.env.MCP_HTTP_TIMEOUT_MS;
    else process.env.MCP_HTTP_TIMEOUT_MS = originalHttp;
    if (originalTool === undefined) delete process.env.MCP_TOOL_TIMEOUT_MS;
    else process.env.MCP_TOOL_TIMEOUT_MS = originalTool;
  });

  it('resolvePositiveMs falls back for invalid values', () => {
    expect(resolvePositiveMs(undefined, 45_000)).toBe(45_000);
    expect(resolvePositiveMs('0', 45_000)).toBe(45_000);
    expect(resolvePositiveMs('-1', 45_000)).toBe(45_000);
    expect(resolvePositiveMs('12000', 45_000)).toBe(12_000);
  });

  it('reads MCP timeout env overrides', () => {
    process.env.MCP_HTTP_TIMEOUT_MS = '12000';
    process.env.MCP_TOOL_TIMEOUT_MS = '8000';
    expect(resolveMcpHttpTimeoutMs()).toBe(12_000);
    expect(resolveMcpToolTimeoutMs()).toBe(8_000);
  });

  it('raceWithTimeout resolves when work finishes first', async () => {
    await expect(
      raceWithTimeout('fast', 200, async () => 'ok'),
    ).resolves.toBe('ok');
  });

  it('raceWithTimeout rejects with McpTimeoutError when work stalls', async () => {
    await expect(
      raceWithTimeout('slow', 20, () => new Promise(() => { /* never */ })),
    ).rejects.toMatchObject({
      name: 'McpTimeoutError',
      timeoutMs: 20,
      message: expect.stringContaining('timed out after 20ms'),
    });
  });
});

describe('handleMcpPost timeout', () => {
  it('fails the HTTP response with 504 JSON-RPC when the handler stalls', async () => {
    const status = jest.fn().mockReturnThis();
    const json = jest.fn();
    const res = {
      headersSent: false,
      writableEnded: false,
      destroyed: false,
      status,
      json,
      destroy: jest.fn(),
    };

    await expect(
      handleMcpPost(
        'mcp/github',
        { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'search_repo_code' } },
        () => new Promise(() => { /* hang */ }),
        { timeoutMs: 25, res: res as never },
      ),
    ).rejects.toBeInstanceOf(McpTimeoutError);

    expect(status).toHaveBeenCalledWith(504);
    expect(json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 7,
      error: {
        code: -32000,
        message: expect.stringContaining('timed out after 25ms'),
      },
    });
  });

  it('summarizeMcpRpc still works for tools/call', () => {
    expect(summarizeMcpRpc({
      method: 'tools/call',
      params: { name: 'search_repo_code' },
    })).toBe('tools/call:search_repo_code');
  });

  it('failMcpHttpResponse is a no-op when already ended', () => {
    const res = {
      headersSent: true,
      writableEnded: true,
      destroyed: false,
      status: jest.fn(),
      json: jest.fn(),
      destroy: jest.fn(),
    };
    failMcpHttpResponse(res as never, { id: 1 }, 'timeout');
    expect(res.status).not.toHaveBeenCalled();
    expect(res.destroy).not.toHaveBeenCalled();
  });
});

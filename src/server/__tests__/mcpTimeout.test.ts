import {
  McpTimeoutError,
  raceWithTimeout,
  resolveAgentMcpToolTimeoutMs,
  resolveMcpHttpTimeoutMs,
  resolveMcpToolTimeoutMs,
  resolvePositiveMs,
} from '../mcp/mcpTimeout';
import {
  buildMcpTimeoutResponse,
  failMcpHttpResponse,
  handleMcpPost,
  summarizeMcpRpc,
} from '../mcp/mcpRequestLog';

describe('mcpTimeout', () => {
  const originalHttp = process.env.MCP_HTTP_TIMEOUT_MS;
  const originalTool = process.env.MCP_TOOL_TIMEOUT_MS;
  const originalAgentTool = process.env.AGENT_MCP_TOOL_TIMEOUT_MS;

  afterEach(() => {
    if (originalHttp === undefined) delete process.env.MCP_HTTP_TIMEOUT_MS;
    else process.env.MCP_HTTP_TIMEOUT_MS = originalHttp;
    if (originalTool === undefined) delete process.env.MCP_TOOL_TIMEOUT_MS;
    else process.env.MCP_TOOL_TIMEOUT_MS = originalTool;
    if (originalAgentTool === undefined) delete process.env.AGENT_MCP_TOOL_TIMEOUT_MS;
    else process.env.AGENT_MCP_TOOL_TIMEOUT_MS = originalAgentTool;
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

  it('sets the owner MCP deadline after the server-side timeout bounds', () => {
    delete process.env.MCP_HTTP_TIMEOUT_MS;
    delete process.env.MCP_TOOL_TIMEOUT_MS;
    delete process.env.AGENT_MCP_TOOL_TIMEOUT_MS;
    expect(resolveAgentMcpToolTimeoutMs()).toBe(60_000);

    process.env.MCP_HTTP_TIMEOUT_MS = '70000';
    process.env.AGENT_MCP_TOOL_TIMEOUT_MS = '30000';
    expect(resolveAgentMcpToolTimeoutMs()).toBe(75_000);
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
  it('finishes a stalled tools/call with a terminal MCP tool result', async () => {
    const status = jest.fn().mockReturnThis();
    const json = jest.fn();
    const res = {
      headersSent: false,
      writableEnded: false,
      destroyed: false,
      status,
      json,
      getHeader: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
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

    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 7,
      result: {
        content: [{
          type: 'text',
          text: expect.stringContaining('timed out after 25ms'),
        }],
        isError: true,
      },
    });
  });

  it('ends an already-started SSE response with a terminal tools/call result', () => {
    const write = jest.fn();
    const end = jest.fn();
    const res = {
      headersSent: true,
      writableEnded: false,
      destroyed: false,
      status: jest.fn(),
      json: jest.fn(),
      getHeader: jest.fn().mockReturnValue('text/event-stream'),
      write,
      end,
      destroy: jest.fn(),
    };

    failMcpHttpResponse(
      res as never,
      { jsonrpc: '2.0', id: 'tool-1', method: 'tools/call' },
      'request timed out',
    );

    expect(write).toHaveBeenCalledWith(expect.stringContaining('"isError":true'));
    expect(end).toHaveBeenCalledTimes(1);
    expect(res.destroy).not.toHaveBeenCalled();
  });

  it('keeps JSON-RPC errors for non-tool requests', () => {
    expect(buildMcpTimeoutResponse(
      { jsonrpc: '2.0', id: 2, method: 'initialize' },
      'request timed out',
    )).toEqual({
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32000, message: 'request timed out' },
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
      getHeader: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
      destroy: jest.fn(),
    };
    failMcpHttpResponse(res as never, { id: 1 }, 'timeout');
    expect(res.status).not.toHaveBeenCalled();
    expect(res.destroy).not.toHaveBeenCalled();
  });
});

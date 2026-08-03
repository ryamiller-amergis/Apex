import {
  clearToolInFlight,
  findExpiredMcpTool,
  identifyMcpTool,
  markToolInFlight,
  type InFlightToolCall,
} from '../services/inFlightToolTracker';

describe('inFlightToolTracker', () => {
  it('identifies Cursor MCP wrapper calls without classifying local tools', () => {
    expect(identifyMcpTool('mcp', {
      providerIdentifier: 'github-repo',
      toolName: 'search_repo_code',
      args: { query: 'walkthrough' },
    })).toBe('mcp:search_repo_code');
    expect(identifyMcpTool('mcp:get_skill_file', {})).toBe('mcp:get_skill_file');
    expect(identifyMcpTool('edit', { path: 'README.md' })).toBeNull();
  });

  it('reports an MCP call only after its owner deadline', () => {
    const calls = new Map<string, InFlightToolCall>();
    markToolInFlight(
      calls,
      'call-1',
      'mcp',
      { providerIdentifier: 'github-repo', toolName: 'search_repo_code' },
      1_000,
    );

    expect(findExpiredMcpTool(calls, 60_999, 60_000)).toBeNull();
    expect(findExpiredMcpTool(calls, 61_000, 60_000)).toMatchObject({
      key: 'call-1',
      mcpLabel: 'mcp:search_repo_code',
      elapsedMs: 60_000,
    });
  });

  it('does not apply the MCP deadline to long-running local tools', () => {
    const calls = new Map<string, InFlightToolCall>();
    markToolInFlight(calls, 'edit-1', 'edit', { path: 'large.md' }, 1_000);

    expect(findExpiredMcpTool(calls, 10 * 60_000, 60_000)).toBeNull();
  });

  it('clears assistant and tool-call aliases by MCP identity', () => {
    const calls = new Map<string, InFlightToolCall>();
    const input = { providerIdentifier: 'github-repo', toolName: 'search_repo_code' };
    markToolInFlight(calls, 'assistant-id', 'mcp', input, 1_000);
    markToolInFlight(calls, 'sdk-call-id', 'mcp', input, 2_000);

    clearToolInFlight(calls, 'sdk-call-id', 'mcp', input);

    expect(calls.size).toBe(0);
  });

  it('clears an MCP alias when an older SDK terminal event omits its args', () => {
    const calls = new Map<string, InFlightToolCall>();
    markToolInFlight(calls, 'assistant-id', 'mcp', {
      providerIdentifier: 'github-repo',
      toolName: 'search_repo_code',
    }, 1_000);

    clearToolInFlight(calls, 'different-sdk-id', 'mcp', undefined);

    expect(calls.size).toBe(0);
  });

  it('does not reset the original start time for duplicate running events', () => {
    const calls = new Map<string, InFlightToolCall>();
    const input = { providerIdentifier: 'github-repo', toolName: 'get_skill_file' };
    markToolInFlight(calls, 'call-1', 'mcp', input, 1_000);
    markToolInFlight(calls, 'call-1', 'mcp', input, 30_000);

    expect(calls.get('call-1')?.startedAtMs).toBe(1_000);
  });
});

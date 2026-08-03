import { summarizeMcpRpc } from '../mcp/mcpRequestLog';

describe('summarizeMcpRpc', () => {
  it('includes tools/call name when present', () => {
    expect(summarizeMcpRpc({
      method: 'tools/call',
      params: { name: 'search_repo_code', arguments: { query: 'foo' } },
    })).toBe('tools/call:search_repo_code');
  });

  it('falls back to method only', () => {
    expect(summarizeMcpRpc({ method: 'initialize' })).toBe('initialize');
  });

  it('handles non-objects', () => {
    expect(summarizeMcpRpc(null)).toBe('unknown');
  });
});

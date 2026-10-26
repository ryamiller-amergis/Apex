import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('mcp server registry migrations', () => {
  it('SC-2 adds view and manage permissions and grants neither to a default role', () => {
    const sql = read('migrations/20261021150000_integrations-permissions.sql');
    const up = sql.split('-- Down Migration')[0];
    expect(up).toContain("'integrations:view'");
    expect(up).toContain("'integrations:manage'");
    expect(up).not.toMatch(/app_role_permissions/i);
    expect(up).not.toMatch(/IN \('admin', 'member', 'viewer'\)/i);
  });

  it('SC-1 seeds the integrations flag off for project targeting', () => {
    const sql = read('migrations/20261021150200_seed-integrations-flag.sql');
    const up = sql.split('-- Down Migration')[0];
    expect(up).toContain("'integrations'");
    expect(up).toMatch(/false/);
    expect(up).not.toMatch(/type,\s*'project'/);
  });

  it('renames the module, permissions, flag, and table to mcp-servers', () => {
    const sql = read('migrations/20261022010000_rename-integrations-to-mcp-servers.sql');
    const up = sql.split('-- Down Migration')[0];
    expect(up).toContain("'mcp-servers:view'");
    expect(up).toContain("'mcp-servers:manage'");
    expect(up).toContain("RENAME TO mcp_servers");
    expect(up).toContain("'mcp-servers'");
  });

  it('SC-3 stores ciphertext columns and no plaintext credential column', () => {
    const sql = read('migrations/20261021150100_integration-connections.sql');
    expect(sql).toContain('credential_ciphertext');
    expect(sql).toContain('credential_iv');
    expect(sql).toContain('credential_auth_tag');
    expect(sql).toContain('credential_hint');
    expect(sql).not.toMatch(/^\s+credential\s+TEXT/m);
  });
});

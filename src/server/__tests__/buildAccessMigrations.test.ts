import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const migrationsDir = path.join(repoRoot, 'migrations');
const permissionsMigration = fs.readFileSync(
  path.join(migrationsDir, '20261023200000_b7e2_add-builds-permissions.sql'),
  'utf8',
);
const flagMigration = fs.readFileSync(
  path.join(migrationsDir, '20261023200100_b7e3_seed-build-from-prompt-flag.sql'),
  'utf8',
);
const allowlistMigration = fs.readFileSync(
  path.join(migrationsDir, '20261023200200_b7e4_build-allowlist.sql'),
  'utf8',
);
const governance = fs.readFileSync(path.join(repoRoot, '.cursor', 'rules', 'rbac-governance.mdc'), 'utf8');

function upBlock(sql: string): string {
  return sql.split('-- Down Migration')[0];
}

function downBlock(sql: string): string {
  return sql.split('-- Down Migration')[1] ?? '';
}

describe('TBI-004 DoD-0 — builds permission migration (VT-11)', () => {
  const up = upBlock(permissionsMigration);
  const down = downBlock(permissionsMigration);

  it('inserts builds:view and builds:run in category builds idempotently', () => {
    expect(up).toContain("'builds:view'");
    expect(up).toContain("'builds:run'");
    expect(up).toContain("'builds'");
    expect(up).toContain('ON CONFLICT (key) DO NOTHING');
    expect(up.match(/ON CONFLICT DO NOTHING/g)).toHaveLength(2);
  });

  it('links builds:view to admin, member and viewer and builds:run to admin and member', () => {
    expect(up).toMatch(/p\.key = 'builds:view'\s+WHERE r\.name IN \('admin', 'member', 'viewer'\)/);
    expect(up).toMatch(/p\.key = 'builds:run'\s+WHERE r\.name IN \('admin', 'member'\)/);
  });

  it('has a real down migration that removes links before keys', () => {
    expect(down).toContain('DELETE FROM app_role_permissions');
    expect(down).toContain('DELETE FROM app_permissions');
    expect(down.indexOf('DELETE FROM app_role_permissions')).toBeLessThan(
      down.search(/DELETE FROM app_permissions\s/),
    );
    expect(down).not.toMatch(/^--\s*DELETE/m);
  });

  it('lists both keys in the rbac-governance catalog with the stated roles', () => {
    expect(governance).toContain('| `builds:view` | builds | admin, member, viewer |');
    expect(governance).toContain('| `builds:run` | builds | admin, member |');
  });
});

describe('TBI-004 DoD-2 — build-from-prompt flag seed (VT-13)', () => {
  const up = upBlock(flagMigration);

  it('seeds the flag off, active, with no rules', () => {
    expect(up).toContain("'build-from-prompt'");
    expect(up).toMatch(/'build-from-prompt',\s+'[^']+',\s+false,\s+'active',\s+false,/);
    expect(up).toContain('ON CONFLICT (key) DO NOTHING');
    expect(up).not.toContain('feature_flag_rules');
  });

  it('down migration removes rules then the flag', () => {
    const down = downBlock(flagMigration);
    expect(down.indexOf('DELETE FROM feature_flag_rules')).toBeLessThan(down.search(/DELETE FROM feature_flags\s/));
  });
});

describe('TBI-004 DoD-3 — allow-list tables', () => {
  const up = upBlock(allowlistMigration);

  it('creates build_allowlist with a unique (project, repository) constraint', () => {
    expect(up).toContain('CREATE TABLE build_allowlist (');
    expect(up).toContain('UNIQUE (project, repository)');
  });

  it('creates an audit table limited to added and removed actions', () => {
    expect(up).toContain('CREATE TABLE build_allowlist_audit (');
    expect(up).toContain("CHECK (action IN ('added', 'removed'))");
    expect(up).toContain('actor_id text NOT NULL');
  });

  it('down migration drops both tables', () => {
    const down = downBlock(allowlistMigration);
    expect(down).toContain('DROP TABLE IF EXISTS build_allowlist_audit');
    expect(down).toContain('DROP TABLE IF EXISTS build_allowlist;');
  });

  it('sorts after the FEAT-001 build tables so node-pg-migrate order checks pass', () => {
    const names = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    const feat001 = names.indexOf('20261023144000_c3d8_build-from-prompt-agent-runs.sql');
    const first = names.indexOf('20261023200000_b7e2_add-builds-permissions.sql');
    expect(feat001).toBeGreaterThan(-1);
    expect(first).toBeGreaterThan(feat001);
  });
});

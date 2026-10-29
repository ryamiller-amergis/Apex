import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const migrationPath = path.join(
  repoRoot,
  'migrations',
  '20260922100000_complete-playbooks-permissions.sql',
);
const governancePath = path.join(repoRoot, '.cursor', 'rules', 'rbac-governance.mdc');

describe('TBI-036 DoD-0/1 — Playbook permission catalog', () => {
  it('VT-01/VT-02 seeds author and admin without changing widened view/run grants', () => {
    const migration = fs.readFileSync(migrationPath, 'utf8');

    expect(migration).toContain("'playbooks:author'");
    expect(migration).toContain("'playbooks:admin'");
    expect(migration).toMatch(
      /UPDATE app_permissions[\s\S]*does not authorize the run''s step effects[\s\S]*playbooks:run/,
    );
    expect(migration).toMatch(
      /r\.name = 'admin'[\s\S]*p\.key = 'playbooks:admin'/,
    );
    expect(migration).not.toMatch(
      /r\.name IN \('admin', 'member'\)[\s\S]*p\.key = 'playbooks:author'/,
    );
  });

  it('VT-03 rollback removes only author/admin and restores the run description', () => {
    const migration = fs.readFileSync(migrationPath, 'utf8');
    const down = migration.split('-- Down Migration')[1];

    expect(down).toContain("'playbooks:author'");
    expect(down).toContain("'playbooks:admin'");
    expect(down).toContain('Start and cancel Playbook runs');
    expect(down).not.toMatch(/DELETE FROM app_permissions[^;]*playbooks:view/);
    expect(down).not.toMatch(/DELETE FROM app_permissions[^;]*playbooks:run/);
  });

  it('records Playbook access as the platform-admin module gate', () => {
    const governance = fs.readFileSync(governancePath, 'utf8');
    const gate = 'platform admin, and Playbooks is enabled for the project';

    expect(governance).toContain(`| \`playbooks:view\` | playbooks | ${gate} |`);
    expect(governance).toContain(`| \`playbooks:run\` | playbooks | ${gate} |`);
    expect(governance).toContain(`| \`playbooks:author\` | playbooks | ${gate} |`);
    expect(governance).toContain(`| \`playbooks:admin\` | playbooks | ${gate} |`);
    expect(governance).toContain(`| \`playbooks:triggers:manage\` | playbooks | ${gate} |`);
  });
});

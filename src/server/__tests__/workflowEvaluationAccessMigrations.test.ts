import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const permissionsMigrationPath = path.join(
  repoRoot,
  'migrations',
  '20261016161000_add-workflow-evaluation-permissions.sql',
);
const flagMigrationPath = path.join(
  repoRoot,
  'migrations',
  '20261016161100_seed-workflow-human-evaluation-flag.sql',
);
const governancePath = path.join(repoRoot, '.cursor', 'rules', 'rbac-governance.mdc');

describe('TBI-004 DoD-0/DoD-2 — workflow-evaluation permission migration', () => {
  const migration = fs.readFileSync(permissionsMigrationPath, 'utf8');
  const down = migration.split('-- Down Migration')[1];

  it('VT-01 inserts both keys with category workflow-evaluation and grants only admin and member', () => {
    expect(migration).toContain("'workflow-evaluation:view'");
    expect(migration).toContain("'workflow-evaluation:submit'");
    expect(migration).toContain("'workflow-evaluation'");
    expect(migration).toContain('ON CONFLICT (key) DO NOTHING');
    expect(migration).toMatch(/r\.name IN \('admin', 'member'\)/);
    expect(migration).not.toContain("'viewer'");
    expect(migration).toContain(
      'View workflow evaluation definitions, event history and job diagnostics',
    );
    expect(migration).toContain(
      'Submit human workflow evaluations on Interview phases and PRDs',
    );
  });

  it('VT-02 down block deletes links then only the two workflow-evaluation keys', () => {
    expect(down).toContain('DELETE FROM app_role_permissions');
    expect(down).toContain("'workflow-evaluation:view'");
    expect(down).toContain("'workflow-evaluation:submit'");
    expect(down.indexOf('DELETE FROM app_role_permissions')).toBeLessThan(
      down.indexOf('DELETE FROM app_permissions'),
    );
    expect(down).not.toContain('playbooks:');
    expect(down).not.toContain('work-board:');
    expect(down).not.toContain("'viewer'");
  });
});

describe('TBI-004 DoD-0 — permission catalog', () => {
  it('VT-03 lists both keys for admin and member', () => {
    const governance = fs.readFileSync(governancePath, 'utf8');

    expect(governance).toContain(
      '| `workflow-evaluation:view` | workflow-evaluation | admin, member |',
    );
    expect(governance).toContain(
      '| `workflow-evaluation:submit` | workflow-evaluation | admin, member |',
    );
  });
});

describe('TBI-005 DoD-0 — workflow-human-evaluation flag seed', () => {
  const migration = fs.readFileSync(flagMigrationPath, 'utf8');
  const down = migration.split('-- Down Migration')[1];

  it('VT-14 seeds an enabled active flag with one Apex project rule', () => {
    expect(migration).toContain("'workflow-human-evaluation'");
    expect(migration).toMatch(/true,\s*'active',\s*false,/);
    expect(migration).toContain('ON CONFLICT (key) DO NOTHING');
    expect(migration).toContain("'project', 'Apex'");
    expect(migration).toContain('NOT EXISTS');
    expect(migration).toContain("r.type = 'project' AND r.value = 'Apex'");
  });

  it('VT-14 down block removes the Apex rule and the flag only', () => {
    expect(down).toContain('DELETE FROM feature_flag_rules');
    expect(down).toContain('DELETE FROM feature_flags WHERE key = \'workflow-human-evaluation\'');
    expect(down).toContain("value = 'Apex'");
    expect(down).not.toContain('work-board');
  });
});

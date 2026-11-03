/**
 * VT-TEMPLATE-3 / VT-TEMPLATE-6 — template metadata columns and the
 * playbook-interview-step rollout flag.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import { playbookDefinitions } from '../db/schema';

const migrationPath = path.resolve(
  process.cwd(),
  'migrations/20261007143000_playbook-interview-template.sql',
);

describe('VT-TEMPLATE-3 / VT-TEMPLATE-6 — interview template migration', () => {
  const migration = fs.existsSync(migrationPath)
    ? fs.readFileSync(migrationPath, 'utf8')
    : '';
  const [upSql = '', downSql = ''] = migration.split(/-- Down Migration/i);

  it('VT-TEMPLATE-3 adds nullable template_key and template_version', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    expect(upSql).toMatch(
      /ALTER\s+TABLE\s+playbook_definitions[\s\S]*ADD\s+COLUMN[\s\S]*template_key\s+TEXT/i,
    );
    expect(upSql).toMatch(/template_version\s+INTEGER/i);
    expect(upSql).not.toMatch(/template_key\s+TEXT\s+NOT\s+NULL/i);
    expect(upSql).not.toMatch(/template_version\s+INTEGER\s+NOT\s+NULL/i);

    const columns = getTableColumns(playbookDefinitions);
    expect(columns.templateKey?.name).toBe('template_key');
    expect(columns.templateKey?.notNull).toBe(false);
    expect(columns.templateVersion?.name).toBe('template_version');
    expect(columns.templateVersion?.notNull).toBe(false);
  });

  it('VT-TEMPLATE-6 seeds playbook-interview-step disabled and active with a cleanup criterion', () => {
    expect(upSql).toMatch(/INSERT\s+INTO\s+feature_flags/i);
    expect(upSql).toMatch(/'playbook-interview-step'/);
    expect(upSql).toMatch(/false,\s*'active'/i);
    expect(upSql).toMatch(/cleanup criterion/i);
    expect(upSql).toMatch(/ON\s+CONFLICT\s*\(\s*key\s*\)\s+DO\s+NOTHING/i);
  });

  it('VT-TEMPLATE-6 down removes rules before the flag', () => {
    const rulesAt = downSql.search(/DELETE\s+FROM\s+feature_flag_rules/i);
    const flagAt = downSql.search(
      /DELETE\s+FROM\s+feature_flags[\s\S]*'playbook-interview-step'/i,
    );
    expect(rulesAt).toBeGreaterThanOrEqual(0);
    expect(flagAt).toBeGreaterThan(rulesAt);
    expect(downSql).toMatch(/playbook-interview-step/);
  });
});

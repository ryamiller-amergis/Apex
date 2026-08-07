import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  process.cwd(),
  'migrations/20260806180000_seed-ai-runs-background-flag.sql',
);
const migration = fs.existsSync(migrationPath)
  ? fs.readFileSync(migrationPath, 'utf8')
  : '';
const [upSql = '', downSql = ''] = migration.split(/-- Down Migration/i);

describe('TBI-007 ai-runs-background rollout seed', () => {
  it('DoD-0: seeds the DB-backed flag active, cleanup-pending, and default-off only when absent', () => {
    expect(upSql).toMatch(/INSERT\s+INTO\s+feature_flags/i);
    expect(upSql).toMatch(/'ai-runs-background'/);
    expect(upSql).toMatch(/false,\s*'active',\s*false,\s*NULL/i);
    expect(upSql).toMatch(/ON\s+CONFLICT\s*\(\s*key\s*\)\s+DO\s+NOTHING/i);
  });

  it('DoD-1 / VT-07: leaves rollout targeting empty for Platform Admin project plus caller rules', () => {
    expect(upSql).not.toMatch(/INSERT\s+INTO\s+feature_flag_rules/i);
    expect(upSql).toMatch(/project\s*\+\s*caller/i);
    expect(upSql).toMatch(/prd,\s*design-doc,\s*validation,\s*test-cases/i);
    expect(upSql).toMatch(/dimensions are ANDed/i);
  });

  it('DoD-0: removes targeting before the flag on rollback without naming a project', () => {
    expect(downSql).toMatch(
      /DELETE\s+FROM\s+feature_flag_rules[\s\S]*WHERE\s+key\s*=\s*'ai-runs-background'/i,
    );
    expect(downSql).toMatch(
      /DELETE\s+FROM\s+feature_flags\s+WHERE\s+key\s*=\s*'ai-runs-background'/i,
    );
    expect(upSql).not.toMatch(/VALUES\s*\([^)]*'project'/i);
  });
});

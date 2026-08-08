import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  process.cwd(),
  'migrations/20260807100000_seed-ai-runs-interactive-flag.sql',
);
const migration = fs.existsSync(migrationPath)
  ? fs.readFileSync(migrationPath, 'utf8')
  : '';
const [upSql = '', downSql = ''] = migration.split(/-- Down Migration/i);

describe('FEAT-007 ai-runs-interactive rollout seed', () => {
  it('seeds the DB-backed flag active and enabled when absent', () => {
    expect(upSql).toMatch(/INSERT\s+INTO\s+feature_flags/i);
    expect(upSql).toMatch(/'ai-runs-interactive'/);
    expect(upSql).toMatch(/true,\s*'active',\s*false,\s*NULL/i);
    expect(upSql).toMatch(/ON\s+CONFLICT\s*\(\s*key\s*\)\s+DO\s+NOTHING/i);
  });

  it('adds an Apex project targeting rule', () => {
    expect(upSql).toMatch(/INSERT\s+INTO\s+feature_flag_rules/i);
    expect(upSql).toMatch(/'project',\s*'Apex'/);
    expect(upSql).toMatch(/NOT\s+EXISTS/i);
  });

  it('removes the Apex rule before the flag on rollback', () => {
    expect(downSql).toMatch(
      /DELETE\s+FROM\s+feature_flag_rules[\s\S]*'ai-runs-interactive'[\s\S]*'project'[\s\S]*'Apex'/i,
    );
    expect(downSql).toMatch(
      /DELETE\s+FROM\s+feature_flags\s+WHERE\s+key\s*=\s*'ai-runs-interactive'/i,
    );
  });
});

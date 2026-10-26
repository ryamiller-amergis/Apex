import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  process.cwd(),
  'migrations/20261019160000_playbook-runtime-foundation-flags.sql'
);

describe('Playbook runtime foundation rollout migration', () => {
  const migration = fs.existsSync(migrationPath)
    ? fs.readFileSync(migrationPath, 'utf8')
    : '';
  const [upSql = '', downSql = ''] = migration.split(/-- Down Migration/i);

  it('seeds both Part 1 flags disabled with cleanup criteria', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    expect(upSql).toMatch(/'playbooks-capability-enforcement'/);
    expect(upSql).toMatch(/'playbooks-step-output-artifacts'/);
    expect(upSql.match(/false,\s*'active',\s*false/gi)).toHaveLength(2);
    expect(upSql.match(/cleanup criterion/gi)).toHaveLength(2);
    expect(upSql).toMatch(/ON\s+CONFLICT\s*\(\s*key\s*\)\s+DO\s+NOTHING/i);
  });

  it('archives the four rollout flags without deleting their rows', () => {
    const archivePath = path.resolve(
      process.cwd(),
      'migrations/20261023101500_archive-playbook-rollout-flags.sql',
    );
    const archive = fs.readFileSync(archivePath, 'utf8');
    const [archiveUp = '', archiveDown = ''] = archive.split(/-- Down Migration/i);
    for (const key of [
      'playbooks-production-adapters',
      'playbooks-authoring-canvas',
      'playbooks-capability-enforcement',
      'playbooks-step-output-artifacts',
    ]) {
      expect(archiveUp).toContain(`'${key}'`);
      expect(archiveDown).toContain(`'${key}'`);
    }
    expect(archiveUp).toMatch(/lifecycle = 'archived'/);
    expect(archiveUp).not.toMatch(/DELETE\s+FROM\s+feature_flags/i);
    expect(archiveDown).toMatch(/lifecycle = 'active'/);
  });

  it('removes targeting rules before flags on rollback', () => {
    const rulesAt = downSql.search(/DELETE\s+FROM\s+feature_flag_rules/i);
    const flagsAt = downSql.search(/DELETE\s+FROM\s+feature_flags/i);
    expect(rulesAt).toBeGreaterThanOrEqual(0);
    expect(flagsAt).toBeGreaterThan(rulesAt);
  });
});

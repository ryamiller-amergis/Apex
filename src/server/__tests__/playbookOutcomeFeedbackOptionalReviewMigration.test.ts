import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  process.cwd(),
  'migrations/20261020190000_playbook-outcome-feedback-optional-review.sql'
);

describe('optional outcome review migration', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');
  const [upSql = '', downSql = ''] = migration.split(/-- Down Migration/i);

  it('lets a learning record exist without a review step', () => {
    expect(migration).toMatch(/^-- Up Migration/m);
    expect(upSql).toMatch(/ALTER COLUMN review_step_run_id DROP NOT NULL/i);
    expect(upSql).toMatch(/'needs_changes', 'recorded'/);
    expect(downSql).toMatch(/ALTER COLUMN review_step_run_id SET NOT NULL/i);
  });
});

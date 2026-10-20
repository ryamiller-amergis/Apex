import fs from 'node:fs';
import path from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import { playbookOutcomeFeedback } from '../db/schema';

const migrationPath = path.resolve(
  process.cwd(),
  'migrations/20261020170000_playbook-outcome-feedback.sql'
);

describe('playbook outcome feedback migration', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');
  const [upSql = '', downSql = ''] = migration.split(/-- Down Migration/i);

  it('marks the up section so node-pg-migrate does not run the drop on apply', () => {
    expect(migration).toMatch(/^-- Up Migration/m);
    expect(migration.indexOf('-- Up Migration')).toBeLessThan(
      migration.indexOf('-- Down Migration')
    );
  });

  it('stores one outcome record per capture step and drops it on rollback', () => {
    expect(upSql).toMatch(/CREATE TABLE playbook_outcome_feedback/i);
    expect(upSql).toMatch(/capture_step_run_id\s+UUID\s+NOT NULL UNIQUE/i);
    expect(upSql).toMatch(/CHECK \(decision IN \('approved', 'rejected'\)\)/i);
    expect(upSql).toMatch(/jsonb_typeof\(answers\) = 'array'/i);
    expect(upSql).toMatch(/jsonb_typeof\(sources\) = 'array'/i);
    expect(downSql).toMatch(/DROP TABLE IF EXISTS playbook_outcome_feedback/i);
  });

  it('mirrors the outcome columns in Drizzle', () => {
    const columns = getTableColumns(playbookOutcomeFeedback);
    expect(columns.captureStepRunId.name).toBe('capture_step_run_id');
    expect(columns.reviewStepRunId.name).toBe('review_step_run_id');
    expect(columns.definitionVersionId.name).toBe('definition_version_id');
    expect(columns.overallComment.name).toBe('overall_comment');
    expect(columns.sources.name).toBe('sources');
  });
});

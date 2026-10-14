import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  process.cwd(),
  'migrations/20260928140000_cloud-agent-run-history.sql',
);

describe('Cloud Agent run history migration', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');
  const [upSql = '', downSql = ''] = migration.split(/-- Down Migration/i);

  it('adds durable job, branch, and pull-request fields to agent_runs', () => {
    for (const column of [
      'cloud_job_name',
      'cloud_job_execution_name',
      'cloud_branch_name',
      'cloud_pr_url',
      'cloud_pr_status',
    ]) {
      expect(upSql).toMatch(new RegExp(`ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+${column}`, 'i'));
    }
    expect(upSql).toMatch(/agent_runs_cloud_pr_status_check/i);
    expect(upSql).toMatch(/'none',\s*'open',\s*'abandoned',\s*'merged'/i);
  });

  it('backfills the current run from existing session metadata', () => {
    expect(upSql).toMatch(/UPDATE\s+agent_runs\s+AS\s+run/i);
    expect(upSql).toMatch(/cloud_job_execution_name[\s\S]*dispatch_message_id/i);
    expect(upSql).toMatch(/session\.current_run_id\s*=\s*run\.id/i);
  });

  it('widens the session status constraint and rolls all changes back', () => {
    expect(upSql).toMatch(/dev_sessions_current_run_pr_status_check/i);
    expect(downSql).toMatch(/current_run_pr_status\s*=\s*'open'[\s\S]*'abandoned'/i);
    expect(downSql).toMatch(/DROP\s+COLUMN\s+IF\s+EXISTS\s+cloud_pr_status/i);
    expect(downSql).toMatch(/DROP\s+COLUMN\s+IF\s+EXISTS\s+cloud_job_name/i);
  });
});

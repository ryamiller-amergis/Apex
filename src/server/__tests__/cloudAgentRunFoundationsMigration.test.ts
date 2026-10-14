import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  process.cwd(),
  'migrations/20260901160000_cloud-agent-run-foundations.sql',
);

describe('FEAT-001 Cloud Agent run foundations migration', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');
  const [upSql = '', downSql = ''] = migration.split(/-- Down Migration/i);

  it('VT-08: adds write-once identity trigger and one-live-run unique index', () => {
    expect(upSql).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+agent_runs_cloud_agent_identity_immutable/i);
    expect(upSql).toMatch(/CREATE\s+TRIGGER\s+agent_runs_cloud_agent_identity_immutable/i);
    expect(upSql).toMatch(/cloud_agent_identity is write-once/);
    expect(upSql).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+uq_agent_runs_one_live_per_session[\s\S]*dev_session_id[\s\S]*workflow_class\s*=\s*'implementation'[\s\S]*queued[\s\S]*dev_session_id\s+IS\s+NOT\s+NULL/i,
    );
  });

  it('adds Cloud Agent columns additively without backfilling agent_runs', () => {
    for (const column of [
      'dev_session_id',
      'workflow_class',
      'cloud_agent_identity',
      'cloud_agent_managed',
    ]) {
      expect(upSql).toMatch(new RegExp(`ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+${column}`, 'i'));
    }
    expect(upSql).not.toMatch(/UPDATE\s+agent_runs/i);
    expect(upSql).toMatch(/lane\s+IN\s*\(\s*'background',\s*'ai-runs-interactive',\s*'cloud-agent'\s*\)/i);
    expect(upSql).toMatch(/'cloud_agent_timeout'/);
  });

  it('seeds my-work-cloud-agent disabled and active', () => {
    expect(upSql).toMatch(/'my-work-cloud-agent'/);
    expect(upSql).toMatch(/false,\s*'active',\s*false,\s*NULL/i);
    expect(upSql).toMatch(/ON\s+CONFLICT\s*\(\s*key\s*\)\s+DO\s+NOTHING/i);
  });

  it('rolls back additive columns, trigger, index, and flag', () => {
    expect(downSql).toMatch(/DROP\s+TRIGGER\s+IF\s+EXISTS\s+agent_runs_cloud_agent_identity_immutable/i);
    expect(downSql).toMatch(/DROP\s+INDEX\s+IF\s+EXISTS\s+uq_agent_runs_one_live_per_session/i);
    expect(downSql).toMatch(/DROP\s+COLUMN\s+IF\s+EXISTS\s+cloud_agent_identity/i);
    expect(downSql).toMatch(/DELETE\s+FROM\s+feature_flags\s+WHERE\s+key\s*=\s*'my-work-cloud-agent'/i);
  });
});

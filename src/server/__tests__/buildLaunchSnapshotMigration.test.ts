import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  process.cwd(),
  'migrations/20261029170000_c9a1_build-launch-snapshot.sql',
);

describe('FEAT-009 build launch snapshot migration', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');
  const [upSql = '', downSql = ''] = migration.split(/-- Down Migration/i);

  it('VT-12 / DoD-2: adds the nullable snapshot column without backfilling', () => {
    expect(upSql).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+build_launch_snapshot\s+JSONB\s*;/i);
    expect(upSql).not.toMatch(/NOT\s+NULL\s+DEFAULT/i);
    expect(upSql).not.toMatch(/UPDATE\s+agent_runs/i);
  });

  it('VT-12 / DoD-2: makes the snapshot write-once with a trigger', () => {
    expect(upSql).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+agent_runs_build_launch_snapshot_immutable/i);
    expect(upSql).toMatch(
      /OLD\.build_launch_snapshot\s+IS\s+NOT\s+NULL[\s\S]*NEW\.build_launch_snapshot\s+IS\s+DISTINCT\s+FROM\s+OLD\.build_launch_snapshot/i,
    );
    expect(upSql).toMatch(/build_launch_snapshot is write-once/);
    expect(upSql).toMatch(/CREATE\s+TRIGGER\s+agent_runs_build_launch_snapshot_immutable\s+BEFORE\s+UPDATE\s+ON\s+agent_runs/i);
  });

  it('VT-12: ties a snapshot to a build task', () => {
    expect(upSql).toMatch(
      /ADD\s+CONSTRAINT\s+agent_runs_build_launch_snapshot_task_check\s+CHECK\s*\(\s*build_launch_snapshot\s+IS\s+NULL\s+OR\s+build_task_id\s+IS\s+NOT\s+NULL\s*\)/i,
    );
  });

  it('VT-12: Down drops the trigger, function, check and column', () => {
    expect(downSql).toMatch(/DROP\s+TRIGGER\s+IF\s+EXISTS\s+agent_runs_build_launch_snapshot_immutable/i);
    expect(downSql).toMatch(/DROP\s+FUNCTION\s+IF\s+EXISTS\s+agent_runs_build_launch_snapshot_immutable/i);
    expect(downSql).toMatch(/DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+agent_runs_build_launch_snapshot_task_check/i);
    expect(downSql).toMatch(/DROP\s+COLUMN\s+IF\s+EXISTS\s+build_launch_snapshot/i);
  });
});

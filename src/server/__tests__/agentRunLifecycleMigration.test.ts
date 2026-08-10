import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  process.cwd(),
  'migrations/20260805200000_extend-agent-runs-lifecycle.sql',
);

describe('FEAT-001 / TBI-001 agent_runs lifecycle migration', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');
  const [upSql = '', downSql = ''] = migration.split(/-- Down Migration/i);

  it('DoD-0 / VT-07 adds every lifecycle field additively without a legacy backfill', () => {
    for (const column of [
      'project_id',
      'lane',
      'queued_at',
      'dispatched_at',
      'dispatch_message_id',
      'execution_snapshot',
      'cancel_requested',
      'cancel_state',
      'terminal_reason',
    ]) {
      expect(upSql).toMatch(new RegExp(`ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+${column}`, 'i'));
    }

    expect(upSql).not.toMatch(/UPDATE\s+agent_runs/i);
    expect(upSql).toMatch(/cancel_requested\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+FALSE/i);
  });

  it('DoD-0 enforces the confirmed lane and terminal-reason contracts', () => {
    expect(upSql).toMatch(
      /CHECK\s*\(\s*lane\s+IS\s+NULL\s+OR\s+lane\s*=\s*'background'\s*\)/i,
    );
    expect(upSql).toMatch(
      /CHECK\s*\(\s*terminal_reason\s+IS\s+NULL\s+OR\s+terminal_reason\s+IN\s*\(\s*'worker_lost'\s*,\s*'progress_timeout'\s*,\s*'queue_ttl'\s*,\s*'forced_cancel'\s*\)\s*\)/i,
    );
  });

  it('PBI-001 performance NFR indexes bounded lifecycle reads on the background lane', () => {
    expect(upSql).toMatch(/idx_agent_runs_status_lane/i);
    expect(upSql).toMatch(/idx_agent_runs_project_status/i);
    expect(upSql).toMatch(/idx_agent_runs_queued_at_worker[\s\S]*WHERE\s+lane\s*=\s*'background'/i);
    expect(upSql).toMatch(/idx_agent_runs_dispatched_at_worker[\s\S]*WHERE\s+lane\s*=\s*'background'/i);
    expect(upSql).toMatch(/idx_agent_runs_heartbeat_at_worker[\s\S]*WHERE\s+lane\s*=\s*'background'/i);
  });

  it('DoD-0 supplies a reversible down migration for additive fields and indexes', () => {
    expect(downSql).toMatch(/DROP\s+INDEX\s+IF\s+EXISTS\s+idx_agent_runs_status_lane/i);
    expect(downSql).toMatch(/ALTER\s+TABLE\s+agent_runs[\s\S]*DROP\s+COLUMN\s+IF\s+EXISTS\s+project_id/i);
  });
});

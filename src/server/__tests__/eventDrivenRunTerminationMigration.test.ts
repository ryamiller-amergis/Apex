import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  process.cwd(),
  'migrations/20260804110000_event-driven-run-termination.sql',
);

describe('TBI-001 DoD-3 / VT-09 timeout_at migration', () => {
  it('backfills only non-terminal rows using started_at or migration time plus two hours', () => {
    const [upSql = ''] = fs.readFileSync(migrationPath, 'utf8').split(/-- Down Migration/i);

    expect(upSql).toMatch(/UPDATE\s+agent_runs/i);
    expect(upSql).toMatch(/status\s+IN\s*\(\s*'queued'\s*,\s*'running'\s*\)/i);
    expect(upSql).toMatch(/COALESCE\s*\(\s*started_at\s*,\s*CURRENT_TIMESTAMP\s*\)/i);
    expect(upSql).toMatch(/INTERVAL\s+'2 hours'/i);
    expect(upSql).not.toMatch(/status\s+IN\s*\([^)]*completed/i);
  });

  it('enforces timeout_at for future non-terminal rows without changing terminal rows', () => {
    const [upSql = ''] = fs.readFileSync(migrationPath, 'utf8').split(/-- Down Migration/i);

    expect(upSql).toMatch(/CHECK\s*\(\s*status\s+NOT\s+IN\s*\(\s*'queued'\s*,\s*'running'\s*\)\s+OR\s+timeout_at\s+IS\s+NOT\s+NULL\s*\)/i);
    expect(upSql).toMatch(/event-driven-run-termination/);
    expect(upSql).toMatch(/enabled[\s\S]*false/i);
  });
});

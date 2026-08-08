import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  process.cwd(),
  'migrations/20260804130000_agent-runs-event-driven-marker.sql',
);

describe('agent_runs event_driven marker migration', () => {
  it('adds a non-null event_driven column defaulting to false', () => {
    const [upSql = ''] = fs.readFileSync(migrationPath, 'utf8').split(/-- Down Migration/i);

    expect(upSql).toMatch(/ALTER\s+TABLE\s+agent_runs/i);
    expect(upSql).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+event_driven/i);
    expect(upSql).toMatch(/BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+FALSE/i);
  });

  it('keeps the destructive drop commented out in the down section', () => {
    const [, downSql = ''] = fs.readFileSync(migrationPath, 'utf8').split(/-- Down Migration/i);

    expect(downSql).toMatch(/--\s*ALTER\s+TABLE\s+agent_runs\s+DROP\s+COLUMN/i);
  });
});

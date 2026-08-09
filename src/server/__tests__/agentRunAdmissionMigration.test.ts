import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  process.cwd(),
  'migrations/20260806004700_add-agent-run-admission-indexes.sql',
);
const schemaPath = path.resolve(process.cwd(), 'src/server/db/schema.ts');

const migration = fs.existsSync(migrationPath)
  ? fs.readFileSync(migrationPath, 'utf8')
  : '';
const [upSql = '', downSql = ''] = migration.split(/-- Down Migration/i);
const schema = fs.readFileSync(schemaPath, 'utf8');

describe('FEAT-002 / TBI-002 S1 agent_runs admission-support indexes', () => {
  it('S1 / DoD-2 / VT-02 enables bounded admission with the partial background in-flight index', () => {
    expect(upSql).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_agent_runs_background_in_flight\s+ON\s+agent_runs\s*\(\s*lane\s*,\s*status\s*\)\s+WHERE\s+lane\s*=\s*'background'\s+AND\s+status\s+IN\s*\(\s*'dispatched'\s*,\s*'running'\s*\)/i,
    );
  });

  it('S1 / DoD-3 / VT-01 / VT-03 enables fair selection with the partial background queue index', () => {
    expect(upSql).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_agent_runs_background_fair_queue\s+ON\s+agent_runs\s*\(\s*project_id\s*,\s*queued_at\s*,\s*id\s*\)\s+WHERE\s+lane\s*=\s*'background'\s+AND\s+status\s*=\s*'queued'/i,
    );
  });

  it('S1 / DoD-2 / DoD-3 / VT-01 / VT-02 / VT-03 drops both admission indexes on Down', () => {
    expect(downSql).toMatch(
      /DROP\s+INDEX\s+IF\s+EXISTS\s+idx_agent_runs_background_fair_queue/i,
    );
    expect(downSql).toMatch(
      /DROP\s+INDEX\s+IF\s+EXISTS\s+idx_agent_runs_background_in_flight/i,
    );
  });

  it('S1 / DoD-2 / DoD-3 / VT-01 / VT-02 / VT-03 registers matching index shapes in agentRuns', () => {
    expect(schema).toMatch(
      /index\(\s*'idx_agent_runs_background_in_flight'\s*\)\s*\.on\(\s*t\.lane\s*,\s*t\.status\s*\)\s*\.where\(\s*sql`\$\{t\.lane\}\s*=\s*'background'\s+AND\s+\$\{t\.status\}\s+IN\s*\(\s*'dispatched'\s*,\s*'running'\s*\)`\s*\)/i,
    );
    expect(schema).toMatch(
      /index\(\s*'idx_agent_runs_background_fair_queue'\s*\)\s*\.on\(\s*t\.projectId\s*,\s*t\.queuedAt\s*,\s*t\.id\s*\)\s*\.where\(\s*sql`\$\{t\.lane\}\s*=\s*'background'\s+AND\s+\$\{t\.status\}\s*=\s*'queued'`\s*\)/i,
    );
  });
});

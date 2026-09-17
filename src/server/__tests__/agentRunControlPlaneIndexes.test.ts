import fs from 'node:fs';
import path from 'node:path';

const schema = fs.readFileSync(
  path.resolve(process.cwd(), 'src/server/db/schema.ts'),
  'utf8',
);
const migration = fs.readFileSync(
  path.resolve(
    process.cwd(),
    'migrations/20260917170000_agent-run-control-plane-indexes.sql',
  ),
  'utf8',
);

describe('agent-run control-plane indexes', () => {
  it('indexes latest and active agent runs by thread', () => {
    expect(schema).toMatch(
      /index\('idx_agent_runs_thread_created'\)\s*\.on\(t\.threadId,\s*t\.createdAt\)/,
    );
    expect(schema).toMatch(
      /index\('idx_agent_runs_thread_active'\)[\s\S]*?\.on\(t\.threadId,\s*t\.createdAt\)[\s\S]*?status[\s\S]*?queued[\s\S]*?dispatched[\s\S]*?running/,
    );
    expect(migration).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_agent_runs_thread_created\s+ON agent_runs \(thread_id, created_at\);/,
    );
    expect(migration).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_agent_runs_thread_active\s+ON agent_runs \(thread_id, created_at\)\s+WHERE status IN \('queued', 'dispatched', 'running'\);/,
    );
  });

  it('indexes only transient design documents for recovery sweeps', () => {
    expect(schema).toMatch(
      /index\('idx_design_docs_transient_updated'\)[\s\S]*?\.on\(t\.status,\s*t\.updatedAt,\s*t\.id\)[\s\S]*?generating[\s\S]*?validating/,
    );
    expect(migration).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_design_docs_transient_updated\s+ON design_docs \(status, updated_at, id\)\s+WHERE status IN \('generating', 'validating'\);/,
    );
  });

  it('drops the indexes in reverse dependency order', () => {
    expect(migration).toMatch(
      /DROP INDEX IF EXISTS idx_design_docs_transient_updated;[\s\S]*?DROP INDEX IF EXISTS idx_agent_runs_thread_active;[\s\S]*?DROP INDEX IF EXISTS idx_agent_runs_thread_created;/,
    );
  });
});

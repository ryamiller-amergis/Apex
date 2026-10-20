import fs from 'node:fs';
import path from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import {
  playbookDeliberationSessions,
  playbookDeliberationTurns,
} from '../db/schema';

const migrationPath = path.resolve(
  process.cwd(),
  'migrations/20261018203000_playbook-board-deliberation.sql'
);

describe('playbook board deliberation migration', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');
  const [upSql = '', downSql = ''] = migration.split(/-- Down Migration/i);

  it('marks the up section so node-pg-migrate does not run the drops on apply', () => {
    expect(migration).toMatch(/^-- Up Migration/m);
    expect(migration.indexOf('-- Up Migration')).toBeLessThan(
      migration.indexOf('-- Down Migration')
    );
  });

  it('creates durable sessions and turns with idempotency constraints', () => {
    expect(upSql).toMatch(/CREATE TABLE playbook_deliberation_sessions/i);
    expect(upSql).toMatch(/CREATE TABLE playbook_deliberation_turns/i);
    expect(upSql).toMatch(/UNIQUE \(session_id, sequence\)/i);
    expect(upSql).toMatch(
      /UNIQUE INDEX uq_playbook_deliberation_turn_agent_run/i
    );
    expect(downSql).toMatch(
      /DROP TABLE IF EXISTS playbook_deliberation_sessions/i
    );
  });

  it('mirrors the tables in Drizzle', () => {
    expect(getTableColumns(playbookDeliberationSessions).stepRunId.name).toBe(
      'step_run_id'
    );
    expect(getTableColumns(playbookDeliberationTurns).agentRunId.name).toBe(
      'agent_run_id'
    );
  });
});

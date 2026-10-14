import fs from 'node:fs';
import path from 'node:path';

const schema = fs.readFileSync(
  path.resolve(process.cwd(), 'src/server/db/schema.ts'),
  'utf8'
);
const controlPlaneMigration = fs.readFileSync(
  path.resolve(
    process.cwd(),
    'migrations/20260917220000_ai-run-v2-control-plane.sql'
  ),
  'utf8'
);
const activeThreadMigration = fs.readFileSync(
  path.resolve(
    process.cwd(),
    'migrations/20260917221000_ai-run-v2-active-thread-index.js'
  ),
  'utf8'
);

describe('AI-run V2 persistence contracts', () => {
  it('adds transport_version to agent_runs with a closed CHECK and queued default', () => {
    expect(schema).toMatch(
      /transportVersion:\s*text\('transport_version'\)[\s\S]*?\.default\('http-files-v1'\)/
    );
    expect(schema).toMatch(
      /agent_runs_transport_version_check[\s\S]*?http-files-v1[\s\S]*?servicebus-blob-v2/
    );
    expect(controlPlaneMigration).toMatch(
      /ALTER COLUMN status SET DEFAULT 'queued'/
    );
    expect(controlPlaneMigration).toMatch(
      /ADD COLUMN IF NOT EXISTS transport_version TEXT NOT NULL DEFAULT 'http-files-v1'/
    );
    expect(controlPlaneMigration).toMatch(
      /agent_runs_transport_version_check[\s\S]*?http-files-v1[\s\S]*?servicebus-blob-v2/
    );
  });

  it('defines attempt, outbox, inbox, and seeded lease tables', () => {
    expect(schema).toMatch(/pgTable\('ai_run_attempts'/);
    expect(schema).toMatch(/pgTable\('ai_run_outbox'/);
    expect(schema).toMatch(/pgTable\('ai_run_inbox'/);
    expect(schema).toMatch(/pgTable\('ai_control_plane_leases'/);

    expect(controlPlaneMigration).toMatch(
      /CREATE TABLE IF NOT EXISTS ai_run_attempts/
    );
    expect(controlPlaneMigration).toMatch(
      /CREATE TABLE IF NOT EXISTS ai_run_outbox/
    );
    expect(controlPlaneMigration).toMatch(
      /CREATE TABLE IF NOT EXISTS ai_run_inbox/
    );
    expect(controlPlaneMigration).toMatch(
      /CREATE TABLE IF NOT EXISTS ai_control_plane_leases/
    );
    expect(controlPlaneMigration).toMatch(
      /INSERT INTO ai_control_plane_leases[\s\S]*'admission'[\s\S]*'recovery'[\s\S]*'reaper'[\s\S]*'outbox'[\s\S]*ON CONFLICT \(lease_key\) DO NOTHING/
    );
    expect(controlPlaneMigration).toMatch(
      /uq_ai_run_attempts_active_run[\s\S]*checking_worker[\s\S]*finalizing/
    );
    expect(controlPlaneMigration).toMatch(
      /uq_ai_run_inbox_attempt_checkpoint[\s\S]*checkpoint_sequence IS NOT NULL/
    );
  });

  it('builds the V2 active-thread unique index concurrently after a preflight', () => {
    expect(schema).toMatch(
      /uq_agent_runs_v2_active_thread[\s\S]*servicebus-blob-v2[\s\S]*queued[\s\S]*dispatched[\s\S]*running/
    );
    expect(activeThreadMigration).toMatch(/pgm\.noTransaction\(\)/);
    expect(activeThreadMigration).toMatch(
      /duplicate active V2 runs exist for one or more threads/
    );
    expect(activeThreadMigration).toMatch(
      /DROP INDEX CONCURRENTLY IF EXISTS uq_agent_runs_v2_active_thread/
    );
    expect(activeThreadMigration).toMatch(
      /CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_agent_runs_v2_active_thread/
    );
  });
});

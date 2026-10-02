exports.up = (pgm) => {
  pgm.noTransaction();

  pgm.sql(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_runs_thread_created
      ON agent_runs (thread_id, created_at);
  `);
  pgm.sql(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_runs_thread_active
      ON agent_runs (thread_id, created_at)
      WHERE status IN ('queued', 'dispatched', 'running');
  `);
  pgm.sql(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_design_docs_transient_updated
      ON design_docs (status, updated_at, id)
      WHERE status IN ('generating', 'validating');
  `);
};

exports.down = (pgm) => {
  pgm.noTransaction();

  pgm.sql(`
    DROP INDEX CONCURRENTLY IF EXISTS idx_design_docs_transient_updated;
  `);
  pgm.sql(`
    DROP INDEX CONCURRENTLY IF EXISTS idx_agent_runs_thread_active;
  `);
  pgm.sql(`
    DROP INDEX CONCURRENTLY IF EXISTS idx_agent_runs_thread_created;
  `);
};

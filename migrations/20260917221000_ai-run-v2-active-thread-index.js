exports.up = (pgm) => {
  pgm.noTransaction();

  // Abort if active V2 runs already collide on a thread — the unique index
  // would otherwise leave behind an INVALID index on a failed concurrent build.
  pgm.sql(`
    DO $preflight$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM agent_runs
        WHERE transport_version = 'servicebus-blob-v2'
          AND status IN ('queued', 'dispatched', 'running')
        GROUP BY thread_id
        HAVING COUNT(*) > 1
      ) THEN
        RAISE EXCEPTION
          'Cannot create uq_agent_runs_v2_active_thread: duplicate active V2 runs exist for one or more threads';
      END IF;
    END
    $preflight$;
  `);

  // A prior failed CONCURRENTLY attempt can leave an INVALID index that
  // IF NOT EXISTS would then skip recreating.
  pgm.sql(`
    DO $cleanup$
    DECLARE
      invalid_index regclass;
    BEGIN
      SELECT indexrelid::regclass
        INTO invalid_index
      FROM pg_index
      WHERE indexrelid = 'uq_agent_runs_v2_active_thread'::regclass
        AND NOT indisvalid;
      IF invalid_index IS NOT NULL THEN
        EXECUTE 'DROP INDEX CONCURRENTLY IF EXISTS uq_agent_runs_v2_active_thread';
      END IF;
    EXCEPTION
      WHEN undefined_table THEN
        NULL;
      WHEN undefined_object THEN
        NULL;
    END
    $cleanup$;
  `);

  pgm.sql(`
    CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_agent_runs_v2_active_thread
      ON agent_runs (thread_id)
      WHERE transport_version = 'servicebus-blob-v2'
        AND status IN ('queued', 'dispatched', 'running');
  `);
};

exports.down = (pgm) => {
  pgm.noTransaction();

  pgm.sql(`
    DROP INDEX CONCURRENTLY IF EXISTS uq_agent_runs_v2_active_thread;
  `);
};

-- Up Migration

-- Entity-scoped rollup lookups (interview / ADR / PRD / prototype / design doc).
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_entity
  ON ai_usage_events (entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_ai_usage_events_thread_id
  ON ai_usage_events (thread_id);

-- Down Migration
-- No-op. apply-named-migration.js runs the whole file in one statement, so a real
-- DROP here would undo the CREATEs above. To remove these indexes, author a new
-- forward migration dropping idx_ai_usage_events_thread_id and
-- idx_ai_usage_events_entity.

-- Up Migration
-- Legacy timestamp guard: this file sorts before the migration that creates the
-- walkthrough tables on a fresh database. The correctly ordered migration
-- 20260729195000_add-walkthrough-routing-provenance-after-walkthrough-tables.sql
-- performs these changes after table creation. Keep this migration idempotent
-- for databases that already recorded its original version.
ALTER TABLE IF EXISTS walkthroughs
  ADD COLUMN IF NOT EXISTS generation_provenance JSONB;

ALTER TABLE IF EXISTS walkthrough_steps
  ADD COLUMN IF NOT EXISTS image_alt TEXT;

-- target_route is now the first-class Step destination. Anchors still require
-- a destination, but unanchored Steps may also carry one.
ALTER TABLE IF EXISTS walkthrough_steps
  DROP CONSTRAINT IF EXISTS chk_walkthrough_steps_anchor_tuple;

ALTER TABLE IF EXISTS walkthrough_steps
  ADD CONSTRAINT chk_walkthrough_steps_anchor_tuple CHECK (
    (anchor_key IS NULL AND placement IS NULL)
    OR (anchor_key IS NOT NULL AND placement IS NOT NULL AND target_route IS NOT NULL)
  );

-- Down Migration
-- Old schemas cannot represent an unanchored destination.
DO $$
BEGIN
  IF to_regclass('walkthrough_steps') IS NOT NULL THEN
    UPDATE walkthrough_steps
    SET target_route = NULL
    WHERE anchor_key IS NULL AND placement IS NULL;
  END IF;
END
$$;

ALTER TABLE IF EXISTS walkthrough_steps
  DROP CONSTRAINT IF EXISTS chk_walkthrough_steps_anchor_tuple;

ALTER TABLE IF EXISTS walkthrough_steps
  ADD CONSTRAINT chk_walkthrough_steps_anchor_tuple CHECK (
    (anchor_key IS NULL AND target_route IS NULL AND placement IS NULL)
    OR (anchor_key IS NOT NULL AND target_route IS NOT NULL AND placement IS NOT NULL)
  );

ALTER TABLE IF EXISTS walkthrough_steps
  DROP COLUMN IF EXISTS image_alt;

ALTER TABLE IF EXISTS walkthroughs
  DROP COLUMN IF EXISTS generation_provenance;

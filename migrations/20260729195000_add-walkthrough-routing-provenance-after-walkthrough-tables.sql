-- Up Migration
-- Correctly ordered application of routing provenance fields. The original
-- Unix-timestamped migration sorts before the walkthrough table-creation
-- migration on fresh databases, so it is retained only as an idempotent legacy
-- guard for environments that may already have recorded it.
ALTER TABLE walkthroughs
  ADD COLUMN IF NOT EXISTS generation_provenance JSONB;

ALTER TABLE walkthrough_steps
  ADD COLUMN IF NOT EXISTS image_alt TEXT;

ALTER TABLE walkthrough_steps
  DROP CONSTRAINT IF EXISTS chk_walkthrough_steps_anchor_tuple;

ALTER TABLE walkthrough_steps
  ADD CONSTRAINT chk_walkthrough_steps_anchor_tuple CHECK (
    (anchor_key IS NULL AND placement IS NULL)
    OR (anchor_key IS NOT NULL AND placement IS NOT NULL AND target_route IS NOT NULL)
  );

-- Down Migration
UPDATE walkthrough_steps
SET target_route = NULL
WHERE anchor_key IS NULL AND placement IS NULL;

ALTER TABLE walkthrough_steps
  DROP CONSTRAINT IF EXISTS chk_walkthrough_steps_anchor_tuple;

ALTER TABLE walkthrough_steps
  ADD CONSTRAINT chk_walkthrough_steps_anchor_tuple CHECK (
    (anchor_key IS NULL AND target_route IS NULL AND placement IS NULL)
    OR (anchor_key IS NOT NULL AND target_route IS NOT NULL AND placement IS NOT NULL)
  );

ALTER TABLE walkthrough_steps
  DROP COLUMN IF EXISTS image_alt;

ALTER TABLE walkthroughs
  DROP COLUMN IF EXISTS generation_provenance;

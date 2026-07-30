-- Up Migration
ALTER TABLE walkthroughs
  ADD COLUMN generation_provenance JSONB;

ALTER TABLE walkthrough_steps
  ADD COLUMN image_alt TEXT;

-- target_route is now the first-class Step destination. Anchors still require
-- a destination, but unanchored Steps may also carry one.
ALTER TABLE walkthrough_steps
  DROP CONSTRAINT IF EXISTS chk_walkthrough_steps_anchor_tuple;

ALTER TABLE walkthrough_steps
  ADD CONSTRAINT chk_walkthrough_steps_anchor_tuple CHECK (
    (anchor_key IS NULL AND placement IS NULL)
    OR (anchor_key IS NOT NULL AND placement IS NOT NULL AND target_route IS NOT NULL)
  );

-- Down Migration
-- Old schemas cannot represent an unanchored destination.
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
  DROP COLUMN image_alt;

ALTER TABLE walkthroughs
  DROP COLUMN generation_provenance;
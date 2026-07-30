-- Up Migration
-- Prevent duplicate targeting rules (e.g. same project twice on one Walkthrough)

-- Collapse any existing duplicates before adding the unique constraint
DELETE FROM walkthrough_targeting_rules a
USING walkthrough_targeting_rules b
WHERE a.id > b.id
  AND a.walkthrough_id = b.walkthrough_id
  AND a.type = b.type
  AND a.value = b.value;

CREATE UNIQUE INDEX uq_walkthrough_targeting_rules_walkthrough_type_value
  ON walkthrough_targeting_rules (walkthrough_id, type, value);

-- Down Migration
DROP INDEX IF EXISTS uq_walkthrough_targeting_rules_walkthrough_type_value;

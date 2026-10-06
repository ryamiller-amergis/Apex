-- When a product build's pull request merges, record that moment for the home history.

-- Up Migration

ALTER TABLE product_builds
  ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ;

-- Down Migration

ALTER TABLE product_builds
  DROP COLUMN IF EXISTS merged_at;

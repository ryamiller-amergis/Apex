-- Up Migration
-- Intentionally empty. Main ships its own 1.40.0 sync, and this file runs out of
-- order on databases that are already past it, so writing a version here would
-- move current_changelog_version backwards.
SELECT 1;

-- Down Migration
SELECT 1;

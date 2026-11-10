-- A revision validated on the warm preview deploys only when the requester
-- accepts it. Record which revision the accept is waiting on so the
-- deployment callback can finish the accept.

-- Up Migration

ALTER TABLE build_runs
  ADD COLUMN accept_requested_revision_number INTEGER;

-- Down Migration

ALTER TABLE build_runs
  DROP COLUMN IF EXISTS accept_requested_revision_number;

-- Up Migration
-- FEAT-014: persist canonical Playbook run bindings across suspend/resume.
-- The design spec assumed playbook_runs already stored JSONB input; it did not.

ALTER TABLE playbook_runs
  ADD COLUMN run_input jsonb;

-- Down Migration

ALTER TABLE playbook_runs
  DROP COLUMN run_input;

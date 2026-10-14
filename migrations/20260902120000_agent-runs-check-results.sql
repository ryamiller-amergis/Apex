-- Pre-PR quality check results on Cloud Agent runs (My Work FEAT-003, TBI-005).
-- Additive nullable jsonb column holding suite-level unit/e2e/WCAG outcomes
-- reported when a run reaches a terminal state. Nullable so every existing
-- agent_runs row and query is unaffected, and so a run that reported nothing
-- is distinguishable from a run that reported an empty result set.

-- Up Migration

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS check_results JSONB;

COMMENT ON COLUMN agent_runs.check_results IS
  'Suite-level pre-PR check outcomes reported by the Cloud Agent at terminal write time: [{"kind":"unit|e2e|wcag","outcome":"passed|failed"}]. NULL means no results were reported. Never gates PR creation or run completion.';

-- Down Migration

ALTER TABLE agent_runs
  DROP COLUMN IF EXISTS check_results;

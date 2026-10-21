-- Leftover-work summary on My Work sessions (FEAT-005, TBI-007).
-- Additive nullable jsonb column holding failing checks, missing-PR, and
-- incomplete acceptance criteria after a Cloud Agent run reaches a terminal
-- state. No default: NULL means no summary (including a clean run). Existing
-- rows and queries stay unaffected.

-- Up Migration

ALTER TABLE dev_sessions
  ADD COLUMN IF NOT EXISTS leftover_work JSONB;

COMMENT ON COLUMN dev_sessions.leftover_work IS
  'Structured leftover-work after a terminal Cloud Agent run: {"failingChecks":string[],"missingPr":boolean,"incompleteAcceptanceCriteria":string[]}. NULL means no summary is shown. Does not spawn child work items.';

-- Down Migration

ALTER TABLE dev_sessions
  DROP COLUMN IF EXISTS leftover_work;

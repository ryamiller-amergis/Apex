-- Up Migration
-- Sampled artifact judge: ADRs, Brainstorm artifacts, build briefs and QA case sets get a
-- blind rubric score recorded as a 'judged' signal. The score lives in metadata; value stays NULL.

ALTER TABLE skill_signals DROP CONSTRAINT IF EXISTS skill_signals_kind_check;
ALTER TABLE skill_signals ADD CONSTRAINT skill_signals_kind_check CHECK (kind IN (
  'rating', 'accepted', 'rejected', 'regenerated', 'rolled_back',
  'handoff_completed', 'handoff_failed', 'gate_approved', 'gate_rejected',
  'run_failed', 'completed', 'abandoned', 'judged'
));

CREATE INDEX IF NOT EXISTS idx_skill_signals_judged_created
  ON skill_signals (project, created_at DESC) WHERE kind = 'judged';

-- Down Migration
DROP INDEX IF EXISTS idx_skill_signals_judged_created;
DELETE FROM skill_signals WHERE kind = 'judged';
ALTER TABLE skill_signals DROP CONSTRAINT IF EXISTS skill_signals_kind_check;
ALTER TABLE skill_signals ADD CONSTRAINT skill_signals_kind_check CHECK (kind IN (
  'rating', 'accepted', 'rejected', 'regenerated', 'rolled_back',
  'handoff_completed', 'handoff_failed', 'gate_approved', 'gate_rejected',
  'run_failed', 'completed', 'abandoned'
));

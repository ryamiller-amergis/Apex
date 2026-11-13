-- Up Migration
-- A drafted candidate is now written by a worker run, so an experiment waits in 'drafting'
-- with no candidate text until the run comes back.

ALTER TABLE skill_experiments ALTER COLUMN candidate_content DROP NOT NULL;
ALTER TABLE skill_experiments ALTER COLUMN candidate_sha256 DROP NOT NULL;
ALTER TABLE skill_experiments ADD COLUMN IF NOT EXISTS draft_run_id UUID;
ALTER TABLE skill_experiments ADD COLUMN IF NOT EXISTS error TEXT;

ALTER TABLE skill_experiments DROP CONSTRAINT IF EXISTS skill_experiments_status_check;
ALTER TABLE skill_experiments ADD CONSTRAINT skill_experiments_status_check CHECK (status IN (
  'drafting', 'running', 'completed', 'awaiting_approval', 'approved', 'rejected', 'promoted', 'failed', 'cancelled'
));

ALTER TABLE skill_experiments DROP CONSTRAINT IF EXISTS skill_experiments_sha_check;
ALTER TABLE skill_experiments ADD CONSTRAINT skill_experiments_sha_check CHECK (
  baseline_sha256 ~ '^[0-9a-f]{64}$'
  AND (candidate_sha256 IS NULL OR candidate_sha256 ~ '^[0-9a-f]{64}$')
);

ALTER TABLE skill_experiments ADD CONSTRAINT skill_experiments_candidate_check CHECK (
  status IN ('drafting', 'failed', 'cancelled')
  OR (candidate_content IS NOT NULL AND candidate_sha256 IS NOT NULL)
);

-- Down Migration
ALTER TABLE skill_experiments DROP CONSTRAINT IF EXISTS skill_experiments_candidate_check;
DELETE FROM skill_experiments WHERE candidate_content IS NULL OR candidate_sha256 IS NULL;
ALTER TABLE skill_experiments DROP CONSTRAINT IF EXISTS skill_experiments_sha_check;
ALTER TABLE skill_experiments ADD CONSTRAINT skill_experiments_sha_check CHECK (
  baseline_sha256 ~ '^[0-9a-f]{64}$' AND candidate_sha256 ~ '^[0-9a-f]{64}$'
);
ALTER TABLE skill_experiments DROP CONSTRAINT IF EXISTS skill_experiments_status_check;
ALTER TABLE skill_experiments ADD CONSTRAINT skill_experiments_status_check CHECK (status IN (
  'running', 'completed', 'awaiting_approval', 'approved', 'rejected', 'promoted', 'failed', 'cancelled'
));
ALTER TABLE skill_experiments DROP COLUMN IF EXISTS error;
ALTER TABLE skill_experiments DROP COLUMN IF EXISTS draft_run_id;
ALTER TABLE skill_experiments ALTER COLUMN candidate_sha256 SET NOT NULL;
ALTER TABLE skill_experiments ALTER COLUMN candidate_content SET NOT NULL;

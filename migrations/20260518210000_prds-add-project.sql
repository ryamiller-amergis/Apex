-- Add nullable first (to allow backfill)
ALTER TABLE prds ADD COLUMN project TEXT;

-- Backfill from interviews
UPDATE prds
SET project = i.project
FROM interviews i
WHERE prds.interview_id = i.id
  AND prds.project IS NULL;

-- For any orphan PRDs (interview_id IS NULL), set a fallback
UPDATE prds SET project = 'Unknown' WHERE project IS NULL;

-- Now make it NOT NULL
ALTER TABLE prds ALTER COLUMN project SET NOT NULL;

-- Index for dashboard filtering
CREATE INDEX idx_prds_project ON prds (project);

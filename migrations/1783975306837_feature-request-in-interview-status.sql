-- Up Migration

UPDATE feature_requests
SET status = 'in-interview',
    updated_at = NOW()
WHERE interview_id IS NOT NULL
  AND status IS DISTINCT FROM 'in-interview';

-- Down Migration

UPDATE feature_requests
SET status = 'under-review',
    updated_at = NOW()
WHERE interview_id IS NOT NULL
  AND status = 'in-interview';

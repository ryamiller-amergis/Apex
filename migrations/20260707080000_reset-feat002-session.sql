-- Reset FEAT-002 session: delete any closed sessions so the feature shows as Ready
-- and can be re-started fresh. The branch for this session was never pushed to
-- remote and the workspace was lost, so the session is unrecoverable.
DELETE FROM dev_sessions
WHERE prd_id = '07895a11-e62a-4144-89d4-fcf06bfa5e59'
  AND feature_id = 'FEAT-002';

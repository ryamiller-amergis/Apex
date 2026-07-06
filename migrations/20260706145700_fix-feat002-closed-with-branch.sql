-- Data fix: the session-to-feature matching bug caused a close action on FEAT-001
-- to target a session incorrectly associated with FEAT-002. The previous migration
-- (20260706140100) only removed sessions with NULL branch_name; this one catches
-- the case where the closed session had a branch_name set.
DELETE FROM dev_sessions
WHERE prd_id = '07895a11-e62a-4144-89d4-fcf06bfa5e59'
  AND feature_id = 'FEAT-002'
  AND status = 'closed';

-- Data fix: remove incorrectly-closed synthetic session for FEAT-002
-- caused by the session-to-feature matching bug (close on 001 closed 002).
-- Only removes synthetic "Mark Complete" sessions (no branch) — real dev sessions are preserved.
DELETE FROM dev_sessions
WHERE prd_id = '07895a11-e62a-4144-89d4-fcf06bfa5e59'
  AND feature_id = 'FEAT-002'
  AND status = 'closed'
  AND branch_name IS NULL;

-- Migrate synthetic "feature complete" sessions from 'closed' to 'completed'.
-- Synthetic sessions inserted by /features/complete have no chat_thread_id.
UPDATE dev_sessions
SET status = 'completed', updated_at = NOW()
WHERE status = 'closed'
  AND chat_thread_id IS NULL;

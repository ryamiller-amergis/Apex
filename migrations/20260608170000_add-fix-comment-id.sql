-- Add fix_comment_id to prds and design_docs so that single-comment AI fixes
-- (fix-comment-with-ai) can be scoped: apply-proposed will only resolve the
-- specific comment that triggered the fix instead of all open comments.
-- Bulk fixes (fix-with-ai) leave this column NULL so apply-proposed still
-- resolves every open comment as before.

ALTER TABLE prds
  ADD COLUMN IF NOT EXISTS fix_comment_id uuid;

ALTER TABLE design_docs
  ADD COLUMN IF NOT EXISTS fix_comment_id uuid;

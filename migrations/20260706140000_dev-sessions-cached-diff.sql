-- Add cached diff columns so the changes panel survives workspace loss (app restart / ephemeral FS)
ALTER TABLE dev_sessions
  ADD COLUMN cached_diff_text text,
  ADD COLUMN cached_changed_files jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN branch_pushed boolean NOT NULL DEFAULT false;

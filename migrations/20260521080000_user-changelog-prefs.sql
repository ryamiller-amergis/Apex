-- Add changelog preference columns to app_users.
-- last_seen_changelog_version: tracks the version the user last acknowledged.
-- show_changelog_on_login: opt-out flag; true by default so existing users keep current behaviour.
ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS last_seen_changelog_version TEXT,
  ADD COLUMN IF NOT EXISTS show_changelog_on_login BOOLEAN NOT NULL DEFAULT TRUE;

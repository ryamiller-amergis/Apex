-- Per-user generation completion sound preferences (PRD / design doc / prototype toasts).
ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS generation_sound_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS generation_sound_id TEXT NOT NULL DEFAULT 'chime';

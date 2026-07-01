-- Add dismissal flag for the beta-to-production announcement modal.
ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS dismissed_beta_prod_announcement BOOLEAN NOT NULL DEFAULT false;

-- Up Migration

-- One Azure DevOps refresh token per user, encrypted with a key derived from SESSION_SECRET.
-- Apex redeems it to open a Playbook's Cloud Agent pull request as the Playbook author.
CREATE TABLE IF NOT EXISTS user_ado_credentials (
  user_id text PRIMARY KEY REFERENCES app_users(oid) ON DELETE CASCADE,
  encrypted_refresh_token jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE IF EXISTS user_ado_credentials;

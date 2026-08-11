-- Restricted user access: pre-provision by email with a role + module list.
-- Users matching a row skip project selection and see only the configured modules.

CREATE TABLE restricted_user_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  role_id UUID NOT NULL REFERENCES app_roles(id) ON DELETE RESTRICT,
  modules JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT restricted_user_access_email_unique UNIQUE (email)
);

CREATE INDEX idx_restricted_user_access_email_lower
  ON restricted_user_access (LOWER(email));

CREATE INDEX idx_restricted_user_access_enabled
  ON restricted_user_access (enabled)
  WHERE enabled = TRUE;

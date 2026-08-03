-- Up Migration
-- Additive user_profiles table for optional bio and avatar metadata.
-- Rollback plan (DoD-3): leave this table in place; do not destructively drop in shared environments.
-- Older binaries ignore the unused table; user-authored bios are preserved.

CREATE TABLE IF NOT EXISTS user_profiles (
  user_oid          TEXT        PRIMARY KEY REFERENCES app_users(oid) ON DELETE CASCADE,
  bio               TEXT,
  avatar_blob_key   TEXT,
  avatar_updated_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_user_oid ON user_profiles(user_oid);

-- Down Migration
-- Intentionally non-destructive for shared environments: leave user_profiles in place.
-- A later reviewed cleanup may drop the table if required.
-- DROP INDEX IF EXISTS idx_user_profiles_user_oid;
-- DROP TABLE IF EXISTS user_profiles;

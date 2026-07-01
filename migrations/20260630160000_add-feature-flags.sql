-- Up Migration

CREATE TABLE feature_flags (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  key         TEXT        UNIQUE NOT NULL,
  description TEXT,
  enabled     BOOLEAN     NOT NULL DEFAULT false,
  lifecycle   TEXT        NOT NULL DEFAULT 'active',
  cleanup_ready BOOLEAN   NOT NULL DEFAULT false,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE feature_flag_rules (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_id     UUID        NOT NULL REFERENCES feature_flags(id) ON DELETE CASCADE,
  type        TEXT        NOT NULL,
  value       TEXT,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_feature_flag_rules_flag_id ON feature_flag_rules(flag_id);

CREATE TABLE feature_flag_audit (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_id     UUID        REFERENCES feature_flags(id) ON DELETE SET NULL,
  flag_key    TEXT        NOT NULL,
  action      TEXT        NOT NULL,
  actor_id    TEXT,
  actor_email TEXT,
  details     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_feature_flag_audit_flag_created ON feature_flag_audit(flag_id, created_at DESC);

-- Down Migration

DROP TABLE IF EXISTS feature_flag_audit;
DROP TABLE IF EXISTS feature_flag_rules;
DROP TABLE IF EXISTS feature_flags;

-- Up Migration: move deployment tracking from JSON file into Postgres

CREATE TABLE IF NOT EXISTS apex_deployments (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project         TEXT        NOT NULL,
  release_id      UUID        REFERENCES apex_releases(id) ON DELETE SET NULL,
  environment     TEXT        NOT NULL
                                CHECK (environment IN ('dev', 'staging', 'prod')),
  version         TEXT        NOT NULL,
  deployed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deployed_by     TEXT        REFERENCES app_users(oid) ON DELETE SET NULL,
  notes           TEXT,
  work_item_ids   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_apex_deployments_project_env
  ON apex_deployments (project, environment, deployed_at DESC);

CREATE INDEX IF NOT EXISTS idx_apex_deployments_release
  ON apex_deployments (release_id)
  WHERE release_id IS NOT NULL;

-- Down Migration

DROP TABLE IF EXISTS apex_deployments;

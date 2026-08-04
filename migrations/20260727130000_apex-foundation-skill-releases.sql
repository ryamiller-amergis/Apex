-- Up Migration
-- Wave 5: APEX Foundation Skills — release management, audit log, and consumer repo status

-- ── foundation_skill_releases ────────────────────────────────────────────────
-- One row per foundation skills suite release (draft → published → deprecated).
-- Artifact coordinates point to the Azure Artifacts feed; manifest_snapshot
-- captures the catalog.json at publish time so the record is self-contained.

CREATE TABLE IF NOT EXISTS foundation_skill_releases (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version          TEXT NOT NULL UNIQUE,
  status           TEXT NOT NULL DEFAULT 'draft',          -- 'draft' | 'published' | 'deprecated'
  artifact_package TEXT NOT NULL DEFAULT '@apex/skills',
  artifact_version TEXT NOT NULL,                          -- semver published to feed
  artifact_feed    TEXT,                                   -- Azure Artifacts feed URL
  integrity_sha256 TEXT,                                   -- SHA-256 of the npm tarball (hex)
  contract_api_version INTEGER NOT NULL DEFAULT 1,
  selected_skills  JSONB NOT NULL DEFAULT '[]',            -- string[] selected skill names
  manifest_snapshot JSONB,                                 -- catalog.json at publish time
  release_notes    TEXT,
  breaking_changes TEXT,
  published_by     TEXT,                                   -- user OID
  published_at     TIMESTAMPTZ,
  deprecated_by    TEXT,
  deprecated_at    TIMESTAMPTZ,
  created_by       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_fsr_status_version
  ON foundation_skill_releases (status, version);

-- ── foundation_skill_release_audit ───────────────────────────────────────────
-- Append-only audit log; rows are never deleted or updated.

CREATE TABLE IF NOT EXISTS foundation_skill_release_audit (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id UUID REFERENCES foundation_skill_releases(id) ON DELETE SET NULL,
  release_version TEXT NOT NULL,                           -- denormalized for audit continuity
  action     TEXT NOT NULL,                                -- 'created' | 'validated' | 'published' | 'deprecated' | 'validation_failed'
  actor_id   TEXT,
  actor_email TEXT,
  details    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_fsra_release_created
  ON foundation_skill_release_audit (release_id, created_at DESC);

CREATE INDEX idx_fsra_action_created
  ON foundation_skill_release_audit (action, created_at DESC);

-- ── foundation_skill_repo_status ─────────────────────────────────────────────
-- Last-observed installation state for each consumer repo.
-- Keyed by (provider, project, repo, branch) — unique per logical repo+branch.
-- Updated by the compatibility service on each check; never deleted.

CREATE TABLE IF NOT EXISTS foundation_skill_repo_status (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider                 TEXT NOT NULL DEFAULT 'ado',    -- 'ado' | 'github'
  project                  TEXT NOT NULL,
  repo                     TEXT NOT NULL,
  branch                   TEXT NOT NULL DEFAULT 'main',
  installed_version        TEXT,                           -- suiteVersion from apex-skills.lock.json
  selected_skills          JSONB NOT NULL DEFAULT '[]',   -- string[] from lockfile
  lock_hash                TEXT,                           -- lockfileIntegrity() from lockfile
  compatibility_status     TEXT,                          -- 'compatible' | 'incompatible' | 'drift' | 'not-installed' | 'unknown'
  compatibility_errors     JSONB NOT NULL DEFAULT '[]',   -- string[] of error messages
  available_version        TEXT,                          -- latest published release version
  update_available         BOOLEAN NOT NULL DEFAULT FALSE,
  compatibility_checked_at TIMESTAMPTZ,
  last_observed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  observed_by              TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, project, repo, branch)
);

CREATE INDEX idx_fssrs_update_available
  ON foundation_skill_repo_status (update_available, last_observed_at DESC);

-- Down Migration
-- DROP TABLE IF EXISTS foundation_skill_repo_status;
-- DROP TABLE IF EXISTS foundation_skill_release_audit;
-- DROP TABLE IF EXISTS foundation_skill_releases;

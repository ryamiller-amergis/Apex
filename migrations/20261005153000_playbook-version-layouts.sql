-- Up Migration: presentation layout for playbook definition versions (Phase 3 canvas)
--
-- Graph topology lives on playbook_definition_versions.graph. Node coordinates are presentation
-- data keyed by version so dragging never mints a version or mutates published graph JSON.

CREATE TABLE playbook_version_layouts (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id  UUID        NOT NULL UNIQUE REFERENCES playbook_definition_versions(id) ON DELETE CASCADE,
  positions   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_playbook_version_layouts_version
  ON playbook_version_layouts (version_id);

-- Down Migration

DROP TABLE IF EXISTS playbook_version_layouts;

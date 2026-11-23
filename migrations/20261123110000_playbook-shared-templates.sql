-- Up Migration
--
-- Shared Playbook templates. A platform admin copies a published Playbook graph here so other
-- projects can install it. The row is a detached snapshot: source_project and source_definition_id
-- are informational and carry no foreign key, so editing or deleting the original changes nothing.
-- Installing copies the graph into a new definition that records no template key.

CREATE TABLE IF NOT EXISTS playbook_shared_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  summary text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT 'shared',
  graph jsonb NOT NULL,
  source_project text NOT NULL,
  source_definition_id uuid,
  source_version_number integer,
  created_by text NOT NULL REFERENCES app_users(oid) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT playbook_shared_templates_name_not_blank CHECK (length(btrim(name)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_playbook_shared_templates_name
  ON playbook_shared_templates (lower(btrim(name)))
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_playbook_shared_templates_created
  ON playbook_shared_templates (created_at DESC);

-- Down Migration

DROP TABLE IF EXISTS playbook_shared_templates;

-- Up Migration
-- Project-owned copies of the shipped core-interview template record which
-- template and version they came from. Existing definitions leave both columns
-- null. The installer is gated by playbook-interview-step, default off.
-- Winning branch: enabled. Cleanup criterion: remove after two stable sprints
-- at full rollout.

ALTER TABLE playbook_definitions
  ADD COLUMN template_key TEXT,
  ADD COLUMN template_version INTEGER;

ALTER TABLE playbook_definitions
  ADD CONSTRAINT playbook_definitions_template_metadata_check
  CHECK (
    (template_key IS NULL AND template_version IS NULL)
    OR (
      template_key IS NOT NULL
      AND length(btrim(template_key)) > 0
      AND template_version IS NOT NULL
      AND template_version >= 1
    )
  );

CREATE UNIQUE INDEX uq_playbook_definitions_project_template
  ON playbook_definitions (project, template_key)
  WHERE template_key IS NOT NULL;

INSERT INTO feature_flags (
  key,
  description,
  enabled,
  lifecycle,
  cleanup_ready,
  created_by
)
VALUES (
  'playbook-interview-step',
  'Gates installation of the shared core-interview Playbook template. Winning branch: enabled. Cleanup criterion: remove after two stable sprints at full rollout.',
  false,
  'active',
  false,
  NULL
)
ON CONFLICT (key) DO NOTHING;

-- Down Migration

DELETE FROM feature_flag_rules
WHERE flag_id = (
  SELECT id FROM feature_flags WHERE key = 'playbook-interview-step'
);

DELETE FROM feature_flags
WHERE key = 'playbook-interview-step';

DROP INDEX IF EXISTS uq_playbook_definitions_project_template;

ALTER TABLE playbook_definitions
  DROP CONSTRAINT IF EXISTS playbook_definitions_template_metadata_check;

ALTER TABLE playbook_definitions
  DROP COLUMN IF EXISTS template_version,
  DROP COLUMN IF EXISTS template_key;

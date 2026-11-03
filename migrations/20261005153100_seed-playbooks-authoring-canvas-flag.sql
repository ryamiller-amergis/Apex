-- Up Migration
--
-- Phase 3 rollout control for the Playbook authoring canvas, live run overlay, and dry run.
-- Winning branch: enabled. Cleanup criterion: retire after canvas acceptance or after the
-- list-editor fallback is stable for two internal sprints.

INSERT INTO feature_flags (
  key,
  description,
  enabled,
  lifecycle,
  cleanup_ready,
  created_by
)
VALUES (
  'playbooks-authoring-canvas',
  'Gates the Playbook authoring canvas, live run overlay on the canvas, and draft dry-run. Winning branch: enabled. Cleanup criterion: retire after canvas spike pass or two stable internal sprints on the surviving authoring surface.',
  false,
  'active',
  false,
  NULL
)
ON CONFLICT (key) DO NOTHING;

-- Down Migration

DELETE FROM feature_flag_rules
WHERE flag_id = (
  SELECT id FROM feature_flags WHERE key = 'playbooks-authoring-canvas'
);

DELETE FROM feature_flags
WHERE key = 'playbooks-authoring-canvas';

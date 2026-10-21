-- Up Migration
--
-- Launch chooser for Cloud Agent: recommended skill, skill and model edits
-- before start, resume from the original run, retry as a new run, and Home
-- guided jobs. Off keeps one-click My Work starts on the project development skill.
-- Winning branch: enabled. Cleanup criterion: retire after two stable sprints
-- at full rollout.

INSERT INTO feature_flags (
  key,
  description,
  enabled,
  lifecycle,
  cleanup_ready,
  created_by
)
VALUES (
  'cloud-agent-guided-launch',
  'Gates the Cloud Agent launch chooser, skill recommendation, resume-from-snapshot, retry, and Home guided jobs. Off keeps one-click My Work starts on the project development skill. Winning branch: enabled. Cleanup criterion: retire after two stable sprints at full rollout.',
  false,
  'active',
  false,
  NULL
)
ON CONFLICT (key) DO NOTHING;

-- Down Migration

DELETE FROM feature_flag_rules
WHERE flag_id = (
  SELECT id FROM feature_flags WHERE key = 'cloud-agent-guided-launch'
);

DELETE FROM feature_flags
WHERE key = 'cloud-agent-guided-launch';

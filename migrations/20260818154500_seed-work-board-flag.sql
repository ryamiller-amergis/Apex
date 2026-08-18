-- Up Migration: seed the Work Board kill switch (on for everyone).
-- Super admin can set Enabled = off in Platform Admin to restore the
-- pre-board screens and Azure DevOps work-item data for every project.
-- Cleanup: retain the enabled branch after two stable sprints at full rollout.

INSERT INTO feature_flags (
  key,
  description,
  enabled,
  lifecycle,
  cleanup_ready,
  created_by
)
VALUES (
  'work-board',
  'Gates the Apex Work Board and board-backed calendar/planning/My Work data. Off restores the classic Azure DevOps views.',
  true,
  'active',
  false,
  NULL
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO feature_flag_rules (flag_id, type, value, created_by)
SELECT f.id, 'everyone', NULL, NULL
FROM feature_flags f
WHERE f.key = 'work-board'
  AND NOT EXISTS (
    SELECT 1 FROM feature_flag_rules r
    WHERE r.flag_id = f.id AND r.type = 'everyone'
  );

-- Down Migration

DELETE FROM feature_flag_rules
WHERE flag_id = (SELECT id FROM feature_flags WHERE key = 'work-board')
  AND type = 'everyone';

DELETE FROM feature_flags WHERE key = 'work-board';

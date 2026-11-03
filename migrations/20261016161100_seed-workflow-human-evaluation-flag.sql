-- Up Migration
-- FEAT-002 / TBI-005: workflow-human-evaluation kill switch.
-- Enabled and active, targeted at the Apex project only.
-- Further pilot projects are added in Platform Admin → Feature Flags.
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
  'workflow-human-evaluation',
  'Gates human workflow evaluation on Interviews and PRDs. Off hides feedback surfaces and refuses evaluation routes.',
  true,
  'active',
  false,
  NULL
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO feature_flag_rules (flag_id, type, value, created_by)
SELECT f.id, 'project', 'Apex', NULL
FROM feature_flags f
WHERE f.key = 'workflow-human-evaluation'
  AND NOT EXISTS (
    SELECT 1 FROM feature_flag_rules r
    WHERE r.flag_id = f.id AND r.type = 'project' AND r.value = 'Apex'
  );

-- Down Migration

DELETE FROM feature_flag_rules
WHERE flag_id = (SELECT id FROM feature_flags WHERE key = 'workflow-human-evaluation')
  AND type = 'project'
  AND value = 'Apex';

DELETE FROM feature_flags WHERE key = 'workflow-human-evaluation';

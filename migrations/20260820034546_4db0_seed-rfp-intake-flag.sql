-- Up Migration
-- Re-seed rfp-intake. The previous seed file ran Up+Down together on databases
-- that applied it before the `-- Up Migration` marker was present.

INSERT INTO feature_flags (
  key,
  description,
  enabled,
  lifecycle,
  cleanup_ready,
  created_by
)
VALUES (
  'rfp-intake',
  'Gates Request for Product intake, evaluation, and Apex triage. Off hides landing cards, queue, and APIs.',
  true,
  'active',
  false,
  NULL
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO feature_flag_rules (flag_id, type, value, created_by)
SELECT f.id, 'everyone', NULL, NULL
FROM feature_flags f
WHERE f.key = 'rfp-intake'
  AND NOT EXISTS (
    SELECT 1 FROM feature_flag_rules r
    WHERE r.flag_id = f.id AND r.type = 'everyone'
  );

-- Down Migration

DELETE FROM feature_flag_rules
WHERE flag_id = (SELECT id FROM feature_flags WHERE key = 'rfp-intake')
  AND type = 'everyone';

DELETE FROM feature_flags WHERE key = 'rfp-intake';

-- Up Migration: seed the FEAT-004 safely disabled native-read control.
-- Disabled by default; Platform Admin adds targeting only after rollout approval.

INSERT INTO feature_flags (
  key,
  description,
  enabled,
  lifecycle,
  cleanup_ready,
  created_by
)
VALUES (
  'native-read',
  'Controls future native repository reads while retaining MCP fallback until runtime capability is proven',
  false,
  'active',
  false,
  NULL
)
ON CONFLICT (key) DO NOTHING;

-- Down Migration

DELETE FROM feature_flag_rules
WHERE flag_id = (
  SELECT id
  FROM feature_flags
  WHERE key = 'native-read'
);

DELETE FROM feature_flags
WHERE key = 'native-read';

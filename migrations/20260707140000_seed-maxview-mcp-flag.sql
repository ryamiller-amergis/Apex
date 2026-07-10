-- Up Migration: Insert the maxview-mcp feature flag (enabled for everyone).
-- Gates whether the chat agent gets the always-on MaxView timecard-debug MCP
-- server. The MCP is only wired when this flag is ON *and* the server has the
-- MAXVIEW_MCP_* env configured. Idempotent — safe to re-run.

INSERT INTO feature_flags (key, description, enabled, lifecycle, cleanup_ready, created_by)
VALUES (
  'maxview-mcp',
  'Wires the MaxView timecard-debug MCP server into the project chat agent',
  true,
  'active',
  false,
  NULL
)
ON CONFLICT (key) DO NOTHING;

-- Target everyone so the MCP is available wherever the server env is configured.
INSERT INTO feature_flag_rules (flag_id, type, value, created_by)
SELECT f.id, 'everyone', NULL, NULL
FROM feature_flags f
WHERE f.key = 'maxview-mcp'
  AND NOT EXISTS (
    SELECT 1 FROM feature_flag_rules r
    WHERE r.flag_id = f.id AND r.type = 'everyone'
  );

-- Down Migration

DELETE FROM feature_flag_rules
WHERE flag_id = (SELECT id FROM feature_flags WHERE key = 'maxview-mcp')
  AND type = 'everyone';

DELETE FROM feature_flags WHERE key = 'maxview-mcp';

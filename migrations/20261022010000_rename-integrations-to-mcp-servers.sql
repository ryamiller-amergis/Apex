-- Up Migration
-- The module is MCP Servers. Keep existing rows by renaming the flag, permissions, menu key, and table.

UPDATE app_permissions
SET key = 'mcp-servers:view',
    description = 'Open MCP Servers and ask through an allowed server',
    category = 'mcp-servers'
WHERE key = 'integrations:view';

UPDATE app_permissions
SET key = 'mcp-servers:manage',
    description = 'Create, test, and remove MCP servers',
    category = 'mcp-servers'
WHERE key = 'integrations:manage';

UPDATE feature_flags
SET key = 'mcp-servers',
    description = 'Project-targeted MCP Servers module. Off until enabled with a project rule. Winner is the enabled branch after two stable sprints at full rollout.',
    updated_at = now()
WHERE key = 'integrations';

UPDATE feature_flag_audit
SET flag_key = 'mcp-servers'
WHERE flag_key = 'integrations';

ALTER TABLE integration_connections RENAME TO mcp_servers;
ALTER INDEX idx_integration_connections_project RENAME TO idx_mcp_servers_project;

UPDATE project_menu_settings
SET enabled_views = replace(enabled_views::text, '"integrations"', '"mcp-servers"')::jsonb
WHERE enabled_views::text LIKE '%"integrations"%';

-- Down Migration

UPDATE project_menu_settings
SET enabled_views = replace(enabled_views::text, '"mcp-servers"', '"integrations"')::jsonb
WHERE enabled_views::text LIKE '%"mcp-servers"%';

ALTER INDEX idx_mcp_servers_project RENAME TO idx_integration_connections_project;
ALTER TABLE mcp_servers RENAME TO integration_connections;

UPDATE feature_flag_audit
SET flag_key = 'integrations'
WHERE flag_key = 'mcp-servers';

UPDATE feature_flags
SET key = 'integrations',
    description = 'Project-targeted Integrations module. Off until enabled with a project rule. Winner is the enabled branch after two stable sprints at full rollout.',
    updated_at = now()
WHERE key = 'mcp-servers';

UPDATE app_permissions
SET key = 'integrations:manage',
    description = 'Create, test, edit access, and remove integration connections',
    category = 'integrations'
WHERE key = 'mcp-servers:manage';

UPDATE app_permissions
SET key = 'integrations:view',
    description = 'Open Integrations and ask through an allowed connection',
    category = 'integrations'
WHERE key = 'mcp-servers:view';

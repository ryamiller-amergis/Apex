-- Up Migration
--
-- The tools a project lets its skills use, beyond reading the repository (for example azure-cli).
-- A platform admin sets them. A project skill may name a tool in `playbook-capabilities` only when
-- its project allows it. Which tool names exist is a code catalog, so no CHECK here.

CREATE TABLE IF NOT EXISTS project_playbook_tools (
  project text NOT NULL,
  tool text NOT NULL,
  enabled_by text NOT NULL,
  enabled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project, tool),
  CONSTRAINT project_playbook_tools_project_not_blank CHECK (length(btrim(project)) > 0),
  CONSTRAINT project_playbook_tools_tool_not_blank CHECK (length(btrim(tool)) > 0)
);

-- The MaxView incident skill already runs with the Azure CLI, so keep it allowed where it exists.
INSERT INTO project_playbook_tools (project, tool, enabled_by)
SELECT DISTINCT project, 'azure-cli', 'system'
FROM project_playbook_skills
WHERE name = 'maxview-incident-investigation'
ON CONFLICT (project, tool) DO NOTHING;

-- Down Migration

DROP TABLE IF EXISTS project_playbook_tools;

-- Up Migration
--
-- The connector operations that change something outside Apex (for example creating an Azure
-- DevOps work item) which a project lets its playbooks run. A platform admin sets them. A
-- playbook can publish and run a write operation only when its project allows it. Which
-- operations exist is a code catalog, so no CHECK on the names here.

CREATE TABLE IF NOT EXISTS project_playbook_connector_writes (
  project text NOT NULL,
  integration text NOT NULL,
  operation text NOT NULL,
  enabled_by text NOT NULL,
  enabled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project, integration, operation),
  CONSTRAINT project_playbook_connector_writes_project_not_blank CHECK (length(btrim(project)) > 0),
  CONSTRAINT project_playbook_connector_writes_integration_not_blank CHECK (length(btrim(integration)) > 0),
  CONSTRAINT project_playbook_connector_writes_operation_not_blank CHECK (length(btrim(operation)) > 0)
);

-- Down Migration

DROP TABLE IF EXISTS project_playbook_connector_writes;

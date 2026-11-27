/**
 * Integrations a Playbook connector can name.
 *
 * One connector shape on the graph, for every project. Adding an integration means adding an
 * entry here and a handler in `playbookConnectorHandlers.ts`. An operation with a handler calls
 * the system with the run's project and keeps the response in the step's `result` output. An
 * operation marked `recordsOnly` has no handler yet: a run records the choice and calls nothing.
 *
 * `access` is the effect of the operation. A `write` operation changes something outside Apex,
 * so the guard requires an approval gate upstream of it. Reads need no gate.
 */

export interface PlaybookConnectorField {
  key: string;
  label: string;
  hint?: string;
  multiline?: boolean;
  required?: boolean;
}

export type PlaybookConnectorAccess = 'read' | 'write';

export interface PlaybookConnectorOperation {
  id: string;
  label: string;
  description: string;
  access: PlaybookConnectorAccess;
  /** No handler yet. Flip `access` to its real effect when the handler is added. */
  recordsOnly?: boolean;
  fields: readonly PlaybookConnectorField[];
}

export interface PlaybookConnectorDefinition {
  id: string;
  label: string;
  description: string;
  operations: readonly PlaybookConnectorOperation[];
}

export const PLAYBOOK_CONNECTOR_IDS = ['teams', 'azure-devops', 'azure'] as const;

export type PlaybookConnectorId = (typeof PLAYBOOK_CONNECTOR_IDS)[number];

export const PLAYBOOK_CONNECTORS: readonly PlaybookConnectorDefinition[] = [
  {
    id: 'teams',
    label: 'Teams',
    description: 'A message for a Teams channel, taken from an earlier step.',
    operations: [
      {
        id: 'send-message',
        label: 'Send a message',
        description: 'Carry a title and a message to the next step.',
        access: 'read',
        recordsOnly: true,
        fields: [
          { key: 'title', label: 'Title' },
          { key: 'body', label: 'Message', hint: 'Insert the report from the previous step.', multiline: true },
        ],
      },
    ],
  },
  {
    id: 'azure-devops',
    label: 'Azure DevOps',
    description: 'Read and change repositories, pull requests, and work items in this project\u2019s Azure DevOps.',
    operations: [
      {
        id: 'list-repositories',
        label: 'List repositories',
        description: 'Every repository in this project.',
        access: 'read',
        fields: [],
      },
      {
        id: 'list-branches',
        label: 'List branches',
        description: 'Branches in a repository, optionally only those whose name starts with a prefix.',
        access: 'read',
        fields: [
          { key: 'repository', label: 'Repository', required: true, hint: 'Repository name or id.' },
          { key: 'startsWith', label: 'Name starts with', hint: 'For example a branch prefix. Leave empty for every branch.' },
        ],
      },
      {
        id: 'list-tags',
        label: 'List tags',
        description: 'Tags in a repository, optionally only those whose name starts with a prefix.',
        access: 'read',
        fields: [
          { key: 'repository', label: 'Repository', required: true, hint: 'Repository name or id.' },
          { key: 'startsWith', label: 'Name starts with', hint: 'Leave empty for every tag.' },
        ],
      },
      {
        id: 'list-pull-requests',
        label: 'List pull requests',
        description: 'Pull requests in a repository, filtered by status and branch.',
        access: 'read',
        fields: [
          { key: 'repository', label: 'Repository', required: true, hint: 'Repository name or id.' },
          { key: 'status', label: 'Status', hint: 'active, completed, abandoned, or all. Default: completed.' },
          { key: 'targetBranch', label: 'Target branch', hint: 'Branch name without refs/heads/. Leave empty for any.' },
          { key: 'sourceBranch', label: 'Source branch', hint: 'Branch name without refs/heads/. Leave empty for any.' },
          { key: 'top', label: 'Most results', hint: 'Default 100, at most 500.' },
        ],
      },
      {
        id: 'get-pull-request',
        label: 'Get a pull request',
        description: 'One pull request with its description, reviewers, and linked work items.',
        access: 'read',
        fields: [
          { key: 'repository', label: 'Repository', required: true, hint: 'Repository name or id.' },
          { key: 'pullRequestId', label: 'Pull request', required: true, hint: 'The pull request number.' },
        ],
      },
      {
        id: 'get-work-item',
        label: 'Get a work item',
        description: 'One work item with its fields and links.',
        access: 'read',
        fields: [
          { key: 'workItemId', label: 'Work item', required: true, hint: 'The work item number.' },
        ],
      },
      {
        id: 'query-work-items',
        label: 'Query work items',
        description: 'Run a WIQL query and return the matching work items.',
        access: 'read',
        fields: [
          { key: 'wiql', label: 'WIQL query', required: true, multiline: true, hint: 'For example: SELECT [System.Id] FROM WorkItems WHERE [System.State] = \'Active\'' },
          { key: 'fields', label: 'Fields', hint: 'Comma-separated field names. Leave empty for the default fields.' },
          { key: 'maxResults', label: 'Most results', hint: 'Default 200, at most 500.' },
        ],
      },
      {
        id: 'rest-get',
        label: 'Read anything (REST GET)',
        description: 'A GET request to any Azure DevOps REST path in this project.',
        access: 'read',
        fields: [
          {
            key: 'path',
            label: 'Path',
            required: true,
            hint: 'Relative to this project, for example _apis/git/repositories. The api-version is added when you leave it out.',
          },
        ],
      },
      {
        id: 'create-work-item',
        label: 'Create a work item',
        description: 'Create a work item in this project. The result holds its id and link.',
        access: 'write',
        fields: [
          { key: 'workItemType', label: 'Work item type', required: true, hint: 'For example Bug, Product Backlog Item, Task.' },
          { key: 'title', label: 'Title', required: true },
          { key: 'description', label: 'Description', multiline: true, hint: 'Markdown. Shown as the description (Repro Steps for a Bug).' },
        ],
      },
      {
        id: 'update-work-item',
        label: 'Update a work item',
        description: 'Set fields on an existing work item.',
        access: 'write',
        fields: [
          { key: 'workItemId', label: 'Work item', required: true, hint: 'The work item number.' },
          {
            key: 'fields',
            label: 'Fields',
            required: true,
            multiline: true,
            hint: 'A JSON object of field names and values, for example {"System.State": "Resolved"}.',
          },
        ],
      },
      {
        id: 'post-comment',
        label: 'Post a comment',
        description: 'Add a comment to a work item.',
        access: 'write',
        fields: [
          { key: 'workItemId', label: 'Work item', required: true, hint: 'The work item number.' },
          { key: 'text', label: 'Comment', required: true, multiline: true },
        ],
      },
      {
        id: 'create-pull-request',
        label: 'Create a pull request',
        description: 'Open a pull request in a repository. The result holds its link.',
        access: 'write',
        fields: [
          { key: 'repository', label: 'Repository', required: true, hint: 'Repository name.' },
          { key: 'sourceBranch', label: 'Source branch', required: true, hint: 'Branch name without refs/heads/.' },
          { key: 'targetBranch', label: 'Target branch', required: true, hint: 'Branch name without refs/heads/.' },
          { key: 'title', label: 'Title', required: true },
          { key: 'description', label: 'Description', multiline: true },
          { key: 'workItemId', label: 'Linked work item', hint: 'Optional work item number.' },
          { key: 'draft', label: 'Draft', hint: 'true to open it as a draft. Default: false.' },
        ],
      },
      {
        id: 'rest-write',
        label: 'Change anything (REST POST, PATCH, PUT, DELETE)',
        description: 'A write request to any Azure DevOps REST path in this project.',
        access: 'write',
        fields: [
          { key: 'method', label: 'Method', required: true, hint: 'POST, PATCH, PUT, or DELETE.' },
          {
            key: 'path',
            label: 'Path',
            required: true,
            hint: 'Relative to this project, for example _apis/wit/workitems/12. The api-version is added when you leave it out.',
          },
          { key: 'body', label: 'Body', multiline: true, hint: 'JSON. Leave empty for none.' },
          {
            key: 'contentType',
            label: 'Content type',
            hint: 'application/json (default) or application/json-patch+json, which work item updates use.',
          },
        ],
      },
    ],
  },
  {
    id: 'azure',
    label: 'Azure',
    description: 'A resource in Azure that a later step can read.',
    operations: [
      {
        id: 'read-resource',
        label: 'Read a resource',
        description: 'Carry the resource name.',
        access: 'read',
        recordsOnly: true,
        fields: [
          { key: 'resource', label: 'Resource', hint: 'A resource name or id from an earlier step.' },
        ],
      },
    ],
  },
];

export function playbookConnector(id: string | undefined): PlaybookConnectorDefinition | undefined {
  return PLAYBOOK_CONNECTORS.find((connector) => connector.id === id);
}

export function playbookConnectorOperation(
  integration: string | undefined,
  operation: string | undefined,
): PlaybookConnectorOperation | undefined {
  return playbookConnector(integration)?.operations.find((item) => item.id === operation);
}

export interface PlaybookConnectorWriteOption {
  /** `integration/operation`. The id the allow-list stores. */
  id: string;
  integrationLabel: string;
  label: string;
  description: string;
}

/** Every write operation in the catalog. A project allows these one by one. */
export function playbookConnectorWriteOptions(
  catalog: readonly PlaybookConnectorDefinition[] = PLAYBOOK_CONNECTORS,
): PlaybookConnectorWriteOption[] {
  return catalog.flatMap((connector) =>
    connector.operations
      .filter((operation) => operation.access === 'write')
      .map((operation) => ({
        id: `${connector.id}/${operation.id}`,
        integrationLabel: connector.label,
        label: operation.label,
        description: operation.description,
      })),
  );
}

/**
 * Whether a connector step's configured operation writes outside Apex. An unknown integration
 * or operation does not count: the step fails on its own when it runs.
 */
export function connectorConfigWrites(
  config: Record<string, unknown> | undefined,
  catalog: readonly PlaybookConnectorDefinition[] = PLAYBOOK_CONNECTORS,
): boolean {
  const integration = typeof config?.integration === 'string' ? config.integration : undefined;
  const operation = typeof config?.operation === 'string' ? config.operation : undefined;
  const found = catalog
    .find((connector) => connector.id === integration)
    ?.operations.find((item) => item.id === operation);
  return found?.access === 'write';
}

export function defaultPlaybookConnectorConfig(): Record<string, unknown> {
  const connector = PLAYBOOK_CONNECTORS[0];
  return {
    integration: connector.id,
    operation: connector.operations[0].id,
    parameters: {},
  };
}

/** The line drawn on the connector shape. */
export function connectorSummary(config: Record<string, unknown> | undefined): string {
  const integration = playbookConnector(typeof config?.integration === 'string' ? config.integration : undefined);
  const operation = playbookConnectorOperation(
    typeof config?.integration === 'string' ? config.integration : undefined,
    typeof config?.operation === 'string' ? config.operation : undefined,
  );
  if (!integration) return '';
  return operation ? `${integration.label} · ${operation.label}` : integration.label;
}

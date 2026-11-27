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
    description: 'Read repositories, branches, pull requests, and work items in this project\u2019s Azure DevOps.',
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
        description: 'Carry a type, title, and description.',
        access: 'read',
        recordsOnly: true,
        fields: [
          { key: 'workItemType', label: 'Work item type' },
          { key: 'title', label: 'Title' },
          { key: 'description', label: 'Description', multiline: true },
        ],
      },
      {
        id: 'post-comment',
        label: 'Post a comment',
        description: 'Carry a work item and a comment.',
        access: 'read',
        recordsOnly: true,
        fields: [
          { key: 'workItemId', label: 'Work item' },
          { key: 'text', label: 'Comment', multiline: true },
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

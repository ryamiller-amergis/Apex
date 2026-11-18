/**
 * Integrations a Playbook connector can name.
 *
 * One connector shape on the graph. Adding an integration means adding an entry here.
 * A run records the choice. It does not call the system.
 */

export interface PlaybookConnectorField {
  key: string;
  label: string;
  hint?: string;
  multiline?: boolean;
}

export interface PlaybookConnectorOperation {
  id: string;
  label: string;
  description: string;
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
    description: 'A work item or a comment for Azure DevOps.',
    operations: [
      {
        id: 'create-work-item',
        label: 'Create a work item',
        description: 'Carry a type, title, and description.',
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

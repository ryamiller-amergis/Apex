/**
 * Which connector write operations a project lets its playbooks run (for example creating an
 * Azure DevOps work item). The catalog of operations is `PLAYBOOK_CONNECTORS`; this service
 * stores which write operations a project allows.
 *
 * A write is checked twice: when a playbook is published, so an author learns at once, and when
 * the step runs, so a later change to the allow-list stops a published version.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { projectPlaybookConnectorWrites } from '../db/schema';
import {
  connectorConfigWrites,
  playbookConnectorOperation,
  playbookConnectorWriteOptions,
} from '../../shared/types/playbookConnectors';
import type { PlaybookGraph } from '../../shared/types/playbook';

export class PlaybookConnectorWriteError extends Error {
  readonly nodeId?: string;

  constructor(message: string, nodeId?: string) {
    super(message);
    this.name = 'PlaybookConnectorWriteError';
    this.nodeId = nodeId;
  }
}

function writeKey(integration: string, operation: string): string {
  return `${integration}/${operation}`;
}

function writeLabel(integration: string, operation: string): string {
  const option = playbookConnectorWriteOptions().find((item) => item.id === writeKey(integration, operation));
  return option ? `${option.integrationLabel} \u00b7 ${option.label}` : writeKey(integration, operation);
}

/** The `integration/operation` ids this project allows. One the catalog no longer lists is dropped. */
export async function listAllowedConnectorWrites(project: string): Promise<string[]> {
  const rows = await db
    .select({
      integration: projectPlaybookConnectorWrites.integration,
      operation: projectPlaybookConnectorWrites.operation,
    })
    .from(projectPlaybookConnectorWrites)
    .where(eq(projectPlaybookConnectorWrites.project, project));
  const offered = new Set(playbookConnectorWriteOptions().map((option) => option.id));
  return rows
    .map((row) => writeKey(row.integration, row.operation))
    .filter((id) => offered.has(id))
    .sort();
}

/** Replaces the project's allowed write operations with the given list. */
export async function setAllowedConnectorWrites(input: {
  project: string;
  operations: readonly string[];
  actorUserId: string;
}): Promise<string[]> {
  const offered = new Set(playbookConnectorWriteOptions().map((option) => option.id));
  const unknown = input.operations.find((id) => !offered.has(id));
  if (unknown) {
    throw new PlaybookConnectorWriteError(`"${unknown}" is not a connector write operation Apex offers.`);
  }
  const operations = [...new Set(input.operations)].sort();
  await db.transaction(async (tx) => {
    await tx
      .delete(projectPlaybookConnectorWrites)
      .where(eq(projectPlaybookConnectorWrites.project, input.project));
    if (operations.length > 0) {
      await tx.insert(projectPlaybookConnectorWrites).values(
        operations.map((id) => {
          const [integration, operation] = id.split('/');
          return { project: input.project, integration, operation, enabledBy: input.actorUserId };
        }),
      );
    }
  });
  return operations;
}

/** Throws when this project has not allowed the write operation. Reads always pass. */
export async function assertConnectorWriteAllowed(
  project: string,
  integration: string,
  operation: string,
  stepId?: string,
): Promise<void> {
  if (playbookConnectorOperation(integration, operation)?.access !== 'write') return;
  const allowed = await listAllowedConnectorWrites(project);
  if (allowed.includes(writeKey(integration, operation))) return;
  throw new PlaybookConnectorWriteError(
    `${project} has not allowed "${writeLabel(integration, operation)}" in playbooks. ` +
      'A platform admin can allow it under Connector writes in the skill library.',
    stepId,
  );
}

/** Publish-time check: every connector write in the graph must be allowed for the project. */
export async function assertConnectorWritesAllowedForGraph(
  project: string,
  graph: PlaybookGraph,
): Promise<void> {
  const writers = graph.nodes.filter(
    (node) => node.stepType === 'connector' && connectorConfigWrites(node.config),
  );
  if (writers.length === 0) return;
  const allowed = new Set(await listAllowedConnectorWrites(project));
  for (const node of writers) {
    const integration = String(node.config?.integration);
    const operation = String(node.config?.operation);
    if (!allowed.has(writeKey(integration, operation))) {
      throw new PlaybookConnectorWriteError(
        `Step "${node.id}" uses "${writeLabel(integration, operation)}", which ${project} has not allowed ` +
          'in playbooks. A platform admin can allow it under Connector writes in the skill library.',
        node.id,
      );
    }
  }
}

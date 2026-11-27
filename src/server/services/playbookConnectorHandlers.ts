/**
 * Server-side handlers for Playbook connector operations.
 *
 * The catalog in `shared/types/playbookConnectors.ts` says what an operation is and what it
 * takes. This table says how it runs. A test checks the two against each other, so the editor
 * never offers an operation that does nothing, except those marked `recordsOnly`.
 *
 * To add an integration: add it to the catalog, then add its operations here.
 */
import { ADO_OPERATIONS, ADO_WRITE_OPERATIONS } from './adoConnectorOperations';

export interface PlaybookConnectorCall {
  project: string;
  initiatorUserId: string;
  parameters: Record<string, string>;
}

/** Returns the system's response as text. The adapter caps its size. */
export type PlaybookConnectorHandler = (call: PlaybookConnectorCall) => Promise<string>;

const HANDLERS: Readonly<Record<string, Readonly<Record<string, PlaybookConnectorHandler>>>> = {
  'azure-devops': Object.fromEntries(
    Object.entries({ ...ADO_OPERATIONS, ...ADO_WRITE_OPERATIONS }).map(([operation, run]) => [
      operation,
      (call: PlaybookConnectorCall) => run({ project: call.project, parameters: call.parameters }),
    ]),
  ),
};

export function playbookConnectorHandler(
  integration: string,
  operation: string,
): PlaybookConnectorHandler | undefined {
  return HANDLERS[integration]?.[operation];
}

/** Every `integration/operation` that has a handler. Used by the catalog consistency test. */
export function playbookConnectorHandlerKeys(): string[] {
  return Object.entries(HANDLERS).flatMap(([integration, operations]) =>
    Object.keys(operations).map((operation) => `${integration}/${operation}`),
  );
}

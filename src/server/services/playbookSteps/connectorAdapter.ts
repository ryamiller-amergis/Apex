/**
 * Runs one operation of a connector integration for the run's project.
 *
 * An operation with a handler calls the system and keeps the response, as text, in `result`.
 * An operation marked `recordsOnly` in the catalog has no handler yet: the step records the
 * choice and calls nothing, as it always did.
 */
import {
  playbookConnectorOperation,
} from '../../../shared/types/playbookConnectors';
import { playbookConnectorHandler } from '../playbookConnectorHandlers';
import { assertConnectorWriteAllowed } from '../playbookConnectorWriteAllowListService';
import { parseStepInput, parseStepOutput } from './descriptorValidation';
import {
  completeStepRun,
  failStepRun,
  type PlaybookStepExecutionContext,
  type PlaybookStepOutcome,
} from './stepRuns';

const STEP_TYPE = 'connector';

/** Largest `result` a step keeps. A step output is stored in the run row. */
export const PLAYBOOK_CONNECTOR_RESULT_LIMIT = 100_000;

interface ConnectorStepConfig {
  integration: string;
  operation: string;
  parameters?: Record<string, string>;
}

async function failWith(context: PlaybookStepExecutionContext, reason: string): Promise<never> {
  await failStepRun({ stepRunId: context.stepRunId, reason });
  throw new Error(reason);
}

function capResult(text: string): { result: string; truncated: boolean } {
  if (text.length <= PLAYBOOK_CONNECTOR_RESULT_LIMIT) return { result: text, truncated: false };
  const marker = '\n[Result cut to the size limit.]';
  return {
    result: text.slice(0, PLAYBOOK_CONNECTOR_RESULT_LIMIT - marker.length) + marker,
    truncated: true,
  };
}

export async function executeConnectorStep(
  context: PlaybookStepExecutionContext,
): Promise<PlaybookStepOutcome> {
  const config = parseStepInput<ConnectorStepConfig>(STEP_TYPE, context.config);
  const operation = playbookConnectorOperation(config.integration, config.operation);
  if (!operation) {
    return failWith(
      context,
      `Connector "${context.stepId}" names operation "${config.operation}" which ${config.integration} does not offer.`,
    );
  }

  const parameters = config.parameters ?? {};
  let response: { result: string; truncated: boolean } | undefined;

  const handler = operation.recordsOnly ? undefined : playbookConnectorHandler(config.integration, config.operation);
  if (!operation.recordsOnly && !handler) {
    return failWith(
      context,
      `Connector "${context.stepId}" cannot run ${config.integration} ${config.operation}: the server has no handler for it.`,
    );
  }

  if (handler) {
    const missing = operation.fields
      .filter((field) => field.required && !parameters[field.key]?.trim())
      .map((field) => field.label);
    if (missing.length > 0) {
      return failWith(context, `Connector "${context.stepId}" needs ${missing.join(', ')}.`);
    }
    // Publishing checked this once. A later change to the allow-list must stop a published version.
    try {
      await assertConnectorWriteAllowed(context.project, config.integration, config.operation, context.stepId);
    } catch (error) {
      return failWith(context, error instanceof Error ? error.message : String(error));
    }
    try {
      response = capResult(
        await handler({ project: context.project, initiatorUserId: context.initiatorUserId, parameters }),
      );
    } catch (error) {
      return failWith(
        context,
        `Connector "${context.stepId}" failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const output = parseStepOutput(STEP_TYPE, {
    integration: config.integration,
    operation: config.operation,
    ...(config.parameters ? { parameters: config.parameters } : {}),
    ...(response ? { result: response.result, ...(response.truncated ? { truncated: true } : {}) } : {}),
    recordedAt: new Date().toISOString(),
  });
  await completeStepRun({ stepRunId: context.stepRunId, output });
  return { kind: 'completed', output };
}

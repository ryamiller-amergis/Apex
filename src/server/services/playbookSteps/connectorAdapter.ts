/**
 * The connector records which integration sits between the steps around it.
 * It completes in the same tick. Calling Teams, Azure DevOps, or Azure is a later addition
 * to this adapter, chosen from the integration catalog.
 */
import {
  playbookConnectorOperation,
} from '../../../shared/types/playbookConnectors';
import { parseStepInput, parseStepOutput } from './descriptorValidation';
import {
  completeStepRun,
  failStepRun,
  type PlaybookStepExecutionContext,
  type PlaybookStepOutcome,
} from './stepRuns';

const STEP_TYPE = 'connector';

interface ConnectorStepConfig {
  integration: string;
  operation: string;
  parameters?: Record<string, string>;
}

export async function executeConnectorStep(
  context: PlaybookStepExecutionContext,
): Promise<PlaybookStepOutcome> {
  const config = parseStepInput<ConnectorStepConfig>(STEP_TYPE, context.config);
  const operation = playbookConnectorOperation(config.integration, config.operation);
  if (!operation) {
    const reason = `Connector "${context.stepId}" names operation "${config.operation}" which ${config.integration} does not offer.`;
    await failStepRun({ stepRunId: context.stepRunId, reason });
    throw new Error(reason);
  }

  const output = parseStepOutput(STEP_TYPE, {
    integration: config.integration,
    operation: config.operation,
    ...(config.parameters ? { parameters: config.parameters } : {}),
    recordedAt: new Date().toISOString(),
  });
  await completeStepRun({ stepRunId: context.stepRunId, output });
  return { kind: 'completed', output };
}

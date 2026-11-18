jest.mock('../services/playbookSteps/stepRuns', () => ({
  completeStepRun: jest.fn(async ({ output }: { output: Record<string, unknown> }) => output),
  failStepRun: jest.fn(),
}));

import { executeConnectorStep } from '../services/playbookSteps/connectorAdapter';
import { getStepTypeDescriptor } from '../services/playbookSteps/registry';
import { completeStepRun, failStepRun } from '../services/playbookSteps/stepRuns';
import type { PlaybookStepExecutionContext } from '../services/playbookSteps/stepRuns';
import { PLAYBOOK_CONNECTORS } from '../../shared/types/playbookConnectors';

function context(config: Record<string, unknown>): PlaybookStepExecutionContext {
  return {
    runId: 'run-1',
    stepRunId: 'step-run-1',
    stepId: 'teams-link',
    stepType: 'connector',
    project: 'Apex',
    initiatorUserId: 'user-1',
    config,
  };
}

describe('playbook connector', () => {
  it('accepts each catalog integration and records the choice', async () => {
    const descriptor = getStepTypeDescriptor('connector');
    for (const connector of PLAYBOOK_CONNECTORS) {
      for (const operation of connector.operations) {
        expect(descriptor.inputSchema.safeParse({
          integration: connector.id,
          operation: operation.id,
          parameters: { note: 'from the agent' },
        }).success).toBe(true);
      }
    }
    expect(descriptor.inputSchema.safeParse({ integration: 'slack', operation: 'send' }).success).toBe(false);

    await executeConnectorStep(context({
      integration: 'teams',
      operation: 'send-message',
      parameters: { title: 'Finding', body: '${steps.scan.reportMd}' },
    }));

    expect(completeStepRun).toHaveBeenCalledWith(expect.objectContaining({
      stepRunId: 'step-run-1',
      output: expect.objectContaining({
        integration: 'teams',
        operation: 'send-message',
        parameters: { title: 'Finding', body: '${steps.scan.reportMd}' },
      }),
    }));
    expect(failStepRun).not.toHaveBeenCalled();
  });

  it('fails a connector whose action is not on that integration', async () => {
    await expect(executeConnectorStep(context({
      integration: 'azure',
      operation: 'send-message',
    }))).rejects.toThrow(/does not offer/);
    expect(failStepRun).toHaveBeenCalled();
  });
});

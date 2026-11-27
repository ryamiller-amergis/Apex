jest.mock('../services/playbookSteps/stepRuns', () => ({
  completeStepRun: jest.fn(async ({ output }: { output: Record<string, unknown> }) => output),
  failStepRun: jest.fn(),
}));

const handler = jest.fn();
jest.mock('../services/playbookConnectorHandlers', () => ({
  playbookConnectorHandler: (integration: string, operation: string) =>
    integration === 'azure-devops' && operation !== 'rest-get' ? handler : undefined,
}));

import {
  executeConnectorStep,
  PLAYBOOK_CONNECTOR_RESULT_LIMIT,
} from '../services/playbookSteps/connectorAdapter';
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

  describe('an operation with a handler', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('calls the system for the run project and keeps the response in result', async () => {
      handler.mockResolvedValue('["Release/2026.17.0"]');

      await executeConnectorStep(context({
        integration: 'azure-devops',
        operation: 'list-branches',
        parameters: { repository: 'api', startsWith: 'Release/' },
      }));

      expect(handler).toHaveBeenCalledWith({
        project: 'Apex',
        initiatorUserId: 'user-1',
        parameters: { repository: 'api', startsWith: 'Release/' },
      });
      expect(completeStepRun).toHaveBeenCalledWith(expect.objectContaining({
        output: expect.objectContaining({ result: '["Release/2026.17.0"]' }),
      }));
    });

    it('fails before the call when a required field is empty', async () => {
      await expect(executeConnectorStep(context({
        integration: 'azure-devops',
        operation: 'list-branches',
        parameters: { repository: '  ' },
      }))).rejects.toThrow(/needs Repository/);

      expect(handler).not.toHaveBeenCalled();
      expect(failStepRun).toHaveBeenCalled();
    });

    it('fails the step with the handler error', async () => {
      handler.mockRejectedValue(new Error('Azure DevOps answered 404'));

      await expect(executeConnectorStep(context({
        integration: 'azure-devops',
        operation: 'list-repositories',
      }))).rejects.toThrow(/failed: Azure DevOps answered 404/);

      expect(completeStepRun).not.toHaveBeenCalled();
    });

    it('cuts a response past the size limit and says so', async () => {
      handler.mockResolvedValue('x'.repeat(PLAYBOOK_CONNECTOR_RESULT_LIMIT + 500));

      await executeConnectorStep(context({
        integration: 'azure-devops',
        operation: 'list-repositories',
      }));

      const output = (completeStepRun as jest.Mock).mock.calls[0][0].output as {
        result: string;
        truncated: boolean;
      };
      expect(output.truncated).toBe(true);
      expect(output.result.length).toBeLessThanOrEqual(PLAYBOOK_CONNECTOR_RESULT_LIMIT);
      expect(output.result).toContain('Result cut to the size limit');
    });

    it('fails an operation that is not recordsOnly and has no handler', async () => {
      await expect(executeConnectorStep(context({
        integration: 'azure-devops',
        operation: 'rest-get',
        parameters: { path: '_apis/projects' },
      }))).rejects.toThrow(/no handler/);
    });
  });
});

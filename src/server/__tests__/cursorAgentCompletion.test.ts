jest.mock('../services/chatAgentService', () => ({
  getThread: jest.fn().mockResolvedValue({
    messages: [
      { id: 'm1', role: 'user', text: 'Investigate', ts: 't1' },
      { id: 'm2', role: 'agent', text: 'The cache key is stale.', ts: 't2' },
    ],
  }),
  hydrateThread: jest.fn().mockResolvedValue(true),
  isOutputWorkspaceReadable: jest.fn().mockReturnValue(true),
  readOutputValidationScorecard: jest.fn().mockReturnValue({ is_ready: true }),
  readOutputValidationScorecardMd: jest.fn().mockReturnValue('# report'),
}));
jest.mock('../services/playbookSteps/v2StepArtifacts', () => ({
  readV2ScorecardFiles: jest.fn().mockResolvedValue(null),
}));

import { cursorAgentCompletionOutput } from '../services/playbookSteps/cursorAgentCompletion';
import {
  hydrateThread,
  isOutputWorkspaceReadable,
  readOutputValidationScorecard,
  readOutputValidationScorecardMd,
} from '../services/chatAgentService';

describe('cursorAgentCompletionOutput', () => {
  it('records thread, scorecard, and report for a completed cursor-agent step', async () => {
    await expect(cursorAgentCompletionOutput({
      stepType: 'cursor-agent',
      agentRunId: 'agent-1',
      completedAt: '2026-09-24T12:00:00.000Z',
      threadId: 'thread-1',
    })).resolves.toEqual({
      agentRunId: 'agent-1',
      completedAt: '2026-09-24T12:00:00.000Z',
      threadId: 'thread-1',
      scorecard: { is_ready: true },
      reportMd: '# report',
      output: '# report',
    });
    expect(hydrateThread).toHaveBeenCalledWith('thread-1');
  });

  it('uses the agent reply as output when the step wrote no report', async () => {
    (readOutputValidationScorecard as jest.Mock).mockReturnValueOnce(null);
    (readOutputValidationScorecardMd as jest.Mock).mockReturnValueOnce(null);

    await expect(cursorAgentCompletionOutput({
      stepType: 'cursor-agent',
      agentRunId: 'agent-1',
      completedAt: '2026-09-24T12:00:00.000Z',
      threadId: 'thread-1',
    })).resolves.toMatchObject({ output: 'The cache key is stale.' });
  });

  it('defers when the workspace is not readable on this instance', async () => {
    (isOutputWorkspaceReadable as jest.Mock).mockReturnValueOnce(false);

    await expect(cursorAgentCompletionOutput({
      stepType: 'cursor-agent',
      agentRunId: 'agent-1',
      completedAt: '2026-09-24T12:00:00.000Z',
      threadId: 'thread-1',
    })).resolves.toBeNull();
  });

  it('omits thread fields when the agent run has no thread', async () => {
    await expect(cursorAgentCompletionOutput({
      stepType: 'cursor-agent',
      agentRunId: 'agent-1',
      completedAt: '2026-09-24T12:00:00.000Z',
    })).resolves.toEqual({
      agentRunId: 'agent-1',
      completedAt: '2026-09-24T12:00:00.000Z',
    });
  });
});

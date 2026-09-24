jest.mock('../services/chatAgentService', () => ({
  readOutputValidationScorecard: jest.fn().mockReturnValue({ is_ready: true }),
  readOutputValidationScorecardMd: jest.fn().mockReturnValue('# report'),
}));

import { cursorAgentCompletionOutput } from '../services/playbookSteps/cursorAgentCompletion';

describe('cursorAgentCompletionOutput', () => {
  it('records thread, scorecard, and report for a completed cursor-agent step', () => {
    expect(cursorAgentCompletionOutput({
      stepType: 'cursor-agent',
      agentRunId: 'agent-1',
      completedAt: '2026-09-24T12:00:00.000Z',
      threadId: 'thread-1',
    })).toEqual({
      agentRunId: 'agent-1',
      completedAt: '2026-09-24T12:00:00.000Z',
      threadId: 'thread-1',
      scorecard: { is_ready: true },
      reportMd: '# report',
    });
  });

  it('omits thread fields when the agent run has no thread', () => {
    expect(cursorAgentCompletionOutput({
      stepType: 'cursor-agent',
      agentRunId: 'agent-1',
      completedAt: '2026-09-24T12:00:00.000Z',
    })).toEqual({
      agentRunId: 'agent-1',
      completedAt: '2026-09-24T12:00:00.000Z',
    });
  });
});

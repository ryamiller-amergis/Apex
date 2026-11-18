const mockAttemptCount = jest.fn();
const mockExecute = jest.fn();
const mockLoadRetrySource = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => mockAttemptCount(),
      }),
    }),
    execute: (...args: unknown[]) => mockExecute(...args),
  },
}));
jest.mock('../services/durableInteractiveTurnService', () => ({
  durableInteractiveTurnService: { retry: jest.fn() },
  loadDurableInteractiveRetrySource: (...args: unknown[]) => mockLoadRetrySource(...args),
}));

import {
  defaultLostTurnRetry,
  workflowAllowsAutomaticRerun,
  type LostTurn,
} from '../services/agentRunReaperService';
import { INTERACTIVE_WORKFLOW_CLASSES } from '../../shared/types/interactiveWorkflow';

const turn: LostTurn = {
  runId: 'run-1',
  threadId: 'thread-1',
  userId: 'user-1',
  reason: 'host_lost',
};

function source(overrides: Record<string, unknown> = {}) {
  return {
    interactiveClass: 'agentic',
    specification: { toolGrant: null, workflowClass: 'assistant', ...overrides },
  };
}

beforeEach(() => {
  mockAttemptCount.mockResolvedValue([{ total: 1 }]);
  mockLoadRetrySource.mockResolvedValue(source());
  mockExecute.mockResolvedValue({ rows: [] });
});

describe('defaultLostTurnRetry.isEligible', () => {
  it('allows a first-attempt assistant turn with no grant and no MCP calls', async () => {
    await expect(defaultLostTurnRetry.isEligible(turn)).resolves.toEqual({ eligible: true });
  });

  it('skips a run that already has a second attempt', async () => {
    mockAttemptCount.mockResolvedValue([{ total: 2 }]);
    await expect(defaultLostTurnRetry.isEligible(turn)).resolves.toEqual({
      eligible: false,
      skippedReason: 'not_first_attempt',
    });
  });

  it('skips a run whose specification cannot be loaded', async () => {
    mockLoadRetrySource.mockResolvedValue(null);
    await expect(defaultLostTurnRetry.isEligible(turn)).resolves.toEqual({
      eligible: false,
      skippedReason: 'no_specification',
    });
  });

  it('skips a turn holding a delegated ADO grant', async () => {
    mockLoadRetrySource.mockResolvedValue(source({ toolGrant: { userId: 'user-1' } }));
    await expect(defaultLostTurnRetry.isEligible(turn)).resolves.toEqual({
      eligible: false,
      skippedReason: 'tool_grant',
    });
  });

  it.each(['interview', 'adr', 'brainstorm'])('skips a %s turn', async (workflowClass) => {
    mockLoadRetrySource.mockResolvedValue(source({ workflowClass }));
    await expect(defaultLostTurnRetry.isEligible(turn)).resolves.toEqual({
      eligible: false,
      skippedReason: 'workflow_class',
    });
  });

  it('skips a turn whose lost attempt called an MCP tool', async () => {
    mockExecute.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    await expect(defaultLostTurnRetry.isEligible(turn)).resolves.toEqual({
      eligible: false,
      skippedReason: 'mcp_tool_call',
    });
  });
});

describe('workflowAllowsAutomaticRerun', () => {
  it('decides every interactive workflow class', () => {
    const allowed = INTERACTIVE_WORKFLOW_CLASSES.filter(workflowAllowsAutomaticRerun);
    expect(allowed).toEqual(['home-chat', 'ask-apex', 'assistant']);
  });
});

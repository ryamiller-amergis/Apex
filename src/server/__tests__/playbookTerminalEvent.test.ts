/**
 * TBI-020 — resume on a terminal agent-run event.
 *
 * Covers VT-01 (a success event resumes the step with its output available), VT-02 (a failure
 * event fails the step rather than resuming it as successful) and VT-03 (a redelivered event moves
 * nothing).
 *
 * VT-02 is the one worth having. Resuming on any terminal event is the plausible-looking mistake:
 * it passes a happy-path test, and produces a Playbook that reports success for an agent turn that
 * crashed.
 */
import fs from 'fs';
import path from 'path';

const selectWhere = jest.fn();
const resumeStepRun = jest.fn();
const failStepRun = jest.fn();
const advanceRun = jest.fn();

jest.mock('../db', () => ({ __esModule: true, default: { end: jest.fn(), on: jest.fn() } }));

jest.mock('../db/drizzle', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: () => selectWhere() }) }) }),
  },
}));

jest.mock('../services/playbookSteps/stepRuns', () => ({
  resumeStepRun: (...a: unknown[]) => resumeStepRun(...a),
  failStepRun: (...a: unknown[]) => failStepRun(...a),
}));

/*
 * Stubbed rather than exercised. Resuming the step and starting the next one are two decisions,
 * and this file is about the first: which events resume, which fail, and which do nothing.
 * `playbook-run-advance.integration.test.ts` covers what advancing actually does, against a real
 * database. What is worth asserting here is only that the handler asks — see VT-01.
 */
jest.mock('../services/playbookAdvanceService', () => ({
  advanceRun: (...a: unknown[]) => advanceRun(...a),
}));

jest.mock('../services/chatAgentService', () => ({
  readOutputValidationScorecard: jest.fn().mockReturnValue(null),
  readOutputValidationScorecardMd: jest.fn().mockReturnValue(null),
}));

import type {
  AgentRunEventEnvelope,
  AgentRunEventStatus,
  AgentRunEventType,
} from '../../shared/types/chat';
import {
  handleTerminalAgentRunEvent,
  isTerminalRunEvent,
} from '../services/playbookTerminalEventService';

const AGENT_RUN_ID = 'agent-run-42';
const STEP_RUN_ID = 'step-run-7';
const RUN_ID = 'run-3';
/** The graph node, as distinct from the step-run row — it is what the engine is parked at. */
const STEP_ID = 'do-the-work';

/** The envelope type the ingest path builds for each outcome. */
const TYPE_FOR_STATUS: Record<AgentRunEventStatus, AgentRunEventType> = {
  completed: 'done',
  failed: 'error',
  cancelled: 'cancel',
  running: 'phase',
  pending: 'phase',
};

function event(status: AgentRunEventStatus): AgentRunEventEnvelope {
  return {
    eventId: `evt-${status}`,
    threadId: 'thread-1',
    runId: AGENT_RUN_ID,
    sourceInstance: 'host:1:uuid',
    sequence: 1,
    timestamp: '2026-09-19T12:00:00.000Z',
    type: TYPE_FOR_STATUS[status],
    phase: 'completion',
    status,
    event: { type: 'phase', phase: 'completion', status },
  } as AgentRunEventEnvelope;
}

/**
 * Progress from one phase of a turn that is still going, which is what an agent emits between
 * `analysis` and `implementation`. It reports `completed` because that phase completed.
 */
function phaseCompletedEvent(): AgentRunEventEnvelope {
  return {
    eventId: 'evt-phase-analysis',
    threadId: 'thread-1',
    runId: AGENT_RUN_ID,
    sourceInstance: 'host:1:uuid',
    sequence: 4,
    timestamp: '2026-09-19T12:00:00.000Z',
    type: 'phase',
    phase: 'analysis',
    status: 'completed',
    detail: 'Analysis completed',
    event: { type: 'phase', phase: 'analysis', status: 'completed', durationMs: 218 },
  } as AgentRunEventEnvelope;
}

/** The step the event correlates to, in the state the handler will find it. */
function stepIs(status: string | null): void {
  selectWhere.mockResolvedValue(
    status === null
      ? []
      : [
          {
            id: STEP_RUN_ID,
            runId: RUN_ID,
            stepId: STEP_ID,
            stepType: 'cursor-agent',
            status,
          },
        ]
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  stepIs('suspended');
  resumeStepRun.mockResolvedValue(true);
  failStepRun.mockResolvedValue(undefined);
  advanceRun.mockResolvedValue({ advanced: true, stepsStarted: 1 });
});

describe('which events count as terminal', () => {
  it('treats completed, failed and cancelled as terminal and nothing else', () => {
    expect(isTerminalRunEvent(event('completed'))).toBe(true);
    expect(isTerminalRunEvent(event('failed'))).toBe(true);
    expect(isTerminalRunEvent(event('cancelled'))).toBe(true);

    expect(isTerminalRunEvent(event('running'))).toBe(false);
    expect(isTerminalRunEvent(event('pending'))).toBe(false);
  });

  /**
   * A turn moving from `analysis` to `implementation` emits exactly this. Reading `status` alone
   * ended the step 218ms into the run, resuming it with no answer and reporting the run complete.
   */
  it('does not treat a finished phase of an unfinished turn as terminal', () => {
    expect(isTerminalRunEvent(phaseCompletedEvent())).toBe(false);
  });

  it('ignores a non-terminal event without touching the database', async () => {
    await expect(handleTerminalAgentRunEvent(event('running'))).resolves.toEqual({
      handled: 'not-correlated',
    });

    expect(selectWhere).not.toHaveBeenCalled();
  });
});

describe('VT-01 — a terminal success event resumes the correlated step', () => {
  it('resumes it and records the completed agent run as the step output', async () => {
    const result = await handleTerminalAgentRunEvent(event('completed'));

    expect(result).toEqual({ handled: 'resumed', stepRunId: STEP_RUN_ID });
    expect(failStepRun).not.toHaveBeenCalled();
    expect(resumeStepRun).toHaveBeenCalledWith({
      stepRunId: STEP_RUN_ID,
      output: { agentRunId: AGENT_RUN_ID, completedAt: '2026-09-19T12:00:00.000Z', threadId: 'thread-1' },
    });
  });

  /*
   * Resuming the step without this leaves the run at `running` with nothing left to wake it: the
   * event that would have advanced it is the one being handled. The run would sit there until the
   * sweep noticed, which is a minute of a demo spent watching a finished step.
   */
  it('advances the run it belongs to, so the next step actually starts', async () => {
    await handleTerminalAgentRunEvent(event('completed'));

    // The step id goes with it: the engine is parked at that node and is told to carry on from it,
    // rather than having the position inferred from the rows as the sweep has to.
    expect(advanceRun).toHaveBeenCalledWith(RUN_ID, STEP_ID);
  });

  it('does nothing when no Playbook step is waiting on that agent run', async () => {
    stepIs(null);

    await expect(handleTerminalAgentRunEvent(event('completed'))).resolves.toEqual({
      handled: 'not-correlated',
    });
    expect(resumeStepRun).not.toHaveBeenCalled();
    expect(failStepRun).not.toHaveBeenCalled();
  });
});

describe('VT-02 — a terminal failure event fails the step', () => {
  it.each(['failed', 'cancelled'] as const)('does not resume on %s', async (status) => {
    const result = await handleTerminalAgentRunEvent(event(status));

    expect(result).toEqual({ handled: 'failed', stepRunId: STEP_RUN_ID });
    expect(resumeStepRun).not.toHaveBeenCalled();
    expect(failStepRun).toHaveBeenCalledWith({
      stepRunId: STEP_RUN_ID,
      // Retryable: the agent turn failed, and a turn cannot be continued from where it stopped.
      retryable: true,
      reason: expect.stringContaining(status),
    });
  });
});

describe('VT-03 — a redelivered terminal event moves nothing', () => {
  it('reports already-moved when the conditional update matches no rows', async () => {
    // What resumeStepRun returns when the step is no longer suspended.
    resumeStepRun.mockResolvedValue(false);

    const result = await handleTerminalAgentRunEvent(event('completed'));

    expect(result).toEqual({ handled: 'already-moved', stepRunId: STEP_RUN_ID });

    /*
     * Only the delivery that moved the step advances. `advanceRun` would refuse a second start on
     * its own, but relying on that would make correctness here depend on a guard in another file.
     */
    expect(advanceRun).not.toHaveBeenCalled();
  });

  it('does not re-fail a step that already moved', async () => {
    stepIs('completed');

    const result = await handleTerminalAgentRunEvent(event('failed'));

    expect(result).toEqual({ handled: 'already-moved', stepRunId: STEP_RUN_ID });
    expect(failStepRun).not.toHaveBeenCalled();
  });

  it('relies on the conditional update rather than reading status first', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'playbookTerminalEventService.ts'),
      'utf8'
    );

    /*
     * The success path must not gate on the status it just read. Doing so reintroduces the
     * check-then-write window that two concurrent deliveries both pass through, which is the bug
     * the conditional update exists to make impossible.
     */
    expect(source).toContain('resumeStepRun');
    expect(source).not.toMatch(/if\s*\(\s*step\.status\s*===\s*'suspended'\s*\)\s*\{[\s\S]{0,200}resumeStepRun/);
  });
});

describe('TBI-032 VT-24 — cursor-agent terminal output validation', () => {
  it('rejects malformed output before durable resume and names the field', async () => {
    const invalid = event('completed');
    invalid.timestamp = 'not-a-time';

    await expect(handleTerminalAgentRunEvent(invalid)).rejects.toThrow(
      /cursor-agent.*output.*completedAt/i
    );
    expect(resumeStepRun).not.toHaveBeenCalled();
    expect(advanceRun).not.toHaveBeenCalled();
  });
});

const selectLimit = jest.fn();
const insertValues = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => selectLimit(),
        }),
      }),
    }),
    insert: () => ({
      values: (row: unknown) => {
        insertValues(row);
        return {
          onConflictDoNothing: () => ({
            returning: async () => [],
          }),
        };
      },
    }),
  },
}));

import { capturePlaybookOutcomeFeedback } from '../services/playbookOutcomeFeedbackService';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const CAPTURE_STEP_RUN_ID = '22222222-2222-4222-8222-222222222222';
const REVIEW_STEP_RUN_ID = '33333333-3333-4333-8333-333333333333';
const CHAIR_STEP_RUN_ID = '44444444-4444-4444-8444-444444444444';

function review(decision: 'approved' | 'rejected') {
  return {
    id: REVIEW_STEP_RUN_ID,
    stepId: 'ratify',
    stepType: 'approval-gate',
    status: 'completed',
    agentRunId: null,
    inputInline: { subject: 'Ratify the ATS board synopsis' },
    outputInline: {
      decision,
      decidedBy: 'leader',
      comment: 'The Phase 1 scope is right.',
      answers: [
        {
          decisionId: 'D-PII',
          resolution: 'direct',
          response: 'Keep Phase 1 synthetic.',
          prompt: 'Do not store this prompt.',
        },
      ],
    },
  };
}

const chair = {
  id: CHAIR_STEP_RUN_ID,
  stepId: 'chair',
  stepType: 'cursor-agent',
  status: 'completed',
  agentRunId: 'agent-chair',
  inputInline: {
    skillPath: '.cursor/skills/ats-board-chair/SKILL.md',
    model: 'test-model',
    prompt: 'Write the full technical synopsis.',
  },
  outputInline: {
    reportMd: 'A very long technical report that learning must not copy.',
  },
};

function queue(rows: unknown[][]) {
  const pending = [...rows];
  selectLimit.mockImplementation(async () => pending.shift() ?? []);
}

beforeEach(() => {
  jest.clearAllMocks();
  insertValues.mockReset();
});

describe('capturePlaybookOutcomeFeedback', () => {
  it('stores the review outcome and AI provenance without prompts or reports', async () => {
    queue([
      [],
      [{ definitionVersionId: 'version-5' }],
      [review('approved'), chair],
      [
        {
          id: 'feedback-1',
          decision: 'approved',
          sources: [{ stepId: 'chair' }],
          capturedAt: '2026-10-20T16:00:00.000Z',
        },
      ],
    ]);

    const result = await capturePlaybookOutcomeFeedback({
      runId: RUN_ID,
      captureStepRunId: CAPTURE_STEP_RUN_ID,
      reviewStepId: 'ratify',
      sourceStepIds: ['chair'],
      label: 'ATS board outcome',
    });

    expect(result).toEqual({
      feedbackId: 'feedback-1',
      decision: 'approved',
      sourceCount: 1,
      capturedAt: '2026-10-20T16:00:00.000Z',
    });
    const stored = insertValues.mock.calls[0][0] as {
      decision: string;
      overallComment: string;
      answers: Array<Record<string, unknown>>;
      sources: Array<Record<string, unknown>>;
    };
    expect(stored.decision).toBe('approved');
    expect(stored.overallComment).toBe('The Phase 1 scope is right.');
    expect(stored.answers).toEqual([
      {
        decisionId: 'D-PII',
        resolution: 'direct',
        response: 'Keep Phase 1 synthetic.',
      },
    ]);
    expect(stored.sources).toEqual([
      {
        stepId: 'chair',
        stepRunId: CHAIR_STEP_RUN_ID,
        stepType: 'cursor-agent',
        agentRunId: 'agent-chair',
        skillPath: '.cursor/skills/ats-board-chair/SKILL.md',
        model: 'test-model',
      },
    ]);
    expect(JSON.stringify(stored)).not.toContain('prompt');
    expect(JSON.stringify(stored)).not.toContain('reportMd');
  });

  it('keeps a send-back as rejected', async () => {
    queue([
      [],
      [{ definitionVersionId: 'version-5' }],
      [review('rejected'), chair],
      [
        {
          id: 'feedback-2',
          decision: 'rejected',
          sources: [{ stepId: 'chair' }],
          capturedAt: '2026-10-20T16:05:00.000Z',
        },
      ],
    ]);

    const result = await capturePlaybookOutcomeFeedback({
      runId: RUN_ID,
      captureStepRunId: CAPTURE_STEP_RUN_ID,
      reviewStepId: 'ratify',
      sourceStepIds: ['chair'],
    });

    expect(result.decision).toBe('rejected');
    expect(insertValues.mock.calls[0][0].decision).toBe('rejected');
  });

  it('returns the existing record when the same capture step runs again', async () => {
    queue([
      [
        {
          id: 'feedback-1',
          decision: 'approved',
          sources: [{ stepId: 'chair' }, { stepId: 'deliberation' }],
          capturedAt: '2026-10-20T16:00:00.000Z',
        },
      ],
    ]);

    const result = await capturePlaybookOutcomeFeedback({
      runId: RUN_ID,
      captureStepRunId: CAPTURE_STEP_RUN_ID,
      reviewStepId: 'ratify',
      sourceStepIds: ['chair', 'deliberation'],
    });

    expect(result.feedbackId).toBe('feedback-1');
    expect(result.sourceCount).toBe(2);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('stores selected AI provenance when no human review is configured', async () => {
    queue([
      [],
      [{ definitionVersionId: 'version-7' }],
      [chair],
      [
        {
          id: 'feedback-3',
          decision: 'recorded',
          sources: [{ stepId: 'chair' }],
          capturedAt: '2026-10-20T16:10:00.000Z',
        },
      ],
    ]);

    const result = await capturePlaybookOutcomeFeedback({
      runId: RUN_ID,
      captureStepRunId: CAPTURE_STEP_RUN_ID,
      sourceStepIds: ['chair', 'missing-branch'],
    });

    expect(result.decision).toBe('recorded');
    const stored = insertValues.mock.calls[0][0] as {
      decision: string;
      reviewStepRunId: string | null;
      sources: Array<{ stepId: string }>;
    };
    expect(stored.decision).toBe('recorded');
    expect(stored.reviewStepRunId).toBeNull();
    expect(stored.sources.map((source) => source.stepId)).toEqual(['chair']);
  });

  it('keeps item choices from a feedback review as needs_changes', async () => {
    queue([
      [],
      [{ definitionVersionId: 'version-7' }],
      [
        {
          id: REVIEW_STEP_RUN_ID,
          stepId: 'leadership-feedback',
          stepType: 'feedback-review',
          status: 'completed',
          agentRunId: null,
          inputInline: { sourceStepIds: ['chair'] },
          outputInline: {
            decision: 'needs_changes',
            comment: 'Please narrow Phase 1.',
            items: [
              {
                sourceStepId: 'chair',
                itemId: 'decision-1',
                action: 'question',
                note: 'Who approves the submission?',
              },
            ],
          },
        },
        chair,
      ],
      [
        {
          id: 'feedback-4',
          decision: 'needs_changes',
          sources: [{ stepId: 'chair' }],
          capturedAt: '2026-10-20T16:12:00.000Z',
        },
      ],
    ]);

    const result = await capturePlaybookOutcomeFeedback({
      runId: RUN_ID,
      captureStepRunId: CAPTURE_STEP_RUN_ID,
      reviewStepId: 'leadership-feedback',
      sourceStepIds: ['chair'],
    });

    expect(result.decision).toBe('needs_changes');
    const stored = insertValues.mock.calls[0][0] as {
      answers: Array<Record<string, string>>;
      overallComment: string;
    };
    expect(stored.overallComment).toBe('Please narrow Phase 1.');
    expect(stored.answers).toEqual([
      {
        decisionId: 'chair:decision-1',
        resolution: 'question',
        response: 'Who approves the submission?',
      },
    ]);
    expect(JSON.stringify(stored)).not.toContain('reportMd');
  });
});

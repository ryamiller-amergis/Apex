import {
  feedbackDecision,
  promptsForSourceStep,
  revisionBrief,
} from '../../shared/feedbackReview';

describe('feedback review prompts', () => {
  it('turns a leadership brief into explicit choices and leaves other agents as one item', () => {
    const chair = promptsForSourceStep('chair', {
      scorecard: {
        schemaVersion: 4,
        status: 'Board approved — awaiting leadership',
        leadershipBrief: {
          headline: 'Phase 1 fills one assignment.',
          aiDecisions: ['A recruiter submits one candidate.'],
          expectedOutcomes: ['The recruiter finishes in one screen.'],
          materialExceptions: [
            {
              id: 'D-PII',
              category: 'real_pii',
              title: 'Customer data',
              question: 'May Phase 1 use real customer data?',
              recommendedResolution: 'Use sample data only.',
            },
          ],
        },
        decisionRequests: ['D-PII'],
        recommendation: 'Build the thin workflow.',
        businessOutcomes: ['One filled assignment.'],
        executiveSynopsis: 'Phase 1 covers one filled assignment.',
        phase1: ['A recruiter submits one candidate.'],
        day1Cutover: 'Open jobs only.',
        separationImpact: 'The new workflow runs without the old system.',
        options: [],
        leadershipActions: [],
        deliberation: [],
        decisions: [],
        dissent: [],
        risks: [],
        assumptions: [],
        advantages: [],
        deferred: [],
        unresolved: [],
        readiness: { ratifiable: true, blockers: [] },
        evidenceRegister: [],
        insufficientEvidence: [],
        lenses: { security: [], cost: [], delivery: [], adoption: [] },
      },
    });

    expect(chair.map((prompt) => prompt.itemId)).toEqual(['decision-1', 'D-PII']);
    expect(chair[1]?.recommendation).toBe('Use sample data only.');
    expect(chair[1]?.title).toBe('Customer data');

    const deliberation = promptsForSourceStep('deliberation', {
      reportMd: '## Audit\n\nThe specialists left payroll open.',
    });
    expect(deliberation).toEqual([
      expect.objectContaining({
        sourceStepId: 'deliberation',
        itemId: 'outcome',
        detail: expect.stringContaining('payroll'),
      }),
    ]);
    expect(deliberation[0]?.detail).not.toContain('##');
  });

  it('replaces decision codes in the choice a leader reads', () => {
    const prompts = promptsForSourceStep('chair', {
      scorecard: {
        leadershipBrief: {
          aiDecisions: ['Phase 1 stays on sample records. See D-PII.'],
          materialExceptions: [
            {
              id: 'D-LEGAL',
              title: 'Legal sign-off',
              question: 'Has legal approved the first release?',
              recommendedResolution: 'Wait for legal sign-off.',
            },
            {
              id: 'D-CUTOVER',
              title: 'Go-live',
              question: 'When does the first release go live?',
              recommendedResolution:
                'Keep a kill switch on publish until D-LEGAL and D-CUTOVER resolutions are recorded.',
            },
          ],
        },
      },
    });

    const goLive = prompts.find((prompt) => prompt.itemId === 'D-CUTOVER');
    expect(goLive?.recommendation).toBe(
      'Keep a kill switch on publish until Legal sign-off and Go-live resolutions are recorded.'
    );
    expect(goLive?.recommendation).not.toMatch(/D-[A-Z]+/);
    expect(prompts[0]?.detail).not.toContain('D-PII');
  });

  it('writes a plain revision note from the choices', () => {
    const prompts = promptsForSourceStep('chair', {
      reportMd: 'Keep Phase 1 to one filled assignment.',
    });
    const items = [
      {
        sourceStepId: 'chair',
        itemId: 'outcome',
        action: 'question' as const,
        note: 'Who approves the submission?',
      },
    ];

    expect(feedbackDecision({ stopped: false, items })).toBe('needs_changes');
    expect(feedbackDecision({ stopped: true, items })).toBe('rejected');
    expect(
      revisionBrief({
        decision: 'needs_changes',
        items,
        prompts,
      })
    ).toBe('Leadership asked for these changes.\nchair: Ask a question. Who approves the submission?');
  });
});

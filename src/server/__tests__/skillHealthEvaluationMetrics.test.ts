import {
  buildProjectEvaluation,
  eventScore,
  humanStats,
  type SkillHealthEvaluationEventInput,
  type SkillHealthEvaluationJobInput,
} from '../services/skillHealthEvaluationMetrics';

const event = (overrides: Partial<SkillHealthEvaluationEventInput> = {}): SkillHealthEvaluationEventInput => ({
  id: 'event-1',
  project: 'Apex',
  subjectType: 'prd',
  subjectId: 'prd-1',
  stageKey: 'prd_human_review',
  skillPath: '.cursor/skills/to-prd/SKILL.md',
  skillVersion: 'sha-a',
  criteriaScores: {
    intent_alignment: 4,
    requirements_coverage: 3,
    scope_alignment: 4,
    acceptance_criteria: 2,
    readiness: 2,
  },
  outcome: 'accept_after_edits',
  comment: null,
  createdAt: '2026-10-15T12:00:00.000Z',
  ...overrides,
});

const judgeJob = (eventId: string, summary: unknown, status: SkillHealthEvaluationJobInput['status'] = 'ready') => ({
  eventId,
  evaluatorKey: 'llm_judge' as const,
  status,
  summary,
});

const judgeSummary = (texts: string[]) => ({
  missedRequirements: [],
  inventedRequirements: [],
  recommendedImprovements: texts.map((text) => ({ text, criterion: 'readiness' })),
  confidence: 'medium',
});

describe('eventScore and humanStats', () => {
  it('averages the five criteria of an event', () => {
    expect(eventScore(event())).toBe(3);
  });

  it('counts events and averages their scores', () => {
    expect(humanStats([event(), event({ criteriaScores: { intent_alignment: 5, readiness: 5 } })])).toEqual({
      humanEvents: 2,
      humanAverageScore: 4,
    });
    expect(humanStats([])).toEqual({ humanEvents: 0, humanAverageScore: null });
  });
});

describe('buildProjectEvaluation', () => {
  it('counts outcomes per stage in seeded order', () => {
    const result = buildProjectEvaluation('Apex', [
      event({ id: 'a', stageKey: 'interview_phase_1', subjectType: 'interview_phase', outcome: 'reject' }),
      event({ id: 'b' }),
      event({ id: 'c', outcome: 'accept_unchanged' }),
    ], []);

    expect(result.events).toBe(3);
    expect(result.stages.map((s) => [s.stageKey, s.events, s.outcomes.accept_unchanged, s.outcomes.reject])).toEqual([
      ['prd_human_review', 2, 1, 0],
      ['interview_phase_1', 1, 0, 1],
    ]);
  });

  it('lists regenerate and reject events newest first with a comment excerpt', () => {
    const result = buildProjectEvaluation('Apex', [
      event({ id: 'old', outcome: 'regenerate', createdAt: '2026-10-01T00:00:00.000Z', comment: 'x'.repeat(300) }),
      event({ id: 'new', outcome: 'reject', createdAt: '2026-10-10T00:00:00.000Z', comment: '  Missed the main flow  ' }),
      event({ id: 'fine', outcome: 'accept_unchanged' }),
    ], []);

    expect(result.flagged.map((f) => f.eventId)).toEqual(['new', 'old']);
    expect(result.flagged[0].commentExcerpt).toBe('Missed the main flow');
    expect(result.flagged[1].commentExcerpt).toHaveLength(160);
  });

  it('groups by Skill path and subject type, with criteria averages and job counts', () => {
    const result = buildProjectEvaluation(
      'Apex',
      [
        event({ id: 'a' }),
        event({ id: 'b', skillPath: '\\.cursor\\skills\\to-prd\\SKILL.md', criteriaScores: { intent_alignment: 2 } }),
        event({ id: 'c', subjectType: 'interview_phase', stageKey: 'interview_phase_1', skillPath: '.cursor/skills/grill-with-docs/SKILL.md' }),
      ],
      [
        { eventId: 'a', evaluatorKey: 'promptfoo', status: 'ready', summary: null },
        { eventId: 'b', evaluatorKey: 'promptfoo', status: 'failed', summary: null },
        judgeJob('a', null, 'pending'),
      ],
    );

    const prdSkill = result.skills.find((s) => s.subjectType === 'prd');
    expect(prdSkill).toMatchObject({
      key: 'Apex:prd:.cursor/skills/to-prd/skill.md',
      events: 2,
      promptfoo: { ready: 1, failed: 1, pending: 0, running: 0 },
      judge: { pending: 1, ready: 0, failed: 0, running: 0 },
    });
    expect(prdSkill?.criteriaAverages.intent_alignment).toBe(3);
    expect(prdSkill?.criteriaAverages.readiness).toBe(2);
    expect(result.skills.find((s) => s.subjectType === 'interview_phase')?.events).toBe(1);
  });

  it('takes recommendations only from ready judge jobs with a valid summary, newest first, five at most', () => {
    const result = buildProjectEvaluation(
      'Apex',
      [
        event({ id: 'old', createdAt: '2026-10-01T00:00:00.000Z' }),
        event({ id: 'new', createdAt: '2026-10-12T00:00:00.000Z' }),
        event({ id: 'bad', createdAt: '2026-10-13T00:00:00.000Z' }),
        event({ id: 'failed', createdAt: '2026-10-14T00:00:00.000Z' }),
      ],
      [
        judgeJob('old', judgeSummary(['o1', 'o2', 'o3'])),
        judgeJob('new', judgeSummary(['n1', 'n2', 'n3'])),
        judgeJob('bad', { recommendedImprovements: 'not a list' }),
        judgeJob('failed', judgeSummary(['f1']), 'failed'),
      ],
    );

    const [skill] = result.skills;
    expect(skill.recommendations.map((r) => r.text)).toEqual(['n1', 'n2', 'n3', 'o1', 'o2']);
    expect(skill.recommendations[0]).toMatchObject({ eventId: 'new', criterion: 'readiness' });
  });
});
